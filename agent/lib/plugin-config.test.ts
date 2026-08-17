/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Конфиг плагина в рантайме: его читает сгенерированный mount при загрузке модуля, и
// упасть ему нельзя — иначе один плагин уронит весь ход.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readPluginConfig } from "./plugin-config.ts";
import { pluginConfigFile } from "./plugin-store.ts";

const worlds: string[] = [];
after(() => {
  for (const dir of worlds) rmSync(dir, { recursive: true, force: true });
});

/** Временный data-каталог как ASSISTANT_DATA_DIR: путь читается из env, как в юните. */
function dataDir(t: { after(fn: () => void): void }): string {
  const home = mkdtempSync(join(tmpdir(), "iva-plugin-config-"));
  worlds.push(home);
  const data = join(home, "data");
  mkdirSync(data, { recursive: true });
  const before = process.env.ASSISTANT_DATA_DIR;
  process.env.ASSISTANT_DATA_DIR = data;
  t.after(() => {
    if (before === undefined) delete process.env.ASSISTANT_DATA_DIR;
    else process.env.ASSISTANT_DATA_DIR = before;
  });
  return data;
}

function write(data: string, name: string, contents: string): void {
  const file = pluginConfigFile(data, name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents);
}

test("the config of a plugin is read from the file beside its folder", (t) => {
  const data = dataDir(t);
  write(data, "trace", JSON.stringify({ level: "debug", limit: 5 }));

  assert.deepEqual(readPluginConfig("trace"), { level: "debug", limit: 5 });
  assert.equal(
    pluginConfigFile(data, "trace"),
    join(data, "custom/plugins/trace.config.json"),
  );
});

test("a missing, unreadable or non-object config is an empty config, never a throw", (t) => {
  const data = dataDir(t);

  assert.deepEqual(readPluginConfig("absent"), {});
  for (const contents of ["{oh no", "[]", "null", '"text"', ""]) {
    write(data, "trace", contents);
    assert.deepEqual(readPluginConfig("trace"), {}, contents);
  }
  // Каталог вместо файла — тоже не повод падать.
  mkdirSync(pluginConfigFile(data, "folder"), { recursive: true });
  assert.deepEqual(readPluginConfig("folder"), {});
});
