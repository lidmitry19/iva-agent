/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Свойства ридера плагина. Якоря контракта — в plugin-reader.test.ts; здесь генератор
// подсовывает то, чего автор теста не придумает: манифест из случайного JSON, дерево
// с симлинками и мусорными именами, имя плагина из произвольных символов.
//
// КАК ВОСПРОИЗВЕСТИ ПАДЕНИЕ: при провале fast-check печатает строку вида
// `Property failed after N tests { seed: -1234567, path: "12:3:0", endOnFailure: true }`.
// Подставь её вторым аргументом — fc.assert(prop, { seed: -1234567, path: "12:3:0" }) —
// и прогон повторится байт в байт, включая shrink.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import fc from "fast-check";
import {
  MCP_SCHEMA_URL,
  PLUGIN_SCHEMA_URL,
  pluginNameProblem,
  readPlugin,
} from "./plugin-reader.ts";

const worlds: string[] = [];

after(() => {
  for (const dir of worlds) rmSync(dir, { recursive: true, force: true });
});

function world(): string {
  const dir = mkdtempSync(join(tmpdir(), "iva-plugin-reader-pbt-"));
  worlds.push(dir);
  return dir;
}

function write(root: string, path: string, contents: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

const RUNS = { numRuns: 60 };

// Опубликованный регэксп схемы 1.0.0 целиком, с lookahead. Ридер проверяет то же
// правило по частям, чтобы называть причину отказа; расхождение — ошибка ридера.
const PUBLISHED_NAME = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u;

test("property: the decomposed name check equals the published schema pattern", () => {
  fc.assert(
    fc.property(
      fc.oneof(
        fc.string(),
        fc.stringMatching(/^[a-z0-9.-]{0,12}$/u),
        fc.constantFrom(
          "a",
          "",
          "a".repeat(64),
          "a".repeat(65),
          "a--b",
          "a..b",
        ),
      ),
      (name) => {
        const accepted = pluginNameProblem(name) === null;
        const expected =
          name.length >= 1 && name.length <= 64 && PUBLISHED_NAME.test(name);
        assert.equal(accepted, expected, JSON.stringify(name));
      },
    ),
    RUNS,
  );
});

test("property: any JSON manifest is accepted or rejected with a reason, never a throw", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.oneof(
        fc.json(),
        fc
          .record(
            {
              $schema: fc.constantFrom(PLUGIN_SCHEMA_URL, "other", 1),
              name: fc.oneof(fc.string(), fc.constantFrom("demo", "a.b", 7)),
              version: fc.oneof(fc.string(), fc.integer()),
              author: fc.oneof(
                fc.record({ name: fc.string() }),
                fc.string(),
                fc.record({ nickname: fc.string() }),
              ),
              keywords: fc.oneof(fc.array(fc.string()), fc.string()),
              extensions: fc.oneof(
                fc.dictionary(fc.string(), fc.object()),
                fc.string(),
              ),
              surprise: fc.integer(),
            },
            { requiredKeys: [] },
          )
          .map((value) => JSON.stringify(value)),
      ),
      async (raw) => {
        const dir = mkdtempSync(join(world(), "manifest-"));
        writeFileSync(join(dir, "plugin.json"), raw);

        const report = await readPlugin(dir);
        if (report.manifest === null) {
          assert.ok(
            report.diagnostics.length > 0,
            "a rejection needs a reason",
          );
          assert.deepEqual(report.skills, []);
          assert.deepEqual(report.mcp, {});
          return;
        }
        // Принят — значит манифест удовлетворяет закрытой схеме.
        const parsed: unknown = JSON.parse(raw);
        assert.ok(parsed !== null && typeof parsed === "object");
        const manifest = parsed as Record<string, unknown>;
        assert.equal(manifest.$schema, PLUGIN_SCHEMA_URL);
        assert.equal(pluginNameProblem(manifest.name), null);
        assert.equal(report.manifest.name, manifest.name);
      },
    ),
    RUNS,
  );
});

type Entry = {
  readonly path: string;
  readonly kind: "file" | "dir" | "symlink" | "skill" | "brokenSkill";
};

const segment = fc.constantFrom(
  "skills",
  "alpha",
  "beta",
  "sh.iva",
  "mcp.json",
  "nested",
  "привет",
  ".hidden",
  "SKILL.md",
);

