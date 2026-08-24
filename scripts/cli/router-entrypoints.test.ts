import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = join(ROOT, "bin/iva.mjs");

function runCli(args: readonly string[]) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      AGENT_LANGUAGE: "en",
      // Node prints a warning to stderr when both are set, and these tests hold the
      // CLI to an empty stderr - which must not depend on the operator's shell.
      FORCE_COLOR: undefined,
      IVA_NO_ANIM: "1",
      NO_COLOR: "1",
      TERM: "dumb",
    },
  });
}

void test("no arguments and every help alias preserve one exact successful response", () => {
  const baseline = runCli([]);

  assert.equal(baseline.status, 0, baseline.stderr || baseline.stdout);
  assert.equal(baseline.signal, null);
  assert.equal(baseline.stderr, "");
  assert.match(baseline.stdout, /^\nIva CLI — manage your personal agent\n/);
  for (const command of [
    "update",
    "config",
    "login",
    "doctor",
    "status",
    "restart",
    "reset",
    "start / stop",
    "usage",
    "notify",
    "userbot",
    "logs",
    "uninstall",
    "version",
  ]) {
    assert.match(baseline.stdout, new RegExp(`\\biva ${command}`));
  }
  assert.doesNotMatch(
    baseline.stdout,
    /_install-units|_activate-units|_await-healthy/,
  );

  for (const alias of ["help", "--help", "-h"]) {
    const result = runCli([alias, "ignored-tail"]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, baseline.stdout);
  }
});

void test("an unknown command reports the exact token before help and exits one", () => {
  const result = runCli(["unknown-sentinel", "untouched-tail"]);

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, "");
  assert.match(
    result.stdout,
    /^✗ Unknown command: unknown-sentinel\n\nIva CLI — manage your personal agent\n/,
  );
  assert.doesNotMatch(result.stdout, /untouched-tail/);
});

void test("tree is a successful no-op outside an interactive color terminal", () => {
  const result = runCli(["tree", "ignored-tail"]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});
