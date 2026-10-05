import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import fc from "fast-check";
import "./lib/ts-esm-hooks.ts";

const directory = mkdtempSync(join(tmpdir(), "iva-task-due-"));
process.env.ASSISTANT_DATA_DIR = directory;
const file = join(directory, "tasks.json");
const { default: tool } = await import("../agent/tools/tasks.ts");
process.on("exit", () => rmSync(directory, { recursive: true, force: true }));

type Input = Parameters<typeof tool.execute>[0];
type Row = {
  id: number;
  text: string;
  priority: "low" | "med" | "high";
  due: string | null;
  done: boolean;
  createdAt: string;
  ownerNote?: string;
};
type Answer = {
  ok: boolean;
  error?: string;
  tasks?: Row[];
  added?: Row;
  updated?: Row;
  current?: Row;
};
const call = async (input: Input): Promise<Answer> =>
  (await tool.execute(input, {} as never)) as Answer;
const read = (): Row[] => JSON.parse(readFileSync(file, "utf8")) as Row[];
const original = (due: string | null = "завтра"): Row => ({
  id: 117,
  text: "позвонить",
  priority: "high",
  due,
  done: false,
  createdAt: "2026-09-23T15:24:07.667Z",
  ownerNote: "keep this",
});
const reset = (rows: Row[] = []): void =>
  writeFileSync(file, JSON.stringify(rows, null, 2));
const seed = 20_261_002;
const date = fc
  .date({
    min: new Date("1000-01-01T00:00:00.000Z"),
    max: new Date("9999-12-31T00:00:00.000Z"),
    noInvalidDate: true,
  })
  .map((value) => value.toISOString().slice(0, 10));
