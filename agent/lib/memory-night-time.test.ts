import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import fc from "fast-check";
import {
  activeMemoryNightTime,
  memoryNightBuildSettings,
  memoryNightCron,
  pendingMemoryNightTime,
  resolveMemoryNightTime,
  MEMORY_NIGHT_BUILD_FILE,
  MEMORY_NIGHT_CONFIG_FILE,
} from "./memory-night-time.ts";

const directory = (t: TestContext) => {
  const root = mkdtempSync(join(tmpdir(), "iva-night-clock-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".output"));
  return root;
};

void test("older builds keep 04:00; runtime env alone never moves their clock", (t) => {
  const root = directory(t);
  assert.equal(activeMemoryNightTime(root), "04:00");
  assert.equal(
    pendingMemoryNightTime("11:37", activeMemoryNightTime(root)),
    "11:37",
  );
  assert.equal(activeMemoryNightTime(root), "04:00");
});

void test("property: every local minute round-trips through compiled settings and cron", (t) => {
  const root = directory(t);
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 23 }),
      fc.integer({ min: 0, max: 59 }),
      (hour, minute) => {
        const time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
        assert.equal(resolveMemoryNightTime(time), time);
        assert.equal(memoryNightCron(time), `${minute} ${hour} * * *`);
        writeFileSync(
          join(root, ".output", MEMORY_NIGHT_CONFIG_FILE),
          memoryNightBuildSettings(time),
        );
        assert.equal(activeMemoryNightTime(root), time);
        assert.equal(
          pendingMemoryNightTime(time, activeMemoryNightTime(root)),
          null,
        );
      },
    ),
    { seed: 20261002, numRuns: 200 },
  );
});

void test("property: invalid times are refused without normalizing or falling back", () => {
  fc.assert(
    fc.property(fc.string(), (raw) => {
      if (/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(raw))
        assert.equal(resolveMemoryNightTime(raw), raw);
      else
        assert.throws(
          () => resolveMemoryNightTime(raw),
          /MEMORY_NIGHT_TIME must be HH:mm/,
        );
    }),
    { seed: 20261002, numRuns: 200 },
  );
  for (const raw of [
    "",
    "4:00",
    "24:00",
    "04:60",
    "04:00 ",
    " 04:00",
    "04:00\n",
    "0 4 * * *",
  ])
    assert.throws(() => resolveMemoryNightTime(raw), /HH:mm/);
});

void test("malformed compiled settings refuse startup rather than silently using 04:00", (t) => {
  const root = directory(t);
  for (const value of [
    "{",
    "null",
    "[]",
    "{}",
    '{"schema":"iva-memory-night/v1"}',
    '{"schema":"wrong","time":"11:37"}',
    '{"schema":"iva-memory-night/v1","time":"24:00"}',
  ]) {
    writeFileSync(join(root, ".output", MEMORY_NIGHT_CONFIG_FILE), value);
    assert.throws(
      () => activeMemoryNightTime(root),
      /Invalid night build settings/,
    );
  }
});

void test("disposable compile snapshot and runtime artifact use the same validated format", (t) => {
  const root = directory(t);
  writeFileSync(
    join(root, ".output", MEMORY_NIGHT_CONFIG_FILE),
    memoryNightBuildSettings("23:59"),
  );
  writeFileSync(
    join(root, MEMORY_NIGHT_BUILD_FILE),
    memoryNightBuildSettings("00:00"),
  );
  assert.equal(activeMemoryNightTime(root), "00:00");
  writeFileSync(join(root, MEMORY_NIGHT_BUILD_FILE), "{");
  assert.throws(
    () => activeMemoryNightTime(root),
    /Invalid night build settings/,
  );
  rmSync(join(root, MEMORY_NIGHT_BUILD_FILE));
  assert.equal(activeMemoryNightTime(root), "23:59");
  assert.equal(pendingMemoryNightTime(undefined, "23:59"), "04:00");
});

void test("property: a snapshot either supplies a valid v1 clock or fails closed", (t) => {
  const root = directory(t);
  fc.assert(
    fc.property(
      fc.oneof(
        fc.jsonValue(),
        fc.record({
          schema: fc.constant("iva-memory-night/v1"),
          time: fc
            .tuple(
              fc.integer({ min: 0, max: 23 }),
              fc.integer({ min: 0, max: 59 }),
            )
            .map(
              ([h, m]) =>
                `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`,
            ),
        }),
      ),
      (value) => {
        writeFileSync(
          join(root, ".output", MEMORY_NIGHT_CONFIG_FILE),
          JSON.stringify(value),
        );
        const object =
          typeof value === "object" && value !== null && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : null;
        if (
          object?.schema === "iva-memory-night/v1" &&
          typeof object.time === "string" &&
          /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(object.time)
        )
          assert.equal(activeMemoryNightTime(root), object.time);
        else
          assert.throws(
            () => activeMemoryNightTime(root),
            /Invalid night build settings/,
          );
      },
    ),
    { seed: 20261002, numRuns: 100 },
  );
});
