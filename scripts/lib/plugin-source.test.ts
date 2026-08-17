/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Anchors for every written form of a plugin source, plus the two properties that
// keep the parser honest: the round trip and "garbage is an error, not a crash".
//
// REPLAYING A FAILURE: fast-check prints
// `Property failed after N tests { seed: -1234567, path: "12:3:0", endOnFailure: true }`.
// Pass that object as the second argument to fc.assert to repeat the run, shrink included.
import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import {
  formatPluginSource,
  parsePluginSource,
  type PluginSource,
} from "./plugin-source.ts";

const RUNS = { numRuns: 200 };

test("every written form parses into one value and writes back unchanged", () => {
  const cases: Array<[string, PluginSource]> = [
    [
      "smixs/iva-plugins",
      {
        kind: "git",
        url: "https://github.com/smixs/iva-plugins.git",
        shorthand: "smixs/iva-plugins",
        subdir: null,
        ref: null,
      },
    ],
    [
      "smixs/iva-plugins/trace",
      {
        kind: "git",
        url: "https://github.com/smixs/iva-plugins.git",
        shorthand: "smixs/iva-plugins",
        subdir: "trace",
        ref: null,
      },
    ],
    [
      "smixs/iva-plugins@refs/tags/v1.2",
      {
        kind: "git",
        url: "https://github.com/smixs/iva-plugins.git",
        shorthand: "smixs/iva-plugins",
        subdir: null,
        ref: "refs/tags/v1.2",
      },
    ],
    [
      "https://user@gitlab.example.test/team/plugin.git@feature/x",
      {
        kind: "git",
        url: "https://user@gitlab.example.test/team/plugin.git",
        shorthand: null,
        subdir: null,
        ref: "feature/x",
      },
    ],
    [
      "smixs/iva-plugins/plugins/trace@v1.2",
      {
        kind: "git",
        url: "https://github.com/smixs/iva-plugins.git",
        shorthand: "smixs/iva-plugins",
        subdir: "plugins/trace",
        ref: "v1.2",
      },
    ],
    [
      "smixs/iva-plugins@0123456789abcdef0123456789abcdef01234567",
      {
        kind: "git",
        url: "https://github.com/smixs/iva-plugins.git",
        shorthand: "smixs/iva-plugins",
        subdir: null,
        ref: "0123456789abcdef0123456789abcdef01234567",
      },
    ],
    [
      "https://gitlab.example.test/team/plugin.git",
      {
        kind: "git",
        url: "https://gitlab.example.test/team/plugin.git",
        shorthand: null,
        subdir: null,
        ref: null,
      },
    ],
    [
      "https://gitlab.example.test/team/plugin.git@release",
      {
        kind: "git",
        url: "https://gitlab.example.test/team/plugin.git",
        shorthand: null,
        subdir: null,
        ref: "release",
      },
    ],
    [
      "file:///srv/mirror/plugin.git",
      {
        kind: "git",
        url: "file:///srv/mirror/plugin.git",
        shorthand: null,
        subdir: null,
        ref: null,
      },
    ],
    [
      "git@github.com:smixs/iva-plugins.git",
      {
        kind: "git",
        url: "git@github.com:smixs/iva-plugins.git",
        shorthand: null,
        subdir: null,
        ref: null,
      },
    ],
    [
      "git@github.com:smixs/iva-plugins.git@main",
      {
        kind: "git",
        url: "git@github.com:smixs/iva-plugins.git",
        shorthand: null,
        subdir: null,
        ref: "main",
      },
    ],
    ["./my-plugin", { kind: "local", path: "./my-plugin" }],
    ["../shared/my-plugin", { kind: "local", path: "../shared/my-plugin" }],
    [
      "/srv/plugins/my-plugin",
      { kind: "local", path: "/srv/plugins/my-plugin" },
    ],
    ["~/plugins/my-plugin", { kind: "local", path: "~/plugins/my-plugin" }],
    // A local path is never split on `@`: the folder may legitimately be named so.
    ["./work@home", { kind: "local", path: "./work@home" }],
  ];

  for (const [raw, expected] of cases) {
    assert.deepEqual(parsePluginSource(raw), expected, raw);
    assert.equal(formatPluginSource(expected), raw, raw);
  }
});

test("an unrecognized source is refused by name, never guessed", () => {
  for (const raw of [
    "",
    "   ",
    "trace",
    "owner/",
    "owner//repo",
    "owner/repo@",
    "own er/repo",
    "owner/repo@bad ref",
    // Подпапка, которая карабкается наружу: она назвала бы каталог вне выкачанного
    // checkout, а установщик переехал бы в стор именно им.
    "owner/repo/../../etc",
    "owner/repo/.",
    "owner/repo@--upload-pack",
    "owner/repo@/leading",
    "owner/repo@trailing/",
  ]) {
    assert.throws(
      () => parsePluginSource(raw),
      (error: unknown) => {
        assert.ok(error instanceof Error, raw);
        assert.equal(error.constructor, Error, raw);
        assert.ok(error.message.length > 0, raw);
        return true;
      },
      raw,
    );
  }
});

// `.` и `..` сегментами не бывают: такую подпапку парсер отвергает, и в канонической
// строке ей взяться неоткуда.
const segment = fc
  .stringMatching(/^[A-Za-z0-9._-]{1,8}$/u)
  .filter((value) => value !== "." && value !== "..");
const ref = fc.stringMatching(
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,5}(?:\/[A-Za-z0-9._-]{1,6}){0,2}$/u,
);

const canonical = fc.oneof(
  fc
    .tuple(
      segment,
      segment,
      fc.array(segment, { maxLength: 2 }),
      fc.option(ref),
    )
    .map(
      ([owner, repo, sub, at]) =>
        `${owner}/${repo}${sub.length ? `/${sub.join("/")}` : ""}${at === null ? "" : `@${at}`}`,
    ),
  fc
    .tuple(
      fc.constantFrom("https://", "http://", "ssh://", "file:///"),
      segment,
      segment,
      fc.option(ref),
    )
    .map(
      ([scheme, host, path, at]) =>
        `${scheme}${host}/${path}.git${at === null ? "" : `@${at}`}`,
    ),
  fc
    .tuple(fc.constantFrom("./", "../", "/", "~/"), segment, segment)
    .map(([prefix, first, second]) => `${prefix}${first}/${second}`),
);

test("property: parse and format are inverse on every canonical source", () => {
  fc.assert(
    fc.property(canonical, (raw) => {
      const parsed = parsePluginSource(raw);
      assert.equal(formatPluginSource(parsed), raw);
      assert.deepEqual(parsePluginSource(formatPluginSource(parsed)), parsed);
    }),
    RUNS,
  );
});

test("property: any string is a source or a plain Error, never a crash", () => {
  fc.assert(
    fc.property(
      fc.oneof(fc.string(), fc.string({ unit: "binary" }), canonical),
      (raw) => {
        let parsed: PluginSource;
        try {
          parsed = parsePluginSource(raw);
        } catch (error) {
          // Именно Error: TypeError или RangeError означали бы разыменование мусора.
          assert.equal((error as object).constructor, Error, raw);
          return;
        }
        // Разобралось — значит записывается обратно и читается снова так же.
        assert.deepEqual(parsePluginSource(formatPluginSource(parsed)), parsed);
      },
    ),
    RUNS,
  );
});
