/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// `iva plugin` against a temp installation home and a local bare repository standing
// in for the remote. Nothing here is mocked out of the interesting path: the command
// runs real git, writes the real store and the real plugins.json, and the assertions
// read those files back.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { readLiveSkills } from "#lib/custom-skills.ts";
import { PLUGIN_SCHEMA_URL } from "#lib/plugin-reader.ts";
import {
  pluginDataDir,
  pluginRoot,
  pluginsStateFile,
  readPluginsState,
} from "#lib/plugin-store.ts";
import { createPluginCommands } from "./plugin.ts";
import { createCliRuntime } from "./runtime.ts";

type Runtime = ReturnType<typeof createCliRuntime>;
type Events = Array<[string, string]>;

const NO_COLOR = { g: "", y: "", r: "", c: "", b: "", d: "", x: "" };

// Изоляция от git-конфига машины: тесты не должны зависеть от чужих хуков,
// шаблонов и подписей.
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "iva-test",
  GIT_AUTHOR_EMAIL: "iva@test.local",
  GIT_COMMITTER_NAME: "iva-test",
  GIT_COMMITTER_EMAIL: "iva@test.local",
};

const worlds: string[] = [];

after(() => {
  for (const dir of worlds) rmSync(dir, { recursive: true, force: true });
});

function world(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `iva-cli-plugin-${prefix}-`));
  worlds.push(dir);
  return dir;
}

function git(args: readonly string[], cwd: string): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: GIT_ENV,
  });
  if (result.status !== 0)
    throw new Error(`git ${args.join(" ")}: ${result.stderr || result.stdout}`);
  return (result.stdout || "").trim();
}

function write(root: string, path: string, contents: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function manifest(name: string, version = "1.0.0"): string {
  return JSON.stringify({ $schema: PLUGIN_SCHEMA_URL, name, version }, null, 2);
}

function skill(name: string, description = `Do the ${name} work.`): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n`;
}

/** Плагин с одним скиллом на диске. */
function plantPlugin(
  dir: string,
  name: string,
  skillName = "alpha",
  version = "1.0.0",
): void {
  write(dir, "plugin.json", manifest(name, version));
  write(dir, `skills/${skillName}/SKILL.md`, skill(skillName));
}

type Remote = { readonly url: string; readonly work: string; sha: string };

/** Локальный bare-репозиторий в роли удалённого источника. */
function remote(name: string, skillName = "alpha"): Remote {
  const base = world("remote");
  const bare = join(base, "remote.git");
  // `--initial-branch`: HEAD раскрытого репозитория должен указывать на ту ветку,
  // в которую пушим, иначе `ls-remote origin HEAD` не находит ничего.
  git(["init", "-q", "--bare", "--initial-branch=main", bare], base);
  const work = join(base, "work");
  mkdirSync(work, { recursive: true });
  git(["init", "-q", "--initial-branch=main"], work);
  plantPlugin(work, name, skillName);
  git(["add", "-A"], work);
  git(["commit", "-qm", "plugin"], work);
  git(["push", "-q", `file://${bare}`, "HEAD:refs/heads/main"], work);
  return { url: `file://${bare}`, work, sha: git(["rev-parse", "HEAD"], work) };
}

/** Ещё один коммит в удалённом: даёт `update` куда двигаться. */
function commit(source: Remote, version: string): string {
  write(source.work, "plugin.json", manifest("demo", version));
  git(["add", "-A"], source.work);
  git(["commit", "-qm", version], source.work);
  git(["push", "-q", `${source.url}`, "HEAD:refs/heads/main"], source.work);
  source.sha = git(["rev-parse", "HEAD"], source.work);
  return source.sha;
}

function home(): string {
  const root = world("home");
  mkdirSync(join(root, "data"), { recursive: true });
  return root;
}

