#!/usr/bin/env node
// Independent of Eve and every LLM: this is the 05:00 proof that the night happened.
import { resolveDataDir } from "./lib/data-dir.ts";
import {
  markNightWatchdogFailure,
  nightTargetDate,
  notifyNightHealth,
  readNightHealth,
  verifyNightArtifacts,
  type NightJobName,
} from "./lib/night-health.ts";
import { isEntrypoint } from "./lib/version-layout.ts";

async function check(
  dataDir: string,
  timeZone: string,
  targetDate: string,
  job: NightJobName,
  send?: (text: string) => Promise<boolean>,
): Promise<boolean> {
  const manifest = readNightHealth(dataDir, targetDate);
  const entry = manifest?.jobs[job];
  const reason =
    !entry || entry.state === "idle"
      ? "job did not start (manifest missing or corrupt)"
      : entry.state === "running"
        ? "job is still running at watchdog time"
        : entry.state !== "success"
          ? (entry.error ?? `job state is ${entry.state}`)
          : verifyNightArtifacts(entry.artifacts);
  if (!reason) return true;
  const failed = markNightWatchdogFailure(dataDir, job, {
    targetDate,
    timeZone,
    artifacts: entry?.artifacts ?? [],
    reason,
  });
  await notifyNightHealth(dataDir, failed, job, send);
  console.error(`night-watchdog: ${job}: ${reason}`);
  return false;
}

export async function runNightWatchdog(
  options: {
    dataDir?: string;
    timeZone?: string;
    targetDate?: string;
    send?: (text: string) => Promise<boolean>;
  } = {},
): Promise<boolean> {
  const dataDir = options.dataDir ?? resolveDataDir(process.cwd());
  const timeZone =
    options.timeZone ?? process.env.ASSISTANT_TIMEZONE ?? "Asia/Yekaterinburg";
  const targetDate = options.targetDate ?? nightTargetDate(timeZone);
  // Serial writes prevent two simultaneous missing-job repairs from losing one another.
  const results: boolean[] = [];
  for (const job of ["bitrixSync", "memoryRollup"] as const)
    results.push(await check(dataDir, timeZone, targetDate, job, options.send));
  const healthy = results.every(Boolean);
  if (healthy) console.log(`night-watchdog: ${targetDate} is healthy`);
  return healthy;
}

if (isEntrypoint(import.meta.url)) {
  if (!(await runNightWatchdog())) process.exitCode = 1;
}
