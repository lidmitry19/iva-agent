import { execFileSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { CATALOG, catalogProvider } from "./lib/model-catalog.ts";
import { notificationChat } from "./lib/notification-chat.ts";
import {
  alertOnce,
  noticeTranslator,
  PLUGIN_ALERT_KEY,
  pluginsSwitchedOffAlert,
} from "./lib/notice-policy.ts";
import {
  isEntrypoint,
  refreshOwnedShim,
  SHIM_PATH,
  throughLink,
} from "./lib/version-layout.ts";
import { conversationStateTargets, quarantinePath } from "./lib/wf-store.ts";
import {
  adoptUpdateLock,
  layoutFor,
  LEGACY_STATE_DIRS,
  readJson,
  STATE_DIRS,
} from "./lib/version-store.ts";
import {
  LEGACY_BRAIN_UNITS,
  LEGACY_MEMORY_UNITS,
} from "./lib/legacy-memory-units.ts";
import {
  commandRunner,
  finishVersionUpdate,
  pluginsOffNotice,
  type UpdateOutcome,
} from "./lib/version-update.ts";
import type { PluginFailure } from "./lib/plugin-build.ts";
import { tryLoadPluginCore } from "./lib/plugin-core.ts";
import { pluginUnitNames, runningPluginUnits } from "./lib/plugin-units.ts";
import type { createCliRuntime } from "./cli/runtime.ts";

type Say = (message: string) => void;
type CliRuntime = ReturnType<typeof createCliRuntime>;
type WriterRuntime = Pick<
  CliRuntime,
  "BRAIN_TIMER" | "BRAIN_SERVICE" | "SERVICES" | "SVC_USERBOT" | "systemd"
>;

export type UpdateQuarantine = {
  readonly path: string;
  readonly trash: string;
};

/** Retire open-conversation state as one reversible update step. */
export function quarantineUpdateState(
  root: string,
  dataDir: string,
  stamp = new Date().toISOString().replace(/[:.]/gu, "-"),
): UpdateQuarantine[] {
  const quarantined: UpdateQuarantine[] = [];
  try {
    for (const target of conversationStateTargets(root, dataDir)) {
      const path = throughLink(target);
      const trash = quarantinePath(target, stamp);
      if (trash) quarantined.push({ path, trash });
    }
    return quarantined;
  } catch (error) {
    try {
      restoreUpdateState(quarantined);
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        "update state quarantine and restoration both failed",
        { cause: restoreError },
      );
    }
    throw error;
  }
}

/** Put quarantined state back before the previous version starts. */
export function restoreUpdateState(
  quarantined: readonly UpdateQuarantine[],
): void {
  for (const entry of [...quarantined].reverse()) {
    rmSync(entry.path, { recursive: true, force: true });
    renameSync(entry.trash, entry.path);
  }
}

export type OptionalWriterState = {
  readonly unit: string;
  readonly loadState: string;
  readonly active: boolean;
  readonly enabled: boolean;
};

function unitLoadState(runtime: WriterRuntime, unit: string): string {
  const result = runtime.systemd.query(
    "show",
    unit,
    "--property=LoadState",
    "--value",
  );
  if (
    result.code === 0 &&
    ["loaded", "not-found", "error", "masked", "stub", "merged"].includes(
      result.out,
    )
  )
    return result.out;
  throw new Error(`could not read load state for ${unit}: ${result.out}`);
}

function present(loadState: string): boolean {
  return loadState !== "not-found";
}

function unitActive(runtime: WriterRuntime, unit: string): boolean {
  const result = runtime.systemd.query("is-active", unit);
  if (
    ["active", "activating", "deactivating", "reloading"].includes(result.out)
  )
    return true;
  if (["inactive", "failed", "unknown"].includes(result.out)) return false;
  throw new Error(`could not read active state for ${unit}: ${result.out}`);
}

