/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Anchors for the marketplace file - one per source form and one per way of being
// broken - plus the property that matters most about it: the file comes from a
// repository nobody vetted, so ANY JSON has to come back as entries and
// diagnostics, never as a thrown error.
//
// REPLAYING A FAILURE: fast-check prints
// `Property failed after N tests { seed: -1234567, path: "12:3:0", endOnFailure: true }`.
// Pass that object as the second argument to fc.assert to repeat the run, shrink included.
import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { formatPluginSource, parsePluginSource } from "./plugin-source.ts";
import {
  marketplaceEntrySource,
  marketplaceSlug,
  parseMarketplace,
  parseMarketplaceRequest,
  type Marketplace,
} from "./plugin-marketplace.ts";

const REPO = {
  url: "https://github.com/smixs/iva-plugins.git",
  sha: "0123456789abcdef0123456789abcdef01234567",
};

function marketplace(plugins: unknown): Marketplace {
  return parseMarketplace({ name: "iva-plugins", plugins });
}

function names(market: Marketplace): string[] {
  return market.entries.map((entry) => entry.name);
}

test("the three source forms are read, and each resolves to one source string", () => {
  const market = marketplace([
    { name: "alpha", source: "./plugins/alpha", description: "A path form." },
    {
      name: "beta",
      source: {
        source: "git-subdir",
        url: "https://gitlab.example.test/team/mono.git",
        path: "plugins/beta",
        ref: "release",
        sha: null,
      },
    },
    {
      name: "gamma",
      source: {
        source: "url",
        url: "https://gitlab.example.test/team/gamma.git",
        ref: null,
        sha: null,
      },
    },
    {
      name: "delta",
      source: { source: "git-subdir", url: REPO.url, path: "plugins/delta" },
    },
  ]);

  assert.equal(market.name, "iva-plugins");
  assert.deepEqual(names(market), ["alpha", "beta", "gamma", "delta"]);
  assert.equal(market.entries[0].description, "A path form.");
  assert.deepEqual(market.diagnostics, []);

  const resolved = market.entries.map((entry) =>
    formatPluginSource(marketplaceEntrySource(entry, REPO)),
  );
  assert.deepEqual(resolved, [
    // Своя папка маркетплейса — подпапка его репозитория, запиненная на прочитанном
    // коммите: иначе «эта папка» означала бы разное в разные дни.
    `smixs/iva-plugins/plugins/alpha@${REPO.sha}`,
    // Чужой хостинг shorthand'а не имеет — подпапку называет разделитель go-getter.
    "https://gitlab.example.test/team/mono.git//plugins/beta@release",
    "https://gitlab.example.test/team/gamma.git",
    "smixs/iva-plugins/plugins/delta",
  ]);
});

test("a sha in the entry pins the install; a ref only tracks", () => {
  const market = marketplace([
    {
      name: "pinned",
      source: {
        source: "url",
        url: "https://gitlab.example.test/team/x.git",
        ref: "main",
        sha: "f".repeat(40),
      },
    },
  ]);
  assert.equal(
    formatPluginSource(marketplaceEntrySource(market.entries[0], REPO)),
    `https://gitlab.example.test/team/x.git@${"f".repeat(40)}`,
  );
});

test("a local entry with no cached commit is refused, not silently unpinned", () => {
  const market = marketplace([{ name: "alpha", source: "plugins/alpha" }]);
  assert.throws(
    () => marketplaceEntrySource(market.entries[0], { ...REPO, sha: "" }),
    /no cached commit/u,
  );
});

test("a git URL that is not GitHub keeps the URL form of the subdirectory", () => {
  const market = marketplace([{ name: "alpha", source: "plugins/alpha" }]);
  assert.equal(
    formatPluginSource(
      marketplaceEntrySource(market.entries[0], {
        url: "file:///srv/mirror/iva-plugins.git",
        sha: REPO.sha,
      }),
    ),
    `file:///srv/mirror/iva-plugins.git//plugins/alpha@${REPO.sha}`,
  );
});

test("npm, policy, interface and anything unknown are ignored out loud", () => {
  const market = marketplace([
    { name: "packaged", source: { source: "npm", package: "iva-plugin-x" } },
    {
      name: "kept",
      source: "./plugins/kept",
      policy: { network: "deny" },
      interface: "cli",
    },
    {
      name: "extra",
      source: { source: "url", url: "https://h.test/x.git", token: "secret" },
    },
  ]);

  assert.deepEqual(names(market), ["kept", "extra"]);
  assert.deepEqual(market.diagnostics, [
    "packaged skipped: npm sources are not installed by Iva, only plugin folders",
    'kept: field "policy" ignored',
    'kept: field "interface" ignored',
    'extra: source field "token" ignored',
  ]);
});