function commands(root: string) {
  const events: Events = [];
  const printed: string[] = [];
  const base = createCliRuntime(root);
  const runtime: Runtime = {
    ...base,
    C: NO_COLOR,
    ok: (message) => events.push(["ok", message]),
    warn: (message) => events.push(["warn", message]),
    bad: (message) => events.push(["bad", message]),
    step: (message) => events.push(["step", message]),
    readEnv: () => ({}),
    cap: (command, args, options = {}) => {
      const result = spawnSync(command, [...args], {
        cwd: typeof options.cwd === "string" ? options.cwd : root,
        encoding: "utf8",
        env: GIT_ENV,
      });
      return {
        code: result.status ?? 1,
        out: (result.stdout || "").trim(),
        err: (result.stderr || "").trim(),
      };
    },
  };
  const { cmdPlugin } = createPluginCommands(runtime, {
    now: () => new Date("2026-08-17T12:00:00.000Z"),
    log: (...args: unknown[]) => printed.push(args.map(String).join(" ")),
    translate: (en) => en,
    cwd: () => root,
  });
  return { cmdPlugin, events, printed, data: join(root, "data") };
}

function messages(events: Events, kind?: string): string {
  return events
    .filter(([type]) => !kind || type === kind)
    .map(([, message]) => message)
    .join("\n");
}

test("add installs a git source, pins the sha and creates the plugin data directory", async (t) => {
  const source = remote("demo");
  const root = home();
  const { cmdPlugin, events, data } = commands(root);

  await cmdPlugin(["add", source.url]);

  assert.ok(existsSync(join(pluginRoot(data, "demo"), "plugin.json")));
  assert.ok(
    existsSync(join(pluginRoot(data, "demo"), "skills/alpha/SKILL.md")),
  );
  assert.ok(existsSync(pluginDataDir(data, "demo")), "PLUGIN_DATA is created");
  // Стор git-источника — это checkout: `update` спрашивает у него git status.
  assert.ok(existsSync(join(pluginRoot(data, "demo"), ".git")));

  const state = await readPluginsState(data);
  assert.deepEqual(state.plugins, [
    {
      name: "demo",
      source: source.url,
      ref: "HEAD",
      sha: source.sha,
      enabled: true,
      trusted: false,
      installedAt: "2026-08-17T12:00:00.000Z",
    },
  ]);
  assert.equal(state.riskNoticeShownAt, "2026-08-17T12:00:00.000Z");
  assert.match(
    messages(events, "ok"),
    /demo 1\.0\.0 installed — skills: alpha/u,
  );
  assert.match(messages(events, "ok"), /skills work from the next turn/u);
  t.diagnostic(messages(events));
});

test("the accepted risk is printed once, before the first install", async () => {
  const first = remote("demo");
  const second = remote("other", "beta");
  const root = home();
  const { cmdPlugin, events } = commands(root);

  await cmdPlugin(["add", first.url]);
  const afterFirst = messages(events, "warn");
  assert.match(afterFirst, /bash inside its skill sees every key/u);

  events.length = 0;
  await cmdPlugin(["add", second.url]);
  assert.doesNotMatch(
    messages(events),
    /bash inside its skill sees every key/u,
  );
});

test("add copies a local folder without following symlinks out of it", async () => {
  const root = home();
  const outside = world("outside");
  write(outside, "secret.txt", "not yours\n");

  const folder = join(world("local"), "my-plugin");
  plantPlugin(folder, "local-demo");
  write(folder, ".git/HEAD", "ref: refs/heads/main\n");
  const { cmdPlugin, events, data } = commands(root);

  await cmdPlugin(["add", folder]);
  assert.ok(existsSync(join(pluginRoot(data, "local-demo"), "plugin.json")));
  // `.git` — служебные объекты git, не содержимое плагина.
  assert.equal(existsSync(join(pluginRoot(data, "local-demo"), ".git")), false);
  const state = await readPluginsState(data);
  assert.equal(state.plugins[0].source, folder);
  assert.equal(state.plugins[0].sha, "");

  const hostile = join(world("hostile"), "evil-plugin");
  plantPlugin(hostile, "evil");
  symlinkSync(join(outside, "secret.txt"), join(hostile, "leak.txt"));
  events.length = 0;
  await assert.rejects(cmdPlugin(["add", hostile]), /symlink/u);
  assert.equal(existsSync(pluginRoot(data, "evil")), false);
});

