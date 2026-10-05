// .memory.lock — один писатель ночной памяти. Раннер держит его `flock` вокруг night.ts и
// говорит об этом ребёнку переменной MEMORY_LOCK_HELD_ENV (agent/lib/schedule-runner.ts).
// Прямой запуск ночи и `iva jobs skip` берут тот же замок тем же `flock`: процесс
// перезапускает себя под ним. Файловый лок из fs-atomic тут не годится — он с `flock` друг
// друга не видят. Срок IVA_JOB_STOP_AT признаком владения замком не служит.
import { spawnSync } from "node:child_process";
import { MEMORY_LOCK_HELD_ENV } from "#lib/schedule-runner.ts";

const BUSY = 75;

/** null — процесс уже под замком, работай; число — код выхода (перезапуск под замком
 * отработал или замок взять нельзя, причина уже в stderr одной строкой). */
export function underMemoryLock(
  lockPath: string,
  env = process.env,
): number | null {
  if (env[MEMORY_LOCK_HELD_ENV] === "1") return null;
  const run = spawnSync(
    "flock",
    [
      "-n",
      "-E",
      String(BUSY),
      lockPath,
      process.execPath,
      ...process.execArgv,
      ...process.argv.slice(1),
    ],
    { stdio: "inherit", env: { ...env, [MEMORY_LOCK_HELD_ENV]: "1" } },
  );
  if (run.error) {
    console.error(
      `cannot take ${lockPath}: flock is unavailable (${run.error.message})`,
    );
    return 1;
  }
  if (run.status === BUSY) {
    console.error(
      `${lockPath} is held by a running memory job — try again after it ends`,
    );
    return 1;
  }
  return run.status ?? 1;
}
