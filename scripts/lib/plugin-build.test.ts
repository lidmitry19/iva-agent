/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Namespace плагина, чтение стора и генерация mount'а. Сборка версии с плагином целиком
// проверяется харнесом апдейтера (scripts/lib/version-update.test.ts); здесь — куски,
// у которых есть свои границы: отображение имени в имя файла и отчёт о том, что
// пропущено.
//
// КАК ВОСПРОИЗВЕСТИ ПАДЕНИЕ свойства: fast-check печатает строку вида
// `Property failed after N tests { seed: -1234567, path: "12:3:0", endOnFailure: true }`.
// Подставь её вторым аргументом — fc.assert(prop, { seed: -1234567, path: "12:3:0" }) —
// и прогон повторится байт в байт, включая shrink.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import fc from "fast-check";
import { PLUGIN_SCHEMA_URL, pluginNameProblem } from "#lib/plugin-reader.ts";
import { readPluginsState } from "#lib/plugin-store.ts";
import {
  codePlugins,
  disableCodePlugin,
  mountSource,
  namespaceProblem,
  namespaceTaken,
  pluginDirectory,
  pluginMount,
  pluginNamespace,
} from "./plugin-build.ts";

const worlds: string[] = [];
after(() => {
  for (const dir of worlds) rmSync(dir, { recursive: true, force: true });
});

function world(): string {
  const dir = mkdtempSync(join(tmpdir(), "iva-plugin-build-"));
  worlds.push(dir);
  return dir;
}

function write(root: string, path: string, contents: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

/** Папка плагина в сторе плюс запись о нём. */
function plant(
  data: string,
  name: string,
  { code = true, config }: { code?: boolean; config?: string } = {},
): void {
  write(
    data,
    `custom/plugins/${name}/plugin.json`,
    JSON.stringify({ $schema: PLUGIN_SCHEMA_URL, name, version: "1.0.0" }),
  );
  if (code)
    write(
      data,
      `custom/plugins/${name}/sh.iva/package.json`,
      JSON.stringify({
        name,
        eve: { extension: { source: "./extension", dist: "./dist/extension" } },
      }),
    );
  if (config !== undefined)
    write(data, `custom/plugins/${name}.config.json`, config);
}

function state(
  data: string,
  entries: readonly { name: string; enabled?: boolean }[],
): void {
  write(
    data,
    "custom/plugins.json",
    JSON.stringify({
      marketplaces: [],
      plugins: entries.map((entry) => ({
        name: entry.name,
        source: `/tmp/${entry.name}`,
        ref: "",
        sha: "",
        digest: "",
        enabled: entry.enabled ?? true,
        trusted: false,
        installedAt: "2026-08-17T00:00:00.000Z",
      })),
    }),
  );
}

test("a namespace is the plugin name with dots and dashes folded to underscores", () => {
  assert.equal(pluginNamespace("trace"), "trace");
  assert.equal(pluginNamespace("my-tool"), "my_tool");
  assert.equal(pluginNamespace("sh.iva.trace"), "sh_iva_trace");
  assert.equal(pluginMount("my-tool"), "agent/extensions/my_tool.ts");
  assert.equal(pluginDirectory("my-tool"), "plugins/my-tool");
});

test("a name eve cannot use as a mount file is refused, not bent into shape", () => {
  // Имя плагина по спеке может начинаться с цифры, а mount у eve — только с буквы.
  assert.equal(namespaceProblem("trace"), null);
  assert.equal(namespaceProblem("my-tool"), null);
  assert.match(namespaceProblem("7zip") ?? "", /eve accepts a letter/u);
  assert.match(namespaceProblem("a".repeat(65)) ?? "", /64 characters/u);
});

test("two names that fold onto one namespace name each other", () => {
  assert.equal(namespaceTaken("my-tool", ["my.tool", "other"]), "my.tool");
  assert.equal(namespaceTaken("my-tool", ["my-tool"]), null); // сам себе не помеха
  assert.equal(namespaceTaken("my-tool", ["other"]), null);
});

test("the mount eve reads names the plugin package and reads its config at load", () => {
  const source = mountSource({
    name: "my-tool",
    root: "/data/custom/plugins/my-tool",
    namespace: "my_tool",
    mount: pluginMount("my-tool"),
    directory: pluginDirectory("my-tool"),
    digest: "abc",
    config: "",
  });
  // Форма, которую eve разбирает статически: `export default <ident>(…)` плюс импорт
  // того же имени по относительному спецификатору.
  assert.match(
    source,
    /^import extension from "\.\.\/\.\.\/plugins\/my-tool\/sh\.iva";$/mu,
  );
  assert.match(
    source,
    /^export default extension\(readPluginConfig\("my-tool"\)\);$/mu,
  );
  assert.match(source, /do not edit/u);
});

test("only the enabled plugins with code are what a version carries", async () => {
  const data = join(world(), "data");
  plant(data, "trace", { config: '{"level":"debug"}\n' });
  plant(data, "skills-only", { code: false });
  plant(data, "off");
  state(data, [
    { name: "trace" },
    { name: "skills-only" },
    { name: "off", enabled: false },
  ]);

  const { plugins, diagnostics } = await codePlugins(data);

  assert.deepEqual(
    plugins.map((plugin) => plugin.name),
    ["trace"],
  );
  assert.deepEqual(diagnostics, []);
  const [trace] = plugins;
  assert.equal(trace.mount, "agent/extensions/trace.ts");
  assert.equal(trace.directory, "plugins/trace");
  assert.equal(trace.config, '{"level":"debug"}\n');
  assert.match(trace.digest, /^[a-f0-9]{64}$/u);
});

test("a plugin the reader refuses is left out of the build and named", async () => {
  const data = join(world(), "data");
  plant(data, "trace");
  write(data, "custom/plugins/broken/plugin.json", "{oh no");
  state(data, [{ name: "trace" }, { name: "broken" }, { name: "gone" }]);

  const { plugins, diagnostics } = await codePlugins(data);

  assert.deepEqual(
    plugins.map((plugin) => plugin.name),
    ["trace"],
  );
  assert.equal(diagnostics.length, 2, diagnostics.join("\n"));
  assert.ok(
    diagnostics.every((line) => /is left out of this build/u.test(line)),
    diagnostics.join("\n"),
  );
});

test("a damaged plugins.json leaves the build with no plugins and says so", async () => {
  const data = join(world(), "data");
  write(data, "custom/plugins.json", "{not json");

  const { plugins, diagnostics } = await codePlugins(data);

  assert.deepEqual(plugins, []);
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0], /left out of this build/u);
});