function unitEnabled(runtime: WriterRuntime, unit: string): boolean {
  const result = runtime.systemd.query("is-enabled", unit);
  if (result.out === "enabled") return true;
  if (
    [
      "disabled",
      "static",
      "masked",
      "indirect",
      "generated",
      "transient",
      "not-found",
    ].includes(result.out)
  )
    return false;
  throw new Error(`could not read enabled state for ${unit}: ${result.out}`);
}

/** Snapshot optional writers before any stop can change their runtime state. */
export function captureOptionalWriterState(
  runtime: WriterRuntime,
): OptionalWriterState[] {
  return [
    ...new Set([
      runtime.BRAIN_TIMER,
      runtime.BRAIN_SERVICE,
      runtime.SVC_USERBOT,
      ...LEGACY_BRAIN_UNITS,
      ...LEGACY_MEMORY_UNITS,
    ]),
  ].map((unit) => {
    const loadState = unitLoadState(runtime, unit);
    return {
      unit,
      loadState,
      active: present(loadState) && unitActive(runtime, unit),
      enabled: present(loadState) && unitEnabled(runtime, unit),
    };
  });
}

/** Stop every present writer. Missing optional units remain a valid legacy state. */
export function stopWriterUnits(
  runtime: WriterRuntime,
  optional = captureOptionalWriterState(runtime),
): void {
  const optionalTimers = optional
    .filter(
      (state) => present(state.loadState) && state.unit.endsWith(".timer"),
    )
    .map((state) => state.unit);
  const optionalServices = optional
    .filter(
      (state) => present(state.loadState) && state.unit.endsWith(".service"),
    )
    .map((state) => state.unit);
  for (const writers of [optionalTimers, optionalServices, runtime.SERVICES]) {
    if (writers.length === 0) continue;
    runtime.systemd.stop(writers);
    for (const unit of writers) {
      if (unitActive(runtime, unit))
        throw new Error(`writer ${unit} remained active after stop`);
    }
  }
}

function checkedUnitAction(
  runtime: WriterRuntime,
  action: "enable" | "start",
  unit: string,
): void {
  const result = runtime.systemd.query(action, unit);
  if (result.code !== 0)
    throw new Error(`systemctl --user ${action} ${unit} failed: ${result.out}`);
}

/** Restore exact optional active/enabled flags without starting a disabled unit. */
export function restoreOptionalWriterState(
  runtime: WriterRuntime,
  states: readonly OptionalWriterState[],
): void {
  for (const state of states) {
    if (!present(state.loadState)) continue;
    if (!present(unitLoadState(runtime, state.unit)))
      throw new Error(`captured writer ${state.unit} disappeared`);
    if (state.enabled !== unitEnabled(runtime, state.unit)) {
      if (state.enabled) checkedUnitAction(runtime, "enable", state.unit);
      else runtime.systemd.disableNow([state.unit]);
    }
    if (state.active !== unitActive(runtime, state.unit)) {
      if (state.active) checkedUnitAction(runtime, "start", state.unit);
      else runtime.systemd.stop([state.unit]);
    }
    if (
      state.enabled !== unitEnabled(runtime, state.unit) ||
      state.active !== unitActive(runtime, state.unit)
    )
      throw new Error(`could not restore ${state.unit} state`);
  }
}

function mergedState(
  states: readonly OptionalWriterState[],
  units: ReadonlySet<string>,
): Pick<OptionalWriterState, "active" | "enabled"> {
  return states
    .filter((state) => present(state.loadState) && units.has(state.unit))
    .reduce<{ active: boolean; enabled: boolean }>(
      (merged, state) => ({
        active: merged.active || state.active,
        enabled: merged.enabled || state.enabled,
      }),
      { active: false, enabled: false },
    );
}

function restoreUnitState(
  runtime: WriterRuntime,
  state: OptionalWriterState,
): void {
  restoreOptionalWriterState(runtime, [state]);
}

