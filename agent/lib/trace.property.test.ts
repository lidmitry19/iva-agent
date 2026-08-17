/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Свойства журнала хода на случайных событиях. Якоря контракта — в trace.test.ts,
// здесь генератор кормит писателя тем, что реально прилетает из чужих payload: юникод-
// мусор, одинокие суррогаты, гигантские аргументы тула, циклы, bigint, битые геттеры.
//
// КАК ВОСПРОИЗВЕСТИ ПАДЕНИЕ: при провале fast-check печатает строку вида
// `Property failed after N tests { seed: -1234567, path: "12:3:0", endOnFailure: true }`.
// Подставь её вторым аргументом — fc.assert(prop, { seed: -1234567, path: "12:3:0" }) —
// и прогон повторится байт в байт, включая shrink.
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";

const root = mkdtempSync(join(tmpdir(), "iva-trace-pbt-"));
process.env.ASSISTANT_DATA_DIR = join(root, "data");
process.env.ASSISTANT_TIMEZONE = "UTC";
mkdirSync(process.env.ASSISTANT_DATA_DIR, { recursive: true });
const {
  appendTrace,
  capTraceString,
  pruneTrace,
  traceDir,
  traceFilePath,
  traceLine,
  TRACE_CONTENT_LIMIT,
  TRACE_ID_LIMIT,
  TRACE_LINE_LIMIT,
  TRACE_TRUNCATION_MARKER,
} = await import("./trace.ts");

process.on("exit", () => rmSync(root, { recursive: true, force: true }));

const RUNS = { numRuns: 200 };
const SCHEMA = ["ts", "turn", "session", "source", "kind", "name", "data"];

// Текст, каким он приходит из чужого payload: любые кодовые единицы, включая одинокие
// суррогаты (их даёт склейка обрезанных строк выше по стеку).
const wildText = fc.oneof(
  fc.string({ unit: "binary", maxLength: 200 }),
  fc.string({ unit: "grapheme", maxLength: 200 }),
  fc.constantFrom("\ud800", "\udfff", "a\ud800b", "🙂".repeat(3)),
  fc
    .tuple(
      fc.integer({ min: 1990, max: 6000 }),
      fc.string({ unit: "grapheme", maxLength: 4 }),
    )
    .map(([size, seed]) => (seed || "x").repeat(size)),
);

const wildValue = fc.oneof(
  wildText,
  fc.anything({
    withBigInt: true,
    withDate: true,
    withMap: true,
    withSet: true,
    withNullPrototype: true,
    withObjectString: true,
    maxDepth: 3,
  }),
);

const record = fc.dictionary(fc.string({ maxLength: 12 }), wildValue, {
  maxKeys: 5,
});

const event = fc.record({
  kind: fc.string({ unit: "grapheme", maxLength: 300 }),
  name: fc.string({ unit: "grapheme", maxLength: 300 }),
  turn: fc.option(wildText, { nil: undefined }),
  session: fc.option(wildText, { nil: undefined }),
  source: fc.option(wildText, { nil: undefined }),
  data: fc.option(record, { nil: undefined }),
  content: fc.option(
    fc.dictionary(fc.string({ maxLength: 12 }), wildText, { maxKeys: 3 }),
    {
      nil: undefined,
    },
  ),
});

const AT = new Date("2026-08-17T10:20:30.000Z");

function parse(line: string): Record<string, unknown> {
  return JSON.parse(line) as Record<string, unknown>;
}

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, out);
  else if (typeof value === "object" && value !== null)
    for (const item of Object.values(value)) strings(item, out);
  return out;
}

test("property: любое событие даёт одну валидную JSON-строку фиксированной схемы", () => {
  fc.assert(
    fc.property(event, (input) => {
      const line = traceLine(input, { now: AT, captureContent: true });

      assert.equal(line.includes("\n"), false);
      assert.ok(line.length <= TRACE_LINE_LIMIT);
      const parsed = parse(line);
      assert.deepEqual(Object.keys(parsed), SCHEMA);
      assert.equal(parsed.ts, "2026-08-17T10:20:30.000Z");
      assert.equal(parsed.kind, capTraceString(input.kind, TRACE_ID_LIMIT));
      assert.equal(parsed.name, capTraceString(input.name, TRACE_ID_LIMIT));
      assert.equal(
        parsed.turn,
        capTraceString(input.turn ?? "", TRACE_ID_LIMIT),
      );
      assert.equal(
        parsed.session,
        capTraceString(input.session ?? "", TRACE_ID_LIMIT),
      );
      assert.equal(
        parsed.source,
        capTraceString(input.source ?? "", TRACE_ID_LIMIT),
      );
      assert.equal(typeof parsed.data, "object");
      assert.notEqual(parsed.data, null);
    }),
    RUNS,
  );
});

test("property: содержимое обрезано по потолку и помечено обрезкой", () => {
  fc.assert(
    fc.property(event, (input) => {
      const parsed = parse(traceLine(input, { now: AT, captureContent: true }));
      const data = parsed.data as Record<string, unknown>;

      // Ни одна строка в событии не длиннее потолка — включая вложенные.
      for (const text of strings(data))
        assert.ok(text.length <= TRACE_CONTENT_LIMIT);

      for (const [key, value] of Object.entries(input.content ?? {})) {
        // Событие, не влезшее в строку даже после обрезки полей, едет без содержимого.
        if (data.traceTrimmed === true) {
          assert.equal(key in data, false);
          continue;
        }
        assert.equal(data[`${key}Chars`], value.length);
        const written = data[key];
        assert.equal(typeof written, "string");
        if (value.length > TRACE_CONTENT_LIMIT) {
          assert.ok(String(written).endsWith(TRACE_TRUNCATION_MARKER));
          assert.ok(String(written).length <= TRACE_CONTENT_LIMIT);
        } else {
          assert.equal(written, value);
        }
      }
    }),
    RUNS,
  );
});