const entry: fc.Arbitrary<Entry> = fc.record({
  path: fc
    .array(segment, { minLength: 1, maxLength: 4 })
    .map((parts) => parts.join("/")),
  kind: fc.constantFrom<Entry["kind"]>(
    "file",
    "dir",
    "symlink",
    "skill",
    "brokenSkill",
  ),
});

function plant(dir: string, entries: readonly Entry[]): void {
  for (const item of entries) {
    const target = join(dir, item.path);
    if (existsSync(target)) continue;
    try {
      switch (item.kind) {
        case "file":
          write(dir, item.path, "content\n");
          break;
        case "dir":
          mkdirSync(target, { recursive: true });
          break;
        case "symlink":
          mkdirSync(dirname(target), { recursive: true });
          symlinkSync("/etc/hosts", target);
          break;
        case "skill":
          write(
            dir,
            `skills/${item.path.split("/")[0]}/SKILL.md`,
            "---\nname: s\ndescription: d\n---\n\nbody\n",
          );
          break;
        case "brokenSkill":
          write(
            dir,
            `skills/${item.path.split("/")[0]}/notes.md`,
            "no skill\n",
          );
          break;
      }
    } catch {
      // Дерево генерится наугад: файл на месте папки и наоборот — часть входа.
    }
  }
}

test("property: any directory tree yields a report, never an exception", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(entry, { maxLength: 8 }),
      fc.boolean(),
      async (entries, withManifest) => {
        const dir = mkdtempSync(join(world(), "tree-"));
        if (withManifest)
          write(
            dir,
            "plugin.json",
            JSON.stringify({ $schema: PLUGIN_SCHEMA_URL, name: "demo" }),
          );
        plant(dir, entries);

        const report = await readPlugin(dir);
        assert.equal(report.root, resolve(dir));
        for (const line of report.diagnostics)
          assert.equal(typeof line, "string");
        if (!withManifest) assert.equal(report.manifest, null);
      },
    ),
    RUNS,
  );
});

test("property: every accepted skill path stays inside the plugin root", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(entry, { maxLength: 8 }), async (entries) => {
      const dir = mkdtempSync(join(world(), "contained-"));
      write(
        dir,
        "plugin.json",
        JSON.stringify({ $schema: PLUGIN_SCHEMA_URL, name: "demo" }),
      );
      plant(dir, entries);

      const report = await readPlugin(dir);
      for (const skill of report.skills) {
        const inside = relative(report.root, resolve(report.root, skill.path));
        assert.ok(
          inside && !inside.startsWith(".."),
          `${skill.path} escapes the root`,
        );
        const markdown = join(report.root, skill.path, "SKILL.md");
        assert.ok(
          lstatSync(markdown).isFile(),
          `${skill.path} has no SKILL.md`,
        );
      }
    }),
    RUNS,
  );
});

const command = fc.oneof(
  fc.constantFrom(
    "node",
    "./bin/server",
    "./../outside/bin",
    "./a/../../b",
    "./sub/./ok",
    "node server.js",
    "${PLUGIN_ROOT}/bin",
    "/usr/bin/node",
  ),
  fc.string({ maxLength: 8 }),
);

const cwd = fc.constantFrom(
  "./tools",
  "./../outside",
  "${PLUGIN_ROOT}",
  "${PLUGIN_ROOT}/x",
  "${PLUGIN_DATA}/x",
  "tools",
);

const url = fc.constantFrom(
  "https://a.test/mcp",
  "http://a.test/mcp",
  "http://localhost:1/mcp",
  "https://u:p@a.test/mcp",
  "not a url",
);

// Записи генерятся по форме транспорта, а не одним общим объектом: закрытая схема
// отвергает чужое поле раньше всех прочих проверок, и «универсальная» запись почти
// никогда не доходила бы до принятия — свойство стало бы пустым.
const stdioEntry = fc.record(
  {
    type: fc.constantFrom("stdio", "stdio", "grpc"),
    command,
    args: fc.oneof(
      fc.array(fc.string({ maxLength: 6 }), { maxLength: 2 }),
      fc.string(),
    ),
    env: fc.oneof(
      fc.dictionary(fc.string({ maxLength: 6 }), fc.string({ maxLength: 6 }), {
        maxKeys: 2,
      }),
      fc.constant({ PLUGIN_ROOT: "/tmp" }),
    ),
    cwd,
  },
  { requiredKeys: ["type", "command"] },
);

