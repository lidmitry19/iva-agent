/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import {
  formatWhatsNew,
  parseWhatsNew,
  whatsNewBetween,
  WHATS_NEW_BUDGET,
  type WhatsNewEntry,
} from "./lib/whats-new.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const README = readFileSync(join(ROOT, "README.md"), "utf8");
const README_RU = readFileSync(join(ROOT, "README.ru.md"), "utf8");
const CHANGELOG = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");

// Пункт релиза: эмодзи, жирный заголовок, дальше текст. Заголовок и есть то, что владелец
// читает в уведомлении об обновлении, поэтому он обязан быть самодостаточным.
const RELEASE_BULLET =
  /^- (?:\p{Extended_Pictographic}[\uFE0F\u200D]*)+ \*\*.+?\*\*/u;

function versionBlock(readme: string, version: string): string[] {
  const lines = readme.split("\n");
  const start = lines.indexOf(`#### v${version}`);
  if (start === -1) return [];
  const block: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line) || line.startsWith("</details>")) break;
    block.push(line);
  }
  return block;
}

test("both READMEs list the same releases in the same order", () => {
  const en = parseWhatsNew(README).map((entry) => entry.version);
  const ru = parseWhatsNew(README_RU).map((entry) => entry.version);
  assert.deepEqual(en, ru);
  assert.deepEqual(en, ["0.3.31", "0.3.30", "0.3.29", "0.3.28", "0.3.27"]);
});

test("a headline is the emoji and the bold opening of its bullet", () => {
  const en = new Map(
    parseWhatsNew(README).map((entry) => [entry.version, entry.headlines]),
  );
  assert.deepEqual(en.get("0.3.31"), [
    "🔁 A reply to an old bot message no longer hangs the bot",
  ]);
  assert.deepEqual(en.get("0.3.30"), [
    "🛑 An old CLI stops instead of breaking",
    "🩺 `repair.sh` proves the service is up before saying so",
  ]);
  assert.equal(en.get("0.3.29")?.length, 5);
  assert.equal(en.get("0.3.29")?.[2], "🗂️ CORE.md is edited, not rewritten");

  const ru = new Map(
    parseWhatsNew(README_RU).map((entry) => [entry.version, entry.headlines]),
  );
  assert.deepEqual(ru.get("0.3.31"), [
    "🔁 Reply на старое сообщение бота больше не вешает бота",
  ]);
  assert.deepEqual(ru.get("0.3.30"), [
    "🛑 Старый CLI останавливается, а не ломается",
    "🩺 `repair.sh` доказывает, что сервис поднялся, прежде чем это сказать",
  ]);
});

test("older markup still parses: the text before the first colon", () => {
  const legacy = [
    "## What's New",
    "",
    "#### v1.2.3",
    "",
    "- A plain headline: the rest of the sentence, with `code` and a colon: here.",
    "- **Bold without an emoji**: the rest.",
    "- No colon and no bold at all",
    "",
  ].join("\n");
  assert.deepEqual(parseWhatsNew(legacy), [
    {
      version: "1.2.3",
      headlines: [
        "A plain headline",
        "Bold without an emoji",
        "No colon and no bold at all",
      ],
    },
  ]);
});

test("junk parses to nothing instead of throwing", () => {
  assert.deepEqual(parseWhatsNew(""), []);
  assert.deepEqual(parseWhatsNew("#### v1.2\n- headline: text"), []);
  assert.deepEqual(parseWhatsNew("#### v1.2.3\n"), []);
  // A list past the end of the details block belongs to no release.
  assert.deepEqual(
    parseWhatsNew("#### v1.2.3\n</details>\n\n- Stray bullet: text"),
    [],
  );
  assert.deepEqual(
    parseWhatsNew(undefined as unknown as string),
    [],
    "a non-string is junk, not a crash",
  );
});

test("the selection is the releases after the installed one, newest first", () => {
  const entries = parseWhatsNew(README);
  const between = whatsNewBetween(entries, "0.3.29", "0.3.31");
  assert.deepEqual(
    between.versions.map((entry) => entry.version),
    ["0.3.31", "0.3.30"],
  );
  assert.equal(between.truncated, false);

  const current = whatsNewBetween(entries, "0.3.31", "0.3.31");
  assert.deepEqual(current.versions, []);
  assert.equal(current.truncated, false);

  // The README keeps three dates, so an older install cannot be told everything.
  const old = whatsNewBetween(entries, "0.3.18", "0.3.31");
  assert.equal(old.truncated, true);
  assert.deepEqual(
    old.versions.map((entry) => entry.version),
    ["0.3.31", "0.3.30", "0.3.29", "0.3.28", "0.3.27"],
  );

  assert.deepEqual(whatsNewBetween(entries, "nightly", "0.3.31").versions, []);
  assert.deepEqual(whatsNewBetween(entries, "0.3.29", "junk"), {
    versions: [],
    truncated: false,
  });
});