const calendarText = fc
  .tuple(
    fc.integer({ min: 0, max: 9999 }),
    fc.integer({ min: 0, max: 14 }),
    fc.integer({ min: 0, max: 35 }),
  )
  .map(
    ([year, month, day]) =>
      `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  );

await test("#258: relative and impossible new deadlines fail without changing the file", async () => {
  reset([original()]);
  for (const due of ["завтра", "tomorrow", "2026-02-29", "2026-04-31"]) {
    const before = readFileSync(file, "utf8");
    const answer = await call({ action: "add", text: "new", due });
    assert.equal(answer.ok, false);
    assert.match(answer.error ?? "", /YYYY-MM-DD/u);
    assert.equal(readFileSync(file, "utf8"), before);
  }
});

await test("absolute dates, including overdue and leap days, persist unchanged", async () => {
  reset();
  for (const due of ["2026-09-24", "2024-02-29", null, undefined]) {
    const answer = await call({ action: "add", text: "new", due });
    assert.equal(answer.ok, true, JSON.stringify(answer));
    assert.equal(answer.added?.due, due ?? null);
  }
  assert.deepEqual(
    read().map((row) => row.due),
    ["2026-09-24", "2024-02-29", null, null],
  );
});

await test("legacy deadlines survive list and unrelated add/done; update repairs only due", async () => {
  const row = original();
  reset([row]);
  const before = readFileSync(file, "utf8");
  assert.deepEqual((await call({ action: "list" })).tasks, [row]);
  assert.equal(readFileSync(file, "utf8"), before);
  assert.equal((await call({ action: "add", text: "another" })).ok, true);
  assert.deepEqual(read()[0], row);
  assert.equal((await call({ action: "done", id: 118 })).ok, true);
  assert.deepEqual(read()[0], row);
  const answer = await call({
    action: "update",
    id: 117,
    due: "2026-09-24",
    expectedDue: "завтра",
  });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.deepEqual(answer.updated, { ...row, due: "2026-09-24" });
  assert.deepEqual(read()[0], answer.updated);
  assert.equal(read()[1].done, true);
});

await test("update explicitly clears a deadline and accepts a previously absent deadline", async () => {
  reset([original(null)]);
  for (const [expectedDue, due] of [
    [null, "2026-09-24"],
    ["2026-09-24", null],
  ] as const) {
    const answer = await call({ action: "update", id: 117, due, expectedDue });
    assert.equal(answer.ok, true, JSON.stringify(answer));
    assert.equal(read()[0].due, due);
  }
});

await test("missing update fields, unknown ids, stale deadlines and invalid dates do not write", async () => {
  reset([original()]);
  const attempts: Input[] = [
    { action: "update", id: 117, due: "2026-09-24" },
    { action: "update", id: 117, expectedDue: "завтра" },
    { action: "update", due: "2026-09-24", expectedDue: "завтра" },
    { action: "update", id: 999, due: "2026-09-24", expectedDue: "завтра" },
    { action: "update", id: 117, due: "2026-09-24", expectedDue: null },
    { action: "update", id: 117, due: "завтра", expectedDue: "завтра" },
  ];
  const before = readFileSync(file, "utf8");
  for (const input of attempts) {
    const answer = await call(input);
    assert.equal(answer.ok, false, JSON.stringify(input));
    assert.equal(readFileSync(file, "utf8"), before);
  }
  const stale = await call({
    action: "update",
    id: 117,
    due: null,
    expectedDue: "old",
  });
  assert.deepEqual(stale.current, original());
  assert.match(stale.error ?? "", /list/u);
});

await test("concurrent repairs with the same expectedDue admit exactly one change", async () => {
  reset([original()]);
  const outcomes = await Promise.all(
    ["2026-09-24", "2026-09-25"].map((due) =>
      call({ action: "update", id: 117, due, expectedDue: "завтра" }),
    ),
  );
  assert.equal(outcomes.filter((answer) => answer.ok).length, 1);
  const winner = outcomes.find((answer) => answer.ok);
  const loser = outcomes.find((answer) => !answer.ok);
  assert.deepEqual(read()[0], winner?.updated);
  assert.deepEqual(loser?.current, winner?.updated);
});

await test(`property: only exact real calendar dates may enter new rows (seed ${seed})`, async () => {
  await fc.assert(
    fc.asyncProperty(fc.oneof(date, calendarText, fc.string()), async (due) => {
      reset([original()]);
      const before = readFileSync(file, "utf8");
      const answer = await call({ action: "add", text: "new", due });
      // Independent oracle: the persisted date round-trips through UTC without
      // normalization, and has exactly the calendar-date shape.
      const parsed = Date.parse(`${due}T00:00:00.000Z`);
      const calendarDate =
        /^\d{4}-\d{2}-\d{2}$/u.test(due) &&
        Number.isFinite(parsed) &&
        new Date(parsed).toISOString().slice(0, 10) === due;
      assert.equal(answer.ok, calendarDate, JSON.stringify({ due, answer }));
      if (answer.ok) {
        assert.equal(read()[1].due, due);
        assert.deepEqual(read()[0], original());
      } else assert.equal(readFileSync(file, "utf8"), before);
    }),
    { seed, numRuns: 150 },
  );
});

await test(`property: repair preserves all other fields/rows; stale repair preserves bytes (seed ${seed})`, async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.option(fc.string(), { nil: null }),
      fc.option(date, { nil: null }),
      async (previous, due) => {
        const row = original(previous);
        const other = { ...original("yesterday"), id: 118, done: true };
        reset([row, other]);
        const answer = await call({
          action: "update",
          id: 117,
          due,
          expectedDue: previous,
        });
        assert.equal(answer.ok, true, JSON.stringify(answer));
        assert.deepEqual(read(), [{ ...row, due }, other]);
        const before = readFileSync(file, "utf8");
        const stale = await call({
          action: "update",
          id: 117,
          due: null,
          expectedDue: "stale value that cannot be a stored calendar date",
        });
        assert.equal(stale.ok, false);
        assert.equal(readFileSync(file, "utf8"), before);
      },
    ),
    { seed, numRuns: 100 },
  );
});