const remoteEntry = fc.record(
  {
    type: fc.constantFrom("streamable-http", "sse", "http"),
    url,
    headers: fc.oneof(
      fc.dictionary(fc.string({ maxLength: 6 }), fc.string({ maxLength: 6 }), {
        maxKeys: 2,
      }),
      fc.constant({ "X-A": "1", "x-a": "2" }),
    ),
  },
  { requiredKeys: ["type", "url"] },
);

const mcpEntry = fc.oneof(
  stdioEntry,
  remoteEntry,
  fc.string(),
  fc.constant(null),
  fc.record({ type: fc.constant("stdio"), command: fc.string(), url }),
);

test("property: any mcp.json yields servers or reasons, and every accepted path is contained", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.oneof(
        fc.json().map((raw) => JSON.parse(raw) as unknown),
        fc
          .record(
            {
              $schema: fc.constantFrom(MCP_SCHEMA_URL, PLUGIN_SCHEMA_URL, 2),
              mcpServers: fc.oneof(
                fc.dictionary(fc.string({ maxLength: 6 }), mcpEntry, {
                  maxKeys: 4,
                }),
                fc.array(mcpEntry, { maxLength: 2 }),
              ),
              extra: fc.integer(),
            },
            { requiredKeys: ["$schema"] },
          )
          .map((value) => value as unknown),
      ),
      async (document) => {
        const dir = mkdtempSync(join(world(), "mcp-"));
        write(
          dir,
          "plugin.json",
          JSON.stringify({ $schema: PLUGIN_SCHEMA_URL, name: "demo" }),
        );
        writeFileSync(join(dir, "mcp.json"), JSON.stringify(document));

        const report = await readPlugin(dir);
        // Битый mcp.json не валит плагин: манифест остаётся принятым.
        assert.notEqual(report.manifest, null);
        for (const [name, server] of Object.entries(report.mcp)) {
          assert.equal(typeof name, "string");
          if (server.type !== "stdio") {
            assert.match(server.url, /^https?:\/\//u);
            continue;
          }
          if (!server.command.startsWith("./")) continue;
          const target = resolve(report.root, server.command);
          const inside = relative(report.root, target);
          assert.ok(
            inside && !inside.startsWith(".."),
            `${server.command} escapes the root`,
          );
        }
      },
    ),
    RUNS,
  );
});

// Путь из случайных сегментов, где `..` встречается ровно так же часто, как обычное
// имя: половина команд вылезает из корня, и правило containment проверяется на деле,
// а не на удачно выпавшей константе.
const relativePath = fc
  .array(fc.constantFrom("bin", "..", ".", "sub", "server"), {
    minLength: 1,
    maxLength: 4,
  })
  .map((parts) => `./${parts.join("/")}`);

test("property: an accepted ./command or ./cwd never leaves the plugin root", async () => {
  await fc.assert(
    fc.asyncProperty(
      relativePath,
      relativePath,
      async (commandPath, cwdPath) => {
        const dir = mkdtempSync(join(world(), "contain-"));
        write(
          dir,
          "plugin.json",
          JSON.stringify({ $schema: PLUGIN_SCHEMA_URL, name: "demo" }),
        );
        write(
          dir,
          "mcp.json",
          JSON.stringify({
            $schema: MCP_SCHEMA_URL,
            mcpServers: {
              one: { type: "stdio", command: commandPath },
              two: { type: "stdio", command: "node", cwd: cwdPath },
            },
          }),
        );

        const report = await readPlugin(dir);
        // Сам корень тоже внутри корня: `./bin/..` — это корень, и спека такой
        // `cwd` разрешает.
        const contained = (path: string): boolean =>
          !relative(report.root, resolve(report.root, path)).startsWith("..");
        const one = report.mcp.one;
        if (one && one.type === "stdio")
          assert.ok(contained(one.command), `${one.command} escapes the root`);
        const two = report.mcp.two;
        if (two && two.type === "stdio" && two.cwd)
          assert.ok(contained(two.cwd), `${two.cwd} escapes the root`);
      },
    ),
    RUNS,
  );
});
