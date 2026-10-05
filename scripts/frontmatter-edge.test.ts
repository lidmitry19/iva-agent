/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Краевые случаи frontmatter.ts, найденные ревью: запятые в квотированных элементах
// flow-списка, YAML-неоднозначные скаляры, одиночный пробел как continuation, пустая
// строка внутри перезаписываемого folded-блока.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import {
  FrontmatterParseError,
  formatField,
  parseFrontmatter,
  renderCardDocument,
  writeFrontmatter,
} from "../agent/lib/frontmatter.ts";

interface ScalarCorpus {
  scalars: string[];
  legacy_single_quoted: Array<{ encoded: string; decoded: string }>;
  garbage: string[];
  controlled_errors: string[];
}

const corpus = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "fixtures/frontmatter-scalar-corpus.cases.json",
    ),
    "utf8",
  ),
) as ScalarCorpus;

const parseValue = (encoded: string) =>
  parseFrontmatter(`---\nvalue: ${encoded}\n---\n`).fields?.value;

test("flow-список: запятая внутри кавычек не рвёт элемент (полный round-trip)", () => {
  const parsed = parseFrontmatter(
    '---\ntags: [work, "a, b", plain]\n---\nbody',
  );
  assert.ok(parsed.fields);
  const { fields } = parsed;
  assert.deepEqual(fields.tags, ["work", "a, b", "plain"]);
  // parse → write → parse: значение обязано пережить полный цикл без искажений.
  const rewritten = writeFrontmatter(fields, []);
  const again = parseFrontmatter(`---\n${rewritten}\n---\nbody`);
  assert.ok(again.fields);
  assert.deepEqual(again.fields.tags, ["work", "a, b", "plain"]);
});

test("YAML-неоднозначные скаляры квотируются (PyYAML не превратит их в bool/null)", () => {
  const text = writeFrontmatter(
    { status: "no", note: "null", ok: "обычное" },
    [],
  );
  assert.match(text, /status: "no"/);
  assert.match(text, /note: "null"/);
  assert.match(text, /ok: "обычное"/);
});

test("D6/M13/M14: общий corpus имеет JSON serialization и quote-aware legacy parse", () => {
  for (const value of corpus.scalars) {
    assert.equal(
      formatField("value", value),
      `value: ${JSON.stringify(value)}`,
    );
    assert.equal(parseValue(JSON.stringify(value)), value);
    const list = [value, "sentinel, [x]", "O'Brien"];
    const encoded = JSON.stringify(list);
    assert.equal(formatField("items", list), `items: ${encoded}`);
    assert.deepEqual(parseValue(encoded), list);
  }
  for (const { encoded, decoded } of corpus.legacy_single_quoted) {
    assert.equal(parseValue(encoded), decoded);
    assert.deepEqual(parseValue(`[${encoded}]`), [decoded]);
  }
  for (const garbage of corpus.garbage) {
    try {
      parseValue(garbage);
    } catch (error) {
      assert.ok(error instanceof FrontmatterParseError);
    }
  }
  for (const garbage of corpus.controlled_errors) {
    assert.throws(() => parseValue(garbage), FrontmatterParseError);
  }
});

test("D6 property: JSON list strings round-trip без изменения", () => {
  fc.assert(
    fc.property(fc.array(fc.string(), { maxLength: 30 }), (values) => {
      const encoded = formatField("value", values);
      const parsed = parseFrontmatter(`---\n${encoded}\n---\n`).fields;
      assert.ok(parsed);
      assert.deepEqual(parsed.value, values);
    }),
    { seed: 18_706, numRuns: 300 },
  );
});

test("M13 property: каждый новый string scalar JSON-round-trip", () => {
  fc.assert(
    fc.property(fc.string(), (value) => {
      const encoded = formatField("value", value);
      assert.equal(encoded, `value: ${JSON.stringify(value)}`);
      assert.equal(
        parseFrontmatter(`---\n${encoded}\n---\n`).fields?.value,
        value,
      );
    }),
    { seed: 18_713, numRuns: 300 },
  );
});

test("M14 property: legacy doubled apostrophe декодируется quote-aware", () => {
  fc.assert(
    fc.property(
      fc.string().filter((value) => !/[\r\n]/.test(value)),
      (value) => {
        const legacy = `'${value.replace(/'/g, "''")}'`;
        assert.equal(parseValue(legacy), value);
        assert.deepEqual(parseValue(`[${legacy}]`), [value]);
      },
    ),
    { seed: 18_714, numRuns: 300 },
  );
});

test("frontmatter property: arbitrary input даёт результат или controlled error", () => {
  fc.assert(
    fc.property(fc.string(), (garbage) => {
      try {
        parseValue(garbage);
      } catch (error) {
        assert.ok(error instanceof FrontmatterParseError);
      }
    }),
    { seed: 18_714, numRuns: 300 },
  );
});

test("кавычки, переводы строк и разделитель frontmatter проходят безопасный round-trip", () => {
  const fields = {
    source: 'report "yes".pdf',
    page: "null",
    section: "Итоги\n---\nyes",
  };
  const text = writeFrontmatter(fields, []);
  assert.match(text, /source: "report \\"yes\\"\.pdf"/);
  assert.match(text, /page: "null"/);
  assert.equal(
    text.split("\n---\n").length,
    1,
    "escaped data must not create a frontmatter delimiter",
  );
  const parsed = parseFrontmatter(`---\n${text}\n---\nbody`);
  assert.deepEqual(parsed.fields, fields);
  assert.equal(parsed.body, "body");
});

