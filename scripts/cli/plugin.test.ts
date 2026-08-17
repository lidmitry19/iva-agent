/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// `iva plugin` against a temp installation home and a local bare repository standing
// in for the remote. Nothing here is mocked out of the interesting path: the command
// runs real git, writes the real store and the real plugins.json, and the assertions
// read those files back.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
  writePluginsState,
} from "#lib/plugin-store.ts";
import { createPluginCommands, leftoverPluginDirs } from "./plugin.ts";
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

type CapHook = (
  command: string,
  args: readonly string[],
  result: { code: number; out: string; err: string },
) => { code: number; out: string; err: string };

function commands(
  root: string,
  hook?: CapHook,
  onLog?: (line: string) => void,
) {
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
      const captured = {
        code: result.status ?? 1,
        out: (result.stdout || "").trim(),
        err: (result.stderr || "").trim(),
      };
      return hook ? hook(command, args, captured) : captured;
    },
  };
  const { cmdPlugin } = createPluginCommands(runtime, {
    now: () => new Date("2026-08-17T12:00:00.000Z"),
    log: (...args: unknown[]) => {
      const line = args.map(String).join(" ");
      printed.push(line);
      onLog?.(line);
    },
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

test("add installs a git source, pins the sha and creates the plugin data directory", async () => {
  const source = remote("demo");
  const root = home();
  const { cmdPlugin, events, printed, data } = commands(root);

  await cmdPlugin(["add", source.url]);

  assert.ok(existsSync(join(pluginRoot(data, "demo"), "plugin.json")));
  assert.ok(
    existsSync(join(pluginRoot(data, "demo"), "skills/alpha/SKILL.md")),
  );
  assert.ok(existsSync(pluginDataDir(data, "demo")), "PLUGIN_DATA is created");
  // Папка git-источника — это checkout на запиненном sha.
  assert.ok(existsSync(join(pluginRoot(data, "demo"), ".git")));

  const state = await readPluginsState(data);
  assert.equal(state.plugins.length, 1);
  const [entry] = state.plugins;
  assert.deepEqual(
    { ...entry, digest: "" },
    {
      name: "demo",
      source: source.url,
      ref: "HEAD",
      sha: source.sha,
      digest: "",
      enabled: true,
      trusted: false,
      installedAt: "2026-08-17T12:00:00.000Z",
    },
  );
  // Отпечаток папки — то, чем `update` узнаёт правку руками (любой вид источника).
  assert.match(entry.digest, /^[a-f0-9]{64}$/u);
  assert.equal(state.riskNoticeShownAt, "2026-08-17T12:00:00.000Z");
  assert.match(messages(events, "ok"), /demo installed/u);
  assert.match(messages(events, "ok"), /skills work from the next turn/u);
  // Состав виден ДО того, как что-то встало на место (user story 6): строка
  // компонент печатается из install, а «installed» — только после переезда.
  assert.match(printed.join("\n"), /demo 1\.0\.0 — skills: alpha/u);
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

  // Относительный путь записывается абсолютным: `sync` запускают из другого
  // каталога, и `./…` там указывало бы в другое место.
  const relativeHome = home();
  const nested = join(relativeHome, "workspace", "second-plugin");
  plantPlugin(nested, "second-demo", "beta");
  const second = commands(relativeHome);
  await second.cmdPlugin(["add", "./workspace/second-plugin"]);
  assert.equal((await readPluginsState(second.data)).plugins[0].source, nested);

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
  printed.length = 0;
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
  assert.match(messages(events, "bad"), /missing — run: iva plugin sync/u);
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

// Источник-подпапка здесь не проверяется намеренно: подпапку выражает только форма
// `owner/repo/sub`, а она резолвится в github.com — до локального bare-репозитория
// такому источнику не дойти. Подпапка целиком закрыта в scripts/lib/plugin-install.test.ts
// («a subdirectory source checks out only that subdirectory»), а правило грязного
// дерева от вида источника не зависит: отпечаток снимается с папки, а не с git.
test("update refuses an edited git checkout until --force", async () => {
  const source = remote("demo");
  const root = home();
  const { cmdPlugin, events, data } = commands(root);

  await cmdPlugin(["add", source.url]);
  const pinned = source.sha;
  writeFileSync(join(pluginRoot(data, "demo"), "notes.md"), "mine\n");
  const moved = commit(source, "1.1.0");

  events.length = 0;
  await cmdPlugin(["update", "demo"]);
  assert.match(messages(events, "warn"), /the folder was edited in place/u);
  assert.equal((await readPluginsState(data)).plugins[0].sha, pinned);
  assert.ok(existsSync(join(pluginRoot(data, "demo"), "notes.md")));

  events.length = 0;
  await cmdPlugin(["update", "demo", "--force"]);
  assert.match(messages(events, "ok"), new RegExp(moved.slice(0, 12), "u"));
  assert.equal((await readPluginsState(data)).plugins[0].sha, moved);
  assert.equal(existsSync(join(pluginRoot(data, "demo"), "notes.md")), false);
});

test("a local plugin is protected by the same digest, with no git anywhere", async () => {
  const root = home();
  const folder = join(world("local"), "my-plugin");
  plantPlugin(folder, "local-demo");
  const { cmdPlugin, events, data } = commands(root);

  await cmdPlugin(["add", folder]);
  writeFileSync(join(pluginRoot(data, "local-demo"), "notes.md"), "mine\n");

  events.length = 0;
  await cmdPlugin(["update", "local-demo"]);
  assert.match(messages(events, "warn"), /the folder was edited in place/u);
  assert.ok(existsSync(join(pluginRoot(data, "local-demo"), "notes.md")));

  events.length = 0;
  await cmdPlugin(["update", "local-demo", "--force"]);
  assert.match(messages(events, "ok"), /local-demo reinstalled/u);
  assert.equal(
    existsSync(join(pluginRoot(data, "local-demo"), "notes.md")),
    false,
  );
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
  assert.match(messages(events, "ok"), /demo restored/u);
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
    /plugins\.json and data\/custom\/plugins\/ agree/u,
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

test("a plugin with code and MCP is installed, reported, and started by nobody yet", async () => {
  const root = home();
  const folder = join(world("code"), "with-code");
  plantPlugin(folder, "carrier");
  mkdirSync(join(folder, "sh.iva"), { recursive: true });
  writeFileSync(join(folder, "sh.iva", "index.ts"), "export {};\n");
  writeFileSync(
    join(folder, "mcp.json"),
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: { db: { type: "stdio", command: "node" } },
    }),
  );
  const { cmdPlugin, events, printed, data } = commands(root);

  await cmdPlugin(["add", folder]);

  assert.match(
    printed.join("\n"),
    /carrier 1\.0\.0 — skills: alpha; code: sh\.iva; mcp: db/u,
  );
  assert.match(
    messages(events, "warn"),
    /code and MCP servers are read and reported, but not built or started yet/u,
  );
  assert.ok(existsSync(join(pluginRoot(data, "carrier"), "sh.iva/index.ts")));

  events.length = 0;
  printed.length = 0;
  await cmdPlugin(["list"]);
  assert.match(printed.join("\n"), /code: sh\.iva; mcp: db/u);
});

test("a checkout that lands on another commit is refused, and installs nothing", async () => {
  const source = remote("demo");
  const root = home();
  const { cmdPlugin, data } = commands(root, (command, args, result) =>
    command === "git" && args[0] === "rev-parse"
      ? { ...result, out: "f".repeat(40) }
      : result,
  );

  await assert.rejects(
    cmdPlugin(["add", source.url]),
    /checked out f{40}, expected/u,
  );
  assert.equal(existsSync(pluginRoot(data, "demo")), false);
  assert.deepEqual((await readPluginsState(data)).plugins, []);
  assert.deepEqual(leftoverPluginDirs(join(data, "custom/plugins")), []);
});

test("a plugin that renames itself is refused, and the installed one stays", async () => {
  const source = remote("demo");
  const root = home();
  const { cmdPlugin, events, data } = commands(root);

  await cmdPlugin(["add", source.url]);
  write(source.work, "plugin.json", manifest("renamed", "2.0.0"));
  git(["add", "-A"], source.work);
  git(["commit", "-qm", "rename"], source.work);
  git(["push", "-q", source.url, "HEAD:refs/heads/main"], source.work);

  events.length = 0;
  await assert.rejects(
    cmdPlugin(["update", "demo"]),
    /could not update: demo/u,
  );
  assert.match(messages(events, "bad"), /now calls itself "renamed"/u);
  const state = await readPluginsState(data);
  assert.deepEqual(
    state.plugins.map((entry) => entry.name),
    ["demo"],
  );
  assert.match(
    readFileSync(join(pluginRoot(data, "demo"), "plugin.json"), "utf8"),
    /"name": "demo"/u,
  );
  assert.deepEqual(leftoverPluginDirs(join(data, "custom/plugins")), []);
});

test("leftovers of an interrupted install are reported, then swept under the lock", async () => {
  const root = home();
  const folder = join(world("sweep"), "my-plugin");
  plantPlugin(folder, "local-demo");
  const { cmdPlugin, events, data } = commands(root);
  const plugins = join(data, "custom/plugins");
  mkdirSync(join(plugins, ".staging-abc"), { recursive: true });
  mkdirSync(join(plugins, ".replaced-9f"), { recursive: true });
  // Законное имя плагина, которое сметало бы вместе с недоделками, если бы уборка
  // смотрела на `.replaced-` где угодно в имени, а не в его начале.
  plantPlugin(join(plugins, "helper.replaced-x"), "helper.replaced-x", "beta");

  await cmdPlugin(["list"]);
  assert.match(messages(events, "warn"), /\.staging-abc is a leftover/u);
  assert.match(messages(events, "warn"), /\.replaced-9f is a leftover/u);
  assert.doesNotMatch(
    messages(events, "warn"),
    /helper\.replaced-x is a leftover/u,
  );

  events.length = 0;
  await cmdPlugin(["add", folder]);
  assert.match(messages(events, "warn"), /cleaned 2 leftover folder\(s\)/u);
  assert.deepEqual(leftoverPluginDirs(plugins), []);
  assert.ok(
    existsSync(join(plugins, "helper.replaced-x", "plugin.json")),
    "a plugin whose name contains .replaced- must survive",
  );

  await cmdPlugin(["sync"]);
  assert.ok(existsSync(join(plugins, "helper.replaced-x", "plugin.json")));
  const named = await readPluginsState(data);
  assert.ok(
    named.plugins.some((entry) => entry.name === "helper.replaced-x"),
    "sync takes the plugin back, it does not sweep it",
  );
  await cmdPlugin(["update"]);
  assert.ok(existsSync(join(plugins, "helper.replaced-x", "plugin.json")));
});

test("a folder without an entry is adopted by add instead of dead-ending", async () => {
  const root = home();
  const folder = join(world("orphan"), "my-plugin");
  plantPlugin(folder, "local-demo");
  const { cmdPlugin, events, data } = commands(root);

  await cmdPlugin(["add", folder]);
  // Запись пропала (руками, миграцией, чем угодно), папка осталась.
  await writePluginsState(data, { marketplaces: [], plugins: [] });

  events.length = 0;
  await cmdPlugin(["add", folder]);
  assert.match(
    messages(events, "warn"),
    /a folder named local-demo was there without an entry in plugins\.json/u,
  );
  assert.deepEqual(
    (await readPluginsState(data)).plugins.map((entry) => entry.name),
    ["local-demo"],
  );
});

test("a damaged plugins.json wedges nothing: commands refuse, sync repairs", async () => {
  const source = remote("demo");
  const root = home();
  const { cmdPlugin, events, data } = commands(root);

  await cmdPlugin(["add", source.url]);
  const installed = await readPluginsState(data);
  writeFileSync(pluginsStateFile(data), "{ broken");

  // Пока файл битый, ни одна команда не делает вид, что плагинов нет.
  for (const argv of [
    ["add", source.url],
    ["list"],
    ["update"],
    ["remove", "demo"],
    ["disable", "demo"],
  ])
    await assert.rejects(cmdPlugin(argv), /not valid JSON/u, argv.join(" "));
  assert.ok(existsSync(pluginRoot(data, "demo")), "nothing was removed");

  events.length = 0;
  await cmdPlugin(["sync"]);
  assert.match(messages(events, "warn"), /not valid JSON/u);
  assert.match(messages(events, "ok"), /demo taken back into plugins\.json/u);

  const repaired = await readPluginsState(data);
  assert.deepEqual(
    repaired.plugins.map((entry) => entry.name),
    ["demo"],
  );
  assert.equal(repaired.plugins[0].digest, installed.plugins[0].digest);
  // Источник восстановить неоткуда, и команда говорит это прямо, а не молчит.
  assert.equal(repaired.plugins[0].source, "");
  events.length = 0;
  await cmdPlugin(["update", "demo"]);
  assert.match(messages(events, "warn"), /has no source recorded/u);
  events.length = 0;
  await cmdPlugin(["list"]);
  assert.equal(messages(events, "bad"), "");

  // И это не тупик: `add` перекрывает запись без источника и записывает источник.
  events.length = 0;
  await cmdPlugin(["add", source.url]);
  assert.match(
    messages(events, "warn"),
    /demo was recorded without a source — replacing it/u,
  );
  assert.doesNotMatch(messages(events, "warn"), /bash inside its skill/u);
  const settled = await readPluginsState(data);
  assert.equal(settled.plugins[0].source, source.url);
  assert.equal(settled.plugins[0].sha, source.sha);
  events.length = 0;
  await cmdPlugin(["update", "demo"]);
  assert.match(messages(events, "ok"), /demo is already at/u);
});

test("sync recovers entries from a backup an older version left behind", async () => {
  const source = remote("demo");
  const root = home();
  const { cmdPlugin, events, data } = commands(root);

  await cmdPlugin(["add", source.url]);
  const saved = readFileSync(pluginsStateFile(data), "utf8");
  writeFileSync(`${pluginsStateFile(data)}.corrupt-2026-08-17`, saved);
  writeFileSync(pluginsStateFile(data), "{ broken");

  await cmdPlugin(["sync"]);
  assert.match(messages(events, "ok"), /recovered 1 plugin\(s\)/u);
  const repaired = await readPluginsState(data);
  assert.equal(repaired.plugins[0].source, source.url);
  assert.equal(repaired.plugins[0].sha, source.sha);
});

test("the components are on screen before anything moves into place", async () => {
  const root = home();
  const folder = join(world("preview"), "my-plugin");
  plantPlugin(folder, "local-demo");
  const data = join(root, "data");
  const plugins = join(data, "custom/plugins");
  // Как только состав напечатан, каталог становится незаписываемым: если бы строка
  // печаталась ПОСЛЕ переезда, установка успела бы пройти целиком.
  const { cmdPlugin, printed } = commands(root, undefined, (line) => {
    if (line.includes("local-demo 1.0.0")) chmodSync(plugins, 0o500);
  });

  try {
    await assert.rejects(cmdPlugin(["add", folder]), /EACCES|permission/iu);
    assert.match(printed.join("\n"), /local-demo 1\.0\.0 — skills: alpha/u);
    assert.equal(existsSync(pluginRoot(data, "local-demo")), false);
  } finally {
    chmodSync(plugins, 0o700);
  }
  assert.deepEqual((await readPluginsState(data)).plugins, []);
});

test("a single stray comma costs nothing: sync keeps the file and recovers every field", async () => {
  const source = remote("demo");
  const root = home();
  const { cmdPlugin, events, data } = commands(root);

  await cmdPlugin(["add", source.url]);
  await cmdPlugin(["disable", "demo"]);
  const before = await readPluginsState(data);
  const file = pluginsStateFile(data);
  const marketplaced = JSON.stringify({
    ...before,
    marketplaces: ["smixs/iva-plugins"],
    plugins: [{ ...before.plugins[0], trusted: true }],
  });
  // Ровно одна лишняя запятая: JSON уже не читается, данные ещё все на месте.
  writeFileSync(file, marketplaced.replace('"plugins":[', '"plugins":[,'));

  events.length = 0;
  await cmdPlugin(["sync"]);

  const after = await readPluginsState(data);
  assert.deepEqual(after.marketplaces, ["smixs/iva-plugins"]);
  assert.deepEqual(after.plugins, [{ ...before.plugins[0], trusted: true }]);
  assert.equal(after.riskNoticeShownAt, before.riskNoticeShownAt);

  // Повреждённая копия сохранена, а не переписана поверх.
  const backups = readdirSync(join(data, "custom")).filter((name) =>
    name.startsWith("plugins.json.corrupt-"),
  );
  assert.equal(backups.length, 1);
  assert.equal(
    readFileSync(join(data, "custom", backups[0]), "utf8"),
    marketplaced.replace('"plugins":[', '"plugins":[,'),
  );
  assert.match(messages(events, "warn"), /kept the damaged file as/u);
  assert.match(
    messages(events, "ok"),
    /recovered 1 plugin\(s\) and 1 marketplace\(s\)/u,
  );
  assert.equal(messages(events, "warn").includes("no source recorded"), false);
});

test("a plugin folder whose manifest disagrees with its name is never taken back", async () => {
  const root = home();
  const { cmdPlugin, events, data } = commands(root);
  // Папку переименовали руками: имя в манифесте осталось прежним.
  plantPlugin(join(data, "custom/plugins/wrong-name"), "real-name");

  await cmdPlugin(["sync"]);

  assert.match(
    messages(events, "bad"),
    /wrong-name: the manifest calls this plugin "real-name"/u,
  );
  assert.deepEqual((await readPluginsState(data)).plugins, []);
});

test("a disable issued during a slow install is refused, not swallowed", async () => {
  const source = remote("demo");
  const root = home();
  const concurrent: Array<Promise<void>> = [];
  const second = commands(root);
  const { cmdPlugin, data } = commands(root, (command, args, result) => {
    // Момент, когда установка уже держит лок и ещё не дописала состояние.
    if (command === "git" && args[0] === "fetch" && concurrent.length === 0)
      concurrent.push(
        assert.rejects(
          second.cmdPlugin(["disable", "demo"]),
          /an update is running/u,
        ),
      );
    return result;
  });

  await cmdPlugin(["add", source.url]);
  assert.equal(concurrent.length, 1, "the concurrent command never started");
  await Promise.all(concurrent);

  // Установка не откатила чужую запись — её просто не было; тумблер работает сразу
  // после того, как лок отпущен, и переживает следующее чтение.
  assert.equal((await readPluginsState(data)).plugins[0].enabled, true);
  await second.cmdPlugin(["disable", "demo"]);
  assert.equal((await readPluginsState(data)).plugins[0].enabled, false);
  await second.cmdPlugin(["update", "demo"]);
  assert.equal((await readPluginsState(data)).plugins[0].enabled, false);
});
