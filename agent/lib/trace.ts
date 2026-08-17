// Trace — журнал хода (ADR-0010). Одна строка JSONL на событие: от приёма апдейта
// Bridge до доставки ответа через Outbox, включая события eve (хук agent/hooks/trace.ts)
// и швы Ивы. Файл дня — data/trace/YYYY-MM-DD.jsonl, append-only. Читают вьюер плагина
// `trace` и `iva trace`, поэтому схема события фиксирована и мала:
//   { ts, turn, session, source, kind, name, data }
// `kind` — группа шва (bridge, inbound, gate, turn, eve, outbox, stop), `name` — конкретное
// событие внутри группы. Всё остальное живёт в `data`, у полей содержимого свой потолок.
//
// Три правила, из которых всё остальное следует:
//  1. Журнал НИКОГДА не ломает и не тормозит ход: любая ошибка записи глотается в
//     console.error. Диагностика не имеет права стоить пользователю сообщения.
//  2. Ход до появления eve-turn связывается ключом апдейта: события Bridge, inbound и
//     inbound-Gate несут `turn = tg:<chat>:<message>`, а шов старта хода пишет
//     `turn.bound` — там ключ апдейта и turnId лежат в одной строке (см. traceBindUpdate).
//  3. Чистка — по дате В ИМЕНИ файла, никогда не по mtime (ADR-0002, philosophy §5):
//     mtime врёт после копирования и восстановления, а платят за это данными.
//
// Модуль живёт в authored tree, потому что пишут журнал и агент, и мост
// (scripts/poller/* через алиас `#lib/trace.ts`) — как у agent/lib/usage.ts.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { dataDir } from "./data-dir.ts";
import { readSettings } from "./settings.ts";
import { allowedTelegramUsers } from "./telegram-allowlist.ts";
import { resolveTimeZone } from "./timezone.ts";

export type TraceEvent = {
  ts: string;
  turn: string;
  session: string;
  source: string;
  kind: string;
  name: string;
  data: Record<string, unknown>;
};

// Вход писателя. `data` пишется всегда (имена, тайминги, размеры); `content` — только
// при captureContent, но его РАЗМЕРЫ (`<ключ>Chars`) остаются в `data` в любом случае:
// выключенное содержимое не должно превращать ход в набор безымянных точек.
export type TraceInput = {
  kind: string;
  name: string;
  turn?: string;
  session?: string;
  source?: string;
  data?: Record<string, unknown>;
  content?: Record<string, unknown>;
};

export type TraceOptions = {
  /** Каталог данных. По умолчанию dataDir() — резолвится на каждой записи. */
  dir?: string;
  now?: Date;
  /** Явное значение тумблера; по умолчанию читается из data/settings.json. */
  captureContent?: boolean;
};

// Потолок на поле содержимого — идея CONTENT_ATTRIBUTE_LIMIT из трейсинга eve, но своя
// реализация: чужие внутренности не парсим (philosophy §5). 2000 знаков — читаемый кусок
// аргумента или ответа, а не файл целиком.
export const TRACE_CONTENT_LIMIT = 2000;
// Короткие поля-идентификаторы: ход, сессия, источник, группа, имя события.
export const TRACE_ID_LIMIT = 200;
// Потолок строки. Одна запись — один write(2) в O_APPEND, поэтому строка обязана быть
// заведомо маленькой: так параллельные писатели (агент и мост) не рвут строки друг другу.
export const TRACE_LINE_LIMIT = 16 * 1024;
// Сколько дней журнала держим: сегодняшний файл и 13 предыдущих.
export const TRACE_RETENTION_DAYS = 14;
export const TRACE_TRUNCATION_MARKER = "…[truncated]";
export const TRACE_DEPTH_MARKER = "…[deep]";

const MAX_DEPTH = 4;
const MAX_ITEMS = 20;
const MAX_KEYS = 30;
const TRACE_FILE_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/u;

export function traceDir(dir: string = dataDir()): string {
  return join(dir, "trace");
}