test("switching a plugin off is one field in plugins.json", async () => {
  const data = join(world(), "data");
  plant(data, "trace");
  state(data, [{ name: "trace" }]);

  assert.equal(await disableCodePlugin(data, "trace"), true);
  assert.equal((await readPluginsState(data)).plugins[0].enabled, false);
  // Второй раз выключать нечего, и файл не переписывается зря.
  assert.equal(await disableCodePlugin(data, "trace"), false);
  assert.equal(await disableCodePlugin(data, "absent"), false);
});

test("any name the spec allows either maps to a mount eve accepts or is refused", () => {
  fc.assert(
    fc.property(
      fc.oneof(
        fc.stringMatching(/^[a-z0-9][a-z0-9.-]{0,20}[a-z0-9]$/u),
        fc.stringMatching(/^[a-z0-9]$/u),
        fc.string(),
      ),
      (name) => {
        // Свойство только про имена, которые ридер вообще принимает.
        if (pluginNameProblem(name) !== null) return true;
        const namespace = pluginNamespace(name);
        if (namespaceProblem(name) !== null) return true;
        assert.match(namespace, /^[a-z][a-z0-9_]{0,63}$/u);
        // Имя файла — один сегмент пути: ни разделителей, ни точек.
        assert.equal(pluginMount(name), `agent/extensions/${namespace}.ts`);
        assert.equal(namespace.includes("/"), false);
        assert.equal(namespace.includes("."), false);
        return true;
      },
    ),
  );
});

test("names collide exactly when their folded forms are equal", () => {
  fc.assert(
    fc.property(
      fc.stringMatching(/^[a-z][a-z0-9.-]{0,10}[a-z0-9]$/u),
      fc.stringMatching(/^[a-z][a-z0-9.-]{0,10}[a-z0-9]$/u),
      (first, second) => {
        fc.pre(
          pluginNameProblem(first) === null &&
            pluginNameProblem(second) === null &&
            first !== second,
        );
        const folded = pluginNamespace(first) === pluginNamespace(second);
        assert.equal(namespaceTaken(first, [second]) !== null, folded);
        assert.equal(namespaceTaken(second, [first]) !== null, folded);
        return true;
      },
    ),
  );
});
