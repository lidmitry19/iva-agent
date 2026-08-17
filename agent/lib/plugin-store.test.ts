/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Якоря состояния плагинов: что попадает в plugins.json, что из него выпадает и что
// делает битый файл. Свойства на случайном JSON — ниже, в том же файле: генератор
// здесь нужен ровно один и держит инвариант «любой вход → состояние, не исключение».
import test, { after } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import {
  EMPTY_PLUGINS_STATE,
  enabledPlugins,
  findPlugin,
  normalizePluginsState,
  pluginDataDir,
  pluginRoot,
  pluginsDir,
  pluginsStateFile,
  readPluginsState,
  readPluginsStateSafe,
  removePlugin,
  upsertPlugin,
  writePluginsState,
  type PluginEntry,
} from "./plugin-store.ts";

const worlds: string[] = [];

after(() => {
  for (const dir of worlds) rmSync(dir, { recursive: true, force: true });
});

function world(): string {
  const dir = mkdtempSync(join(tmpdir(), "iva-plugin-store-"));
  worlds.push(dir);
  return dir;
}

function entry(overrides: Partial<PluginEntry> = {}): PluginEntry {
  return {
    name: "demo",
    source: "smixs/iva-plugins/trace",
    ref: "main",
    sha: "a".repeat(40),
    digest: "d".repeat(64),
    enabled: true,
    trusted: false,
    installedAt: "2026-08-17T10:00:00.000Z",
    ...overrides,
  };
}

test("the layout keeps plugin data outside the plugins folder", () => {
  const data = "/srv/iva/data";
  assert.equal(pluginsDir(data), "/srv/iva/data/custom/plugins");
  assert.equal(pluginRoot(data, "trace"), "/srv/iva/data/custom/plugins/trace");
  assert.equal(pluginsStateFile(data), "/srv/iva/data/custom/plugins.json");
  assert.equal(pluginDataDir(data, "trace"), "/srv/iva/data/plugin-data/trace");
});

test("a missing state file reads as empty state, not as an error", async () => {
  assert.deepEqual(await readPluginsState(world()), EMPTY_PLUGINS_STATE);
});

test("state survives a write and a read byte for byte", async () => {
  const data = world();
  const state = {
    marketplaces: ["smixs/iva-plugins"],
    plugins: [entry(), entry({ name: "alpha", enabled: false, trusted: true })],
    riskNoticeShownAt: "2026-08-17T09:00:00.000Z",
  };

  await writePluginsState(data, state);
  const read = await readPluginsState(data);

  assert.deepEqual(read.marketplaces, ["smixs/iva-plugins"]);
  assert.deepEqual(
    read.plugins.map((item) => item.name),
    ["alpha", "demo"],
  );
  assert.equal(read.riskNoticeShownAt, "2026-08-17T09:00:00.000Z");
  assert.equal(findPlugin(read, "alpha")?.trusted, true);
  assert.deepEqual(
    enabledPlugins(read).map((item) => item.name),
    ["demo"],
  );
  // Пишем в data/custom/, каталог создаём сами: свежая инсталляция его не имеет.
  assert.ok(existsSync(pluginsStateFile(data)));
});

test("junk entries fall out and the survivors keep their order", () => {
  const state = normalizePluginsState({
    marketplaces: ["ok", 7, { name: "x" }],
    plugins: [
      { name: "zeta", source: "./z" },
      "not an entry",
      { name: "Bad Name" },
      { name: "alpha", enabled: false, trusted: "yes" },
      { name: "alpha", source: "duplicate" },
      null,
    ],
    unknownField: true,
  });

  assert.deepEqual(state.marketplaces, ["ok"]);
  assert.deepEqual(
    state.plugins.map((item) => item.name),
    ["alpha", "zeta"],
  );
  // Отсутствующий тумблер = включён; trusted включается только явным true.
  assert.equal(findPlugin(state, "zeta")?.enabled, true);
  assert.equal(findPlugin(state, "alpha")?.enabled, false);
  assert.equal(findPlugin(state, "alpha")?.trusted, false);
  assert.equal(findPlugin(state, "alpha")?.source, "");
});