export function traceFilePath(day: string, dir: string = dataDir()): string {
  return join(traceDir(dir), `${day}.jsonl`);
}

// День в часовом поясе установки — тот же, что у дневных файлов Vault
// (agent/lib/vault-daily.ts): один ход не должен попадать в два разных «сегодня».
export function traceDay(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: resolveTimeZone(process.env.ASSISTANT_TIMEZONE),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function captureContentEnabled(): boolean {
  return readSettings().captureContent !== false;
}

// Обрезка строки по потолку с явной пометкой. Пара суррогатов пополам не режется:
// иначе в журнале осталась бы одинокая половина символа.
export function capTraceString(value: string, limit: number): string {
  if (value.length <= limit) return value;
  let keep = Math.max(0, limit - TRACE_TRUNCATION_MARKER.length);
  const last = keep > 0 ? value.charCodeAt(keep - 1) : 0;
  if (last >= 0xd800 && last <= 0xdbff) keep -= 1;
  return value.slice(0, keep) + TRACE_TRUNCATION_MARKER;
}

// Любое значение → JSON-безопасное и ограниченное: строки по потолку, массивы и объекты
// по числу элементов, вложенность по глубине. Циклы обрываются той же глубиной, поэтому
// JSON.stringify ниже не может уйти в бесконечность.
function capValue(value: unknown, limit: number, depth: number): unknown {
  if (typeof value === "string") return capTraceString(value, limit);
  if (typeof value === "number" || typeof value === "boolean" || value === null)
    return value;
  if (typeof value === "bigint") return capTraceString(value.toString(), limit);
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return TRACE_DEPTH_MARKER;
    const items: unknown[] = value
      .slice(0, MAX_ITEMS)
      .map((item) => capValue(item, limit, depth + 1) ?? null);
    if (value.length > MAX_ITEMS) items.push(TRACE_TRUNCATION_MARKER);
    return items;
  }
  if (typeof value === "object") {
    if (depth >= MAX_DEPTH) return TRACE_DEPTH_MARKER;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, MAX_KEYS)) {
      const capped = capValue(item, limit, depth + 1);
      if (capped !== undefined)
        out[capTraceString(key, TRACE_ID_LIMIT)] = capped;
    }
    return out;
  }
  return undefined; // undefined, функция, symbol — в JSON им места нет
}

function capRecord(
  record: Record<string, unknown>,
  limit: number,
): Record<string, unknown> {
  return capValue(record, limit, 1) as Record<string, unknown>;
}

function header(input: TraceInput, now: Date) {
  return {
    ts: now.toISOString(),
    turn: capTraceString(String(input.turn ?? ""), TRACE_ID_LIMIT),
    session: capTraceString(String(input.session ?? ""), TRACE_ID_LIMIT),
    source: capTraceString(String(input.source ?? ""), TRACE_ID_LIMIT),
    kind: capTraceString(String(input.kind), TRACE_ID_LIMIT),
    name: capTraceString(String(input.name), TRACE_ID_LIMIT),
  };
}

/**
 * Событие → одна строка JSONL (без перевода строки). Чистая функция: writer вызывает
 * её, а тесты проверяют схему и потолки без файловой системы.
 *
 * Гарантии: результат — валидный JSON без переводов строк внутри, длиной не больше
 * TRACE_LINE_LIMIT. Строка, не влезшая с содержимым, пересобирается без него и метится
 * `data.traceTrimmed`, поэтому «слишком большое событие» становится маленьким событием,
 * а не потерянным.
 */