test("one unusable entry is skipped by name and the rest of the file still works", () => {
  const market = marketplace([
    { name: "good", source: "./plugins/good" },
    { source: "./plugins/nameless" },
    { name: "escapee", source: "../../etc" },
    { name: "absolute", source: "/etc/passwd" },
    { name: "sourceless" },
    { name: "typed", source: { source: "url", url: 7 } },
    {
      name: "reffed",
      source: { source: "url", url: "https://h.test/x", ref: 7 },
    },
    { name: "unknown-form", source: { source: "oci", image: "x" } },
    { name: "good", source: "./plugins/twice" },
    "just a string",
    { name: "../../evil", source: "./plugins/evil" },
  ]);

  assert.deepEqual(names(market), ["good"]);
  assert.deepEqual(market.diagnostics, [
    "plugins[1] skipped: name must be a plain plugin name",
    'escapee skipped: source "../../etc" is not a path inside the marketplace',
    'absolute skipped: source "/etc/passwd" is not a path inside the marketplace',
    "sourceless skipped: no source",
    "typed skipped: source.url must be a string",
    "reffed skipped: source.ref must be a string",
    'unknown-form skipped: unknown source type "oci"',
    "good skipped: the name is listed twice",
    "plugins[9] skipped: not an object",
    "plugins[10] skipped: name must be a plain plugin name",
  ]);
});

test("a file that cannot be used at all says so instead of pretending to be empty", () => {
  for (const [raw, why] of [
    [null, /must be a JSON object/u],
    [[], /must be a JSON object/u],
    ["a string", /must be a JSON object/u],
    [{ plugins: [] }, /name must be a non-empty string/u],
    [{ name: "  ", plugins: [] }, /name must be a non-empty string/u],
    [{ name: 7, plugins: [] }, /name must be a non-empty string/u],
  ] as const) {
    const market = parseMarketplace(raw);
    assert.equal(market.name, null, JSON.stringify(raw));
    assert.deepEqual(market.entries, []);
    assert.match(market.diagnostics.join("\n"), why, JSON.stringify(raw));
  }

  // Имя есть, список сломан: маркетплейс годен, плагинов из него ноль.
  const broken = parseMarketplace({ name: "iva-plugins", plugins: "trace" });
  assert.equal(broken.name, "iva-plugins");
  assert.deepEqual(broken.entries, []);
  assert.deepEqual(broken.diagnostics, ["plugins must be an array; none read"]);

  const empty = parseMarketplace({ name: "iva-plugins", version: 2 });
  assert.equal(empty.name, "iva-plugins");
  assert.deepEqual(empty.diagnostics, [
    'field "version" ignored',
    "no plugins",
  ]);
});

test("a bare name is a marketplace request; every source form is not", () => {
  assert.deepEqual(parseMarketplaceRequest("trace"), {
    name: "trace",
    marketplace: null,
  });
  assert.deepEqual(parseMarketplaceRequest("trace@iva-plugins"), {
    name: "trace",
    marketplace: "iva-plugins",
  });
  for (const raw of [
    "smixs/iva-plugins",
    "smixs/iva-plugins/trace@v1",
    "https://h.test/x.git",
    "git@h.test:team/x.git",
    "./my-plugin",
    "../my-plugin",
    "/srv/my-plugin",
    "~/my-plugin",
    ".hidden",
    "-trace",
    "trace@",
    "trace@a@b",
    "trace name",
    "",
  ])
    assert.equal(parseMarketplaceRequest(raw), null, raw);
});

test("a cache slug is one directory name, never a path", () => {
  const sources = [
    "smixs/iva-plugins",
    "smixs/iva-plugins@main",
    "https://gitlab.example.test/team/mono.git",
    "/srv/plugins/../../etc",
    "..",
    "~/plugins",
  ];
  for (const source of sources) {
    const slug = marketplaceSlug(source);
    assert.doesNotMatch(slug, /[/\\]/u, source);
    assert.doesNotMatch(slug, /\.\./u, source);
    assert.match(slug, /^[A-Za-z0-9][A-Za-z0-9._-]*-[a-f0-9]{8}$/u, source);
  }
  // Разные источники — разные папки, даже когда санитайзер сводит их к одному виду.
  assert.notEqual(
    marketplaceSlug("smixs/iva-plugins"),
    marketplaceSlug("smixs-iva-plugins"),
  );
  assert.equal(
    marketplaceSlug("smixs/iva-plugins"),
    marketplaceSlug("smixs/iva-plugins"),
  );
});

// Значения-мусор рядом с законными: генератор обязан доходить и до ПРИНЯТЫХ записей,
// иначе свойство проверяло бы одни отказы. Замерено на 4000 прогонах: 2896 годных
// файлов, 1565 принятых записей, 1485 из них становятся источником, 80 отказывают.
// Первая версия генератора давала на тех же 4000 прогонах НОЛЬ принятых записей —
// зелёное свойство проверяло только то, что мусор не падает.
const value = fc.oneof(
  fc.constantFrom(
    "./plugins/alpha",
    "plugins/alpha",
    "../escape",
    "npm",
    "local",
    "url",
    "git-subdir",
    "https://h.test/x.git",
    "main",
    "f".repeat(40),
    "alpha",
    "",
  ),
  fc.string(),
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
);

