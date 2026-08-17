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

const skillName = fc.constantFrom(
  "alpha",
  "beta",
  "at.tach",
  "привет",
  "-lead",
);

const skillShape = fc.constantFrom(
  "valid",
  "noFrontmatter",
  "noDescription",
  "noName",
  "directory",
  "absent",
);

type PlantedSkill = { readonly name: string; readonly shape: string };

test("property: a skill is accepted exactly when the Agent Skills rules are met", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.uniqueArray(fc.record({ name: skillName, shape: skillShape }), {
        maxLength: 6,
        selector: (item: PlantedSkill) => item.name,
      }),
      async (planted) => {
        const dir = mkdtempSync(join(world(), "skills-"));
        write(
          dir,
          "plugin.json",
          JSON.stringify({ $schema: PLUGIN_SCHEMA_URL, name: "demo" }),
        );
        for (const { name, shape } of planted) {
          const path = `skills/${name}/SKILL.md`;
          if (shape === "valid")
            write(dir, path, "---\nname: s\ndescription: d\n---\n\nbody\n");
          if (shape === "noFrontmatter") write(dir, path, "body only\n");
          if (shape === "noDescription")
            write(dir, path, "---\nname: s\n---\n\nbody\n");
          if (shape === "noName")
            write(dir, path, "---\ndescription: d\n---\n\nbody\n");
          if (shape === "directory") write(dir, `${path}/inside.txt`, "x\n");
          if (shape === "absent") write(dir, `skills/${name}/notes.md`, "x\n");
        }

        const report = await readPlugin(dir);
        const expected = planted
          .filter(
            ({ name, shape }) =>
              shape === "valid" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name),
          )
          .map(({ name }) => name)
          .sort();
        assert.deepEqual(
          report.skills.map((skill) => skill.name).sort(),
          expected,
        );
        // На каждый пропуск — своя строка: молча терять скилл нельзя.
        for (const { name, shape } of planted)
          if (shape !== "valid" || !expected.includes(name))
            assert.ok(
              report.diagnostics.some((line) =>
                line.includes(`skills/${name}:`),
              ),
              `no diagnostic for ${name}`,
            );
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
