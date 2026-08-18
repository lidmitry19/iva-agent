import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";

import { validateTimeZone as validateAuthored } from "#lib/timezone.ts";
import { validateTimeZone } from "./timezone.ts";

// Оба дерева экспортируют одну функцию: authored tree проверяет зону на старте сервера,
// scripts/ — когда Doctor пишет юниты без каталога agent/.
const CASES: readonly [unknown, string | null][] = [
  [" Asia/Tashkent ", "Asia/Tashkent"],
  ["Mars/Olympus", null],
  [undefined, null],
  ["", null],
  ["   ", null],
  ["UTC", "UTC"],
  // Регистр `Intl` прощает, systemd — нет: `OnCalendar=*-*-* 05:00:00 europe/moscow`
  // не поднимает таймер. Наружу поэтому уходит канон, а не то, что ввёл пользователь.
  ["europe/moscow", "Europe/Moscow"],
  ["Europe/Moscow", "Europe/Moscow"],
  // Бэкслеш не разделитель зоны ни для кого: такой ввод остаётся отказом.
  ["europe\\moscow", null],
];

// Канонические зоны текущей ICU: вход из этого списка обязан вернуться собой.
const ZONES = Intl.supportedValuesOf("timeZone");

const PADDING = fc.constantFrom("", " ", "  ", "\t", "\n", " ", " ");

void test("authored and operational trees export one validator", () => {
  assert.equal(validateAuthored, validateTimeZone);
});

for (const [input, expected] of CASES) {
  void test(`timezone validation agrees on ${JSON.stringify(input)}`, () => {
    assert.equal(validateTimeZone(input), expected);
    assert.equal(validateAuthored(input), expected);
  });
}

void test("validation is idempotent for every input", () => {
  fc.assert(
    fc.property(
      fc.oneof(fc.string(), fc.string({ unit: "binary" })),
      (input) => {
        const once = validateTimeZone(input);
        assert.equal(validateTimeZone(once), once);
      },
    ),
    { seed: 190_001, numRuns: 1_000 },
  );
});

void test("case and padding never move a canonical zone", () => {
  fc.assert(
    fc.property(
      fc.constantFrom(...ZONES),
      fc.constantFrom<(value: string) => string>(
        (value) => value,
        (value) => value.toUpperCase(),
        (value) => value.toLowerCase(),
      ),
      PADDING,
      PADDING,
      (zone, vary, before, after) => {
        assert.equal(validateTimeZone(`${before}${vary(zone)}${after}`), zone);
      },
    ),
    { seed: 190_002, numRuns: 2_000 },
  );
});

void test("arbitrary input yields a zone Intl accepts, or nothing", () => {
  fc.assert(
    fc.property(
      fc.oneof(fc.string(), fc.string({ unit: "binary" })),
      (input) => {
        const zone = validateTimeZone(input);
        if (zone === null) return;
        // Канон стабилен и годится для systemd, TZ= и любого потребителя Intl.
        assert.equal(zone, zone.trim());
        assert.equal(validateTimeZone(zone), zone);
        assert.doesNotThrow(() =>
          new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(0),
        );
      },
    ),
    { seed: 190_003, numRuns: 1_000 },
  );
});
