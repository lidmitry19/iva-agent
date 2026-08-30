import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { markNightJob, readNightHealth } from "./lib/night-health.ts";
import { runNightWatchdog } from "./night-watchdog.ts";

const TARGET = "2026-08-28";

void test("watchdog records every missing job without concurrent manifest loss", async () => {
  const data = mkdtempSync(join(tmpdir(), "iva-watchdog-missing-"));
  try {
    assert.equal(
      await runNightWatchdog({
        dataDir: data,
        targetDate: TARGET,
        send: () => Promise.resolve(true),
      }),
      false,
    );
    const manifest = readNightHealth(data, TARGET);
    assert.equal(manifest?.jobs.bitrixSync.state, "failed");
    assert.equal(manifest?.jobs.memoryRollup.state, "failed");
    assert.match(manifest?.jobs.bitrixSync.error ?? "", /did not start/u);
    assert.match(manifest?.jobs.memoryRollup.error ?? "", /did not start/u);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

void test("watchdog fails running and corrupt-result jobs", async () => {
  const data = mkdtempSync(join(tmpdir(), "iva-watchdog-results-"));
  try {
    const corrupt = join(data, "bitrix.json");
    writeFileSync(corrupt, "not json\n");
    markNightJob(data, "bitrixSync", {
      targetDate: TARGET,
      state: "success",
      artifacts: [corrupt],
    });
    markNightJob(data, "memoryRollup", {
      targetDate: TARGET,
      state: "running",
      artifacts: [join(data, "daily.md")],
      now: new Date("2026-08-28T22:00:00.000Z"),
    });
    await runNightWatchdog({
      dataDir: data,
      targetDate: TARGET,
      send: () => Promise.resolve(true),
    });
    const manifest = readNightHealth(data, TARGET);
    assert.equal(manifest?.jobs.bitrixSync.state, "failed");
    assert.match(
      manifest?.jobs.bitrixSync.error ?? "",
      /artifact missing or corrupt/u,
    );
    assert.equal(manifest?.jobs.memoryRollup.state, "failed");
    assert.match(manifest?.jobs.memoryRollup.error ?? "", /still running/u);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});