const anyJson = fc.letrec<{ node: unknown }>((tie) => ({
  node: fc.oneof(
    { maxDepth: 3 },
    value,
    fc.array(tie("node"), { maxLength: 4 }),
    fc.dictionary(
      fc.constantFrom("name", "source", "plugins", "path", "url", "ref"),
      tie("node"),
      { maxKeys: 5 },
    ),
  ),
})).node;

const sourceLike = fc.oneof(
  { arbitrary: fc.constantFrom("./plugins/alpha", "plugins/alpha"), weight: 3 },
  { arbitrary: fc.constantFrom("../escape", "/etc/passwd", ""), weight: 1 },
  {
    arbitrary: fc.record(
      {
        source: fc.constantFrom("local", "url", "git-subdir", "npm", "oci", 7),
        path: fc.oneof(
          { arbitrary: fc.constantFrom("plugins/alpha", "./x"), weight: 3 },
          { arbitrary: fc.constantFrom("../up"), weight: 1 },
          { arbitrary: value, weight: 1 },
        ),
        url: fc.oneof(
          {
            arbitrary: fc.constantFrom(
              "https://github.com/smixs/iva-plugins.git",
              "https://h.test/x.git",
              "git@h.test:team/x.git",
            ),
            weight: 3,
          },
          { arbitrary: value, weight: 1 },
        ),
        ref: fc.oneof(
          {
            arbitrary: fc.constantFrom("main", "refs/tags/v1", null),
            weight: 3,
          },
          { arbitrary: value, weight: 1 },
        ),
        sha: fc.oneof(
          { arbitrary: fc.constantFrom("f".repeat(40), null), weight: 3 },
          { arbitrary: value, weight: 1 },
        ),
        policy: value,
      },
      { requiredKeys: ["source"] },
    ),
    weight: 4,
  },
  { arbitrary: value, weight: 1 },
);

const nameLike = fc.oneof(
  { arbitrary: fc.constantFrom("alpha", "beta", "trace"), weight: 4 },
  { arbitrary: fc.constantFrom("../evil", "A B", "-x"), weight: 1 },
  { arbitrary: value, weight: 1 },
);

const entryLike = fc.oneof(
  {
    arbitrary: fc.record({
      name: nameLike,
      source: sourceLike,
      description: value,
      interface: value,
    }),
    weight: 5,
  },
  // Записи с пропущенными полями тоже нужны, но редко: иначе принятых записей
  // в прогоне почти не остаётся.
  {
    arbitrary: fc.record(
      { name: nameLike, source: sourceLike, description: value },
      { requiredKeys: [] },
    ),
    weight: 1,
  },
);

const fileLike = fc.oneof(
  { arbitrary: anyJson, weight: 1 },
  {
    arbitrary: fc.record(
      {
        name: fc.oneof(
          { arbitrary: fc.constant("iva-plugins"), weight: 4 },
          { arbitrary: value, weight: 1 },
        ),
        plugins: fc.oneof(
          {
            arbitrary: fc.array(entryLike, { minLength: 1, maxLength: 4 }),
            weight: 5,
          },
          { arbitrary: value, weight: 1 },
        ),
        version: value,
      },
      { requiredKeys: ["name", "plugins"] },
    ),
    weight: 5,
  },
);

const RUNS = { numRuns: 400 };

test("property: any JSON is entries and diagnostics, never a throw", () => {
  fc.assert(
    fc.property(fileLike, (raw: unknown) => {
      const market: Marketplace = parseMarketplace(raw);
      // `Array.isArray` здесь не проверяют намеренно: он сужает readonly-массив до
      // `any[]`, и дальше все обращения к записи стали бы непроверяемыми.
      // Отклонённый файл не отдаёт ни одной записи, а причину называет всегда.
      if (market.name === null) {
        assert.deepEqual(market.entries, []);
        assert.ok(market.diagnostics.length > 0);
      }
      for (const entry of market.entries) {
        assert.ok(entry.name.length > 0);
        assert.equal(typeof entry.description, "string");
        // Принятая запись либо становится источником, либо отказывает обычным
        // Error — TypeError означал бы разыменование мусора из файла.
        let source;
        try {
          source = marketplaceEntrySource(entry, REPO);
        } catch (error) {
          assert.equal((error as object).constructor, Error, entry.name);
          continue;
        }
        // Разрешилось — значит это git-источник, который пишется строкой и читается
        // из неё обратно, и его подпапка не карабкается наружу репозитория.
        assert.equal(source.kind, "git", entry.name);
        const written = formatPluginSource(source);
        assert.deepEqual(parsePluginSource(written), source, written);
        if (source.kind === "git" && source.subdir)
          assert.equal(source.subdir.split("/").includes(".."), false, written);
      }
    }),
    RUNS,
  );
});