test("upsert replaces one plugin and remove takes only its entry", () => {
  const first = upsertPlugin(EMPTY_PLUGINS_STATE, entry());
  const replaced = upsertPlugin(first, entry({ sha: "b".repeat(40) }));
  assert.equal(replaced.plugins.length, 1);
  assert.equal(replaced.plugins[0].sha, "b".repeat(40));
  // Чистая функция: исходное состояние не тронуто.
  assert.equal(first.plugins[0].sha, "a".repeat(40));

  const both = upsertPlugin(replaced, entry({ name: "alpha" }));
  assert.deepEqual(
    removePlugin(both, "demo").plugins.map((item) => item.name),
    ["alpha"],
  );
});

test("a damaged plugins.json is reported and left exactly where it is", async () => {
  const data = world();
  mkdirSync(join(data, "custom"), { recursive: true });
  const file = pluginsStateFile(data);
  writeFileSync(file, "{ not json");

  // Читает КАЖДЫЙ ход агента: чтение, которое чинит файл, однажды унесло бы список
  // плагинов молча, посреди разговора.
  const first = await readPluginsStateSafe(data);
  assert.deepEqual(first.state, EMPTY_PLUGINS_STATE);
  assert.match(first.damaged?.message ?? "", /not valid JSON/u);
  assert.match(first.damaged?.message ?? "", /iva plugin sync/u);
  const second = await readPluginsStateSafe(data);
  assert.equal(second.damaged !== null, true);

  assert.deepEqual(readdirSync(join(data, "custom")), ["plugins.json"]);
  assert.equal(readFileSync(file, "utf8"), "{ not json");

  // Команда владельца обязана упереться, а не работать на пустом состоянии.
  await assert.rejects(readPluginsState(data), /not valid JSON/u);
});

test("an unreadable state file is damaged, not empty", async () => {
  const data = world();
  mkdirSync(join(data, "custom"), { recursive: true });
  mkdirSync(pluginsStateFile(data)); // каталог вместо файла — читается с EISDIR

  const { state, damaged } = await readPluginsStateSafe(data);
  assert.deepEqual(state, EMPTY_PLUGINS_STATE);
  assert.match(damaged?.message ?? "", /unreadable/u);
});

const RUNS = { numRuns: 100 };

// Половина входа — чистый мусор, половина — правдоподобное состояние: иначе ветка
// разбора записи почти никогда бы не выполнилась.
const rawState = fc.oneof(
  fc.json().map((raw) => JSON.parse(raw) as unknown),
  fc.record(
    {
      marketplaces: fc.oneof(fc.array(fc.string()), fc.string()),
      riskNoticeShownAt: fc.oneof(fc.string(), fc.integer()),
      plugins: fc.array(
        fc.oneof(
          fc.record(
            {
              name: fc.oneof(
                fc.constantFrom("demo", "a.b", "Bad Name", ""),
                fc.string(),
              ),
              source: fc.oneof(fc.string(), fc.integer()),
              ref: fc.string(),
              sha: fc.string(),
              digest: fc.oneof(fc.string(), fc.integer()),
              enabled: fc.oneof(fc.boolean(), fc.string()),
              trusted: fc.oneof(fc.boolean(), fc.string()),
              installedAt: fc.string(),
            },
            { requiredKeys: [] },
          ),
          fc.string(),
          fc.constant(null),
        ),
        { maxLength: 5 },
      ),
    },
    { requiredKeys: [] },
  ),
);

test("property: any JSON becomes a state, and normalizing twice changes nothing", () => {
  fc.assert(
    fc.property(rawState, (raw) => {
      const state = normalizePluginsState(raw);
      for (const market of state.marketplaces)
        assert.equal(typeof market, "string");
      for (const item of state.plugins) {
        assert.equal(typeof item.name, "string");
        assert.equal(typeof item.enabled, "boolean");
        assert.equal(typeof item.trusted, "boolean");
        assert.equal(typeof item.sha, "string");
        assert.equal(typeof item.digest, "string");
      }
      assert.deepEqual(normalizePluginsState(state), state);
    }),
    RUNS,
  );
});
