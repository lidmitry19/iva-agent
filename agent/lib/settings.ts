// Runtime-переключаемые настройки UI, общие для моста (telegram-poll.mjs) и канала
// (agent/channels/telegram.ts): оба процесса читают/пишут ОДИН файл data/settings.json.
//
// Зачем отдельный файл, а не .env: язык интерфейса меняется кнопкой в /menu и должен
// применяться мгновенно, без рестарта, обоими процессами. Файл крошечный, пишем
// атомарно (fs-atomic.ts), чтобы читатель никогда не увидел полуфайл.

import { readFileSync } from "node:fs";
import { isUtf8 } from "node:buffer";
import { join } from "node:path";
import { dataDir } from "./data-dir.ts";
import {
  acquireFileLockSync,
  releaseFileLock,
  writeFileAtomicSync,
} from "./fs-atomic.ts";

export type Settings = Record<string, unknown>;
export type SettingsFileState =
  | { state: "missing" }
  | { state: "valid"; settings: Settings }
  | { state: "corrupt"; error: Error }
  | { state: "unreadable"; error: unknown };

export const SETTINGS_WRITE_REFUSED = "ESETTINGS_WRITE_REFUSED";

export class SettingsWriteError extends Error {
  readonly code = SETTINGS_WRITE_REFUSED;
  readonly state: SettingsFileState["state"] | "busy";

  constructor(state: SettingsFileState["state"] | "busy", cause?: unknown) {
    const action =
      state === "busy"
        ? "another process holds the settings lock"
        : `settings.json is ${state}`;
    super(`Refusing to patch settings: ${action}; repair it explicitly`, {
      cause,
    });
    this.name = "SettingsWriteError";
    this.state = state;
  }
}

// Каталог фиксируется на импорте (см. data-dir.ts — почему от cwd, а не от import.meta.url).
const SETTINGS_FILE = join(dataDir(), "settings.json");
const SETTINGS_LOCK = `${SETTINGS_FILE}.lock`;

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

export function readSettingsState(
  file: string = SETTINGS_FILE,
): SettingsFileState {
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch (error) {
    return errorCode(error) === "ENOENT"
      ? { state: "missing" }
      : { state: "unreadable", error };
  }

  if (!isUtf8(bytes)) {
    return {
      state: "corrupt",
      error: new Error("settings.json is not valid UTF-8"),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    return {
      state: "corrupt",
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      state: "corrupt",
      error: new Error("settings.json must contain a JSON object"),
    };
  }
  return { state: "valid", settings: parsed as Settings };
}

// Чтение остаётся settings-specific и fail-safe: UI/Report не включаются из-за
// битого файла. Запись ниже использует полное состояние и ничего не чинит молча.
// Путь параметром нужен читателям, которые резолвят каталог данных на каждом вызове
// (журнал хода: agent/lib/trace.ts). По умолчанию — тот же файл, что и у записи.
export function readSettings(file: string = SETTINGS_FILE): Settings {
  const result = readSettingsState(file);
  return result.state === "valid" ? result.settings : {};
}

// Частичное обновление: patch мержится поверх текущего, null-поля удаляют ключ.
// Missing/valid сериализуются общим локом. Corrupt/unreadable не меняются.
export function writeSettings(patch: Settings): Settings {
  const lock = acquireFileLockSync(SETTINGS_LOCK, { mode: 0o600 });
  if (!lock) throw new SettingsWriteError("busy");
  try {
    const current = readSettingsState();
    if (current.state === "corrupt" || current.state === "unreadable") {
      throw new SettingsWriteError(current.state, current.error);
    }
    const next = {
      ...(current.state === "valid" ? current.settings : {}),
      ...patch,
    };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete next[key];
    }
    writeFileAtomicSync(SETTINGS_FILE, JSON.stringify(next), { mode: 0o600 });
    return next;
  } finally {
    releaseFileLock(lock);
  }
}