test("the block is bilingual, plain and carries the link", () => {
  const selection = whatsNewBetween(
    parseWhatsNew(README_RU),
    "0.3.30",
    "0.3.31",
  );
  const ru = formatWhatsNew(selection, "ru");
  assert.equal(
    ru,
    [
      "Что нового:",
      "v0.3.31",
      "• 🔁 Reply на старое сообщение бота больше не вешает бота",
      "Полный список: https://github.com/smixs/iva-agent/releases",
    ].join("\n"),
  );

  const en = formatWhatsNew(
    whatsNewBetween(parseWhatsNew(README), "0.3.30", "0.3.31"),
    "en",
    "https://example.test/releases",
  );
  assert.match(en, /^What's new:\n/);
  assert.match(en, /\nFull list: https:\/\/example\.test\/releases$/);

  assert.equal(formatWhatsNew({ versions: [], truncated: true }, "ru"), "");
});

test("markdown markers never reach a message sent without parse_mode", () => {
  // The daily notice goes out through sendUpdateOffer, which posts no parse_mode:
  // markers cannot break the send, but they must not be read by the owner either.
  const readme = [
    "#### v9.9.9",
    "",
    "- 🧪 **`iva doctor` reports `<path>/package.json` & more**: the rest.",
    "- 🔗 **See [the docs](https://example.test/docs)**: the rest.",
    "",
  ].join("\n");
  const block = formatWhatsNew(
    whatsNewBetween(parseWhatsNew(readme), "9.9.8", "9.9.9"),
    "en",
  );
  assert.ok(
    block.includes("• 🧪 iva doctor reports <path>/package.json & more"),
    block,
  );
  assert.ok(block.includes("• 🔗 See the docs"), block);
  assert.ok(!block.includes("`"), "no backticks reach the chat");
  assert.ok(!block.includes("**"), "no emphasis markers reach the chat");
  assert.ok(!block.includes("]("), "no link syntax reaches the chat");
});

test("the budget cuts whole releases, never a headline", () => {
  const long = (mark: string) => `${mark} ${"headline ".repeat(20).trim()}`;
  const entries: WhatsNewEntry[] = ["1.0.9", "1.0.8", "1.0.7", "1.0.6"].map(
    (version) => ({
      version,
      headlines: [long("🔧"), long("🧪"), long("📦")],
    }),
  );
  const block = formatWhatsNew(
    whatsNewBetween(entries, "1.0.5", "1.0.9"),
    "en",
  );
  assert.ok(block.length <= WHATS_NEW_BUDGET, `${block.length} chars`);
  const kept = block.split("\n").filter((line) => line.startsWith("v"));
  assert.ok(kept.length > 0 && kept.length < entries.length);
  for (const line of block.split("\n").filter((l) => l.startsWith("• ")))
    assert.ok(line.endsWith("headline"), `cut mid-headline: ${line}`);
});

// ── The release-time drift guard ──────────────────────────────────────────────
// The bilingual source of the notice is the README pair, and it is written by hand every
// release. Documentation drift is fixed in the documentation (docs/philosophy.md §5), so
// the release is what fails here, not the notice at run time.

test("the newest CHANGELOG release is in both READMEs, in the notice format", () => {
  const newest: string | undefined = /^## \[(\d+\.\d+\.\d+)\]/m.exec(
    CHANGELOG,
  )?.[1];
  assert.ok(newest, "CHANGELOG has no topmost release");
  // The guard has teeth: the old markup and a bare bold opening both fail it.
  for (const bullet of [
    "- A headline without an emoji: the text.",
    "- 🔧 A headline without the bold: the text.",
    "- **Bold but no emoji**: the text.",
  ])
    assert.doesNotMatch(bullet, RELEASE_BULLET);

  for (const [name, readme] of [
    ["README.md", README],
    ["README.ru.md", README_RU],
  ] as const) {
    assert.ok(
      readme.includes(`#### v${newest}`),
      `${name} has no What's New block for v${newest}`,
    );
    const entry: WhatsNewEntry | undefined = parseWhatsNew(readme).find(
      (candidate) => candidate.version === newest,
    );
    if (!entry || entry.headlines.length === 0)
      assert.fail(`${name} gives the update notice no headline for v${newest}`);
    const bullets: string[] = versionBlock(readme, newest).filter((line) =>
      line.startsWith("- "),
    );
    assert.equal(bullets.length, entry.headlines.length);
    for (const bullet of bullets)
      assert.match(
        bullet,
        RELEASE_BULLET,
        `${name}: a v${newest} bullet must open with an emoji and a bold headline`,
      );
  }
});

