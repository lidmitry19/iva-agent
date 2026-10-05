// Shared path resolution for agent/schedules/*.ts — root/dataDir/statusPath/lockPath were
// duplicated identically across all 5 schedule files; one place to change if the status
// filename, lock filename, or ASSISTANT_DATA_DIR resolution rule ever changes.
import { join } from "node:path";
import { dataDir } from "./data-dir.ts";
import { jobFactsFile } from "./job-facts.ts";
import { JOB_STOP_GRACE_MS } from "./schedule-runner.ts";

export interface SchedulePaths {
  readonly root: string;
  readonly dataDir: string;
  readonly statusPath: string;
  readonly memoryLockPath: string;
  /** Таблица фактов расписаний (T20 п.1) — история запусков для агента и доктора. */
  readonly factsPath: string;
}

/** Замок ночной памяти установки: его держат раннер, прямой запуск ночи и `iva jobs skip`. */
export const memoryLockPath = (root: string): string =>
  join(root, ".memory.lock");

export function resolvePaths(): SchedulePaths {
  const root = process.cwd();
  const resolvedDataDir = dataDir();
  return {
    root,
    dataDir: resolvedDataDir,
    statusPath: join(resolvedDataDir, "rollup-status.json"),
    memoryLockPath: memoryLockPath(root),
    factsPath: jobFactsFile(resolvedDataDir),
  };
}

// The single code-driven night replaces four conversational rollups.
export function memoryNightJob() {
  const { root, statusPath, memoryLockPath, factsPath } = resolvePaths();
  return {
    name: "memory-night",
    argv: ["scripts/memory/night.ts"],
    root,
    nodeBin: process.execPath,
    lockPath: memoryLockPath,
    statusPath,
    factsPath,
    killGraceMs: JOB_STOP_GRACE_MS,
    wake: false,
  };
}
