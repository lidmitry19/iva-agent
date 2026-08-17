/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
// `services/` — третий корень: там живут сервисы Ивы со своими тестами (MCP proxy).
const TEST_ROOTS = [
  "agent/**/*.test.ts",
  "scripts/**/*.test.ts",
  "services/**/*.test.ts",
] as const;
const EXPECTED_TEST_COMMAND =
  'node --test --test-concurrency=4 "agent/**/*.test.ts" "scripts/**/*.test.ts" "services/**/*.test.ts"';

function writeTest(path: string, name: string, failure = false): void {
  writeFileSync(
    path,
    `import assert from "node:assert/strict";\nimport test from "node:test";\ntest(${JSON.stringify(name)}, () => { assert.equal(${failure ? "false" : "true"}, true); });\n`,
  );
}

test("npm test is pinned to the canonical test roots", () => {
  const parsed: unknown = JSON.parse(
    readFileSync(join(ROOT, "package.json"), "utf8"),
  );
  assert.ok(typeof parsed === "object" && parsed !== null);
  assert.ok("scripts" in parsed);
  const scripts = parsed.scripts;
  assert.ok(typeof scripts === "object" && scripts !== null);
  assert.ok("test" in scripts);
  assert.equal(scripts.test, EXPECTED_TEST_COMMAND);
});

test("scoped discovery runs canonical tests and excludes a nested worktree", () => {
  const fixture = mkdtempSync(join(tmpdir(), "iva-test-discovery-"));

  try {
    mkdirSync(join(fixture, "agent"), { recursive: true });
    mkdirSync(join(fixture, "scripts"), { recursive: true });
    mkdirSync(join(fixture, "services/proxy"), { recursive: true });
    mkdirSync(join(fixture, "wt/nested"), { recursive: true });
    writeTest(
      join(fixture, "agent/canonical.test.ts"),
      "CANONICAL_AGENT_EXECUTED",
    );
    writeTest(
      join(fixture, "scripts/canonical.test.ts"),
      "CANONICAL_SCRIPT_EXECUTED",
    );
    writeTest(
      join(fixture, "services/proxy/canonical.test.ts"),
      "CANONICAL_SERVICE_EXECUTED",
    );
    writeTest(
      join(fixture, "wt/nested/sentinel.test.ts"),
      "NESTED_TEST_DISCOVERED",
      true,
    );

    const childEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;

    const result = spawnSync(
      process.execPath,
      ["--test", "--test-concurrency=4", ...TEST_ROOTS],
      { cwd: fixture, encoding: "utf8", env: childEnv },
    );
    const output = `${result.stdout}${result.stderr}`;

    assert.equal(result.status, 0, output);
    assert.match(output, /CANONICAL_AGENT_EXECUTED/u);
    assert.match(output, /CANONICAL_SCRIPT_EXECUTED/u);
    assert.match(output, /CANONICAL_SERVICE_EXECUTED/u);
    assert.doesNotMatch(output, /NESTED_TEST_DISCOVERED/u);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("Git ignores only the updater output backup tree", () => {
  const ignored = spawnSync(
    "git",
    [
      "check-ignore",
      "--no-index",
      "--quiet",
      ".output.iva-backup-1/sentinel.ts",
    ],
    { cwd: ROOT },
  );
  const adjacentSource = spawnSync(
    "git",
    ["check-ignore", "--no-index", "--quiet", ".output.iva-source/sentinel.ts"],
    { cwd: ROOT },
  );

  assert.equal(ignored.status, 0);
  assert.equal(adjacentSource.status, 1);
});
