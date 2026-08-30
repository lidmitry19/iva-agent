import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  detectCodeVersion,
  markNightJob,
  markNightWatchdogFailure,
  nightTargetDate,
  notifyNightHealth,
  readNightHealth,
} from "./night-health.ts";

void test("night health is atomic, rejects a missing result, and preserves target/run identity", () => {
  const data = mkdtempSync(join(tmpdir(), "iva-night-health-"));
  try {
    const failed = markNightJob(data, "memoryRollup", {
      targetDate: "2026-08-28",
      state: "success",
      artifacts: [join(data, "missing.md")],
    });
    assert.equal(failed.runId, "night-2026-08-28");
    assert.equal(failed.jobs.memoryRollup.state, "failed");
    assert.match(failed.jobs.memoryRollup.error ?? "", /artifact missing/u);

    const artifact = join(data, "daily.md");
    writeFileSync(artifact, "# summary\n");
    markNightJob(data, "memoryRollup", {
      targetDate: "2026-08-28",
      state: "success",
      artifacts: [artifact],
    });
    assert.equal(
      readNightHealth(data, "2026-08-28")?.jobs.memoryRollup.state,
      "success",
    );
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

void test("failure notifications deduplicate and successful retry announces recovery", async () => {
  const data = mkdtempSync(join(tmpdir(), "iva-night-notice-"));
  const sent: string[] = [];
  const send = (message: string) => {
    sent.push(message);
    return Promise.resolve(true);
  };
  try {
    const failed = markNightJob(data, "bitrixSync", {
      targetDate: "2026-08-28",
      state: "failed",
      artifacts: [],
      error: "exit=1",
    });
    await notifyNightHealth(data, failed, "bitrixSync", send);
    await notifyNightHealth(data, failed, "bitrixSync", send);
    const cache = join(data, "cache.json");
    writeFileSync(cache, "{}\n");
    const recovered = markNightJob(data, "bitrixSync", {
      targetDate: "2026-08-29",
      state: "success",
      artifacts: [cache],
    });
    await notifyNightHealth(data, recovered, "bitrixSync", send);
    assert.equal(sent.length, 2);
    assert.match(sent[0] ?? "", /failed/u);
    assert.match(sent[1] ?? "", /recovered/u);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

void test("watchdog preserves the original failure and does not emit a duplicate", async () => {
  const data = mkdtempSync(join(tmpdir(), "iva-night-watchdog-failure-"));
  const sent: string[] = [];
  const send = (message: string) => {
    sent.push(message);
    return Promise.resolve(true);
  };
  try {
    const failed = markNightJob(data, "bitrixSync", {
      targetDate: "2026-08-28",
      state: "failed",
      artifacts: [],
      error: "daily sync has 1 failed task",
      now: new Date("2026-08-28T22:20:00.000Z"),
    });
    await notifyNightHealth(data, failed, "bitrixSync", send);
    const watched = markNightWatchdogFailure(data, "bitrixSync", {
      targetDate: "2026-08-28",
      reason: failed.jobs.bitrixSync.error ?? "failed",
      now: new Date("2026-08-29T00:00:00.000Z"),
    });
    await notifyNightHealth(data, watched, "bitrixSync", send);
    assert.equal(sent.length, 1);
    assert.equal(
      watched.jobs.bitrixSync.finishedAt,
      "2026-08-28T22:20:00.000Z",
    );
    assert.equal(watched.jobs.bitrixSync.error, "daily sync has 1 failed task");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

void test("code version uses an immutable release directory and repairs unknown", () => {
  const data = mkdtempSync(join(tmpdir(), "iva-night-version-"));
  const root = join(data, "0.3.34-0123456789ab+deadbeef");
  try {
    writeFileSync(join(data, "artifact.json"), "{}\n");
    mkdirSync(root);
    assert.equal(detectCodeVersion(root), "0.3.34-0123456789ab+deadbeef");
    const first = markNightJob(data, "memoryRollup", {
      targetDate: "2026-08-28",
      codeVersion: "unknown",
      state: "running",
    });
    assert.equal(first.codeVersion, "unknown");
    const repaired = markNightJob(data, "memoryRollup", {
      targetDate: "2026-08-28",
      codeVersion: "0.3.34-0123456789ab+deadbeef",
      state: "failed",
      error: "test",
    });
    assert.equal(repaired.codeVersion, "0.3.34-0123456789ab+deadbeef");
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

void test("target date uses the completed Asia/Yekaterinburg day across UTC midnight", () => {
  assert.equal(
    nightTargetDate("Asia/Yekaterinburg", new Date("2026-08-28T19:30:00.000Z")),
    "2026-08-28",
  );
  assert.equal(
    nightTargetDate("Asia/Yekaterinburg", new Date("2026-08-28T18:30:00.000Z")),
    "2026-08-27",
  );
});