export function traceLine(
  input: TraceInput,
  options: TraceOptions = {},
): string {
  const now = options.now ?? new Date();
  const capture = options.captureContent ?? captureContentEnabled();
  const content = input.content ?? {};
  const sizes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(content)) {
    if (typeof value === "string") sizes[`${key}Chars`] = value.length;
  }
  const base = { ...(input.data ?? {}), ...sizes };
  const full = capture ? { ...base, ...content } : base;

  const head = header(input, now);
  const line = JSON.stringify({
    ...head,
    data: capRecord(full, TRACE_CONTENT_LIMIT),
  });
  if (line.length <= TRACE_LINE_LIMIT) return line;

  const trimmed = JSON.stringify({
    ...head,
    data: capRecord({ ...base, traceTrimmed: true }, TRACE_CONTENT_LIMIT),
  });
  if (trimmed.length <= TRACE_LINE_LIMIT) return trimmed;
  return JSON.stringify({ ...head, data: { traceTrimmed: true } });
}

// Каталог журнала создаём внутри УЖЕ существующего каталога данных и один раз на процесс.
// Сам data/ писатель не создаёт: журнал не имеет права материализовать установку там, где
// её нет (тест, CLI из чужого cwd) — он всего лишь диагностика.
let ensuredTraceDir = "";
function ensureTraceDir(dir: string): boolean {
  const target = traceDir(dir);
  if (ensuredTraceDir === target) return true;
  if (!existsSync(dir)) return false;
  mkdirSync(target, { recursive: true });
  ensuredTraceDir = target;
  return true;
}

let prunedFor = "";
function pruneOnNewDay(dir: string, day: string): void {
  const marker = `${dir} ${day}`;
  if (prunedFor === marker) return;
  prunedFor = marker;
  pruneTrace(dir, day);
}

/**
 * Чистка журнала по дате В ИМЕНИ файла. Имена не по шаблону не трогаем вовсе: чужой файл
 * в каталоге — не повод его удалять. Возвращает удалённые имена (для теста и CLI).
 */
export function pruneTrace(
  dir: string = dataDir(),
  today: string = traceDay(),
  days: number = TRACE_RETENTION_DAYS,
): string[] {
  const cutoff = shiftDay(today, -(days - 1));
  if (cutoff === null) return []; // непонятное «сегодня» — ничего не удаляем
  const removed: string[] = [];
  let names: string[];
  try {
    names = readdirSync(traceDir(dir));
  } catch {
    return removed; // каталога журнала ещё нет
  }
  for (const name of names) {
    if (!TRACE_FILE_RE.test(name)) continue;
    if (name.slice(0, 10) >= cutoff) continue;
    rmSync(join(traceDir(dir), name), { force: true });
    removed.push(name);
  }
  return removed;
}

function shiftDay(day: string, delta: number): string | null {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(day);
  if (!parts) return null;
  const at = new Date(
    Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]) + delta),
  );
  return Number.isNaN(at.getTime()) ? null : at.toISOString().slice(0, 10);
}

/**
 * Дозапись одного события. Одна строка одним appendFileSync в O_APPEND — параллельные
 * писатели (процесс агента и мост) не перемешивают половины строк.
 */
export function appendTrace(
  input: TraceInput,
  options: TraceOptions = {},
): void {
  try {
    const dir = options.dir ?? dataDir();
    const now = options.now ?? new Date();
    const day = traceDay(now);
    if (!ensureTraceDir(dir)) return;
    appendFileSync(
      traceFilePath(day, dir),
      `${traceLine(input, { ...options, now })}\n`,
      "utf8",
    );
    pruneOnNewDay(dir, day);
  } catch (error) {
    console.error("[trace] событие не записано:", error);
  }
}

// Швы зовут журнал одной строкой, поэтому сборка события тоже обязана быть безопасной:
// упавший геттер в чужом payload не имеет права уронить ход.
function emit(build: () => TraceInput): void {
  try {
    appendTrace(build());
  } catch (error) {
    console.error("[trace] событие не собрано:", error);
  }
}

// --- Корреляция: ключ апдейта ↔ ход ---

// В журнал попадает только то, что имеет текстовый вид: чужой объект в поле id даёт
// пустую часть ключа, а не "[object Object]".
function scalarText(value: unknown): string {
  return typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean"
    ? String(value)
    : "";
}

