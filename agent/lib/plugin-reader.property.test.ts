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
        assert.ok(Array.isArray(report.diagnostics));
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
