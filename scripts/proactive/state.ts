// Состояние Watch — data/proactive.json (ADR-0020). Своей очереди событий нет: непрочитанное
// держат Telegram и Gmail, здесь только что уже видели и сообщили (`seen`) и счётчики дня.
//
// Чтение своё, по образцу readStatus (agent/lib/schedule-runner.ts): нет файла — начальное
// состояние; битый, нечитаемый, чужой формат или версия новее — ошибка без переименования,
// файл остаётся на месте до починки (loadJsonStrict переименовал бы его, а следующий прогон
// принял бы всё непрочитанное за новое). Запись — целым объектом через saveJsonAtomic.
import { readFileSync } from "node:fs";
import { saveJsonAtomic } from "#lib/json-store.ts";
import { zonedParts } from "#lib/zoned-time.ts";

const PROACTIVE_SCHEMA_VERSION = 1;

export type SeenEntry = {
  readonly firstSeenMs: number;
  readonly unread: number;
  readonly reported: boolean;
};

/** Счётчик одного дня; день — дата в зоне владельца, другой день — ноль. */
export type DayCount = { readonly day: string; readonly count: number };

export type ProactiveState = {
  readonly schemaVersion: number;
  readonly seen: Readonly<Record<string, SeenEntry>>;
  readonly wakes: DayCount;
  readonly modelWakes: DayCount;
  readonly briefDone: {
    readonly day: string;
    readonly slots: readonly number[];
  };
  readonly failuresSeenUpToMs: number;
};

class ProactiveStateError extends Error {}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Начальное состояние первого прогона: сбои последних суток ещё впереди. */
export function initialState(now: number): ProactiveState {
  return {
    schemaVersion: PROACTIVE_SCHEMA_VERSION,
    seen: {},
    wakes: { day: "", count: 0 },
    modelWakes: { day: "", count: 0 },
    briefDone: { day: "", slots: [] },
    failuresSeenUpToMs: now - DAY_MS,
  };
}

const isCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

function isDayCount(value: unknown): value is DayCount {
  const v = value as Partial<DayCount> | null;
  return typeof v?.day === "string" && isCount(v.count);
}

function isSeenEntry(value: unknown): value is SeenEntry {
  const v = value as Partial<SeenEntry> | null;
  return (
    typeof v?.firstSeenMs === "number" &&
    Number.isFinite(v.firstSeenMs) &&
    isCount(v.unread) &&
    typeof v.reported === "boolean"
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isState(value: Record<string, unknown>): boolean {
  const brief = value.briefDone as Partial<ProactiveState["briefDone"]> | null;
  return (
    isObject(value.seen) &&
    Object.values(value.seen).every(isSeenEntry) &&
    isDayCount(value.wakes) &&
    isDayCount(value.modelWakes) &&
    typeof brief?.day === "string" &&
    Array.isArray(brief.slots) &&
    brief.slots.every(isCount) &&
    typeof value.failuresSeenUpToMs === "number" &&
    Number.isFinite(value.failuresSeenUpToMs)
  );
}

/** Состояние с диска; нет файла — null. Остальное, кроме своего формата, — ошибка с путём. */
export function readProactiveState(path: string): ProactiveState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ProactiveStateError(
      `${path} unreadable or damaged: ${(error as Error).message}`,
    );
  }
  const version = isObject(parsed) ? parsed.schemaVersion : undefined;
  if (typeof version === "number" && version > PROACTIVE_SCHEMA_VERSION)
    throw new ProactiveStateError(
      `${path} has schemaVersion ${version}, newer than ${PROACTIVE_SCHEMA_VERSION}: written by a newer Iva`,
    );
  if (
    version !== PROACTIVE_SCHEMA_VERSION ||
    !isState(parsed as Record<string, unknown>)
  )
    throw new ProactiveStateError(`${path} is not in the proactive state form`);
  return parsed as ProactiveState;
}

export async function writeProactiveState(
  path: string,
  state: ProactiveState,
): Promise<void> {
  await saveJsonAtomic(path, state, { mode: 0o600 });
}

/** День владельца (`YYYY-MM-DD`), час и минута в его зоне. */
export function localDay(now: number, timeZone: string) {
  const { y, m, d, hh, mm } = zonedParts(now, timeZone);
  const pad = (n: number) => String(n).padStart(2, "0");
  return { day: `${y}-${pad(m)}-${pad(d)}`, hour: hh, minute: mm };
}

/** Сколько насчитано сегодня. */
export function countToday(counter: DayCount, day: string): number {
  return counter.day === day ? counter.count : 0;
}

/** Счётчик дня плюс один. */
export function bump(counter: DayCount, day: string): DayCount {
  return { day, count: countToday(counter, day) + 1 };
}

/**
 * Обновление `seen` (шаг 4): новый ключ — `firstSeenMs = now`, не сообщён; ключа нет в
 * источнике — запись уходит; у сообщённого вырос `unread` — снова не сообщён с `now`; меньше,
 * но больше нуля — новое число, `reported` прежний. `keep` — ключи источников, которые в этот
 * прогон не смотрели (ошибка или выключен): их записи не трогаются.
 */
export function updateSeen(
  seen: Readonly<Record<string, SeenEntry>>,
  observed: ReadonlyArray<{ readonly key: string; readonly unread: number }>,
  keep: (key: string) => boolean,
  now: number,
): Record<string, SeenEntry> {
  const next: Record<string, SeenEntry> = {};
  for (const [key, entry] of Object.entries(seen))
    if (keep(key)) next[key] = entry;
  for (const { key, unread } of observed) {
    const prev = Object.hasOwn(seen, key) ? seen[key] : undefined;
    next[key] =
      prev === undefined || (prev.reported && unread > prev.unread)
        ? { firstSeenMs: now, unread, reported: false }
        : { ...prev, unread };
  }
  return next;
}