/** Ключ апдейта: минимальное, что знают обе стороны — мост и ядро. */
export function traceUpdateKey(chatId: unknown, messageId: unknown): string {
  return `tg:${scalarText(chatId)}:${scalarText(messageId)}`;
}

type TelegramUpdateLike = {
  update_id?: unknown;
  message?: { message_id?: unknown; chat?: { id?: unknown } } | null;
  callback_query?: {
    id?: unknown;
    message?: { chat?: { id?: unknown } } | null;
  } | null;
};

// Разбор сырого апдейта Telegram живёт в одном месте: и мост, и ядро должны получать
// ОДИН И ТОТ ЖЕ ключ, иначе цепочка хода рвётся ровно посередине.
function updateFacts(update: TelegramUpdateLike): {
  updateId: unknown;
  chatId: unknown;
  messageId: string;
  kind: string;
} {
  const message = update.message ?? undefined;
  const callback = update.callback_query ?? undefined;
  const chatId = message?.chat?.id ?? callback?.message?.chat?.id;
  return {
    updateId: typeof update.update_id === "number" ? update.update_id : null,
    chatId: chatId ?? null,
    messageId: message
      ? scalarText(message.message_id)
      : `cb:${scalarText(callback?.id)}`,
    kind: message ? "message" : callback ? "callback" : "unknown",
  };
}

// Ключ апдейта, с которого начался ход этого чата. Живёт в памяти процесса агента ровно
// между приёмом апдейта и turn.started — оба события в одном процессе. Карта ограничена:
// журнал не имеет права расти вместе с числом чатов.
const MAX_BINDINGS = 64;
const bindings = new Map<string, string>();

export function traceBindUpdate(chatKey: string, updateKey: string): void {
  if (!chatKey) return;
  bindings.delete(chatKey);
  bindings.set(chatKey, updateKey);
  for (const key of bindings.keys()) {
    if (bindings.size <= MAX_BINDINGS) break;
    bindings.delete(key);
  }
}

export function traceBoundUpdate(chatKey: string): string {
  return bindings.get(chatKey) ?? "";
}

// --- Швы Ивы ---

type InboundMessageLike = {
  readonly chat: { readonly id: string; readonly type: string };
  readonly from?: { readonly id: string } | undefined;
  readonly messageId: string;
  readonly text: string;
  readonly caption: string;
};

/**
 * Шов Inbound pipeline: апдейт вошёл внутрь. Вердикт allowlist читается из того же
 * источника, что и сам барьер (`allowedTelegramUsers`), поэтому в журнале не может
 * появиться «пропущен» там, где пайплайн отказал.
 */
export function traceInboundReceived(message: InboundMessageLike): void {
  emit(() => {
    const userId = message.from?.id ?? "";
    const text = message.text || message.caption || "";
    return {
      kind: "inbound",
      name: "received",
      turn: traceUpdateKey(message.chat.id, message.messageId),
      source: "telegram",
      data: {
        chatId: message.chat.id,
        chatType: message.chat.type,
        messageId: message.messageId,
        userId,
        allowlisted: allowedTelegramUsers().has(userId),
      },
      content: { text },
    };
  });
}

/**
 * Шов Inbound pipeline: чем кончился разбор апдейта. Ход поехал — пишем состав контекста,
 * который Ива собрала сама (цитата, медиа, буфер занятости, пометки Gate); апдейт отброшен —
 * пишем это отдельным событием, иначе цепочка обрывается без объяснения.
 */
export function traceInboundOutcome(
  message: InboundMessageLike,
  chatKey: string,
  context: readonly string[] | undefined,
  accepted: boolean,
): void {
  emit(() => {
    const updateKey = traceUpdateKey(message.chat.id, message.messageId);
    // Ход вот-вот начнётся: запоминаем, каким апдейтом он вызван, чтобы turn.started
    // мог связать его с turnId. Отброшенный апдейт хода не порождает и ничего не метит.
    if (accepted) traceBindUpdate(chatKey, updateKey);
    return {
      kind: "inbound",
      name: accepted ? "accepted" : "dropped",
      turn: updateKey,
      source: "telegram",
      data: {
        chatId: message.chat.id,
        chatKey,
        parts: context?.length ?? 0,
        partChars: (context ?? []).map((part) => part.length),
      },
      content: { context: context ?? [] },
    };
  });
}

