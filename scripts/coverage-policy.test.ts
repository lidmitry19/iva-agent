/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const EXPECTED_PRODUCTION_COUNT = 221;
const EXPECTED_INVENTORY_SHA256 =
  "fc70804cfbbc2f61fb41e9624da474ddb5869b1fade307e7f14267b40afa09f6";

// Node's native include globs filter loaded modules; they do not load untouched files.
// This test pins the exact production path inventory and a separately measured 26-path
// blind-spot snapshot. It does not determine what the current import graph loads, claim
// that the other paths are reported, or notice import-graph changes without path changes.
// Measured again for this inventory: the web inbound-gate round added `agent/lib/web-gate.ts`
// and `agent/tools/web_fetch.ts`, both reported, and gave `agent/tools/web_search.ts` its
// first loading test - so the blind spot dropped from 26 paths to 25. The subagent slots
// `agent/subagents/planner/tools/web_fetch.ts` and `web_search.ts` came next, both reported
// at 100% by scripts/web-surface-gate.test.ts, so the blind spot stays at 25. The per-node
// sandbox pin `agent/subagents/planner/sandbox.ts` came after it: measured unreported, like
// the root `agent/sandbox.ts` it re-exports - no test loads either - so the blind spot is 26.
// The notice policy module `scripts/lib/notice-policy.ts` and the `/menu` screen that switches
// the reports, `scripts/lib/menu/notices.ts`, came next - both loaded by their own tests and
// reported, so the blind spot stayed at 26. The provider resolver `agent/lib/model-provider.ts`
// came after them, reported at 100% by its own test. Its integration test also settled a
// standing claim about `agent/hooks/usage.ts`: a spawned child inherits NODE_V8_COVERAGE, so
// the hook it imports is measured like any other file - re-measured at 82% lines here, which
// takes it off this list and puts the blind spot at 25. The turn-cancellation seam came next -
// `agent/lib/eve-cancel.ts`, `agent/lib/telegram-cancel-route.ts` and
// `agent/lib/telegram-cancel-client.ts` - all three loaded by `scripts/lib/telegram-cancel.test.ts`
// and reported, so the blind spot stays at 25. The webhook-mode Stop handler
// `agent/lib/telegram-stop.ts` came last, loaded by `scripts/telegram-failure-events.test.ts`
// through the real channel and reported, so the blind spot stays at 25. The memory resolver
// `scripts/lib/memory-mode.ts` came next, loaded and reported by its own test
// (`scripts/lib/memory-mode.test.ts`), so the blind spot stays at 25. The Reminder CLI
// `scripts/cli/remind.ts` followed, reported by its own test, so it stays at 25. The live skill
// resolver came last: `agent/lib/custom-skills.ts` (99% lines) and `agent/lib/data-dir.ts` (100%)
// are loaded and reported by their own tests, while the slot file `agent/skills/custom.ts` is
// loaded by eve alone - measured unreported, like `agent/sandbox.ts` - so the blind spot is 26.
// The durable Telegram bridge then added `scripts/poller/inbox.ts`,
// `process-lock.ts`, `startup-state.ts`, and `update-callback.ts`. Scoped coverage
// reported all four through their proof tests, so the blind spot stays at 26.
// The recovery owner `scripts/lib/update-recovery.ts` came next. Its target-aware
// collision and manifest modules followed. The scoped update suite reports all three
// at 94.55%, 97.53% and 100% lines, so the blind spot stays at 26. The updater split
// then added candidate, command, resource, applied-state, ownership, IO, object-store,
// collision-owner, and snapshot-verifier modules. The 140-test scoped suite reports
// every added module and totals 96.02% lines, 84.69% branches, and 95.50% functions,
// so the blind spot stays at 26. The resource identity and owner modules followed;
// their 19-test scoped anchor reports 89.49% and 86.76% lines, so neither is blind.
// Wave B added `agent/lib/context-window.ts`, `agent/lib/telegram-private-chat.ts`,
// `scripts/lib/data-dir.ts`, and `scripts/memory/read-core.ts`. Their scoped seam tests
// report all four at 100% lines. The shared context-window package implementation also
// reports 100% lines, so moving the resolver does not add a blind spot; the snapshot stays 26.
// The plugin rails came next, seven paths: `agent/lib/plugin-reader.ts`,
// `agent/lib/plugin-skills.ts`, `agent/lib/plugin-store.ts`, `scripts/cli/plugin.ts`,
// `scripts/lib/plugin-core.ts`, `scripts/lib/plugin-install.ts` and
// `scripts/lib/plugin-source.ts`. Their scoped suite (the reader anchors and properties,
// the store, the source parser, the install seam, and the `iva plugin` and doctor CLI
// tests) reports all seven, 97.61% lines together and no file under 93%, so the blind
// spot stays 26.
// The turn journal (ADR-0010) came next: `agent/lib/trace.ts` and `agent/hooks/trace.ts`.
// Scoped coverage over `agent/lib/trace.test.ts`, `agent/lib/trace.property.test.ts` and
// `agent/lib/trace-hook.test.ts` reports them at 97% and 98% lines, so the blind spot
// stays 26 - unlike `agent/hooks/transcript.ts`, this hook is loaded by its own test. That
// test lives in `agent/lib/`, not beside the hook: eve treats every file under
// `agent/hooks/` as a hook, and `trace.test` is not a legal hook name.
// The rich-message reader `agent/lib/telegram-rich-message.ts` came next. Its own test
// reports it at 99.53% lines, 92.69% branches and 100% functions, so the blind spot
// stays 26. The rich-post CLI `scripts/cli/post.ts` came last, replacing the skill's
// Python sender: `scripts/cli/post.test.ts` reports it at 93.54% lines, 82.64% branches
// and 86.96% functions - the uncovered remainder is the tmpfiles.org upload and the
// stdin reader, both injected in tests - so the blind spot stays 26.
const MEASURED_UNREPORTED_BY_CATEGORY = {
  frameworkBoundaries: [
    "agent/agent.ts",
    "agent/channels/eve.ts",
    "agent/connections/telegram-userbot.ts",
    "agent/hooks/transcript.ts",
    "agent/instructions/05-language.ts",
    "agent/instructions/20-core.ts",
    "agent/instructions/25-persona.ts",
    "agent/instructions/now.ts",
    "agent/sandbox.ts",
    "agent/skills/custom.ts",
    "agent/subagents/planner/agent.ts",
    "agent/subagents/planner/sandbox.ts",
  ],
  thinAgentTools: [
    "agent/tools/glob.ts",
    "agent/tools/grep.ts",
    "agent/tools/tasks.ts",
  ],
  standaloneOperations: [
    "scripts/build.ts",
    "scripts/check-bash-cwd.ts",
    "scripts/check-reasoning-strip.ts",
    "scripts/daily-digest.ts",
    "scripts/memory/brain.ts",
    "scripts/memory/embed-index.ts",
    "scripts/memory/rollup.ts",
    // A one-shot data migration, run out of the version that introduced it.
    "scripts/migrations/001-iva-port.ts",
    "scripts/replica-smoke.ts",
    "scripts/setup/main.ts",
    // Runs as its own process, spawned by the version being installed.
    "scripts/update-finish.ts",
  ],
} as const;

