import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import fc from "fast-check";
import {
  capDescription,
  cleanupVault,
  collapseRepeatedDescription,
} from "./vault-cleanup.ts";

const UNIT = "Sales lead for the Q3 pipeline review";

// Значения из collapse_repeated_description v0.4.8 (scripts/autograph/common.py) на тех же
// входах: половины — только длиннее 40 знаков, период — только единица длиннее 20.
const PYTHON_048: Record<string, string> = {
  "Duran Duran": "Duran Duran",
  "Bora Bora": "Bora Bora",
  "да да": "да да",
  "bye bye": "bye bye",
  "New York New York": "New York New York",
  "Нью-Йорк Нью-Йорк": "Нью-Йорк Нью-Йорк",
  "#tag #tag": "#tag #tag",
  "a: b a: b": "a: b a: b",
  "it''s ok it''s ok": "it''s ok it''s ok",
  [UNIT]: UNIT,
  [`${UNIT} ${UNIT}`]: UNIT,
  [`${UNIT} ${UNIT} ${UNIT}`]: UNIT,
  ["short unit x ".repeat(6).trim()]: "short unit x ".repeat(3).trim(),
  ["ab ".repeat(22).trim()]: "ab ".repeat(11).trim(),
};

void test("описание из повторённого слова остаётся, как в v0.4.8; раздутое схлопывается", () => {
  for (const [input, expected] of Object.entries(PYTHON_048))
    assert.equal(collapseRepeatedDescription(input), expected, input);
});