/** Шов inbound-Gate: вердикт санитайзера входа. */
export function traceInboundGate(
  surface: string,
  verdict: {
    readonly blocked: boolean;
    readonly reason: string;
    readonly flags: readonly string[];
    readonly truncatedChars: number;
  },
  chars: number,
): void {
  emit(() => ({
    kind: "gate",
    name: "inbound",
    source: surface,
    data: {
      surface,
      blocked: verdict.blocked,
      reason: verdict.reason,
      flags: [...verdict.flags],
      truncatedChars: verdict.truncatedChars,
      chars,
    },
  }));
}

/**
 * Шов старта хода: ключ апдейта и turnId в одной строке. Это единственное место, где
 * события «до хода» сшиваются с событиями eve, поэтому оно пишется даже когда ключа нет
 * (проактивный ход, callback) — тогда `updateKey` пустой.
 */
export function traceTurnBound(
  chatKey: string,
  sessionId: string,
  turnId: string,
): void {
  emit(() => ({
    kind: "turn",
    name: "bound",
    turn: turnId,
    session: sessionId,
    source: "telegram",
    data: { chatKey, updateKey: traceBoundUpdate(chatKey) },
  }));
}

/** Шов outbound-Gate: что нашёл сканер в тексте, уходящем в чат. */
export function traceOutboundGate(
  turn: string,
  session: string,
  clean: boolean,
  findings: readonly { readonly type: string; readonly name: string }[],
  chars: number,
): void {
  emit(() => ({
    kind: "gate",
    name: "outbound",
    turn,
    session,
    source: "telegram",
    data: {
      clean,
      findings: findings.map((finding) => `${finding.type}:${finding.name}`),
      chars,
    },
  }));
}

/** Шов Outbox: что ушло в чат и чем кончилась доставка. */
export function traceOutboxResult(
  turn: string,
  session: string,
  text: string,
  result: {
    readonly ok: boolean;
    readonly delivered: number;
    readonly fellBack: boolean;
    readonly error: string;
  },
  ms: number,
): void {
  emit(() => ({
    kind: "outbox",
    name: result.ok ? "delivered" : "failed",
    turn,
    session,
    source: "telegram",
    data: { ...result, ms },
    content: { text },
  }));
}

/** Шов «Стоп»: чем кончилась просьба остановить ход. */
export function traceStop(
  chatKey: string,
  turnId: unknown,
  outcome: string,
): void {
  emit(() => ({
    kind: "stop",
    name: outcome,
    turn: typeof turnId === "string" ? turnId : "",
    source: "telegram",
    data: { chatKey, outcome },
  }));
}

/** Шов Bridge: апдейт принят мостом (или отброшен его политикой). */
export function traceBridgeAdmission(
  update: TelegramUpdateLike,
  decision: string,
): void {
  emit(() => {
    const facts = updateFacts(update);
    return {
      kind: "bridge",
      name: "admitted",
      turn: traceUpdateKey(facts.chatId, facts.messageId),
      source: "bridge",
      data: { ...facts, decision },
    };
  });
}

/** Шов Bridge: апдейт отдан агенту (или не принят им). */
export function traceBridgeDelivery(
  update: TelegramUpdateLike,
  accepted: unknown,
  ms: number,
): void {
  emit(() => {
    const facts = updateFacts(update);
    return {
      kind: "bridge",
      name: accepted ? "delivered" : "rejected",
      turn: traceUpdateKey(facts.chatId, facts.messageId),
      source: "bridge",
      data: {
        ...facts,
        accepted: accepted === "handled" ? "handled" : Boolean(accepted),
        ms,
      },
    };
  });
}