test("property: captureContent=false не пропускает содержимое, но оставляет размеры", () => {
  fc.assert(
    fc.property(event, (input) => {
      const data = parse(traceLine(input, { now: AT, captureContent: false }))
        .data as Record<string, unknown>;

      // Событие без содержимого вовсе — эталон. Выключенный тумблер обязан дать ровно
      // его же плюс размеры: сравнение с эталоном ловит и утечку значения, и случай,
      // когда ключ содержимого совпал с ключом data (тогда значение из data — законно).
      const bare = parse(
        traceLine(
          { ...input, content: undefined },
          { now: AT, captureContent: false },
        ),
      ).data as Record<string, unknown>;
      const expected: Record<string, unknown> = { ...bare };
      for (const [key, value] of Object.entries(input.content ?? {}))
        expected[`${key}Chars`] = value.length;

      assert.deepEqual(data, expected);
    }),
    RUNS,
  );
});

// Смещение дня в UTC — тот же расчёт, что у писателя, но записанный тестом отдельно:
// граница окна проверяется числами, а не повтором продовой строки.
function shift(day: string, delta: number): string {
  const at = new Date(`${day}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + delta);
  return at.toISOString().slice(0, 10);
}

test("property: чистка удаляет по дате в имени и не трогает чужие файлы", () => {
  const today = fc
    .date({
      min: new Date("2020-01-01T00:00:00Z"),
      max: new Date("2035-01-01T00:00:00Z"),
      noInvalidDate: true,
    })
    .map((value) => value.toISOString().slice(0, 10));
  // Смещения вокруг границы окна (-13) — иначе случайная дата за 15 лет попадает
  // ровно в край раз в тысячу прогонов, и off-by-one живёт в проде.
  const offsets = fc.uniqueArray(fc.integer({ min: -30, max: 2 }), {
    maxLength: 12,
  });
  const foreign = fc.constantFrom(
    "notes.md",
    "2026-08-05.jsonl.bak",
    "trace.jsonl",
    "20260805.jsonl",
    "2026-08-05.json",
  );

  fc.assert(
    fc.property(
      today,
      offsets,
      fc.uniqueArray(foreign, { maxLength: 3 }),
      (day, deltas, others) => {
        const dir = mkdtempSync(join(root, "prune-"));
        mkdirSync(traceDir(dir), { recursive: true });
        const days = deltas.map((delta) => shift(day, delta));
        for (const value of days)
          writeFileSync(join(traceDir(dir), `${value}.jsonl`), "");
        for (const name of others) writeFileSync(join(traceDir(dir), name), "");

        const removed = pruneTrace(dir, day);
        const left = new Set(readdirSync(traceDir(dir)));

        for (const name of others) assert.ok(left.has(name));
        // Окно — сегодняшний файл и 13 предыдущих; всё, что старше ПО ИМЕНИ, в утиль.
        const cutoff = shift(day, -13);
        for (const value of days) {
          const name = `${value}.jsonl`;
          const keep = value >= cutoff;
          assert.equal(left.has(name), keep);
          assert.equal(removed.includes(name), !keep);
        }
      },
    ),
    { numRuns: 100 },
  );
});

test("property: писатель не кидает ни на каком входе", (t) => {
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => errors.push(args);
  t.after(() => {
    console.error = original;
  });

  const cyclic: Record<string, unknown> = { name: "cycle" };
  cyclic.self = cyclic;
  const hostile: Record<string, unknown>[] = [
    cyclic,
    {
      get boom() {
        throw new Error("getter");
      },
    },
    { big: 10n ** 40n, fn: () => 1, sym: Symbol("s"), undef: undefined },
    { deep: [[[[[["bottom"]]]]]] },
    { huge: "я".repeat(100_000) },
    {
      toJSON: () => {
        throw new Error("toJSON");
      },
    },
  ];

  const dir = mkdtempSync(join(root, "safe-"));
  mkdirSync(join(dir, "data"), { recursive: true });
  const dataDir = join(dir, "data");

  for (const data of hostile) {
    assert.doesNotThrow(() =>
      appendTrace(
        { kind: "eve", name: "action.result", data },
        { dir: dataDir, now: AT },
      ),
    );
  }
  // Сломанное назначение записи: каталога нет, а на месте журнала лежит файл.
  assert.doesNotThrow(() =>
    appendTrace(
      { kind: "eve", name: "turn.started" },
      { dir: join(dir, "gone"), now: AT },
    ),
  );
  const blocked = mkdtempSync(join(root, "blocked-"));
  mkdirSync(join(blocked, "data"), { recursive: true });
  writeFileSync(traceDir(join(blocked, "data")), "file, not a directory");
  assert.doesNotThrow(() =>
    appendTrace(
      { kind: "eve", name: "turn.started" },
      { dir: join(blocked, "data"), now: AT },
    ),
  );

  // Всё, что не упало на сборке, обязано лежать в файле валидными строками.
  const written = readFileSync(traceFilePath("2026-08-17", dataDir), "utf8")
    .split("\n")
    .filter(Boolean);
  assert.ok(written.length >= hostile.length - 2);
  for (const line of written) assert.doesNotThrow(() => parse(line));

  fc.assert(
    fc.property(event, (input) => {
      assert.doesNotThrow(() => appendTrace(input, { dir: dataDir, now: AT }));
    }),
    RUNS,
  );
});