test("одиночный пробел — тоже continuation, а не новый ключ", () => {
  const { fields } = parseFrontmatter(
    "---\ndescription: >-\n line one\n line two\nstatus: active\n---\nb",
  );
  assert.ok(fields);
  assert.equal(fields.description, "line one line two");
  assert.equal(fields.status, "active");
});

test("пустая строка внутри перезаписываемого folded-блока не воскрешает старый хвост", () => {
  const lines = [
    "type: contact",
    "description: >-",
    "  первый абзац",
    "",
    "  второй абзац",
    "status: active",
  ];
  const out = writeFrontmatter({ description: "новое" }, lines);
  assert.doesNotMatch(
    out,
    /первый абзац/,
    "начало старого блока не должно остаться",
  );
  assert.doesNotMatch(
    out,
    /второй абзац/,
    "хвост старого блока не должен просочиться",
  );
  assert.match(out, /description: "новое"/);
  assert.match(out, /status: active/);
});

test("folded >- сохраняет абзацы через parse → write → parse", () => {
  const source =
    "---\ndescription: >-\n  Первый абзац\n\n  Второй абзац\n\n\n  Третий абзац\nstatus: active\n---\nbody";
  const first = parseFrontmatter(source);
  assert.ok(first.fields);
  assert.equal(
    first.fields.description,
    "Первый абзац\nВторой абзац\n\nТретий абзац",
  );
  const written = writeFrontmatter(first.fields, first.lines);
  const second = parseFrontmatter(`---\n${written}\n---\nbody`);
  assert.ok(second.fields);
  assert.equal(second.fields.description, first.fields.description);
  assert.equal(second.fields.status, "active");
});

test("literal |- сохраняет пустую строку между абзацами через round-trip", () => {
  const source =
    "---\nnote: |-\n  Строка один\n\n  Строка два\nkind: note\n---\nbody";
  const first = parseFrontmatter(source);
  assert.ok(first.fields);
  assert.equal(first.fields.note, "Строка один\n\nСтрока два");
  const written = writeFrontmatter(first.fields, first.lines);
  const second = parseFrontmatter(`---\n${written}\n---\nbody`);
  assert.ok(second.fields);
  assert.equal(second.fields.note, first.fields.note);
  assert.equal(second.fields.kind, "note");
});

test("ночная правка поля сохраняет остальные строки frontmatter и CRLF byte-identical", () => {
  const safe = fc
    .stringMatching(/^[a-z]{1,12}$/u)
    .filter((value) => value !== "true" && value !== "false");
  fc.assert(
    fc.property(
      fc.integer({ min: -10_000, max: 10_000 }),
      fc.boolean(),
      fc.array(safe, { maxLength: 5 }),
      safe,
      (number, boolean, list, word) => {
        const lines = [
          "# owner comment",
          `tier: ${number}`,
          `pinned: ${boolean}`,
          "created: 2026-01-05",
          `tags: [${list.join(", ")}]`,
          "meta:",
          `  source: ${word}`,
          `  score: ${number}`,
          "description: >-",
          `  ${word} first`,
          "",
          `  ${word} second`,
        ];
        const source = `---\r\n${lines.join("\r\n")}\r\n---\r\n# Card\r\n`;
        const parsed = parseFrontmatter(source);
        const output = renderCardDocument(
          parsed,
          { ...(parsed.fields ?? {}), truth_date: "2026-09-26" },
          parsed.body,
        );
        assert.ok(output.includes("\r\n"));
        const frontmatterStart = output.indexOf("\r\n") + 2;
        const renderedLines = output
          .slice(frontmatterStart, output.indexOf("\r\n---\r\n"))
          .split("\r\n")
          .filter((line) => !line.startsWith("truth_date:"));
        assert.deepEqual(renderedLines, lines);
      },
    ),
    { seed: 20_260_928, numRuns: 200, endOnFailure: true },
  );
});

test("ночная правка удаляет названное поле и не оставляет пустой/BOM frontmatter в теле", () => {
  const source =
    '\uFEFF---\r\ntruth_pending: "2026-09-25"\r\n---\r\n# Card\r\n';
  const parsed = parseFrontmatter(source);
  const fields = { ...(parsed.fields ?? {}), truth_date: "2026-09-26" };
  delete (fields as Record<string, string | string[]>).truth_pending;
  const output = renderCardDocument(parsed, fields, parsed.body, [
    "truth_pending",
  ]);
  assert.ok(output.includes("\r\n"));
  assert.doesNotMatch(output, /truth_pending/u);
  assert.equal((output.match(/^---\r?$/gmu) ?? []).length, 2);
  assert.match(output, /# Card/u);

  const empty = parseFrontmatter("---\n\n---\n# Empty\n");
  const rendered = renderCardDocument(
    empty,
    { updated: "2026-09-28" },
    empty.body,
  );
  assert.equal((rendered.match(/^---$/gmu) ?? []).length, 2);
  assert.doesNotMatch(rendered, /---\n\n---\n# Empty/u);
});