test("a plugin that fails validation leaves the store and the state untouched", async () => {
  const root = home();
  const folder = join(world("broken"), "broken-plugin");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "plugin.json"), '{"name":"broken"}');
  const { cmdPlugin, events, data } = commands(root);

  await assert.rejects(
    cmdPlugin(["add", folder]),
    /is not a usable Agent Plugins folder/u,
  );
  assert.match(messages(events, "bad"), /\$schema must be/u);
  assert.equal(existsSync(pluginsStateFile(data)), false);
  assert.deepEqual((await readPluginsState(data)).plugins, []);
});

test("two plugins claiming one skill name: the second add is refused", async () => {
  const first = remote("demo", "viewer");
  const second = remote("other", "viewer");
  const root = home();
  const { cmdPlugin, data } = commands(root);

  await cmdPlugin(["add", first.url]);
  await assert.rejects(
    cmdPlugin(["add", second.url]),
    /skill "viewer" is already provided by the plugin demo/u,
  );
  assert.equal(existsSync(pluginRoot(data, "other")), false);
  assert.deepEqual(
    (await readPluginsState(data)).plugins.map((entry) => entry.name),
    ["demo"],
  );
});

test("installing the same plugin twice points at update instead", async () => {
  const source = remote("demo");
  const root = home();
  const { cmdPlugin } = commands(root);

  await cmdPlugin(["add", source.url]);
  await assert.rejects(
    cmdPlugin(["add", source.url]),
    /demo is already installed — use: iva plugin update demo/u,
  );
});

test("list shows components and calls out a plugin missing from the store", async () => {
  const source = remote("demo");
  const root = home();
  const { cmdPlugin, events, printed, data } = commands(root);

  await cmdPlugin(["add", source.url]);
  await cmdPlugin(["list"]);
  assert.match(
    printed.join("\n"),
    new RegExp(
      `demo  1\\.0\\.0  ${source.sha.slice(0, 12)}  enabled · untrusted  skills: alpha`,
      "u",
    ),
  );

  rmSync(pluginRoot(data, "demo"), { recursive: true, force: true });
  events.length = 0;
  printed.length = 0;
  await cmdPlugin(["list"]);
  assert.match(
    messages(events, "bad"),
    /missing from the store — run: iva plugin sync/u,
  );
});

test("disable and enable flip one toggle and nothing else", async () => {
  const source = remote("demo");
  const root = home();
  const { cmdPlugin, events, data } = commands(root);

  await cmdPlugin(["add", source.url]);
  await cmdPlugin(["disable", "demo"]);
  assert.equal((await readPluginsState(data)).plugins[0].enabled, false);
  assert.ok(existsSync(pluginRoot(data, "demo")), "disable keeps the folder");

  await cmdPlugin(["enable", "demo"]);
  assert.equal((await readPluginsState(data)).plugins[0].enabled, true);

  events.length = 0;
  await cmdPlugin(["enable", "demo"]);
  assert.match(messages(events, "ok"), /already enabled/u);
  await assert.rejects(cmdPlugin(["disable", "absent"]), /is not installed/u);
});

test("remove takes the folder and the entry, and keeps the plugin data", async () => {
  const source = remote("demo");
  const root = home();
  const { cmdPlugin, data } = commands(root);

  await cmdPlugin(["add", source.url]);
  writeFileSync(join(pluginDataDir(data, "demo"), "state.json"), "{}");

  await cmdPlugin(["remove", "demo"]);
  assert.equal(existsSync(pluginRoot(data, "demo")), false);
  assert.deepEqual((await readPluginsState(data)).plugins, []);
  assert.ok(
    existsSync(join(pluginDataDir(data, "demo"), "state.json")),
    "plugin data survives removal",
  );
});