const EXPECTED_COVERAGE_COMMAND =
  'node --test --test-concurrency=4 --experimental-test-coverage --test-coverage-include="agent/**/*.ts" --test-coverage-include="scripts/**/*.ts" --test-coverage-exclude="**/*.test.ts" --test-coverage-exclude="scripts/fixtures/**/*.ts" --test-coverage-lines=75 --test-coverage-branches=77 --test-coverage-functions=71 "agent/**/*.test.ts" "scripts/**/*.test.ts"';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function productionTypeScriptFiles(): string[] {
  const files: string[] = [];

  function visit(relativeDirectory: string): void {
    for (const entry of readdirSync(join(ROOT, relativeDirectory), {
      withFileTypes: true,
    })) {
      const relativePath = posix.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) {
        if (relativePath !== "scripts/fixtures") visit(relativePath);
      } else if (
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts")
      ) {
        files.push(relativePath);
      }
    }
  }

  visit("agent");
  visit("scripts");
  return files.sort();
}

function digest(paths: readonly string[]): string {
  return createHash("sha256").update(paths.join("\n")).digest("hex");
}

function assertProductionPathInventory(
  productionFiles: readonly string[],
): void {
  assert.equal(
    productionFiles.length,
    EXPECTED_PRODUCTION_COUNT,
    "production TypeScript inventory changed; rerun scoped coverage and classify the changed files",
  );
  assert.equal(
    digest(productionFiles),
    EXPECTED_INVENTORY_SHA256,
    "production TypeScript paths changed; rerun scoped coverage before updating the inventory ratchet",
  );

  const measuredUnreported = Object.values(MEASURED_UNREPORTED_BY_CATEGORY)
    .flat()
    .sort();
  assert.equal(measuredUnreported.length, 26);
  assert.equal(new Set(measuredUnreported).size, measuredUnreported.length);
  assert.deepEqual(
    measuredUnreported.filter((path) => !productionFiles.includes(path)),
    [],
    "the measured coverage blind-spot snapshot contains a missing production file",
  );
}

test("coverage policy pins production paths and the measured blind-spot snapshot", () => {
  const productionFiles = productionTypeScriptFiles();
  assertProductionPathInventory(productionFiles);

  assert.throws(
    () =>
      assertProductionPathInventory(
        [...productionFiles, "agent/lib/unclassified-production.ts"].sort(),
      ),
    /production TypeScript inventory changed/u,
  );
});

test("coverage command is the exact cross-platform production policy", () => {
  const parsed: unknown = JSON.parse(
    readFileSync(join(ROOT, "package.json"), "utf8"),
  );
  assert.ok(isRecord(parsed));
  assert.ok(isRecord(parsed.scripts));
  const command = parsed.scripts["test:coverage"];
  if (typeof command !== "string") {
    throw new TypeError("test:coverage must be a package script");
  }
  assert.equal(command, EXPECTED_COVERAGE_COMMAND);
});
