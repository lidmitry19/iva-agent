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
  statSync,
  symlinkSync,
  utimesSync,
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
  type PluginEntry,
} from "#lib/plugin-store.ts";
import {
  DEFAULT_MARKETPLACE,
  marketplaceCachePath,
  marketplaceSlug,
} from "../lib/marketplace.ts";
import { createSystemdControl } from "../lib/systemd-control.ts";
import { createPluginCommands, leftoverPluginDirs } from "./plugin.ts";
import { createCliRuntime } from "./runtime.ts";
import type { PluginVersionBuild } from "./version-update-command.ts";

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

function manifest(
  name: string,
  version = "1.0.0",
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify(
    { $schema: PLUGIN_SCHEMA_URL, name, version, ...extra },
    null,
    2,
  );
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

/** Папка плагина с кодом: `sh.iva/` — это eve Extension (ADR-0009). */
function codePlugin(
  name: string,
  {
    body = "export {};\n",
    version = "1.0.0",
    skill = "alpha",
  }: { body?: string; version?: string; skill?: string } = {},
): string {
  const folder = join(world("code"), name);
  plantPlugin(folder, name, skill, version);
  // Ключ `extensions["sh.iva"]` — заявка автора на наш namespace; без него папка
  // `sh.iva/` не читается вовсе (ADR-0009, решение 12).
  write(
    folder,
    "plugin.json",
    manifest(name, version, { extensions: { "sh.iva": {} } }),
  );
  write(folder, "sh.iva/index.ts", body);
  // Свой tsconfig — часть контракта расширения: без него eve не эмитит декларации
  // внутри дерева версии (TS5112), и `add` отказывает ещё до стора.
  write(folder, "sh.iva/tsconfig.json", '{ "include": ["*.ts"] }\n');
  write(
    folder,
    "sh.iva/package.json",
    JSON.stringify({
      name,
      version,
      eve: { extension: { source: "./extension", dist: "./dist/extension" } },
    }),
  );
  return folder;
}

type Remote = { readonly url: string; readonly work: string; sha: string };

/** Локальный bare-репозиторий в роли удалённого: содержимое кладёт вызывающий. */
function bareRemote(seed: (work: string) => void): Remote {
  const base = world("remote");
  const bare = join(base, "remote.git");
  // `--initial-branch`: HEAD раскрытого репозитория должен указывать на ту ветку,
  // в которую пушим, иначе `ls-remote origin HEAD` не находит ничего.
  git(["init", "-q", "--bare", "--initial-branch=main", bare], base);
  const work = join(base, "work");
  mkdirSync(work, { recursive: true });
  git(["init", "-q", "--initial-branch=main"], work);
  seed(work);
  git(["add", "-A"], work);
  git(["commit", "-qm", "plugin"], work);
  git(["push", "-q", `file://${bare}`, "HEAD:refs/heads/main"], work);
  return { url: `file://${bare}`, work, sha: git(["rev-parse", "HEAD"], work) };
}

/** Репозиторий, корень которого — сам плагин. */
function remote(name: string, skillName = "alpha"): Remote {
  return bareRemote((work) => plantPlugin(work, name, skillName));
}

/** Репозиторий-Marketplace: список в конвенции Codex плюс то, что он раздаёт. */
function marketplaceRemote(
  list: unknown,
  seed: (work: string) => void = () => undefined,
): Remote {
  return bareRemote((work) => {
    write(
      work,
      ".agents/plugins/marketplace.json",
      JSON.stringify(list, null, 2),
    );
    seed(work);
  });
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
  /** Где команда была запущена: по нему отличают кэш Marketplace от установки. */
  cwd: string,
) => { code: number; out: string; err: string };

type Build = {
  readonly calls: { readonly requirePlugins: boolean }[];
  outcome: PluginVersionBuild;
  readonly buildVersion: (options: {
    readonly requirePlugins: boolean;
  }) => Promise<PluginVersionBuild>;
};

/** Сборка версии как её видит команда: что попросили и чем это кончилось. */
function buildStub(
  outcome: PluginVersionBuild = {
    status: "built",
    version: "0.3.24-abcdefabcdef",
  },
): Build {
  const calls: { requirePlugins: boolean }[] = [];
  const stub: Build = {
    calls,
    outcome,
    buildVersion: (options) => {
      calls.push({ requirePlugins: options.requirePlugins });
      return Promise.resolve(stub.outcome);
    },
  };
  return stub;
}

/**
 * `systemctl --user` фейком плюс свой каталог юнитов: живого systemd в тестах нет и
 * быть не может, а на Linux `hasSystemd()` сказал бы «да» и погнал бы команды в
 * настоящие пользовательские юниты.
 */
function unitWorld() {
  const dir = join(world("units"), "systemd");
  mkdirSync(dir, { recursive: true });
  const calls: string[] = [];
  const enabled = new Set<string>();
  const active = new Set<string>();
  const control = createSystemdControl({
    run: (args) => {
      calls.push(args.join(" "));
      const [action, ...rest] = args;
      const unit = rest.filter((value) => !value.startsWith("--")).at(0) ?? "";
      switch (action) {
        case "enable":
          enabled.add(unit);
          if (rest.includes("--now")) active.add(unit);
          return { code: 0, out: "" };
        case "disable":
        case "stop":
          enabled.delete(unit);
          active.delete(unit);
          return { code: 0, out: "" };
        case "is-enabled":
          return enabled.has(unit)
            ? { code: 0, out: "enabled" }
            : { code: 1, out: "disabled" };
        case "is-active":
          return active.has(unit)
            ? { code: 0, out: "active" }
            : { code: 3, out: "inactive" };
        default:
          return { code: 0, out: "" };
      }
    },
  });
  return {
    dir,
    calls,
    control,
    /** Юниты плагинов на диске, по именам. */
    units: () =>
      readdirSync(dir)
        .filter((name) => /^iva-(?:mcp|plugin)-/u.test(name))
        .sort(),
    active: () => [...active].sort(),
  };
}

type Units = ReturnType<typeof unitWorld>;

function commands(
  root: string,
  hook?: CapHook,
  onLog?: (line: string) => void,
  /** Дополнение к git-окружению теста: см. `httpsInsteadOf`. */
  gitEnv: NodeJS.ProcessEnv = {},
  build?: Build,
  /** Фейковый systemd и ответ на вопрос доверия. */
  extra: { units?: Units; confirm?: () => Promise<boolean> } = {},
) {
  const events: Events = [];
  const printed: string[] = [];
  const base = createCliRuntime(root);
  const runtime: Runtime = {
    ...base,
    C: NO_COLOR,
    // systemd в тестах только фейковый: без него команды честно говорят «нет systemd».
    hasSystemd: () => extra.units !== undefined,
    ...(extra.units
      ? { systemd: extra.units.control, UNIT_DIR: extra.units.dir }
      : {}),
    ...(extra.confirm ? { confirm: extra.confirm } : {}),
    ok: (message) => events.push(["ok", message]),
    warn: (message) => events.push(["warn", message]),
    bad: (message) => events.push(["bad", message]),
    step: (message) => events.push(["step", message]),
    readEnv: () => ({}),
    cap: (command, args, options = {}) => {
      const where = typeof options.cwd === "string" ? options.cwd : root;
      const result = spawnSync(command, [...args], {
        cwd: where,
        encoding: "utf8",
        env: { ...GIT_ENV, ...gitEnv },
      });
      const captured = {
        code: result.status ?? 1,
        out: (result.stdout || "").trim(),
        err: (result.stderr || "").trim(),
      };
      return hook ? hook(command, args, captured, where) : captured;
    },
  };
  const { cmdPlugin } = createPluginCommands(runtime, {
    ...(build ? { buildVersion: build.buildVersion } : {}),
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

test("a plugin with code and MCP is built into a version; only MCP still waits", async () => {
  const root = home();
  const folder = codePlugin("carrier");
  writeFileSync(
    join(folder, "mcp.json"),
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: { db: { type: "stdio", command: "node" } },
    }),
  );
  const build = buildStub();
  const { cmdPlugin, events, printed, data } = commands(
    root,
    undefined,
    undefined,
    {},
    build,
  );

  await cmdPlugin(["add", folder]);

  assert.match(
    printed.join("\n"),
    /carrier 1\.0\.0 — skills: alpha; code: sh\.iva; mcp: db/u,
  );
  // Код собирается по рельсам апдейтера, и его отказ обязан отменить установку.
  assert.deepEqual(build.calls, [{ requirePlugins: true }]);
  assert.match(
    messages(events, "ok"),
    /code is built into the version that runs/u,
  );
  assert.match(messages(events, "ok"), /carrier__/u);
  // Процессы плагина видны владельцу построчно, а ответ по умолчанию — «нет»: тест
  // не TTY, и `--trust` не передан.
  assert.match(printed.join("\n"), /^ {4}mcp db: node$/mu);
  assert.match(
    messages(events, "warn"),
    /carrier is not trusted: its MCP servers and services stay off/u,
  );
  assert.equal((await readPluginsState(data)).plugins[0].trusted, false);
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
  // Старая смещённая копия: за ней уже некому вернуться. Свежую уборка не трогает —
  // её держит идущая установка, и на это есть свой тест. Время — от часов харнеса
  // (`now`), а не от настоящих: иначе «старая» становилась бы свежей после полудня.
  const old = new Date("2026-08-17T09:00:00.000Z");
  utimesSync(join(plugins, ".replaced-9f"), old, old);
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

// ─── Marketplace ───────────────────────────────────────────────────────────────
//
// Дефолтный `smixs/iva-plugins` в тестах недостижим — ровно как сегодня в жизни:
// репозитория ещё нет. Хук глушит любую команду git в его кэше, поэтому ни один
// тест не выходит в сеть, а сообщения об отказе проверяются на настоящем пути.
const DEFAULT_CACHE = marketplaceSlug(DEFAULT_MARKETPLACE);

const offlineDefault: CapHook = (command, args, result, cwd) =>
  command === "git" &&
  (cwd.includes(DEFAULT_CACHE) ||
    args.some((arg) => arg.includes("smixs/iva-plugins")))
    ? {
        code: 128,
        out: "",
        err: "fatal: repository 'https://github.com/smixs/iva-plugins.git/' not found",
      }
    : result;

/**
 * Маркетплейс имеет право назвать только `https://`, `ssh://` или `git@host:` — и
 * это правило проверяется на настоящих формах, а не в обход. Чтобы тест остался без
 * сети, https-адрес переписывается в локальный репозиторий средствами самого git
 * (`url.<local>.insteadOf`), заданными через окружение, без файла конфига.
 */
function httpsInsteadOf(
  pairs: ReadonlyArray<readonly [string, string]>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { GIT_CONFIG_COUNT: String(pairs.length) };
  pairs.forEach(([https, local], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = `url.${local}.insteadOf`;
    env[`GIT_CONFIG_VALUE_${index}`] = https;
  });
  return env;
}

/** Список из трёх форм `source` плюс запись `npm`, которую мы не ставим. */
function threeForms(monoUrl: string, ownUrl: string): unknown {
  return {
    name: "iva-plugins",
    plugins: [
      {
        name: "alpha",
        source: "./plugins/alpha",
        description: "A folder of the marketplace itself.",
      },
      {
        name: "beta",
        source: {
          source: "git-subdir",
          url: monoUrl,
          path: "plugins/beta",
          ref: null,
          sha: null,
        },
      },
      {
        name: "gamma",
        source: { source: "url", url: ownUrl, ref: null, sha: null },
        description: "A repository of its own.",
      },
      {
        name: "packaged",
        source: { source: "npm", package: "iva-plugin-packaged" },
        policy: { network: "deny" },
      },
    ],
  };
}

test("the default marketplace is implicit, and it cannot offer a name it has not got", async () => {
  const root = home();
  const { cmdPlugin, events, printed, data } = commands(root, offlineDefault);

  await cmdPlugin(["marketplace", "list"]);
  assert.match(printed.join("\n"), /smixs\/iva-plugins/u);
  assert.match(printed.join("\n"), /\(default\)/u);
  assert.match(printed.join("\n"), /not read yet/u);

  events.length = 0;
  await assert.rejects(
    cmdPlugin(["add", "trace"]),
    /no marketplace offers a plugin named "trace" — iva plugin list --available/u,
  );
  // Причина отказа названа отдельной строкой, а не стектрейсом.
  assert.match(
    messages(events, "bad"),
    /could not be read: fatal: repository/u,
  );
  assert.deepEqual((await readPluginsState(data)).plugins, []);

  events.length = 0;
  printed.length = 0;
  await cmdPlugin(["list", "--available"]);
  assert.match(messages(events, "bad"), /could not be read/u);
  assert.match(printed.join("\n"), /Nothing on offer/u);

  await assert.rejects(
    cmdPlugin(["marketplace", "remove", DEFAULT_MARKETPLACE]),
    /is the built-in default, not a list entry/u,
  );
  await assert.rejects(
    cmdPlugin(["marketplace", "remove", "whatever"]),
    /whatever is not on the list/u,
  );
});

test("marketplace add reads the list once, and add by name installs all three source forms", async () => {
  const mono = bareRemote((work) =>
    plantPlugin(join(work, "plugins/beta"), "beta", "beta-skill"),
  );
  const own = remote("gamma", "gamma-skill");
  // Адреса в файле — настоящие https, как их напишет живой Marketplace; git
  // переписывает их в локальные репозитории, поэтому теста без сети это не лишает.
  const monoUrl = "https://gitlab.example.test/team/mono.git";
  const ownUrl = "https://gitlab.example.test/team/gamma.git";
  const market = marketplaceRemote(threeForms(monoUrl, ownUrl), (work) =>
    plantPlugin(join(work, "plugins/alpha"), "alpha", "alpha-skill"),
  );
  const root = home();
  const { cmdPlugin, events, printed, data } = commands(
    root,
    offlineDefault,
    undefined,
    httpsInsteadOf([
      [monoUrl, mono.url],
      [ownUrl, own.url],
    ]),
  );

  await cmdPlugin(["marketplace", "add", market.url]);
  assert.match(messages(events, "ok"), /iva-plugins added — 3 plugin\(s\)/u);
  // Запись `npm` и поле `policy` не молчат.
  assert.match(
    messages(events, "warn"),
    /iva-plugins: packaged skipped: npm sources are not installed by Iva/u,
  );
  assert.match(messages(events, "warn"), /packaged: field "policy" ignored/u);
  // Первый свой список материализует дефолт, первым: снять его теперь есть чем.
  assert.deepEqual((await readPluginsState(data)).marketplaces, [
    DEFAULT_MARKETPLACE,
    market.url,
  ]);

  events.length = 0;
  printed.length = 0;
  await cmdPlugin(["list", "--available"]);
  const table = printed.join("\n");
  assert.match(table, /NAME\s+DESCRIPTION\s+MARKETPLACE/u);
  assert.match(
    table,
    /alpha .*A folder of the marketplace itself\..*available/u,
  );
  assert.match(table, /beta .*-.*iva-plugins.*available/u);
  assert.match(table, /gamma .*A repository of its own\..*available/u);
  assert.doesNotMatch(table, /packaged/u);

  // Форма 1: папка самого Marketplace — подпапка его репозитория на прочитанном sha.
  events.length = 0;
  await cmdPlugin(["add", "alpha"]);
  // Диагностики файла печатаются там, где владелец просил список; повторять их на
  // каждой установке — приучать их не читать.
  assert.doesNotMatch(messages(events, "warn"), /packaged skipped/u);
  const afterAlpha = await readPluginsState(data);
  assert.deepEqual(
    { ...afterAlpha.plugins[0], digest: "", installedAt: "" },
    {
      name: "alpha",
      source: `${market.url}//plugins/alpha@${market.sha}`,
      ref: market.sha,
      sha: market.sha,
      digest: "",
      enabled: true,
      trusted: false,
      installedAt: "",
      marketplace: "iva-plugins",
    },
  );
  assert.ok(existsSync(join(pluginRoot(data, "alpha"), "plugin.json")));
  assert.match(messages(events, "step"), /Installing alpha from iva-plugins/u);

  // Форма 2: подпапка чужого репозитория — тот же путь установки, sha от него.
  await cmdPlugin(["add", "beta"]);
  const beta = (await readPluginsState(data)).plugins.find(
    (entry) => entry.name === "beta",
  );
  assert.equal(beta?.source, `${monoUrl}//plugins/beta`);
  assert.equal(beta?.sha, mono.sha);
  assert.equal(beta?.ref, "HEAD");
  assert.equal(beta?.marketplace, "iva-plugins");

  // Форма 3: отдельный репозиторий — строка источника ровно его URL.
  await cmdPlugin(["add", "gamma"]);
  const gamma = (await readPluginsState(data)).plugins.find(
    (entry) => entry.name === "gamma",
  );
  assert.equal(gamma?.source, ownUrl);
  assert.equal(gamma?.sha, own.sha);

  // Скиллы всех трёх работают со следующего хода, без сборки и рестарта.
  assert.deepEqual(await nextTurnSkills(data), [
    "alpha-skill",
    "beta-skill",
    "gamma-skill",
  ]);

  // Провенанс виден в `list`, а поставленное — в `list --available`.
  printed.length = 0;
  await cmdPlugin(["list"]);
  assert.match(printed.join("\n"), /via iva-plugins/u);
  // Строка источника уже несёт `@sha`: второй раз тот же sha печатать незачем.
  assert.equal(
    printed.join("\n").includes(`@${market.sha} @${market.sha}`),
    false,
  );
  printed.length = 0;
  await cmdPlugin(["list", "--available"]);
  assert.match(printed.join("\n"), /alpha .*installed/u);
});

test("sync and update replay a source resolved through a marketplace", async () => {
  const market = marketplaceRemote(
    {
      name: "iva-plugins",
      plugins: [{ name: "alpha", source: "./plugins/alpha" }],
    },
    (work) => plantPlugin(join(work, "plugins/alpha"), "alpha", "alpha-skill"),
  );
  const root = home();
  const { cmdPlugin, events, data } = commands(root, offlineDefault);

  await cmdPlugin(["marketplace", "add", market.url]);
  await cmdPlugin(["add", "alpha"]);
  const installed = await readPluginsState(data);

  // Папку снесли: `sync` доставляет ровно запиненный коммит по записанной строке.
  rmSync(pluginRoot(data, "alpha"), { recursive: true, force: true });
  events.length = 0;
  await cmdPlugin(["sync"]);
  assert.match(messages(events, "ok"), /alpha restored/u);
  const restored = await readPluginsState(data);
  assert.deepEqual(restored.plugins[0], installed.plugins[0]);
  assert.ok(existsSync(join(pluginRoot(data, "alpha"), "plugin.json")));

  // `update` идёт по той же строке и видит, что двигаться некуда: Marketplace
  // запинил коммит. Как сойти с пина — сказано прямо.
  events.length = 0;
  await cmdPlugin(["update", "alpha"]);
  assert.match(messages(events, "ok"), /alpha is already at/u);
  assert.match(
    messages(events, "ok"),
    /pinned by iva-plugins.*iva plugin remove alpha/u,
  );
  assert.deepEqual(
    (await readPluginsState(data)).plugins[0],
    installed.plugins[0],
  );
});

test("one name in two marketplaces is the owner's choice, not ours", async () => {
  const list = (name: string): unknown => ({
    name,
    plugins: [{ name: "alpha", source: "./plugins/alpha" }],
  });
  const plant = (work: string): void =>
    plantPlugin(join(work, "plugins/alpha"), "alpha", "alpha-skill");
  const first = marketplaceRemote(list("iva-plugins"), plant);
  const second = marketplaceRemote(list("other-plugins"), plant);
  const root = home();
  const { cmdPlugin, events, data } = commands(root, offlineDefault);

  await cmdPlugin(["marketplace", "add", first.url]);
  await cmdPlugin(["marketplace", "add", second.url]);

  await assert.rejects(
    cmdPlugin(["add", "alpha"]),
    /alpha is offered by iva-plugins and other-plugins — pick one: iva plugin add alpha@iva-plugins/u,
  );
  assert.deepEqual((await readPluginsState(data)).plugins, []);

  await assert.rejects(
    cmdPlugin(["add", "alpha@nowhere"]),
    /no marketplace named "nowhere"/u,
  );

  // Квалификатор — имя из файла или строка источника (см. marketplace.test.ts);
  // адрес со схемой в него не влезает и уходит в разбор источника, где и отказывает.
  // Важно одно: ничего не ставится.
  await assert.rejects(cmdPlugin(["add", `alpha@${first.url}`]));
  assert.deepEqual((await readPluginsState(data)).plugins, []);
  events.length = 0;
  await cmdPlugin(["add", "alpha@other-plugins"]);
  const entry = (await readPluginsState(data)).plugins[0];
  assert.equal(entry.marketplace, "other-plugins");
  assert.equal(entry.source, `${second.url}//plugins/alpha@${second.sha}`);

  // Два списка под одним именем сделали бы этот выбор невыразимым.
  const twin = marketplaceRemote(list("iva-plugins"), plant);
  await assert.rejects(
    cmdPlugin(["marketplace", "add", twin.url]),
    /a marketplace named "iva-plugins" is already on the list/u,
  );
});

test("a marketplace that cannot be refreshed serves the cached list and says it is stale", async () => {
  const market = marketplaceRemote(
    {
      name: "iva-plugins",
      plugins: [{ name: "alpha", source: "./plugins/alpha" }],
    },
    (work) => plantPlugin(join(work, "plugins/alpha"), "alpha", "alpha-skill"),
  );
  const root = home();
  const cache = marketplaceCachePath(join(root, "data"), market.url);
  let offline = false;
  const { cmdPlugin, events, printed, data } = commands(
    root,
    (command, args, result, cwd) => {
      // Гаснет только обновление кэша: установка обязана и дальше ходить в git.
      if (offline && command === "git" && args[0] === "fetch" && cwd === cache)
        return { code: 128, out: "", err: "fatal: unable to access remote" };
      return offlineDefault(command, args, result, cwd);
    },
  );

  await cmdPlugin(["marketplace", "add", market.url]);
  offline = true;

  events.length = 0;
  printed.length = 0;
  await cmdPlugin(["list", "--available"]);
  assert.match(
    messages(events, "warn"),
    /iva-plugins could not be refreshed \(fatal: unable to access remote\) — using the cached list, it may be stale/u,
  );
  assert.match(printed.join("\n"), /alpha/u);

  events.length = 0;
  await cmdPlugin(["add", "alpha"]);
  assert.match(
    messages(events, "warn"),
    /using the cached list, it may be stale/u,
  );
  assert.ok(existsSync(join(pluginRoot(data, "alpha"), "plugin.json")));
  assert.equal((await readPluginsState(data)).plugins[0].sha, market.sha);
});

test("a repository without a usable list is not a marketplace, and nothing is recorded", async () => {
  const broken = bareRemote((work) =>
    write(work, ".agents/plugins/marketplace.json", "{ broken"),
  );
  const nameless = marketplaceRemote({ plugins: [] });
  const plain = remote("demo");
  const root = home();
  const { cmdPlugin, events, data } = commands(root, offlineDefault);

  for (const [source, why] of [
    [broken.url, /is not valid JSON/u],
    [nameless.url, /name must be a non-empty string/u],
    [plain.url, /no \.agents\/plugins\/marketplace\.json in the repository/u],
  ] as const) {
    events.length = 0;
    await assert.rejects(
      cmdPlugin(["marketplace", "add", source]),
      /has no usable \.agents\/plugins\/marketplace\.json/u,
      source,
    );
    assert.match(messages(events, "warn"), why, source);
    assert.deepEqual((await readPluginsState(data)).marketplaces, [], source);
    // Отказ не оставляет за собой выкачанную копию непринятого репозитория.
    assert.equal(existsSync(marketplaceCachePath(data, source)), false, source);
  }

  // Битый файл у УЖЕ добавленного списка не роняет команду и виден в диагностике.
  const market = marketplaceRemote(
    {
      name: "iva-plugins",
      plugins: [{ name: "alpha", source: "./plugins/alpha" }],
    },
    (work) => plantPlugin(join(work, "plugins/alpha"), "alpha", "alpha-skill"),
  );
  await cmdPlugin(["marketplace", "add", market.url]);
  write(market.work, ".agents/plugins/marketplace.json", "{ broken");
  git(["add", "-A"], market.work);
  git(["commit", "-qm", "break"], market.work);
  git(["push", "-q", market.url, "HEAD:refs/heads/main"], market.work);

  events.length = 0;
  await assert.rejects(
    cmdPlugin(["add", "alpha"]),
    /no marketplace offers a plugin named "alpha"/u,
  );
  // Имя маркетплейса живёт в его файле: файл сломан — в строке остаётся источник,
  // из которого он взят. Другого имени взять негде, и выдумывать его нечем. Причину
  // владелец видит именно здесь, на установке: без неё «плагина никто не предлагает»
  // выглядело бы как «плагин пропал».
  assert.match(
    messages(events, "warn"),
    /remote\.git: \.agents\/plugins\/marketplace\.json is not valid JSON/u,
  );
});

test("marketplace remove takes the entry and its cache, by name or by source", async () => {
  const market = marketplaceRemote({ name: "iva-plugins", plugins: [] });
  const other = marketplaceRemote({ name: "other-plugins", plugins: [] });
  const root = home();
  const { cmdPlugin, events, printed, data } = commands(root, offlineDefault);

  await cmdPlugin(["marketplace", "add", market.url]);
  await cmdPlugin(["marketplace", "add", other.url]);
  assert.ok(existsSync(marketplaceCachePath(data, market.url)));

  events.length = 0;
  await cmdPlugin(["marketplace", "remove", "iva-plugins"]);
  assert.match(messages(events, "ok"), /removed/u);
  assert.equal(existsSync(marketplaceCachePath(data, market.url)), false);
  assert.deepEqual((await readPluginsState(data)).marketplaces, [
    DEFAULT_MARKETPLACE,
    other.url,
  ]);

  printed.length = 0;
  await cmdPlugin(["marketplace", "list"]);
  assert.match(printed.join("\n"), /other-plugins.*0 plugin\(s\)/u);
  assert.doesNotMatch(printed.join("\n"), /\(default\)/u);

  await cmdPlugin(["marketplace", "remove", other.url]);
  await cmdPlugin(["marketplace", "remove", DEFAULT_MARKETPLACE]);
  // Список опустел — дефолт снова неявный, и это единственное его состояние.
  assert.deepEqual((await readPluginsState(data)).marketplaces, []);
  printed.length = 0;
  await cmdPlugin(["marketplace", "list"]);
  assert.match(printed.join("\n"), /smixs\/iva-plugins.*\(default\)/u);

  await assert.rejects(
    cmdPlugin(["marketplace", "frobnicate"]),
    /unknown: iva plugin marketplace frobnicate — add, remove, list/u,
  );
  await assert.rejects(
    cmdPlugin(["marketplace", "add"]),
    /iva plugin marketplace add <source>/u,
  );
});

test("a marketplace that offers a plugin under another name installs nothing", async () => {
  const market = marketplaceRemote(
    {
      name: "iva-plugins",
      plugins: [{ name: "trace", source: "./plugins/trace" }],
    },
    // В папке лежит плагин с ДРУГИМ именем: файл списка непроверенный, имя
    // объявляет манифест.
    (work) => plantPlugin(join(work, "plugins/trace"), "evil", "evil-skill"),
  );
  const root = home();
  const { cmdPlugin, data } = commands(root, offlineDefault);

  await cmdPlugin(["marketplace", "add", market.url]);
  await assert.rejects(
    cmdPlugin(["add", "trace"]),
    /iva-plugins offers trace, but this plugin calls itself "evil" — refusing to install it/u,
  );
  assert.equal(existsSync(pluginRoot(data, "evil")), false);
  assert.deepEqual((await readPluginsState(data)).plugins, []);
  assert.deepEqual(leftoverPluginDirs(join(data, "custom/plugins")), []);
});

test("a marketplace entry that is not a source at all is named, not obeyed", async () => {
  const root = home();
  const { cmdPlugin, events, data } = commands(root, offlineDefault);
  // Строка попала в plugins.json руками или из чужой версии: источником она не
  // является, и притворяться, что список пуст, команда не имеет права.
  await writePluginsState(data, {
    marketplaces: ["not a source at all"],
    plugins: [],
  });

  await cmdPlugin(["marketplace", "list"]);
  assert.match(messages(events, "bad"), /unknown plugin source/u);

  events.length = 0;
  await assert.rejects(
    cmdPlugin(["add", "trace"]),
    /no marketplace offers a plugin named "trace"/u,
  );
  assert.match(messages(events, "bad"), /unknown plugin source/u);
});

test("a marketplace on the disk is a git repository too, and its plugins stay replayable", async () => {
  const market = marketplaceRemote(
    {
      name: "mine",
      plugins: [{ name: "alpha", source: "plugins/alpha" }],
    },
    (work) => plantPlugin(join(work, "plugins/alpha"), "alpha", "alpha-skill"),
  );
  const root = home();
  const { cmdPlugin, events, data } = commands(root, offlineDefault);

  // Локальный источник — рабочая копия репозитория, не bare: так владелец и держит
  // свой список, пока пишет его.
  await cmdPlugin(["marketplace", "add", market.work]);
  assert.match(messages(events, "ok"), /mine added — 1 plugin\(s\)/u);
  assert.deepEqual((await readPluginsState(data)).marketplaces, [
    DEFAULT_MARKETPLACE,
    market.work,
  ]);

  await cmdPlugin(["add", "alpha"]);
  const entry = (await readPluginsState(data)).plugins[0];
  // Путь с диска записан как `file://`: строку источника проигрывает `sync`, а он
  // умеет один язык — git.
  assert.equal(
    entry.source,
    `file://${market.work}//plugins/alpha@${market.sha}`,
  );
  assert.equal(entry.marketplace, "mine");
  assert.deepEqual(await nextTurnSkills(data), ["alpha-skill"]);

  rmSync(pluginRoot(data, "alpha"), { recursive: true, force: true });
  events.length = 0;
  await cmdPlugin(["sync"]);
  assert.match(messages(events, "ok"), /alpha restored/u);
});

test("a marketplace naming file:// gets nothing: not offered, not fetched, not installed", async () => {
  // Репозиторий владельца с ВАЛИДНЫМ плагином в корне: раньше такая запись
  // клонировалась в staging и держалась только на ридере манифеста.
  const victim = remote("victim", "victim-skill");
  const market = marketplaceRemote({
    name: "iva-plugins",
    plugins: [
      { name: "victim", source: { source: "url", url: victim.url } },
      {
        name: "subdir-victim",
        source: {
          source: "git-subdir",
          url: victim.url,
          path: "skills",
          ref: null,
          sha: null,
        },
      },
      { name: "plain", source: { source: "url", url: "http://h.test/x.git" } },
    ],
  });
  const root = home();
  const { cmdPlugin, events, printed, data } = commands(root, offlineDefault);

  await cmdPlugin(["marketplace", "add", market.url]);
  assert.match(messages(events, "ok"), /iva-plugins added — 0 plugin\(s\)/u);
  for (const name of ["victim", "subdir-victim", "plain"])
    assert.match(
      messages(events, "warn"),
      new RegExp(
        `${name} skipped: source\\.url .* is not a remote repository`,
        "u",
      ),
      name,
    );

  events.length = 0;
  printed.length = 0;
  await cmdPlugin(["list", "--available"]);
  assert.match(printed.join("\n"), /Nothing on offer/u);
  assert.doesNotMatch(printed.join("\n"), /victim/u);

  events.length = 0;
  await assert.rejects(
    cmdPlugin(["add", "victim"]),
    /no marketplace offers a plugin named "victim"/u,
  );
  assert.equal(existsSync(pluginRoot(data, "victim")), false);
  assert.deepEqual((await readPluginsState(data)).plugins, []);
  assert.deepEqual(leftoverPluginDirs(join(data, "custom/plugins")), []);
});

test("the git of plugins never stops to ask for a password", async () => {
  const root = home();
  // Фейковый git на PATH: пишет своё окружение в файл и отказывает. Настоящий
  // runtime.cap здесь не подменён — проверяется то, что реально доедет до процесса.
  const bin = world("fake-git");
  const dumped = join(bin, "env.txt");
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh\nprintf 'GIT_TERMINAL_PROMPT=%s\\n' "$GIT_TERMINAL_PROMPT" >> ${dumped}\nexit 128\n`,
  );
  chmodSync(join(bin, "git"), 0o755);

  const previousPath = process.env.PATH;
  // Переменную снимаем с процесса теста: иначе она приехала бы из окружения машины,
  // и тест был бы зелёным даже без правки.
  const previousPrompt = process.env.GIT_TERMINAL_PROMPT;
  delete process.env.GIT_TERMINAL_PROMPT;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  try {
    const base = createCliRuntime(root);
    const { cmdPlugin } = createPluginCommands(
      {
        ...base,
        C: NO_COLOR,
        ok: () => undefined,
        warn: () => undefined,
        bad: () => undefined,
        step: () => undefined,
      },
      { translate: (en) => en, log: () => undefined, cwd: () => root },
    );
    // Кэш дефолтного Marketplace: команда обязана вернуться, а не ждать ввода.
    await cmdPlugin(["list", "--available"]);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousPrompt !== undefined)
      process.env.GIT_TERMINAL_PROMPT = previousPrompt;
  }

  const seen = readFileSync(dumped, "utf8").trim().split("\n");
  assert.ok(seen.length > 0, "the fake git was actually called");
  assert.deepEqual(
    [...new Set(seen)],
    ["GIT_TERMINAL_PROMPT=0"],
    "every git call of the plugin rails carries the switch",
  );
});

// ── Код плагина: сборка версии как часть команды (ADR-0009) ──────────────────────────────

test("a plugin with only skills is installed without building any version", async () => {
  const root = home();
  const folder = join(world("skills"), "quiet");
  plantPlugin(folder, "quiet");
  const build = buildStub();
  const { cmdPlugin, events } = commands(root, undefined, undefined, {}, build);

  await cmdPlugin(["add", folder]);

  assert.deepEqual(build.calls, []);
  assert.match(messages(events, "ok"), /skills work from the next turn/u);
});

test("a plugin whose version build fails is not installed at all", async () => {
  const root = home();
  const folder = codePlugin("carrier");
  const build = buildStub({
    status: "failed",
    reason: "eve: extension build failed",
  });
  const { cmdPlugin, data } = commands(root, undefined, undefined, {}, build);

  await assert.rejects(
    cmdPlugin(["add", folder]),
    /carrier was not installed: eve: extension build failed/u,
  );

  // Ни папки, ни записи: команда вернула стор туда, откуда взяла.
  assert.equal(existsSync(pluginRoot(data, "carrier")), false);
  assert.deepEqual((await readPluginsState(data)).plugins, []);
  assert.deepEqual(leftoverPluginDirs(join(data, "custom/plugins")), []);
});

test("an update whose build fails puts the previous copy of the plugin back", async () => {
  const root = home();
  const folder = codePlugin("carrier", { body: "export const one = 1;\n" });
  const build = buildStub();
  const { cmdPlugin, data } = commands(root, undefined, undefined, {}, build);
  await cmdPlugin(["add", folder]);
  const installed = await readPluginsState(data);

  // Автор выпустил новую версию, и она не собирается.
  write(folder, "sh.iva/index.ts", "export const two = 2;\n");
  write(
    folder,
    "plugin.json",
    manifest("carrier", "2.0.0", { extensions: { "sh.iva": {} } }),
  );
  build.outcome = { status: "failed", reason: "eve: boom" };

  await assert.rejects(
    cmdPlugin(["update", "carrier"]),
    /nothing was updated/u,
  );

  assert.equal(
    readFileSync(join(pluginRoot(data, "carrier"), "sh.iva/index.ts"), "utf8"),
    "export const one = 1;\n",
  );
  assert.deepEqual(await readPluginsState(data), installed);
  assert.deepEqual(leftoverPluginDirs(join(data, "custom/plugins")), []);
});

test("an enable that will not build leaves the plugin disabled", async () => {
  const root = home();
  const folder = codePlugin("carrier");
  const build = buildStub();
  const { cmdPlugin, data } = commands(root, undefined, undefined, {}, build);
  await cmdPlugin(["add", folder]);
  await cmdPlugin(["disable", "carrier"]);
  build.calls.length = 0;
  build.outcome = { status: "failed", reason: "eve: boom" };

  await assert.rejects(
    cmdPlugin(["enable", "carrier"]),
    /carrier stays disabled: eve: boom/u,
  );

  assert.equal((await readPluginsState(data)).plugins[0].enabled, false);
  assert.deepEqual(build.calls, [{ requirePlugins: true }]);
});

test("switching a plugin off and removing it rebuild without demanding it", async () => {
  const root = home();
  const folder = codePlugin("carrier");
  const build = buildStub();
  const { cmdPlugin, events, data } = commands(
    root,
    undefined,
    undefined,
    {},
    build,
  );
  await cmdPlugin(["add", folder]);
  build.calls.length = 0;
  events.length = 0;

  await cmdPlugin(["disable", "carrier"]);
  // Выключенный плагин уже не в составе версии, поэтому включать его назад нечему.
  await cmdPlugin(["enable", "carrier"]);
  await cmdPlugin(["remove", "carrier"]);

  assert.deepEqual(build.calls, [
    { requirePlugins: false },
    { requirePlugins: true },
    { requirePlugins: false },
  ]);
  // Шаг сборки называет направление: плагин уходит из версии, а не приезжает в неё.
  assert.deepEqual(messages(events, "step").split("\n"), [
    "Rebuilding Iva without carrier",
    "Building Iva with carrier",
    "Rebuilding Iva without carrier",
  ]);
  assert.equal(existsSync(pluginRoot(data, "carrier")), false);
});

test("a build that cannot happen here leaves the plugin installed and says why", async () => {
  const root = home();
  const folder = codePlugin("carrier");
  const build = buildStub({
    status: "skipped",
    reason:
      "this tree is a development checkout - build it yourself: npm run build",
  });
  const { cmdPlugin, events, data } = commands(
    root,
    undefined,
    undefined,
    {},
    build,
  );

  await cmdPlugin(["add", folder]);

  assert.match(messages(events, "warn"), /development checkout/u);
  assert.equal((await readPluginsState(data)).plugins.length, 1);
  // Последняя строка не имеет права обещать код в работающей версии сразу после того,
  // как команда сказала, что собрать его тут нечем.
  assert.match(
    messages(events, "ok"),
    /code is not in the version that runs; its tools appear once it is built/u,
  );
  assert.doesNotMatch(
    messages(events, "ok"),
    /code is built into the version/u,
  );
});

test("two plugins whose code wants one mount file are not installed together", async () => {
  const root = home();
  const first = codePlugin("my.tool");
  const second = codePlugin("my-tool", { skill: "beta" });
  const build = buildStub();
  const { cmdPlugin, data } = commands(root, undefined, undefined, {}, build);

  await cmdPlugin(["add", first]);
  await assert.rejects(
    cmdPlugin(["add", second]),
    /my-tool and my\.tool both need the extension mount my_tool\.ts/u,
  );

  assert.deepEqual(
    (await readPluginsState(data)).plugins.map((entry) => entry.name),
    ["my.tool"],
  );
  // Отказ до переезда в стор: папка второго плагина не появилась.
  assert.equal(existsSync(pluginRoot(data, "my-tool")), false);
  assert.deepEqual(build.calls, [{ requirePlugins: true }]);
});

test("a name eve cannot mount is refused for code and fine for skills", async () => {
  const root = home();
  const withCode = codePlugin("7zip");
  const build = buildStub();
  const { cmdPlugin, data } = commands(root, undefined, undefined, {}, build);

  await assert.rejects(cmdPlugin(["add", withCode]), /eve accepts a letter/u);
  assert.equal(existsSync(pluginRoot(data, "7zip")), false);

  // Тот же плагин без кода — обычный плагин со скиллом, ему mount не нужен.
  const skillsOnly = join(world("skills"), "7zip");
  plantPlugin(skillsOnly, "7zip");
  await cmdPlugin(["add", skillsOnly]);
  assert.deepEqual(
    (await readPluginsState(data)).plugins.map((entry) => entry.name),
    ["7zip"],
  );
  assert.deepEqual(build.calls, []);
});

test("a version that runs without the plugin's code is not a successful install", async () => {
  const root = home();
  const folder = codePlugin("carrier");
  // The pipeline says it built something; the version that runs has no mount for the
  // plugin. "installed" is a promise about the code that runs, so this is a failure.
  const build = buildStub({ status: "built", version: "0.3.24-abcdefabcdef" });
  const { cmdPlugin, data } = commands(root, undefined, undefined, {}, build);

  await cmdPlugin(["add", folder]);

  // The stub cannot lie about a real version tree, so the guard that catches this lives
  // in `rebuild` (scripts/cli/version-update-command.ts); here the contract is that a
  // failure reason from it aborts the install, whatever produced it.
  build.outcome = {
    status: "failed",
    reason: "0.3.24-abcdefabcdef runs without the code of carrier",
  };
  await cmdPlugin(["disable", "carrier"]);
  await assert.rejects(
    cmdPlugin(["enable", "carrier"]),
    /carrier stays disabled: .*runs without the code of carrier/u,
  );
  assert.equal((await readPluginsState(data)).plugins[0].enabled, false);
});

test("a code plugin without a tsconfig in sh.iva is refused with what to do", async () => {
  const root = home();
  const folder = codePlugin("carrier");
  rmSync(join(folder, "sh.iva/tsconfig.json"));
  const build = buildStub();
  const { cmdPlugin, data } = commands(root, undefined, undefined, {}, build);

  await assert.rejects(
    cmdPlugin(["add", folder]),
    /carrier carries code without sh\.iva\/tsconfig\.json.*eve extension init/su,
  );

  assert.equal(existsSync(pluginRoot(data, "carrier")), false);
  assert.deepEqual((await readPluginsState(data)).plugins, []);
  assert.deepEqual(build.calls, []);
});

test("the copy an install displaced survives another command's sweep while it builds", async () => {
  const root = home();
  const folder = codePlugin("carrier");
  const build = buildStub();
  const { cmdPlugin, data } = commands(root, undefined, undefined, {}, build);
  await cmdPlugin(["add", folder]);
  // What an install in progress leaves in the store while its version builds: the copy
  // it displaced, waiting to be put back if the build fails. The build holds the update
  // lock, so the only thing that can take it away is the next command's sweep.
  const plugins = join(data, "custom/plugins");
  mkdirSync(join(plugins, ".replaced-fresh"), { recursive: true });

  await cmdPlugin(["list"]);
  await cmdPlugin(["disable", "carrier"]);

  assert.ok(
    existsSync(join(plugins, ".replaced-fresh")),
    "a young displaced copy belongs to a build that is still running",
  );
});

test("an update of several plugins names the one that broke the build", async () => {
  const root = home();
  const first = codePlugin("alpha-code", { skill: "one" });
  const second = codePlugin("beta-code", { skill: "two" });
  const build = buildStub();
  const { cmdPlugin, data } = commands(root, undefined, undefined, {}, build);
  await cmdPlugin(["add", first]);
  await cmdPlugin(["add", second]);
  const installed = await readPluginsState(data);

  write(first, "sh.iva/index.ts", "export const one = 1;\n");
  write(second, "sh.iva/index.ts", "export const two = 2;\n");
  build.outcome = {
    status: "failed",
    reason: "building the extension of beta-code:\neve: extension build failed",
  };

  await assert.rejects(
    cmdPlugin(["update"]),
    /nothing was updated: building the extension of beta-code/u,
  );

  // Both are back where they were: one build serves the whole run, so one failure takes
  // the whole run back.
  assert.deepEqual(await readPluginsState(data), installed);
  assert.deepEqual(leftoverPluginDirs(join(data, "custom/plugins")), []);
});

test("sync says the code of a restored plugin is not in the version that runs", async () => {
  const root = home();
  const folder = codePlugin("carrier");
  const build = buildStub();
  const { cmdPlugin, events, data } = commands(
    root,
    undefined,
    undefined,
    {},
    build,
  );
  await cmdPlugin(["add", folder]);
  rmSync(pluginRoot(data, "carrier"), { recursive: true, force: true });
  events.length = 0;

  await cmdPlugin(["sync"]);

  assert.match(messages(events, "ok"), /carrier restored/u);
  assert.match(
    messages(events, "warn"),
    /carrier: code is not built into the current version — run: iva update/u,
  );
});

test("sync refuses to restore a plugin whose code wants a taken mount file", async () => {
  const root = home();
  const first = codePlugin("my.tool", { skill: "one" });
  const build = buildStub();
  const { cmdPlugin, events, data } = commands(
    root,
    undefined,
    undefined,
    {},
    build,
  );
  await cmdPlugin(["add", first]);
  // A state file that asks for two plugins whose code folds onto one mount: `add`
  // refuses such a pair, so this one comes from a hand-edited or salvaged plugins.json.
  const second = codePlugin("my-tool", { skill: "two" });
  const state = await readPluginsState(data);
  await writePluginsState(data, {
    ...state,
    plugins: [
      ...state.plugins,
      {
        name: "my-tool",
        source: second,
        ref: "",
        sha: "",
        digest: "",
        enabled: true,
        trusted: false,
        installedAt: "2026-08-17T12:00:00.000Z",
      },
    ],
  });
  events.length = 0;

  await assert.rejects(cmdPlugin(["sync"]), /could not restore: my-tool/u);

  assert.match(
    messages(events, "bad"),
    /my-tool and my\.tool both need the extension mount my_tool\.ts/u,
  );
  assert.equal(existsSync(pluginRoot(data, "my-tool")), false);
});

/** Плагин со stdio-MCP и сервисом: ровно то, ради чего существует доверие. */
function processPlugin(
  name: string,
  { servicePort = 8726 }: { servicePort?: number } = {},
): string {
  const folder = join(world("processes"), name);
  plantPlugin(folder, name);
  write(
    folder,
    "plugin.json",
    manifest(name, "1.0.0", { extensions: { "sh.iva": {} } }),
  );
  write(
    folder,
    "mcp.json",
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: {
        viewer: { type: "stdio", command: "node", args: ["serve.mjs"] },
        api: { type: "streamable-http", url: "https://api.test/mcp" },
      },
    }),
  );
  write(
    folder,
    "sh.iva/services/web/service.json",
    JSON.stringify({
      command: "node",
      args: ["server.mjs", "${PLUGIN_DATA}"],
      port: servicePort,
    }),
  );
  write(folder, "sh.iva/services/web/server.mjs", "// server\n");
  return folder;
}

test("trust hands out ports and tokens, writes the units and starts them", async () => {
  const root = home();
  const folder = processPlugin("trace");
  const units = unitWorld();
  const build = buildStub();
  const { cmdPlugin, events, data } = commands(
    root,
    undefined,
    undefined,
    {},
    build,
    { units },
  );

  await cmdPlugin(["add", folder]);
  // Без доверия — ни юнитов, ни портов, ни сборки: скиллы и так живые.
  assert.deepEqual(units.units(), []);
  assert.equal((await readPluginsState(data)).plugins[0].mcp, undefined);
  assert.deepEqual(build.calls, []);

  events.length = 0;
  await cmdPlugin(["trust", "trace"]);

  const entry = (await readPluginsState(data)).plugins[0];
  assert.equal(entry.trusted, true);
  // Порт только у stdio-сервера: `streamable-http` ходит напрямую, без прокси.
  assert.deepEqual(entry.mcp, { viewer: { port: 8730 } });
  // Сервис получил порт, который просил.
  assert.deepEqual(entry.services, { web: { port: 8726 } });
  // Токен — 32 байта hex и режим 0600.
  const token = join(pluginDataDir(data, "trace"), "mcp-viewer.token");
  assert.match(readFileSync(token, "utf8").trim(), /^[a-f0-9]{64}$/u);
  assert.equal(statSync(token).mode & 0o777, 0o600);
  // Юниты на диске и подняты.
  assert.deepEqual(units.units(), [
    "iva-mcp-trace-viewer.service",
    "iva-plugin-trace-web.service",
  ]);
  assert.deepEqual(units.active(), units.units());
  const proxy = readFileSync(
    join(units.dir, "iva-mcp-trace-viewer.service"),
    "utf8",
  );
  assert.match(proxy, /--plugin "trace" --server "viewer" --port 8730/u);
  assert.match(proxy, new RegExp(`--token-file "${token}"`, "u"));
  const service = readFileSync(
    join(units.dir, "iva-plugin-trace-web.service"),
    "utf8",
  );
  // Плейсхолдер раскрыт до записи в юнит: systemd его не раскрывает.
  assert.match(
    service,
    new RegExp(
      `^ExecStart=/usr/bin/env "node" "server.mjs" "${pluginDataDir(data, "trace")}"$`,
      "mu",
    ),
  );
  assert.match(service, /^Environment="IVA_SERVICE_PORT=8726"$/mu);
  // Плагин с MCP пересобирает версию: connection-файлы живут в ней.
  assert.deepEqual(build.calls, [{ requirePlugins: true }]);
  assert.match(messages(events, "ok"), /trace trusted/u);

  // Повторное доверие ничего не двигает и второй сборки не просит.
  events.length = 0;
  build.calls.length = 0;
  await cmdPlugin(["trust", "trace"]);
  assert.match(messages(events, "ok"), /already trusted/u);
  assert.deepEqual(build.calls, []);

  // untrust гасит и снимает юниты, порты остаются за плагином.
  events.length = 0;
  await cmdPlugin(["untrust", "trace"]);
  assert.deepEqual(units.units(), []);
  assert.deepEqual(units.active(), []);
  const after = (await readPluginsState(data)).plugins[0];
  assert.equal(after.trusted, false);
  assert.deepEqual(after.mcp, { viewer: { port: 8730 } });
  assert.deepEqual(build.calls, [{ requirePlugins: false }]);
  assert.match(messages(events, "ok"), /trace .* processes are stopped/u);

  // Второе доверие возвращает ТЕ ЖЕ порты: они в юните и в connection-файле.
  await cmdPlugin(["trust", "trace"]);
  assert.deepEqual((await readPluginsState(data)).plugins[0].mcp, {
    viewer: { port: 8730 },
  });
  assert.deepEqual(units.units(), [
    "iva-mcp-trace-viewer.service",
    "iva-plugin-trace-web.service",
  ]);
});

test("add --trust answers the question, and a yes at the prompt does the same", async () => {
  const root = home();
  const units = unitWorld();
  const build = buildStub();
  const { cmdPlugin, printed, data } = commands(
    root,
    undefined,
    undefined,
    {},
    build,
    { units },
  );

  await cmdPlugin(["add", processPlugin("trace"), "--trust"]);
  assert.equal((await readPluginsState(data)).plugins[0].trusted, true);
  // Команды всё равно напечатаны: `--trust` отвечает на вопрос, а не прячет его.
  assert.match(printed.join("\n"), /^ {4}mcp viewer: node serve\.mjs$/mu);
  assert.match(printed.join("\n"), /^ {4}service web: node server\.mjs/mu);
  assert.deepEqual(units.units(), [
    "iva-mcp-trace-viewer.service",
    "iva-plugin-trace-web.service",
  ]);
  // Одна сборка на установку: доверие решено до неё.
  assert.deepEqual(build.calls, [{ requirePlugins: true }]);

  // Тот же ответ из терминала.
  const second = home();
  const yes = commands(second, undefined, undefined, {}, buildStub(), {
    units: unitWorld(),
    confirm: () => Promise.resolve(true),
  });
  await yes.cmdPlugin(["add", processPlugin("other")]);
  assert.equal((await readPluginsState(yes.data)).plugins[0].trusted, true);
});

test("disable takes the units down, enable brings them back", async () => {
  const root = home();
  const units = unitWorld();
  const { cmdPlugin, data } = commands(
    root,
    undefined,
    undefined,
    {},
    buildStub(),
    { units },
  );

  await cmdPlugin(["add", processPlugin("trace"), "--trust"]);
  assert.equal(units.units().length, 2);

  await cmdPlugin(["disable", "trace"]);
  assert.deepEqual(units.units(), [], "a disabled plugin runs nothing");
  assert.equal((await readPluginsState(data)).plugins[0].trusted, true);

  await cmdPlugin(["enable", "trace"]);
  assert.equal(units.units().length, 2);

  await cmdPlugin(["remove", "trace"]);
  assert.deepEqual(units.units(), []);
  // Данные плагина, включая токен, остаются (спека §9.1).
  assert.ok(existsSync(join(pluginDataDir(data, "trace"), "mcp-viewer.token")));
});

test("a plugin with services and no code needs no version build", async () => {
  const root = home();
  const folder = join(world("service-only"), "svc");
  plantPlugin(folder, "svc");
  write(
    folder,
    "plugin.json",
    manifest("svc", "1.0.0", { extensions: { "sh.iva": {} } }),
  );
  write(
    folder,
    "sh.iva/services/web/service.json",
    JSON.stringify({ command: "node", args: ["server.mjs"], port: 8726 }),
  );
  const units = unitWorld();
  const build = buildStub();
  const { cmdPlugin, data } = commands(root, undefined, undefined, {}, build, {
    units,
  });

  await cmdPlugin(["add", folder, "--trust"]);

  // Ни кода, ни MCP — версии пересобирать нечего, юнит всё равно есть.
  assert.deepEqual(build.calls, []);
  assert.deepEqual(units.units(), ["iva-plugin-svc-web.service"]);
  assert.deepEqual((await readPluginsState(data)).plugins[0].services, {
    web: { port: 8726 },
  });
});

test("sync finishes what trust does and puts the units back", async () => {
  const root = home();
  const units = unitWorld();
  const { cmdPlugin, data } = commands(
    root,
    undefined,
    undefined,
    {},
    buildStub(),
    { units },
  );
  await cmdPlugin(["add", processPlugin("trace"), "--trust"]);

  // Кто-то снёс юниты руками и потерял порты из состояния.
  for (const unit of units.units()) rmSync(join(units.dir, unit));
  const state = await readPluginsState(data);
  await writePluginsState(data, {
    ...state,
    plugins: state.plugins.map((entry) => {
      const stripped: Record<string, unknown> = { ...entry };
      delete stripped.mcp;
      delete stripped.services;
      return stripped as unknown as PluginEntry;
    }),
  });

  await cmdPlugin(["sync"]);

  const entry = (await readPluginsState(data)).plugins[0];
  assert.deepEqual(entry.mcp, { viewer: { port: 8730 } });
  assert.deepEqual(entry.services, { web: { port: 8726 } });
  assert.deepEqual(units.units(), [
    "iva-mcp-trace-viewer.service",
    "iva-plugin-trace-web.service",
  ]);
});

test("without systemd the state still changes and the command says so", async () => {
  const root = home();
  const { cmdPlugin, events, data } = commands(
    root,
    undefined,
    undefined,
    {},
    buildStub(),
  );

  await cmdPlugin(["add", processPlugin("trace"), "--trust"]);
  assert.equal((await readPluginsState(data)).plugins[0].trusted, true);
  assert.match(
    messages(events, "warn"),
    /no systemd here: the units of the plugin are not written/u,
  );
});

test("a trust whose version build fails leaves the plugin untrusted", async () => {
  const root = home();
  const units = unitWorld();
  const build = buildStub();
  const { cmdPlugin, data } = commands(root, undefined, undefined, {}, build, {
    units,
  });
  await cmdPlugin(["add", processPlugin("trace")]);
  build.outcome = { status: "failed", reason: "eve: boom" };

  await assert.rejects(
    cmdPlugin(["trust", "trace"]),
    /trace stays untrusted: eve: boom/u,
  );

  assert.equal((await readPluginsState(data)).plugins[0].trusted, false);
  assert.deepEqual(units.units(), [], "nothing runs for an untrusted plugin");
});

test("a plugin whose MCP is all remote is not trusted by a question nobody asked", async () => {
  const root = home();
  const folder = join(world("remote"), "weather");
  plantPlugin(folder, "weather");
  write(
    folder,
    "mcp.json",
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: {
        api: { type: "streamable-http", url: "https://a.test/mcp" },
      },
    }),
  );
  const units = unitWorld();
  const build = buildStub();
  const { cmdPlugin, events, printed, data } = commands(
    root,
    undefined,
    undefined,
    {},
    build,
    // Ответ «да» здесь бы солгал: вопрос про процессы, а процессов нет.
    { units, confirm: () => Promise.resolve(true) },
  );

  await cmdPlugin(["add", folder]);
  assert.equal((await readPluginsState(data)).plugins[0].trusted, false);
  assert.doesNotMatch(printed.join("\n"), /wants to run processes/u);
  assert.match(
    messages(events, "warn"),
    /weather is not trusted: its MCP servers and services stay off/u,
  );
  assert.deepEqual(
    build.calls,
    [],
    "an untrusted remote server builds nothing",
  );

  // `--trust` — прямое разрешение владельца, и его достаточно.
  const second = home();
  const explicit = commands(second, undefined, undefined, {}, buildStub(), {
    units: unitWorld(),
  });
  await explicit.cmdPlugin(["add", folder, "--trust"]);
  assert.equal(
    (await readPluginsState(explicit.data)).plugins[0].trusted,
    true,
  );
});

test("an update that changes only the plugin's code still restarts its unit", async () => {
  // Плагин с одним сервисом и без кода: в версию он не попадает вовсе, поэтому рестарт
  // юнита — единственное, что переводит его на новый код.
  const service = JSON.stringify({
    command: "node",
    args: ["server.mjs"],
    port: 8726,
  });
  const source = bareRemote((work) => {
    plantPlugin(work, "svc");
    write(
      work,
      "plugin.json",
      manifest("svc", "1.0.0", { extensions: { "sh.iva": {} } }),
    );
    write(work, "sh.iva/services/web/service.json", service);
    write(work, "sh.iva/services/web/server.mjs", "// v1\n");
  });
  const root = home();
  const units = unitWorld();
  const { cmdPlugin, events, data } = commands(
    root,
    undefined,
    undefined,
    {},
    buildStub(),
    { units },
  );

  await cmdPlugin(["add", source.url, "--trust"]);
  assert.deepEqual(units.units(), ["iva-plugin-svc-web.service"]);
  assert.deepEqual(units.active(), ["iva-plugin-svc-web.service"]);

  // Автор выпустил новую версию сервера. `service.json` не менялся: тело юнита будет
  // байт в байт тем же, а код за ним — другим.
  write(source.work, "sh.iva/services/web/server.mjs", "// v2\n");
  git(["add", "-A"], source.work);
  git(["commit", "-qm", "v2"], source.work);
  git(["push", "-q", source.url, "HEAD:refs/heads/main"], source.work);
  units.calls.length = 0;
  events.length = 0;

  await cmdPlugin(["update", "svc"]);

  assert.equal(
    readFileSync(
      join(pluginRoot(data, "svc"), "sh.iva/services/web/server.mjs"),
      "utf8",
    ),
    "// v2\n",
  );
  assert.ok(
    units.calls.includes("restart iva-plugin-svc-web.service"),
    units.calls.join("\n"),
  );
  assert.match(
    messages(events, "ok"),
    /restarted: iva-plugin-svc-web\.service/u,
  );

  // Второй `update` без нового коммита ничего не перезапускает: содержимое то же.
  units.calls.length = 0;
  await cmdPlugin(["update", "svc"]);
  assert.equal(
    units.calls.includes("restart iva-plugin-svc-web.service"),
    false,
    units.calls.join("\n"),
  );
});