test("update moves the pinned sha and prints old → new", async () => {
  const source = remote("demo");
  const root = home();
  const { cmdPlugin, events, data } = commands(root);

  await cmdPlugin(["add", source.url]);
  const before = source.sha;

  events.length = 0;
  await cmdPlugin(["update"]);
  assert.match(messages(events, "ok"), /demo is already at/u);

  const after = commit(source, "1.1.0");
  events.length = 0;
  await cmdPlugin(["update", "demo"]);
  assert.match(
    messages(events, "ok"),
    new RegExp(`demo: ${before.slice(0, 12)} → ${after.slice(0, 12)}`, "u"),
  );
  const state = await readPluginsState(data);
  assert.equal(state.plugins[0].sha, after);
  assert.match(
    readFileSync(join(pluginRoot(data, "demo"), "plugin.json"), "utf8"),
    /1\.1\.0/u,
  );
});

test("update refuses to touch a store copy with local changes", async () => {
  const source = remote("demo");
  const root = home();
  const { cmdPlugin, events, data } = commands(root);

  await cmdPlugin(["add", source.url]);
  const pinned = source.sha;
  writeFileSync(join(pluginRoot(data, "demo"), "notes.md"), "mine\n");
  commit(source, "1.1.0");

  events.length = 0;
  await cmdPlugin(["update", "demo"]);
  assert.match(messages(events, "warn"), /has local changes/u);
  assert.equal((await readPluginsState(data)).plugins[0].sha, pinned);
  assert.ok(existsSync(join(pluginRoot(data, "demo"), "notes.md")));
});

test("sync restores a plugin whose folder is gone, at the sha that was pinned", async () => {
  const source = remote("demo");
  const root = home();
  const { cmdPlugin, events, data } = commands(root);

  await cmdPlugin(["add", source.url]);
  const pinned = source.sha;
  await cmdPlugin(["disable", "demo"]);
  commit(source, "1.1.0");
  rmSync(pluginRoot(data, "demo"), { recursive: true, force: true });

  events.length = 0;
  await cmdPlugin(["sync"]);
  assert.match(messages(events, "ok"), /demo restored — skills: alpha/u);
  assert.ok(existsSync(join(pluginRoot(data, "demo"), "plugin.json")));
  const state = await readPluginsState(data);
  assert.equal(
    state.plugins[0].sha,
    pinned,
    "sync restores, it does not update",
  );
  assert.equal(state.plugins[0].enabled, false, "sync keeps the toggles");
  assert.equal(state.plugins[0].source, source.url);

  events.length = 0;
  await cmdPlugin(["sync"]);
  assert.match(
    messages(events, "ok"),
    /every plugin in plugins.json is in the store/u,
  );
});

test("an unknown subcommand names the ones that exist", async () => {
  const { cmdPlugin, printed } = commands(home());

  await assert.rejects(
    cmdPlugin(["frobnicate"]),
    /unknown: iva plugin frobnicate/u,
  );
  await cmdPlugin([]);
  assert.match(printed.join("\n"), /iva plugin add/u);
});

/** Читает скиллы так, как их прочитает следующий ход агента. */
async function nextTurnSkills(data: string): Promise<string[]> {
  const previous = process.env.ASSISTANT_DATA_DIR;
  process.env.ASSISTANT_DATA_DIR = data;
  try {
    return Object.keys(await readLiveSkills(() => undefined)).sort();
  } finally {
    if (previous === undefined) delete process.env.ASSISTANT_DATA_DIR;
    else process.env.ASSISTANT_DATA_DIR = previous;
  }
}

test("what add installs is what the next turn sees, with no build and no restart", async () => {
  const source = remote("demo", "viewer");
  const root = home();
  const { cmdPlugin, data } = commands(root);

  assert.deepEqual(await nextTurnSkills(data), []);

  await cmdPlugin(["add", source.url]);
  assert.deepEqual(await nextTurnSkills(data), ["viewer"]);

  await cmdPlugin(["disable", "demo"]);
  assert.deepEqual(await nextTurnSkills(data), []);

  await cmdPlugin(["enable", "demo"]);
  assert.deepEqual(await nextTurnSkills(data), ["viewer"]);

  await cmdPlugin(["remove", "demo"]);
  assert.deepEqual(await nextTurnSkills(data), []);
});