/** Restore captured writer semantics after writeUnits retires legacy names. */
export function restoreMigratedWriterState(
  runtime: WriterRuntime,
  states: readonly OptionalWriterState[],
  { legacyMemoryOwnerProven = false } = {},
): void {
  restoreOptionalWriterState(
    runtime,
    states.filter((state) => state.unit === runtime.SVC_USERBOT),
  );
  const brainTimers = new Set([
    runtime.BRAIN_TIMER,
    ...LEGACY_BRAIN_UNITS.filter((unit) => unit.endsWith(".timer")),
  ]);
  const brainServices = new Set([
    runtime.BRAIN_SERVICE,
    ...LEGACY_BRAIN_UNITS.filter((unit) => unit.endsWith(".service")),
  ]);
  restoreUnitState(runtime, {
    unit: runtime.BRAIN_TIMER,
    loadState: "loaded",
    ...mergedState(states, brainTimers),
  });
  restoreUnitState(runtime, {
    unit: runtime.BRAIN_SERVICE,
    loadState: "loaded",
    ...mergedState(states, brainServices),
  });

  const legacyMemory = states.filter(
    (state) =>
      LEGACY_MEMORY_UNITS.includes(state.unit) && present(state.loadState),
  );
  const remaining = new Map(
    legacyMemory.map((state) => [
      state.unit,
      present(unitLoadState(runtime, state.unit)),
    ]),
  );
  restoreOptionalWriterState(
    runtime,
    legacyMemory.filter((state) => remaining.get(state.unit)),
  );
  const hadLegacyMemorySchedule = legacyMemory.some(
    (state) => state.active || state.enabled,
  );
  const completeLegacySchedule = legacyMemory.every((state) => {
    if (!state.active && !state.enabled) return true;
    if (!remaining.get(state.unit)) return false;
    if (!state.unit.endsWith(".timer")) return true;
    return remaining.get(state.unit.replace(/\.timer$/u, ".service")) === true;
  });
  const owner = runtime.SERVICES[0];
  if (hadLegacyMemorySchedule && !completeLegacySchedule) {
    if (!legacyMemoryOwnerProven)
      throw new Error(
        "legacy memory schedule owner was not proven by writeUnits",
      );
    if (!owner || !unitActive(runtime, owner))
      throw new Error("legacy memory schedule has no active service owner");
  }
}

export function restoreWriterOwnership(
  runtime: WriterRuntime,
  states: readonly OptionalWriterState[],
  phase: {
    readonly unitMigrationStarted: boolean;
    readonly legacyMemoryOwnerProven: boolean;
  },
): void {
  if (!phase.unitMigrationStarted) {
    restoreOptionalWriterState(runtime, states);
    return;
  }
  restoreMigratedWriterState(runtime, states, {
    legacyMemoryOwnerProven: phase.legacyMemoryOwnerProven,
  });
}

/** Build leftovers of a checkout: not tracked, not state, never worth keeping. */
const ARTIFACTS =
  ".git .iva-build .iva-update .output .worktrees node_modules".split(" ");

/** First path segment, for both `agent/tools/x.ts` and a bare `install.sh`. */
function topLevel(path: string): string {
  return path.split("/", 1)[0] ?? "";
}

/** Never removed, whatever git says about them. */
const KEEP = new Set([
  ...[...STATE_DIRS, ...LEGACY_STATE_DIRS].map(topLevel),
  ...".env current repo versions".split(" "),
]);

function git(home: string, args: string[]): string {
  return execFileSync("git", ["-C", home, ...args], {
    encoding: "utf8",
    maxBuffer: 1 << 24,
  });
}

/** Install the shim that outlives every version; refresh only an owned stale snapshot. */
export function writeShim(home: string, log: Say): void {
  if (refreshOwnedShim(SHIM_PATH, home, process.execPath, layoutFor(home).data))
    log(`rewrote ${SHIM_PATH}`);
}

/**
 * Remove the working tree the installation ran from, now that a version runs
 * instead. Only files git accounts for, only where unedited, one at a time: what
 * git ignores inside a tracked directory - the userbot's venv, a skill's
 * credentials - is the user's, and a layout change is no right to it.
 */
