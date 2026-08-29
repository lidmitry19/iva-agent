// Shared path resolution for agent/schedules/*.ts — root/dataDir/statusPath/lockPath were
// duplicated identically across all 5 schedule files; one place to change if the status
// filename, lock filename, or ASSISTANT_DATA_DIR resolution rule ever changes.
import { join, resolve } from "node:path";
import { dataDir } from "./data-dir.ts";

export interface SchedulePaths {
  readonly root: string;
  readonly dataDir: string;
  readonly statusPath: string;
  readonly memoryLockPath: string;
}

export function resolvePaths(): SchedulePaths {
  const root = process.cwd();
  const resolvedDataDir = dataDir();
  return {
    root,
    dataDir: resolvedDataDir,
    statusPath: join(resolvedDataDir, "rollup-status.json"),
    memoryLockPath: join(root, ".memory.lock"),
  };
}

export type MemoryPeriod = "daily" | "weekly" | "monthly" | "yearly";

// Same command shape every memory-*.ts schedule spawns: `flock -w 3900 .memory.lock node
// --env-file=.env scripts/memory/rollup.ts <period>` — see agent/lib/schedule-runner.ts.
export function memoryRollupJob(period: MemoryPeriod) {
  const { root, statusPath, memoryLockPath } = resolvePaths();
  return {
    name: `memory-${period}`,
    argv: ["scripts/memory/rollup.ts", period],
    root,
    nodeBin: process.execPath,
    lockPath: memoryLockPath,
    statusPath,
    ...(period === "daily"
      ? {
          nightHealth: {
            job: "memoryRollup" as const,
            artifacts: (targetDate: string) => [
              resolve(
                process.env.ASSISTANT_VAULT_DIR ?? join(root, "vault"),
                "summaries",
                "daily",
                `${targetDate}.md`,
              ),
            ],
          },
        }
      : {}),
  };
}
