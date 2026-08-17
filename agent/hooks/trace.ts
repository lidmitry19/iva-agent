import { defineHook, type HookContext } from "eve/hooks";
import { appendTrace } from "../lib/trace.js";
import { parentTurnId, subagentTurnId } from "../lib/usage.js";

// Журнал хода, часть eve: ОДИН хук на подстановочное событие `*` пишет каждый шаг модели,
// каждый вызов тула и каждый терминальный исход в data/trace/YYYY-MM-DD.jsonl (ADR-0010).
// Швы самой Ивы (Bridge, Inbound pipeline, Gate, Outbox, Стоп) пишут туда же из
// agent/lib/trace.ts — вместе получается цепочка одного хода.
//
// ВАЖНО: в отличие от transcript.ts раунды tool-calls НЕ фильтруются — в журнале обязан
// быть КАЖДЫЙ шаг. Зато отброшены дельта-события (`message.appended`, `reasoning.appended`,
// `action.partial`): они несут накопительный `…SoFar` сотни раз за ход, поэтому журнал рос
// бы квадратично, ничего нового не сообщая — итоговый текст приходит в `*.completed`.
//
// Шаги инлайн-субагента (planner) приходят завёрнутыми в `subagent.event`: разворачиваем и
// пишем внутреннее событие ключом хода РОДИТЕЛЯ с суффиксом (тот же subagentTurnId, что у
// usage.jsonl), поэтому ход субагента виден вложенным и сходится с учётом расхода.
const DELTA_EVENTS = new Set([
  "message.appended",
  "reasoning.appended",
  "action.partial",
]);

// Короткие поля события: имена, индексы, коды, статусы. Пишутся всегда.
const SCALAR_FIELDS = [
  "sequence",
  "stepIndex",
  "finishReason",
  "status",
  "code",
  "callId",
  "childSessionId",
  "sessionId",
  "subagentName",
  "toolName",
  "name",
  "isError",
] as const;

// Содержимое: текст модели, аргументы и результаты тулов. Пишется под тумблером
// captureContent и всегда с потолком на поле (agent/lib/trace.ts).
const CONTENT_FIELDS = [
  "message",
  "reasoning",
  "output",
  "result",
  "input",
  "details",
] as const;

type StreamEvent = { readonly type: string; readonly data?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isScalar(value: unknown): boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// Одна запрошенная моделью операция: что это и как называется. Аргументы остаются в
// содержимом целиком — в data едет только имя.
function actionSummary(action: unknown): Record<string, unknown> {
  if (!isRecord(action)) return {};
  const out: Record<string, unknown> = {};
  for (const key of ["kind", "callId", "toolName", "name", "subagentName"]) {
    if (isScalar(action[key])) out[key] = action[key];
  }
  return out;
}

function project(data: Record<string, unknown>): {
  data: Record<string, unknown>;
  content: Record<string, unknown>;
} {
  const out: Record<string, unknown> = {};
  const content: Record<string, unknown> = {};

  for (const key of SCALAR_FIELDS)
    if (isScalar(data[key])) out[key] = data[key];

  if (isRecord(data.usage)) {
    const usage = data.usage;
    out.usage = {
      in: usage.inputTokens ?? 0,
      out: usage.outputTokens ?? 0,
      cacheRead: usage.cacheReadTokens ?? 0,
      cacheWrite: usage.cacheWriteTokens ?? 0,
      ...(typeof usage.costUsd === "number" ? { costUsd: usage.costUsd } : {}),
    };
  }
  if (Array.isArray(data.actions)) {
    // Имена операций — в data, аргументы — в содержимое, ПОЗИЦИЯ В ПОЗИЦИЮ: один ключ не
    // может значить «сводка» при выключенном тумблере и «всё целиком» при включённом.
    out.actions = data.actions.map(actionSummary);
    content.args = data.actions.map((action: unknown) =>
      isRecord(action) ? action.input : action,
    );
  }
  if (Array.isArray(data.parts)) out.parts = data.parts.length;
  // Ошибка тула: код — в data (по нему видно класс отказа), текст — в содержимое.
  if (isRecord(data.error)) {
    if (isScalar(data.error.code)) out.errorCode = data.error.code;
    content.error = data.error.message;
  }
  // Результат тула несёт своё имя и признак ошибки — они нужны и без содержимого.
  if (isRecord(data.result)) {
    for (const key of ["toolName", "callId", "isError"]) {
      if (out[key] === undefined && isScalar(data.result[key]))
        out[key] = data.result[key];
    }
  }
  for (const key of CONTENT_FIELDS) {
    if (data[key] !== undefined && content[key] === undefined)
      content[key] = data[key];
  }
  return { data: out, content };
}

function record(
  event: StreamEvent,
  ctx: HookContext,
  subagent?: { name: string; callId: unknown },
): void {
  if (DELTA_EVENTS.has(event.type)) return;
  const data = isRecord(event.data) ? event.data : {};
  const projected = project(data);
  appendTrace({
    kind: "eve",
    name: event.type,
    turn: subagent
      ? subagentTurnId(ctx.session.turn, subagent.name, text(data.turnId))
      : text(data.turnId) || parentTurnId(ctx.session.turn),
    session: ctx.session.id,
    source: ctx.channel?.kind ?? "unknown",
    data: subagent
      ? {
          ...projected.data,
          subagent: subagent.name,
          parentCallId: subagent.callId,
        }
      : projected.data,
    content: projected.content,
  });
}

export default defineHook({
  events: {
    // `*` ловит каждое принятое событие рантайма — отдельная подписка на конкретный тип
    // здесь запрещена: она пришла бы вместе с подстановочной и удвоила строку.
    "*": (event, ctx) => {
      // Один try на весь обработчик: журнал не имеет права уронить ход НИ НА ЧЁМ —
      // ни на чужом геттере в payload, ни на обрезанном subagent.event, ни на
      // контексте без канала. Писатель внутри тоже глотает свои ошибки, но событие
      // ещё надо собрать, а собирается оно из чужих данных.
      try {
        if (event.type === "subagent.event") {
          record(event.data.event, ctx, {
            name: event.data.subagentName,
            callId: event.data.callId,
          });
          return;
        }
        record(event, ctx);
      } catch (error) {
        console.error("[trace] событие eve не записано:", error);
      }
    },
  },
});
