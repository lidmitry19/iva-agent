import { spawn } from "node:child_process";
import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { isAuthoredPath } from "./authored-paths.ts";
import { resolveDataDir } from "./data-dir.ts";
import {
  buildPluginExtension,
  codePlugins,
  disableCodePlugin,
  removePluginFromVersion,
  type CodePlugin,
  type PluginFailure,
} from "./plugin-build.ts";
import {
  awaitServing,
  probeEnvironment,
  probeVersion,
  servicePort,
} from "./health-probe.ts";
import {
  bindProbe,
  DEFAULT_PORT,
  PortChecker,
  PortSelector,
  procProbe,
} from "./ports.ts";
import {
  acquireUpdateLock,
  createVersionStore,
  parseVersionName,
  releaseOf,
  versionName,
  writeJson,
} from "./version-store.ts";

export type CommandResult = { readonly code: number; readonly output: string };
export type Runner = (
  command: string,
  args: readonly string[],
  cwd: string,
) => Promise<CommandResult>;

type Say = (message: string) => void;
/** `busy`: the port went, not the version - the same tree on another port may pass. */
type Health = { ok: boolean; log: string; busy?: boolean };
type Probe = (dir: string, port: number) => Promise<Health>;
/** Whether the user's own files are in the version that runs. */
type Custom = "none" | "applied" | "stock";
type Store = ReturnType<typeof createVersionStore>;

export type UpdateOutcome =
  | { status: "busy" }
  | { status: "current"; version: string }
  | { status: "unhealthy"; version: string; log: string }
  | { status: "failed"; message: string }
  | {
      status: "updated";
      version: string;
      previous: string | null;
      custom: Custom;
      migrations: string[];
      removed: string[];
    };

/** The active version plus one to roll back to; disks on these boxes are small. */
const KEEP = 2;
const INSTALL = ["ci", "--no-audit", "--no-fund"];
const BUILD = ["run", "build"];
/** Candidate ports one probe may lose to a neighbour before it gives up. */
const PROBE_PORTS = 4;
const MIGRATION_FILE = /^\d{3}-[a-z0-9-]+\.ts$/;
const MIGRATION_MARKER = "migrations.json";
const OUTPUT_TAIL = 20_000;

export type MigrationContext = Record<string, unknown>;
export type Migration = (context: MigrationContext) => void | Promise<void>;

type FinishOptions = {
  readonly home: string;
  /** The staged version to build, prove and activate. */
  readonly name: string;
  readonly run: Runner;
  readonly probe?: Probe;
  /** Stop every service that can write shared state before migrations start. */
  readonly quiesce?: () => Promise<void>;
  /** Resume the old writers after a pre-activation fault, without changing units. */
  readonly resumeOldWriters?: (root: string) => Promise<void>;
  /** Refresh units and start the candidate only after activation. */
  readonly startCandidate?: (root: string) => Promise<void>;
  /** Whether the restarted service answers on the port the installation runs on. */
  readonly serving?: (port: number) => Promise<Health>;
  /** Retire recovery writers only after live health durably commits the candidate. */
  readonly retireCommittedWriters?: (root: string) => Promise<void>;
  /** Layout changes the installation itself needs: the shim, the old checkout. */
  readonly adopt?: () => void;
  readonly notify?: Say;
  readonly log?: Say;
  readonly store?: Store;
  /**
   * `iva plugin add|update|enable`: the plugin is the point of the build, so a plugin
   * that will not build fails it and leaves the running version alone. An `iva update`
   * leaves this off - there a plugin broken by a new eve is switched off instead, and
   * the release still installs (ADR-0003).
   */
  readonly requirePlugins?: boolean;
  /** Tell the owner which plugins are off, at most once a week per set (ADR-0007). */
  readonly alertPlugins?: (failures: readonly PluginFailure[]) => Promise<void>;
};

type UpdateOptions = Omit<FinishOptions, "name"> & {
  /** Fetches into the mirror and reports what should run next. */
  readonly resolveTarget: () => Promise<{ sha: string; version: string }>;
  /** `--force`: build this release again, even where a build of it already runs. */
  readonly force?: boolean;
  /** Hands the staged version to the updater that version ships. */
  readonly handoff?: (name: string) => Promise<UpdateOutcome>;
};