void test("чистка не трогает Card с коротким повтором в description", (t) => {
  const root = mkdtempSync(join(tmpdir(), "iva-vault-cleanup-short-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const text = '---\ndescription: "Duran Duran"\n---\n# Band\n';
  writeFileSync(join(root, "card.md"), text);
  assert.equal(cleanupVault(root, true).cleaned, 0);
  assert.equal(readFileSync(join(root, "card.md"), "utf8"), text);
});

void test("description collapse and cap preserve a single bounded value", () => {
  assert.equal(
    collapseRepeatedDescription(`${UNIT} ${UNIT} ${UNIT} ${UNIT}`),
    UNIT,
  );
  assert.equal(capDescription("word ".repeat(200)).length <= 501, true);
});

void test("streaming cleanup changes frontmatter and keeps body byte-identical", (t) => {
  const root = mkdtempSync(join(tmpdir(), "iva-vault-cleanup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "card.md");
  const body = "# Card\n\nbody\n```\n---\n```\n";
  writeFileSync(
    file,
    `---\ntype: note\ndescription: "${UNIT} ${UNIT} ${UNIT} ${UNIT}"\n---\n${body}`,
  );
  const dry = cleanupVault(root, false);
  assert.equal(dry.cleaned, 1);
  assert.match(
    readFileSync(file, "utf8"),
    new RegExp(`${UNIT} ${UNIT} ${UNIT} ${UNIT}`, "u"),
  );
  const applied = cleanupVault(root, true);
  assert.equal(applied.cleaned, 1);
  const changed = readFileSync(file, "utf8");
  assert.equal(changed.slice(changed.indexOf("# Card")), body);
  assert.ok(changed.includes(`description: "${UNIT}"`), changed);
  assert.equal(cleanupVault(root, true).cleaned, 0);
});

void test("строка description больше порога чтения и больше куска — схлопывается, тело байт в байт", (t) => {
  const root = mkdtempSync(join(tmpdir(), "iva-vault-cleanup-huge-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "card.md");
  const unit = "Повторённое описание карточки после бага двойной записи";
  const body = "# Card\n\n```\n---\n```\nтело\n";
  const huge = Array.from({ length: 40_000 }, () => unit).join(" ");
  writeFileSync(
    file,
    `---\ntype: note\ndescription: >-\n  ${huge}\nstatus: active\n---\n${body}`,
  );
  assert.ok(huge.length > 2 * (1 << 20));
  assert.equal(cleanupVault(root, true).cleaned, 1);
  const changed = readFileSync(file, "utf8");
  assert.equal(
    changed,
    `---\ntype: note\ndescription: ${JSON.stringify(unit)}\nstatus: active\n---\n${body}`,
  );
});

void test("CLI чистки: dry-run печатает строку, которую читает меню, --apply чистит", (t) => {
  const root = mkdtempSync(join(tmpdir(), "iva-vault-cleanup-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(
    join(root, "card.md"),
    `---\ndescription: "${UNIT} ${UNIT} ${UNIT}"\n---\n# A\n`,
  );
  const cli = (...args: string[]) =>
    spawnSync(
      process.execPath,
      [join(import.meta.dirname, "../vault-cleanup.ts"), ...args],
      { encoding: "utf8" },
    );
  const dry = cli(root);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(
    dry.stdout,
    /cleanup \(dry-run\): 1 file\(s\), \d+ bytes of bug garbage — run with --apply to fix/u,
  );
  const applied = cli(root, "--apply");
  assert.match(applied.stdout, /cleanup \(applied\): 1 file\(s\)/u);
  assert.match(
    readFileSync(join(root, "card.md"), "utf8"),
    new RegExp(`description: "${UNIT}"`, "u"),
  );
  assert.equal(cli().status, 1);
});

// Ремонт: длина, половина и период — в символах (code points), как len() в Python v0.4.8,
// а не в UTF-16. Значения посчитаны самим collapse_repeated_description / cap_description.
const MUSIC = `${"🎵".repeat(10)}123456789`;
const SONG = "🎵 Песня про море и солнце 🌊";
const SHEET = "𝄞 music sheet unit x";
const PYTHON_048_ASTRAL: Record<string, string> = {
  [`${MUSIC} ${MUSIC}`]: `${MUSIC} ${MUSIC}`,
  ["🎵".repeat(40)]: "🎵".repeat(40),
  ["😀 ".repeat(20).trim()]: "😀 ".repeat(20).trim(),
  ["🎉 party time 🎉 🎉 party time 🎉"]: "🎉 party time 🎉 🎉 party time 🎉",
  [Array(4).fill(SONG).join(" ")]: SONG,
  [Array(6).fill(SHEET).join(" ")]: SHEET,
  ["👍".repeat(41)]: "👍".repeat(41),
};

void test("символы вне BMP считаются как в v0.4.8: 39 символов с эмодзи не режутся", () => {
  for (const [input, expected] of Object.entries(PYTHON_048_ASTRAL))
    assert.equal(collapseRepeatedDescription(input), expected, input);
  assert.equal(
    capDescription(`${"🎵".repeat(499)} x${"y".repeat(10)}`),
    `${"🎵".repeat(499)}…`,
  );
});

void test("property: описание не длиннее 40 символов чистка не меняет никогда", () => {
  const seed = 20_260_928;
  console.log(`fast-check seed ${seed}`);
  const symbol = fc.constantFrom(
    "a",
    "б",
    " ",
    "🎵",
    "😀",
    "𝄞",
    ":",
    "'",
    "e\u0301",
  );
  const short = fc
    .array(symbol, { maxLength: 40 })
    .map((parts) => parts.join(""))
    .filter((text) => text === text.trim() && [...text].length <= 40);
  // Удвоенная половина из 10–19 символов: до 40 символов, но в UTF-16 часто длиннее 40.
  const twice = fc
    .array(symbol, { minLength: 10, maxLength: 19 })
    .map((parts) => parts.join("").trim())
    .map((half) => `${half} ${half}`.trim())
    .filter((text) => [...text].length <= 40);
  fc.assert(
    fc.property(fc.oneof(short, twice), (text) => {
      assert.equal(collapseRepeatedDescription(text), text);
    }),
    { seed, numRuns: 500 },
  );
});
