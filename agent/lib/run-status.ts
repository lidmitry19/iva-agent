// Общее состояние «идёт ли сейчас ход» per chatKey — мост (telegram-poll.mjs) и
// канал (agent/channels/telegram.ts) читают/пишут файлы data/run-status.d/*.json.
//
// Зачем: мост решает, доставлять сообщение в eve или буферизовать (агент занят),
// берёт отсюда sessionId+turnId для отмены хода по кнопке ⏹ Стоп, а канал
// пишет сюда пульс живого хода, чтобы жнец моста не снял его как протухший.
// Отдельный файл на chatKey не даёт параллельной записи одного чата потерять статус
// другого. Запись одного ключа защищена O_EXCL-локом и атомарна (unique tmp+rename).
// ЛЮБАЯ успешная запись двигает generation и updatedAt — на updatedAt держится и
// жнец, и пульс (agent/lib/telegram-turn-start.ts).
//
// chatKey = `${chatId}:${threadId ?? ""}` — тот же ключ, что chatKey() Bridge.

import { readFileSync, readdirSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  acquireFileLockSync,
  releaseFileLock,
  writeFileAtomicSync,
  type FileLock,
} from "./fs-atomic.ts";
import { dataDir } from "./data-dir.ts";

type StatusRecord = {
  generation?: number;
  status?: string;
  updatedAt?: number;
  [key: string]: unknown;
};
type StatusPatch = Record<string, unknown>;

// Поле нужно только для отката на 0.3.x. Удалить после стабилизации 0.4.x.
export const RETIRED_SESSION_ROUTING_FIELD = "continuationToken";

const errorCode = (error: unknown): string | undefined =>
  error !== null && typeof error === "object" && "code" in error
    ? typeof error.code === "string"
      ? error.code
      : undefined
    : undefined;

// Путь от cwd, как в usage.ts, а НЕ от import.meta.url: канал инлайнится в кэш
// authored-modules eve, откуда «две папки вверх» указывают в node_modules/.cache.
// Оба процесса (iva.service и мост) стартуют из одного WorkingDirectory (корень установки Ивы).
const DATA_DIR = dataDir();
const LEGACY_STATUS_FILE = join(DATA_DIR, "run-status.json");
const STATUS_DIR = join(DATA_DIR, "run-status.d");
const positiveMs = (raw: string | undefined, fallback: number): number => {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
const LOCK_STALE_MS = positiveMs(
  process.env.IVA_RUN_STATUS_LOCK_STALE_MS,
  30_000,
);
const LOCK_TIMEOUT_MS = positiveMs(
  process.env.IVA_RUN_STATUS_LOCK_TIMEOUT_MS,
  5_000,
);
const LOCK_RETRY_MS = 10;

// Ход длиннее этого считаем зависшим/осиротевшим (упал без terminal-события):
// мост перестаёт буферизовать, чтобы сообщения не копились вечно.
export const RUN_STALE_MS = Number(
  process.env.IVA_RUN_STALE_MS ?? 30 * 60 * 1000,
);

export function chatKeyOf(
  chatId: string | number,
  threadId?: string | number | null,
): string {
  return `${chatId}:${threadId ?? ""}`;
}

function statusFileOf(chatKey: string): string {
  return join(
    STATUS_DIR,
    `${Buffer.from(chatKey, "utf8").toString("base64url")}.json`,
  );
}

function readObject(file: string): StatusRecord | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      const error = new Error(`${file} does not contain a JSON object`);
      Object.assign(error, { code: "ERR_RUN_STATUS_SCHEMA" });
      throw error;
    }
    return parsed as StatusRecord;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

function isCorruptStatus(error: unknown): boolean {
  return (
    error instanceof SyntaxError || errorCode(error) === "ERR_RUN_STATUS_SCHEMA"
  );
}

function readLegacy(chatKey: string): StatusRecord | null {
  try {
    const legacy = readObject(LEGACY_STATUS_FILE);
    const value = legacy?.[chatKey];
    return isRecord(value) ? value : null;
  } catch (error) {
    // Старый код считал битый whole-map пустым. Чтение остаётся совместимым,
    // но новый код legacy-файл не переписывает и не рискует остальными чатами.
    if (isCorruptStatus(error)) return null;
    throw error;
  }
}