/** The files the user authored; the rest of `data/custom` is the layer's bookkeeping. */
function authored(customDir: string): string[] {
  try {
    return readdirSync(customDir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) =>
        join(relative(customDir, entry.parentPath), entry.name)
          .split(sep)
          .join("/"),
      )
      .filter(isAuthoredPath)
      .sort();
  } catch {
    return [];
  }
}

/** The authored files and a digest of them: an edit to `data/custom` is a version. */
export function customOverlay(customDir: string): {
  files: string[];
  digest: string | null;
} {
  const hash = createHash("sha256");
  const files: string[] = [];
  for (const path of authored(customDir)) {
    let body: Buffer;
    try {
      body = readFileSync(join(customDir, path));
    } catch {
      continue; // Deleted between the listing and the read.
    }
    files.push(path);
    hash.update(`${path}\0${body.length}\0`);
    hash.update(body);
  }
  return {
    files,
    digest: files.length > 0 ? hash.digest("hex").slice(0, 8) : null,
  };
}

/**
 * What a version is built out of, beyond its commit: the files the user authored and
 * the plugins that carry code (ADR-0009). Both go into the digest that names it, so
 * adding, updating, enabling or disabling a code plugin is a new release and a build -
 * and a plugin with only skills changes nothing, because its skills are live.
 */
export async function versionOverlay(
  dataDir: string,
  log: Say = () => {},
): Promise<{
  files: string[];
  digest: string | null;
  plugins: readonly CodePlugin[];
}> {
  const { files, digest } = customOverlay(join(dataDir, "custom"));
  const { plugins, diagnostics } = await codePlugins(dataDir);
  for (const line of diagnostics) log(line);
  if (plugins.length === 0) return { files, digest, plugins };
  // The plugin's content, not the digest recorded for it: a folder edited in place is
  // a different version, and the config beside it is the owner's to change too.
  const hash = createHash("sha256");
  hash.update(`${digest ?? ""}\0`);
  for (const plugin of plugins)
    hash.update(
      `${plugin.name}\0${plugin.digest}\0${plugin.config.length}\0${plugin.config}\n`,
    );
  return { files, digest: hash.digest("hex").slice(0, 8), plugins };
}

function sameFile(one: string, other: string): boolean {
  try {
    return readFileSync(one).equals(readFileSync(other));
  } catch {
    return false;
  }
}

/**
 * What a version was built with, by contents: a stock tree has authored paths too.
 * A plugin counts by its generated mount - without one, eve does not load its code,
 * whatever the version is named after.
 */
export function builtWith(
  dir: string,
  name: string,
  customDir: string,
  plugins: readonly CodePlugin[] = [],
): Custom {
  if (!parseVersionName(name)?.overlay) return "none";
  const { files } = customOverlay(customDir);
  const carried = files.length > 0 || plugins.length > 0;
  return carried &&
    files.every((path) => sameFile(join(dir, path), join(customDir, path))) &&
    plugins.every((plugin) => existsSync(join(dir, plugin.mount)))
    ? "applied"
    : "stock";
}

/**
 * Build a version, prove it starts, flip a symlink, move the installation onto it.
 * Nothing before the flip touches what runs; nothing after it is a one-shot.
 */
export async function runVersionUpdate(
  options: UpdateOptions,
): Promise<UpdateOutcome> {
  const {
    home,
    resolveTarget,
    handoff,
    force = false,
    log = () => {},
    store = createVersionStore(home),
  } = options;
  const lock = acquireUpdateLock(store.layout.data);
  if (!lock) return { status: "busy" };
  try {
    // Safe only under the lock: leftovers are garbage because nobody owns them.
    for (const stale of store.sweep()) log(`removed leftover ${stale}`);
    store.heal();

    const target = await resolveTarget();
    // Half of what gets built, so half of what it is called.
    const { digest } = await versionOverlay(store.layout.data, log);
    const release = versionName(target.version, target.sha, digest);
    const active = store.currentName();
    // Finished, not just flipped: unrun migrations are an update still owed.
    const settled =
      active && releaseOf(active) === release && store.settled() === active;
    if (settled && !force) {
      if (store.cleanupPending(active))
        return handoff
          ? await handoff(active)
          : await finishVersionUpdate({ ...options, name: active, store });
      store.gc(KEEP);
      return { status: "current", version: active };
    }

    // Reusing a finished build makes dropping a customization a flip, not a build.
    // `--force` refuses it: the build already there is the broken one. So does a
    // release the service has already died on - handing that tree back is how one
    // bad start becomes an update that lays the installation down for good.
    const finished =
      force || store.liveFailed(release)
        ? undefined
        : store.list().find((name) => releaseOf(name) === release);
    const name = finished ?? store.nextBuild(release);
    if (!finished) {
      const dir = store.stage(name);
      try {
        await store.materialize({ sha: target.sha, dir });
        store.linkState(dir);
      } catch (error) {
        rmSync(dir, { recursive: true, force: true });
        throw error;
      }
    }
    return handoff
      ? await handoff(name)
      : await finishVersionUpdate({ ...options, name, store });
  } finally {
    // A handoff leaves the child owning this lock; release only drops one's own.
    lock.release();
  }
}