export function retireCheckout(home: string): string[] {
  let tracked: string[];
  let dirty: Set<string>;
  try {
    // -z on both: without it git escapes and quotes every path outside ASCII,
    // and a quoted name matches no file, retiring the checkout only in part.
    tracked = git(home, ["ls-tree", "-r", "-z", "--name-only", "HEAD"])
      .split("\0")
      .filter(Boolean);
    dirty = new Set(
      git(home, ["status", "--porcelain=v1", "--untracked-files=all", "-z"])
        .split("\0")
        .filter(Boolean)
        .map((entry) => topLevel(entry.slice(3))),
    );
  } catch {
    // Without git there is no telling the user's files from ours: keep everything.
    return [];
  }
  if (!tracked.includes("package.json")) return [];

  const removed = new Set<string>();
  // Artifacts however edited: rebuilt, never authored, and .git is mirrored.
  for (const path of [...tracked, ...ARTIFACTS]) {
    const name = topLevel(path);
    if (KEEP.has(name) || (dirty.has(name) && !ARTIFACTS.includes(path)))
      continue;
    const full = join(home, path);
    if (!existsSync(full)) continue;
    rmSync(full, { recursive: true, force: true });
    removed.add(name);
    // Up to the first directory that still holds something, which is never ours:
    // git listed everything of ours in `tracked`.
    for (
      let at = dirname(full);
      at !== home && readdirSync(at).length === 0;
      at = dirname(at)
    )
      rmdirSync(at);
  }
  return [...removed].sort();
}

/**
 * Files the custom layer of the checkout era recorded as deleted. The overlay that
 * replaces it only adds, so a deletion comes undone and has to be reported.
 */
export function tombstoned(
  home: string,
  dataDir = layoutFor(home).data,
): string[] {
  const entries = (readJson(join(dataDir, "custom/manifest.json")).entries ??
    {}) as Record<string, { tombstone?: boolean } | undefined>;
  return Object.keys(entries)
    .filter((path) => entries[path]?.tombstone)
    .sort();
}

/**
 * One plain message to the owner's chat. A direct Bot API call, like the update offer
 * this Alert stands beside (scripts/check-update.ts): the marked-up sender lives in the
 * authored tree, and this process runs in a version directory that may not have a
 * `node_modules` yet - a dependency reached on any path through it is a crash with no
 * update (scripts/lib/version-update.test.ts pins that). The text is this file's own
 * copy with plugin names in it, so there is nothing here for the outbound Gate to redact.
 */
function sendToChat(
  token: string,
  chat: string,
): (text: string) => Promise<boolean> {
  return async (text) => {
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chat, text }),
        },
      );
      return response.ok;
    } catch (error) {
      console.error("[plugins] could not send the alert:", error);
      return false;
    }
  };
}

/**
 * A plugin was switched off because its code will not build with this version. The
 * update output carries the reason for whoever is watching it; this is the half that
 * reaches an owner who ordered the update from Telegram and never sees a terminal.
 *
 * An Alert, so it obeys ADR-0007: it says what broke, what it costs and what to do,
 * and it repeats at most once a week for the same set of plugins. The essence is what
 * each of them contained - a plugin the owner has changed since is a different problem
 * and speaks at once.
 */
export async function alertOwnerAboutPlugins(
  layout: ReturnType<typeof layoutFor>,
  failures: readonly PluginFailure[],
  notify: Say,
  /** The chat, or a stand-in for it in tests; absent means the installation's own. */
  send?: (text: string) => Promise<boolean>,
): Promise<void> {
  notify(pluginsOffNotice(failures));
  const token = String(layout.values.TELEGRAM_BOT_TOKEN ?? "").trim();
  const chat = notificationChat(layout.values);
  const deliver = send ?? (token && chat ? sendToChat(token, chat) : null);
  if (!deliver) return; // Nowhere to say it; the output above is all there is.
  const tr = await noticeTranslator(layout.values);
  const names = failures.map((failure) => failure.name);
  const text = pluginsSwitchedOffAlert(tr, names);
  const outcome = await alertOnce(
    layout.data,
    PLUGIN_ALERT_KEY,
    // The essence is which content failed: a plugin the owner has since changed is a
    // different problem and speaks at once instead of waiting out the week.
    failures.map((failure) => `${failure.name}@${failure.digest}`).join(" "),
    () => deliver(text),
  );
  if (outcome === "failed")
    notify(`could not tell you in Telegram about ${names.join(", ")}`);
}