function isRecord(value: unknown): value is StatusRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPerChat(chatKey: string): StatusRecord | null {
  const file = statusFileOf(chatKey);
  try {
    return readObject(file);
  } catch (error) {
    if (!isCorruptStatus(error)) throw error;
    const backup = `${file}.corrupt-${Date.now()}-${randomUUID()}`;
    try {
      renameSync(file, backup);
    } catch (error) {
      // Another process may have quarantined the same file after our read.
      if (errorCode(error) !== "ENOENT") throw error;
    }
    return null;
  }
}

function readCurrent(chatKey: string): StatusRecord | null {
  return readPerChat(chatKey) ?? readLegacy(chatKey);
}

// Статус хода — не публичные данные: и лок, и сам файл создаются под 0600.
function acquireChatLock(file: string): FileLock {
  const lock = `${file}.lock`;
  const held = acquireFileLockSync(lock, {
    timeoutMs: LOCK_TIMEOUT_MS,
    staleMs: LOCK_STALE_MS,
    retryMs: LOCK_RETRY_MS,
    mode: 0o600,
  });
  if (held === null) throw new Error(`run-status lock timeout: ${lock}`);
  return held;
}

function writeCurrent(file: string, value: StatusRecord): void {
  writeFileAtomicSync(file, JSON.stringify(value), { mode: 0o600 });
}

export function getChatStatus(chatKey: string): StatusRecord | null {
  return readCurrent(chatKey);
}

// Снимок всех per-chat записей для фонового обслуживания мостом.
// Служебные lock/tmp/corrupt файлы и legacy whole-map сюда не попадают.
export function listChatStatuses(): Array<{
  chatKey: string;
  status: StatusRecord;
}> {
  let names: string[];
  try {
    names = readdirSync(STATUS_DIR);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }

  const records: Array<{ chatKey: string; status: StatusRecord }> = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const encoded = name.slice(0, -".json".length);
    if (encoded.length === 0) continue;
    const chatKey = Buffer.from(encoded, "base64url").toString("utf8");
    if (statusFileOf(chatKey) !== join(STATUS_DIR, name)) continue;
    const value = readPerChat(chatKey);
    if (value) records.push({ chatKey, status: value });
  }
  return records;
}

// true, когда по chatKey реально идёт ход (running и не протух).
export function isRunning(chatKey: string, now = Date.now()): boolean {
  const st = getChatStatus(chatKey);
  return Boolean(
    st && st.status === "running" && now - (st.updatedAt ?? 0) < RUN_STALE_MS,
  );
}

function updateChatStatus(
  chatKey: string,
  patch: StatusPatch,
  expected: StatusPatch | null,
): StatusRecord | null {
  const file = statusFileOf(chatKey);
  const lock = acquireChatLock(file);
  try {
    // Первый write лениво мигрирует этот ключ из legacy whole-map.
    const prev = readCurrent(chatKey) ?? {};
    if (
      expected &&
      Object.entries(expected).some(
        ([key, value]) => !Object.is(prev[key], value),
      )
    ) {
      return null;
    }
    const previousGeneration =
      typeof prev.generation === "number" &&
      Number.isSafeInteger(prev.generation) &&
      prev.generation >= 0
        ? prev.generation
        : 0;
    const next: StatusRecord = {
      ...prev,
      ...patch,
      generation: previousGeneration + 1,
      updatedAt: Date.now(),
    };
    delete next[RETIRED_SESSION_ROUTING_FIELD];
    for (const key of Object.keys(next))
      if (next[key] === null) delete next[key];
    writeCurrent(file, next);
    return next;
  } finally {
    releaseFileLock(lock);
  }
}

// Частичное обновление записи chatKey; null-поля в patch удаляют ключ.
export function setChatStatus(
  chatKey: string,
  patch: StatusPatch,
): StatusRecord {
  return updateChatStatus(chatKey, patch, null) as StatusRecord;
}

// Atomic compare-and-set для terminal Eve events: reset может успеть удалить
// sessionId между ранним read и записью позднего события.
export function setChatStatusIf(
  chatKey: string,
  expected: StatusPatch,
  patch: StatusPatch,
): StatusRecord | null {
  return updateChatStatus(chatKey, patch, expected);
}
