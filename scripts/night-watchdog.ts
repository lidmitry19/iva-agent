#!/usr/bin/env node
// Independent of Eve and every LLM: this is the 05:00 proof that the night happened.
import { resolveDataDir } from "./lib/data-dir.ts";
import {
  markNightJob,
  nightTargetDate,
  notifyNightHealth,
  readNightHealth,
  verifyNightArtifacts,
  type NightJobName,
} from "./lib/night-health.ts";

const dataDir = resolveDataDir(process.cwd());
const timeZone = process.env.ASSISTANT_TIMEZONE ?? "Asia/Yekaterinburg";
const targetDate = nightTargetDate(timeZone);

async function check(job: NightJobName): Promise<boolean> {
  const manifest = readNightHealth(dataDir, targetDate);
  const entry = manifest?.jobs[job];
  const reason =
    !entry
      ? "job did not start (manifest missing or corrupt)"
      : entry.state === "running"
        ? "job is still running at watchdog time"
        : entry.state !== "success"
          ? entry.error ?? `job state is ${entry.state}`
          : verifyNightArtifacts(entry.artifacts);
  if (!reason) return true;
  const failed = markNightJob(dataDir, job, {
    targetDate,
    timeZone,
    state: "failed",
    artifacts: entry?.artifacts ?? [],
    error: `watchdog: ${reason}`,
  });
  await notifyNightHealth(dataDir, failed, job);
  console.error(`night-watchdog: ${job}: ${reason}`);
  return false;
}

const results = await Promise.all([check("bitrixSync"), check("memoryRollup")]);
if (results.every(Boolean)) console.log(`night-watchdog: ${targetDate} is healthy`);
else process.exitCode = 1;