// ── Properties ────────────────────────────────────────────────────────────────

const RELEASE = fc
  .tuple(fc.nat(4), fc.nat(30), fc.nat(60))
  .map(([major, minor, patch]) => `${major}.${minor}.${patch}`);
const WORDS = fc
  .array(fc.constantFrom("alpha", "бета", "gamma", "42", "fix", "eve"), {
    minLength: 1,
    maxLength: 6,
  })
  .map((words) => words.join(" "));
const EMOJI = fc.constantFrom("🔧", "📦", "🧠", "🗂️", "↪️");
const JUNK = fc.oneof(
  fc.string({ maxLength: 200 }),
  fc.string({ unit: "grapheme", maxLength: 200 }),
  fc
    .array(
      fc.oneof(
        fc.constantFrom(
          "#### v1.2.3",
          "#### v",
          "## What's New",
          "</details>",
          "- ",
          "-",
          "- **",
          "- **:",
          "* not a bullet",
        ),
        fc.string({ maxLength: 40 }),
      ),
      { maxLength: 40 },
    )
    .map((lines) => lines.join("\n")),
);

test("property: parsing arbitrary text returns entries and never throws", () => {
  fc.assert(
    fc.property(JUNK, (text) => {
      const entries = parseWhatsNew(text);
      assert.ok(Array.isArray(entries));
      for (const entry of entries) {
        assert.match(entry.version, /^\d+\.\d+\.\d+$/);
        assert.ok(entry.headlines.length > 0);
        for (const headline of entry.headlines) {
          assert.equal(typeof headline, "string");
          assert.ok(!headline.includes("**"));
        }
      }
    }),
    { seed: 203_001, numRuns: 500 },
  );
});

test("property: a planted section parses back to exactly its headlines", () => {
  const PLANTED = fc.array(
    fc.record({
      version: RELEASE,
      headlines: fc.array(fc.tuple(EMOJI, WORDS), {
        minLength: 1,
        maxLength: 4,
      }),
    }),
    { minLength: 1, maxLength: 5 },
  );
  fc.assert(
    fc.property(PLANTED, WORDS, (planted, tail) => {
      const lines = ["## What's New", "", "<details>", ""];
      for (const release of planted) {
        lines.push(`#### v${release.version}`, "");
        for (const [emoji, headline] of release.headlines)
          lines.push(`- ${emoji} **${headline}**: ${tail}.`);
        lines.push("");
      }
      lines.push("</details>", "", `- ${tail}: outside the section.`);
      const parsed = parseWhatsNew(lines.join("\n"));
      assert.deepEqual(
        parsed,
        planted.map((release) => ({
          version: release.version,
          headlines: release.headlines.map(
            ([emoji, headline]) => `${emoji} ${headline}`,
          ),
        })),
      );
    }),
    { seed: 203_002, numRuns: 300 },
  );
});

test("property: the block fits the budget and invents no headline", () => {
  const SELECTION = fc.record({
    versions: fc.array(
      fc.record({
        version: RELEASE,
        headlines: fc.array(
          fc.tuple(EMOJI, WORDS).map(([emoji, words]) => `${emoji} ${words}`),
          { minLength: 1, maxLength: 6 },
        ),
      }),
      { maxLength: 8 },
    ),
    truncated: fc.boolean(),
  });
  fc.assert(
    fc.property(SELECTION, fc.constantFrom("ru", "en"), (selection, locale) => {
      const block = formatWhatsNew(selection, locale);
      if (selection.versions.length === 0) {
        assert.equal(block, "");
        return;
      }
      assert.ok(
        block.length <= WHATS_NEW_BUDGET,
        `${block.length} chars over budget`,
      );
      const planted = new Set(
        selection.versions.flatMap((entry) => entry.headlines),
      );
      const shown = block
        .split("\n")
        .filter((line) => line.startsWith("• "))
        .map((line) => line.slice(2));
      for (const headline of shown)
        assert.ok(planted.has(headline), `invented headline: ${headline}`);
      // Whole releases only: a version line never appears without its headlines.
      for (const line of block.split("\n")) {
        if (!/^v\d/.test(line)) continue;
        const entry = selection.versions.find(
          (candidate) => `v${candidate.version}` === line,
        );
        assert.ok(entry);
        for (const headline of entry.headlines)
          assert.ok(block.includes(`• ${headline}`), headline);
      }
    }),
    { seed: 203_003, numRuns: 400 },
  );
});