/**
 * The half of an update the new version runs about itself, so a fix to any of it
 * ships with the release carrying it. The flip decides what runs, the marker
 * whether the move is finished.
 */
export async function finishVersionUpdate({
  home,
  name,
  run,
  probe,
  quiesce = async () => {},
  resumeOldWriters = async () => {},
  startCandidate = async () => {},
  serving = (port) => awaitServing({ port }),
  retireCommittedWriters = async () => {},
  adopt = () => {},
  notify = () => {},
  log = () => {},
  store = createVersionStore(home),
  requirePlugins = false,
  alertPlugins,
}: FinishOptions): Promise<UpdateOutcome> {
  const dir = join(store.layout.versions, name);
  const customDir = join(store.layout.data, "custom");
  const active = store.currentName();
  const settledBefore = store.settled(); // Validate state before build or mutation.
  const env = store.layout.env;
  const check: Probe =
    probe ??
    ((at, port) =>
      probeVersion({ dir: at, port, env: probeEnvironment(env, port, at) }));
  const { plugins } = await versionOverlay(store.layout.data, log);
  const tell =
    alertPlugins ??
    ((failures) => Promise.resolve(notify(pluginsOffNotice(failures))));
  let custom = builtWith(dir, name, customDir, plugins);
  if (active === name && settledBefore === name && store.cleanupPending(name)) {
    await runPostHealthCleanup({
      name,
      run,
      retireCommittedWriters,
      adopt,
      log,
      store,
    });
    return { status: "current", version: name };
  }
  /** A version being built is garbage nothing points at: a failure takes it away. */
  const discard = (error: unknown): never => {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  };
  const prove = async (): Promise<Health> => {
    // A real server start, on scratch state: an update about to be thrown away
    // must not have touched the installation.
    const scratch = store.sandboxState(name);
    const selector = new PortSelector(new PortChecker([bindProbe, procProbe]));
    try {
      // The pid spreads two updaters apart; the selector steps over what listens.
      // Nothing holds a port between that check and the start, so the version's own
      // bind is the only reservation there is: a port a neighbour took inside that
      // window comes back as busy, and the next candidate gets the same chance.
      let from = DEFAULT_PORT + 100 + (process.pid % 100);
      for (let left = PROBE_PORTS; left > 0; left--) {
        const port = await selector.firstFree(from);
        if (port === null)
          return { ok: false, log: "no free port for a probe" };
        const health = await check(dir, port);
        if (!health.busy) return health;
        log(
          `the probe port ${port} was taken before the version could bind it`,
        );
        from = port + 1;
      }
      return {
        ok: false,
        log: `no probe port stayed free for ${PROBE_PORTS} tries`,
      };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  };

  // Built by a run that never activated it: the tree is there, the rest is owed.
  const prepared = store.list().includes(name);
  if (active === name) {
    // The flip happened, the rest did not: pick the update up where it stopped.
    log(`finishing the move onto ${name}`);
  } else {
    if (prepared) log(`reusing prepared version ${name}`);
    else if (store.liveFailed(name)) {
      // This code has been live once and the service died on it. The overlay is
      // the only part of the tree that is not upstream's, so it is the part that
      // comes out; without one there is nothing to drop and this is a rebuild.
      log(
        "the service died on this version before; building it without data/custom",
      );
      await buildStock(store, name, run).catch(discard);
      custom = builtWith(dir, name, customDir, plugins);
      if (custom === "stock") notify(deferredNotice());
    } else {
      const built = await buildVersion({
        store,
        name,
        run,
        notify,
        log,
        plugins,
        requirePlugins,
      }).catch(discard);
      custom = built.custom;
      // The build is done and the version is good; a plugin it refused is switched
      // off before anything else happens, so a probe failure or a bad start cannot
      // leave the installation carrying a plugin nothing can build.
      for (const failure of built.failed) {
        if (await disableCodePlugin(store.layout.data, failure.name))
          log(`switched the plugin ${failure.name} off`);
      }
      if (built.failed.length > 0) await tell(built.failed);
    }
    let health = await prove();
    // A green build is not a start: the service compiles the authored TypeScript
    // again when it comes up, and a release is not the user's code to hold up.
    if (!health.ok && custom === "applied" && !prepared) {
      log("the customized version does not start; rebuilding without it");
      await buildStock(store, name, run).catch(discard);
      custom = "stock";
      const broken = health.log;
      health = await prove();
      if (health.ok) notify(stockNotice("start against", broken));
    }
    if (!health.ok) {
      // Garbage nothing points at - unless an earlier run finished it, and then
      // it is somebody's way back, which a failed probe never takes.
      if (!prepared) rmSync(dir, { recursive: true, force: true });
      notify(
        `update to ${name} did not start; staying on ${active ?? "the current version"}`,
      );
      return { status: "unhealthy", version: name, log: health.log };
    }
    // Proved and immutable. It remains a candidate until all old writers stop
    // and every state migration finishes against the old active Version.
    store.complete(name);
  }

  let migrations: string[];
  const storedPrevious = store.previousName();
  const rollback =
    active !== null && active !== name && store.list().includes(active)
      ? active
      : storedPrevious !== name
        ? storedPrevious
        : null;
  try {
    // Completion of this callback is the boundary: no old writer can overlap a
    // present or future migration that changes shared state.
    await quiesce();
    migrations = await runMigrations({
      dir: join(dir, "scripts/migrations"),
      dataDir: store.layout.data,
      context: { home, dataDir: store.layout.data, versionDir: dir },
      log,
    });
    // Before the restart: the cleaner repairs cards an older frontmatter writer
    // grew to gigabytes. Once the new agent opens them, repair is too late.
    await errand(run, log, {
      what: "the vault cleanup",
      failure: "the update continues without it",
      command: "uv",
      args: ["run", join(dir, "scripts/autograph/cleanup.py"), ".", "--apply"],
      cwd: store.layout.vault,
    });
    if (store.currentName() !== name) store.activate(name);
    await startCandidate(store.layout.current);
  } catch (error) {
    // Every recoverable fault restores the Version that served before this run.
    // The candidate stays complete, so the next update can retry without rebuild.
    if (rollback !== null && rollback !== name && store.currentName() === name)
      store.activate(rollback);
    const recoveryRoot =
      active === null && store.currentName() === null
        ? home
        : store.layout.current;
    await resumeOldWriters(recoveryRoot).catch((restartError: unknown) =>
      log(`service recovery failed: ${String(restartError)}`),
    );
    throw error;
  }

  const port = servicePort(env);
  const live = await serving(port).catch((error: unknown) => ({
    ok: false,
    log: error instanceof Error ? error.message : String(error),
  }));
  if (!live.ok) {
    // The probe before the flip ran on scratch state on a scratch port, so an
    // installation that only breaks on its own - a card store it cannot open, a
    // port still held, its unit's environment - fails here and nowhere earlier.
    // Going back is a flip and a restart, and it is not the user's to do by hand
    // through an agent that is down.
    const back = rollback;
    // Written before the rollback: a kill in the middle of one must not leave the
    // next update believing this tree is a good one to hand back.
    let recordFailure: unknown;
    try {
      store.recordLive(name, false);
    } catch (error) {
      recordFailure = error;
    }
    if (back) {
      store.activate(back);
      // A restart that fails here leaves a service the user is without either
      // way, and the flip is what makes the next start the older version's.
      await resumeOldWriters(store.layout.current).catch((error: unknown) =>
        log(`the restart onto ${back} failed: ${String(error)}`),
      );
      store.settle(back);
    }
    notify(
      `${name} did not answer on port ${port} after the restart; ` +
        (back
          ? `going back to ${back}`
          : "there is no earlier version to go back to") +
        (custom === "applied"
          ? ". Your files in data/custom are the likeliest cause - they build and" +
            " they start, and the service still did not come up on them. The next" +
            " update installs this version without them."
          : ""),
    );
    if (recordFailure !== undefined)
      throw recordFailure instanceof Error
        ? recordFailure
        : new Error("recording live failure threw a non-Error value", {
            cause: recordFailure,
          });
    return { status: "unhealthy", version: name, log: live.log };
  }

  // Served: whatever this code did to the installation before, it does not now.
  store.recordLive(name, true);
  // Service state commits before every optional cleanup. A crash or cleanup
  // fault leaves explicit debt, never a healthy update reported as unfinished.
  store.settle(name, {
    cleanupPending: true,
    previous: active !== name ? active : rollback,
  });
  // After the service is up: until it runs the new version, the old checkout is
  // what a failed restart falls back to, so it is not ours to remove any earlier.
  const removed = await runPostHealthCleanup({
    name,
    run,
    retireCommittedWriters,
    adopt,
    log,
    store,
  });
  return {
    status: "updated",
    version: name,
    previous: rollback,
    custom,
    migrations,
    removed,
  };
}

/** Optional installation chores are durable debt after service commit. */
async function runPostHealthCleanup({
  name,
  run,
  retireCommittedWriters,
  adopt,
  log,
  store,
}: {
  readonly name: string;
  readonly run: Runner;
  readonly retireCommittedWriters: (root: string) => Promise<void>;
  readonly adopt: () => void;
  readonly log: Say;
  readonly store: Store;
}): Promise<string[]> {
  let complete = true;
  let removed: string[] = [];
  try {
    await retireCommittedWriters(store.layout.current);
  } catch (error) {
    complete = false;
    log(`writer retirement remains pending: ${String(error)}`);
  }
  try {
    adopt();
  } catch (error) {
    complete = false;
    log(`installation adoption remains pending: ${String(error)}`);
  }
  if (
    !(await errand(run, log, {
      what: "the Google CLI update",
      failure: "cleanup remains pending",
      command: "npm",
      args: ["i", "-g", "@googleworkspace/cli@latest"],
      cwd: join(store.layout.versions, name),
    }))
  )
    complete = false;
  try {
    removed = store.gc(KEEP);
  } catch (error) {
    complete = false;
    log(`version cleanup remains pending: ${String(error)}`);
  }
  if (complete) {
    try {
      store.finishCleanup(name);
    } catch (error) {
      log(`cleanup state remains pending: ${String(error)}`);
    }
  }
  return removed;
}

/**
 * Something an update does for the installation rather than for the version it
 * installs: the vault cleaner, run out of the new version before the service can
 * open what it repairs, and the Google CLI, the one dependency that lives outside
 * a version. Neither has ever been allowed to fail an update - a done update
 * stays done when one of them cannot run.
 */
async function errand(
  run: Runner,
  log: Say,
  {
    what,
    failure,
    command,
    args,
    cwd,
  }: {
    readonly what: string;
    readonly failure: string;
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
  },
): Promise<boolean> {
  const done = await run(command, args, cwd).catch(
    (error: unknown): CommandResult => ({ code: 1, output: String(error) }),
  );
  if (done.code === 0) return true;
  log(`${what} did not run; ${failure}`);
  return false;
}

function stockNotice(verb: string, failure: string): string {
  return `your customization in data/custom does not ${verb} this version, so Iva is running the stock build:\n${failure.slice(-1500)}`;
}

/**
 * The customization is held back rather than tried: the last update that carried
 * it left the service down. Only an edit to `data/custom` or a new release makes
 * an update try it again, so the user is told which of the two is theirs to do.
 */
function deferredNotice(): string {
  return (
    "Iva is running the stock build: the version carrying your data/custom files " +
    "did not come up after the restart last time, so this update leaves them out. " +
    "The files are untouched where you wrote them - fix them, and the next update " +
    "installs them again."
  );
}

/**
 * The local half of what a refused plugin costs the owner: the update output says it
 * outright. The Alert that says the same in the chat is the caller's (ADR-0007), and
 * `iva update` from Telegram is exactly the run whose output nobody reads.
 */
export function pluginsOffNotice(failures: readonly PluginFailure[]): string {
  const named = failures.map((failure) => failure.name).join(", ");
  const one = failures.length === 1;
  return (
    `${one ? "this plugin does" : "these plugins do"} not build with this version, so ` +
    `${one ? "it is" : "they are"} switched off: ${named}. ` +
    `${one ? "Its" : "Their"} code and skills are out until fixed. Update and turn back ` +
    `on: iva plugin update <name>, then iva plugin enable <name>` +
    `${one ? "" : " - one at a time, so the one that breaks the build is the one you see"}.` +
    `\n${failures[0]?.reason.slice(-1500) ?? ""}`
  );
}

/** One npm step in place; the step's own output is the failure report. */
async function npmStep(
  dir: string,
  run: Runner,
  args: readonly string[],
  what: string,
): Promise<void> {
  const done = await run("npm", args, dir);
  if (done.code !== 0) throw new Error(`${what} failed:\n${done.output}`);
}

/** What a build carried, and every plugin it refused along the way. */
type BuiltVersion = {
  readonly custom: Custom;
  readonly failed: readonly PluginFailure[];
};

/** Build a staged version with the user's files in it, or without them if they break it. */
async function buildVersion({
  store,
  name,
  run,
  notify,
  log,
  plugins,
  requirePlugins,
}: {
  readonly store: Store;
  readonly name: string;
  readonly run: Runner;
  readonly notify: Say;
  readonly log: Say;
  readonly plugins: readonly CodePlugin[];
  readonly requirePlugins: boolean;
}): Promise<BuiltVersion> {
  const dir = join(store.layout.versions, name);
  const customDir = join(store.layout.data, "custom");
  const { files } = customOverlay(customDir);
  await npmStep(dir, run, INSTALL, "dependency installation");
  for (const path of files) {
    // Confined to the version by `isAuthoredPath`: it rejects anything absolute,
    // anything that climbs out with `..`, and everything outside `agent/`.
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    cpSync(join(customDir, path), join(dir, path));
  }
  if (files.length > 0) log(`applied ${files.length} customized file(s)`);
  /**
   * Whether the version carries anything of the owner's. A mounted plugin counts:
   * it is code the release does not ship, so a version that will not start with it
   * has to be rebuilt without it, exactly like a skill that will not start.
   */
  const carried = (withPlugins: number): Custom =>
    files.length > 0 || withPlugins > 0 ? "applied" : "none";

  // One plugin at a time: a plugin whose own extension build fails is named by that
  // step, and its neighbours still get theirs.
  const failed: PluginFailure[] = [];
  const mounted: CodePlugin[] = [];
  for (const plugin of plugins) {
    const staged = await buildPluginExtension({
      versionDir: dir,
      plugin,
      run,
      log,
    });
    if (staged.ok) {
      mounted.push(plugin);
      continue;
    }
    removePluginFromVersion(dir, plugin);
    if (requirePlugins) throw new Error(staged.output);
    log(staged.output);
    failed.push({
      name: plugin.name,
      digest: plugin.digest,
      reason: staged.output,
    });
  }

  const built = await run("npm", BUILD, dir);
  if (built.code === 0) return { custom: carried(mounted.length), failed };

  // The tree will not compile with the plugins in it. Which one of them it is is not
  // worth a search: they are the only part of the tree that is neither upstream's nor
  // the user's, so they all come out in one build, and the owner puts them back one at
  // a time. That answer costs one rebuild; a search costs one per plugin.
  if (mounted.length > 0) {
    for (const plugin of mounted) removePluginFromVersion(dir, plugin);
    const withoutPlugins = await run("npm", BUILD, dir);
    if (withoutPlugins.code === 0) {
      const named = mounted.map((plugin) => plugin.name).join(", ");
      const reason = `this version does not build with ${named}:\n${built.output.slice(-OUTPUT_TAIL)}`;
      if (requirePlugins) throw new Error(reason);
      log(reason);
      return {
        custom: carried(0),
        failed: [
          ...failed,
          ...mounted.map((plugin) => ({
            name: plugin.name,
            digest: plugin.digest,
            reason,
          })),
        ],
      };
    }
    // Not the plugins after all. Nothing is put back: what comes next rebuilds the
    // whole tree from the commit, or throws and takes the directory with it.
  }
  if (files.length === 0) throw new Error(`build failed:\n${built.output}`);

  // The user's own code must never keep the service down: rebuild the stock tree
  // in place and say so. The customization stays untouched in data/custom.
  log("the customized build failed; rebuilding this version without it");
  await buildStock(store, name, run);
  notify(stockNotice("build against", built.output));
  return { custom: "stock", failed };
}

/** Rebuild a staged version from its commit alone: a broken customization is tried once. */
async function buildStock(
  store: Store,
  name: string,
  run: Runner,
): Promise<void> {
  const dir = store.reset(name);
  await store.materialize({ sha: parseVersionName(name)?.sha ?? "", dir });
  store.linkState(dir);
  await npmStep(dir, run, INSTALL, "dependency installation");
  await npmStep(dir, run, BUILD, "build");
}

function validMigrationState(
  value: unknown,
): value is { schema: "iva-migrations/v1"; applied: string[] } {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const state = value as Record<string, unknown>;
  const keys = Object.keys(state);
  return (
    keys.length === 2 &&
    keys.every((key) => key === "schema" || key === "applied") &&
    state.schema === "iva-migrations/v1" &&
    Array.isArray(state.applied) &&
    state.applied.every(
      (name, index, names) =>
        typeof name === "string" &&
        MIGRATION_FILE.test(`${name}.ts`) &&
        names.indexOf(name) === index,
    )
  );
}

/** Names already applied. Missing is valid; every existing invalid marker blocks. */
function appliedMigrations(dataDir: string): string[] {
  const marker = join(dataDir, MIGRATION_MARKER);
  let regularFile: boolean;
  try {
    regularFile = lstatSync(marker).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(
      `${MIGRATION_MARKER} is corrupt or unreadable: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!regularFile)
    throw new Error(
      `${MIGRATION_MARKER} is corrupt or unreadable: migration state marker is not a regular file`,
    );
  let bytes: Buffer;
  try {
    bytes = readFileSync(marker);
  } catch (error) {
    throw new Error(
      `${MIGRATION_MARKER} is corrupt or unreadable: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!isUtf8(bytes))
    throw new Error(
      `${MIGRATION_MARKER} is corrupt or unreadable: invalid UTF-8`,
    );
  let state: unknown;
  try {
    state = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(
      `${MIGRATION_MARKER} is corrupt or unreadable: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!validMigrationState(state))
    throw new Error(
      `${MIGRATION_MARKER} is corrupt or unreadable: invalid migration state schema`,
    );
  return state.applied;
}

/** Unapplied migrations this version ships. Each is idempotent; the marker only saves work. */
export async function runMigrations({
  dir,
  dataDir,
  context,
  log,
}: {
  readonly dir: string;
  readonly dataDir: string;
  readonly context: MigrationContext;
  readonly log?: Say;
}): Promise<string[]> {
  let files: string[];
  try {
    files = readdirSync(dir).filter((name) => MIGRATION_FILE.test(name));
  } catch {
    return [];
  }
  if (files.length === 0) return [];
  const applied = appliedMigrations(dataDir);
  const done: string[] = [];
  const marker = join(dataDir, MIGRATION_MARKER);
  for (const name of files.sort().map((file) => file.slice(0, -3))) {
    if (applied.includes(name)) continue;
    log?.(`migration ${name}`);
    try {
      const module = (await import(
        pathToFileURL(join(dir, `${name}.ts`)).href
      )) as { default: Migration };
      await module.default(context);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`migration ${name} failed: ${detail}`, { cause: error });
    }
    done.push(name);
    writeJson(marker, {
      schema: "iva-migrations/v1",
      applied: [...applied, ...done],
    });
  }
  return done;
}

/** npm as a `Runner`: silent unless it fails, when its output is the report. */
export function commandRunner(verbose: boolean): Runner {
  return (command, args, cwd) =>
    new Promise<CommandResult>((resolve) => {
      const io = verbose ? "inherit" : "pipe";
      const child = spawn(command, [...args], {
        cwd,
        env: {
          ...process.env,
          ASSISTANT_DATA_DIR: resolveDataDir(cwd),
          PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
        },
        stdio: ["ignore", io, io],
      });
      let output = "";
      const collect = (chunk: unknown): void => {
        output = `${output}${String(chunk)}`.slice(-OUTPUT_TAIL);
      };
      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);
      child.on("error", (error) => resolve({ code: 1, output: error.message }));
      child.on("close", (code) => resolve({ code: code ?? 1, output }));
    });
}