/**
 * After the flip: an MCP proxy and a plugin service run code out of the version that
 * `current` points at, so the flip alone does not move them - a restart does.
 *
 * Only what is running is restarted, and a unit that refuses is one line in the log: an
 * update that is otherwise finished must not fail over a plugin, and `iva doctor` says
 * which unit is down.
 */
export async function restartPluginUnits(
  runtime: Pick<CliRuntime, "systemd" | "UNIT_DIR">,
  dataDir: string,
  log: Say,
): Promise<void> {
  const core = await tryLoadPluginCore();
  if (!core) return;
  const { state, damaged } = await core.store.readPluginsStateSafe(dataDir);
  if (damaged) return;
  const units: string[] = [];
  for (const entry of state.plugins) {
    if (!entry.enabled || !entry.trusted) continue;
    units.push(...pluginUnitNames(entry));
  }
  const live = runningPluginUnits({
    units,
    unitDir: runtime.UNIT_DIR,
    isActive: (unit) => runtime.systemd.isActive(unit),
  });
  if (live.length === 0) return;
  try {
    runtime.systemd.restart(live);
    log(`restarted ${live.length} plugin unit(s) onto the new version`);
  } catch (error) {
    log(
      `some plugin units did not restart: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * The second half of an update, run by the version being installed: install,
 * build, probe, flip, migrate, restart and retire the old checkout all belong to
 * the new code, so a fix to any of them ships in the release carrying it.
 */
export async function main(argv: readonly string[]): Promise<number> {
  const [home, name, ...flags] = argv;
  if (!home || !name) throw new Error("usage: update-finish <home> <version>");
  const verbose = flags.includes("--verbose");
  // `iva plugin add|update|enable`: the plugin is what this build is for, so a plugin
  // that will not build fails the build instead of being switched off (ADR-0009).
  const requirePlugins = flags.includes("--require-plugins");
  const layout = layoutFor(home);

  // The same MODEL_PROVIDER check the CLI does before it starts an update — repeated here
  // because on a managed installation the first half of every update is run by the version
  // already on disk. A check that only exists in the new version can therefore never run
  // while the value is broken: the old CLI fetches, this half builds, the probe fails, the
  // update rolls back, and the next attempt repeats it. Forever, not once.
  //
  // This function is the first code of the new version to execute on the machine, and it
  // runs before the build, so refusing here costs the user one fetch instead of a build and
  // a health cycle - and finally names the value. `iva update` on the release after this one
  // refuses before even that (scripts/cli/version-update-command.ts).
  const configured = layout.values.MODEL_PROVIDER ?? "ollama";
  if (!catalogProvider(configured)) {
    const outcome: UpdateOutcome = {
      status: "failed",
      message: `Invalid MODEL_PROVIDER ${JSON.stringify(configured)}; expected one of: ${Object.keys(CATALOG).join(", ")} — run: iva config`,
    };
    const report = process.env.IVA_UPDATE_OUTCOME;
    if (report) writeFileSync(report, JSON.stringify(outcome));
    else console.log(JSON.stringify(outcome));
    return 1;
  }

  const lock = adoptUpdateLock(layout.data);
  const log: Say = (message) => console.log(`  ${message}`);
  const notify: Say = (message) => console.log(`! ${message}`);
  let optionalWriterState: OptionalWriterState[] | undefined;
  let unitMigrationStarted = false;
  let quarantinedState: UpdateQuarantine[] = [];
  let outcome: UpdateOutcome;
  try {
    outcome = await finishVersionUpdate({
      home,
      name,
      run: commandRunner(verbose),
      log,
      notify,
      requirePlugins,
      alertPlugins: (failures) =>
        alertOwnerAboutPlugins(layout, failures, notify),
      quiesce: async () => {
        const { createCliRuntime } = await import("./cli/runtime.ts");
        // Before the first conversion there is no current symlink: the checkout
        // itself is the old writer root and must remain usable until activation.
        const runtime = createCliRuntime(
          existsSync(layout.current) ? layout.current : home,
        );
        optionalWriterState = captureOptionalWriterState(runtime);
        stopWriterUnits(runtime, optionalWriterState);
        quarantinedState = quarantineUpdateState(home, layout.data);
        await Promise.resolve();
      },
      resumeOldWriters: async (root) => {
        const { createCliRuntime } = await import("./cli/runtime.ts");
        const runtime = createCliRuntime(root);
        let stateReady = true;
        try {
          if (quarantinedState.length > 0) {
            stopWriterUnits(runtime, optionalWriterState);
            try {
              restoreUpdateState(quarantinedState);
              quarantinedState = [];
            } catch (error) {
              stateReady = false;
              throw error;
            }
          }
          // Recovery before activation must not rewrite or retire old unit files.
          runtime.systemd.restart(runtime.SERVICES);
        } finally {
          if (stateReady && optionalWriterState)
            restoreWriterOwnership(runtime, optionalWriterState, {
              unitMigrationStarted,
              legacyMemoryOwnerProven: false,
            });
        }
        await Promise.resolve();
      },
      startCandidate: async (root) => {
        const { createCliRuntime } = await import("./cli/runtime.ts");
        const { createCliSystemd } = await import("./cli/systemd.ts");
        const { reinstallUserbot } = await import("./cli/userbot.ts");
        // Units name `current`: they survive every later flip unrewritten.
        const runtime = createCliRuntime(root);
        const services = createCliSystemd(runtime);
        const capturedUserbot = optionalWriterState?.find(
          (state) => state.unit === runtime.SVC_USERBOT,
        );
        try {
          services.restartServices({
            afterUnitWrite: () => {
              unitMigrationStarted = true;
            },
            ...(capturedUserbot?.loadState === "not-found"
              ? { skipUnits: [runtime.SVC_USERBOT] }
              : {}),
            deferBrainMigration: true,
            deferMemoryMigration: true,
          });
          runtime.systemd.activate([runtime.UPDATE_TIMER]);
          // The code of every plugin proxy is in the version this flip just made
          // current; nothing else brings them onto it.
          await restartPluginUnits(runtime, layout.data, log);
          if (capturedUserbot?.active === true)
            reinstallUserbot(runtime, services, notify, {
              knownActive: true,
            });
        } finally {
          if (optionalWriterState) {
            restoreWriterOwnership(runtime, optionalWriterState, {
              unitMigrationStarted,
              legacyMemoryOwnerProven: false,
            });
            if (unitMigrationStarted) services.retireDeferredBrainUnits();
          }
        }
        await Promise.resolve();
      },
      retireCommittedWriters: async (root) => {
        const { createCliRuntime } = await import("./cli/runtime.ts");
        const { createCliSystemd } = await import("./cli/systemd.ts");
        const runtime = createCliRuntime(root);
        const services = createCliSystemd(runtime);
        services.retireLegacyMemoryUnits();
        await Promise.resolve();
      },
      adopt: () => {
        writeShim(home, log);
        if (!existsSync(join(home, ".git"))) return;
        const back = tombstoned(home, layout.data);
        if (back.length > 0)
          notify(
            `a version cannot have a file of Iva's own deleted from it, so ${back.length} you had removed are back: ${back.join(", ")}`,
          );
        for (const removed of retireCheckout(home)) log(`retired ${removed}`);
      },
    });
  } catch (error) {
    // The caller is another process: a stack trace explains nothing there, and
    // the update stays where the next run can pick it up.
    outcome = {
      status: "failed",
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    lock.release();
  }
  const report = process.env.IVA_UPDATE_OUTCOME;
  if (report) writeFileSync(report, JSON.stringify(outcome));
  else console.log(JSON.stringify(outcome));
  return outcome.status === "updated" ? 0 : 1;
}

if (isEntrypoint(import.meta.url))
  process.exitCode = await main(process.argv.slice(2));
