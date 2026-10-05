import {
  DEFAULT_TIMEOUT_MS,
  JOB_STOP_AT_ENV,
  JOB_STOP_GRACE_MS,
} from "#lib/schedule-runner.ts";

const MAX_TIMER_MS = 2 ** 31 - 1;

/** Resolve the code-driven night's stop time from the schedule runner deadline. */
export function resolveStopAt(raw: string | undefined, nowMs: number): number {
  if (raw === undefined || raw === "")
    return nowMs + DEFAULT_TIMEOUT_MS - JOB_STOP_GRACE_MS;
  const stopAt = Number(raw);
  const ahead = stopAt - nowMs;
  if (!/^\d+$/u.test(raw) || ahead <= 0 || ahead > MAX_TIMER_MS)
    throw new TypeError(
      `${JOB_STOP_AT_ENV}=${raw} is not a future epoch time in milliseconds within ${MAX_TIMER_MS} ms from now`,
    );
  return stopAt;
}
