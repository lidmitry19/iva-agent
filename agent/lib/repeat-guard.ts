// Временно до встроенной в eve защиты от повторов; удалить, когда eve остановит ход
// на повторяющемся невалидном вызове сам. См. docs/tech-debt.md.
import type { LanguageModelMiddleware } from "ai";
import type {
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";
import { tr } from "./i18n.ts";
import { traceRepeatGuard } from "./trace.ts";

type Call = {
  toolCallId: string;
  toolName: string;
  input: unknown;
  at: number;
};
type Failure = {
  toolCallId: string;
  tool: string;
  signature: string;
  errorHead: string;
  at: number;
};
type Attempt = {
  toolCallId: string;
  tool: string;
  failure?: Failure;
  at: number;
};
type Stop = { tool: string; count: number; errorHead: string; message: string };

function canonical(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function canonicalInput(input: unknown): string {
  if (typeof input !== "string") return canonical(input);
  try {
    return canonical(JSON.parse(input));
  } catch {
    return canonical(input);
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonempty(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === "")
    return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  const object = record(value);
  if (object) {
    if (nonempty(object.error)) return errorText(object.error);
    if (typeof object.message === "string" && object.message.trim())
      return object.message;
  }
  return canonical(value);
}

function decodedOutput(kind: unknown, raw: unknown): unknown {
  if ((kind !== "text" && kind !== "error-text") || typeof raw !== "string")
    return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw; // обычный текстовый ответ инструмента
  }
}

function failureFromOutput(output: unknown): string | undefined {
  const part = record(output);
  if (!part) return undefined;
  const { type: kind, value: raw } = part;
  const value = decodedOutput(kind, raw);
  const object = record(value);
  if (kind === "error-text" || kind === "error-json" || kind === "tool-error")
    return errorText(value);
  if (object && nonempty(object.error)) return errorText(object.error);
  if (object?.ok === false) return "ok: false";
  return undefined;
}

function normalizedError(value: string): string {
  return value
    .replace(
      /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/gu,
      "<time>",
    )
    .replace(/\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/gu, "<time>")
    .replace(
      /\/(?:private\/)?tmp\/[^\s"']+|\/var\/folders\/[^\s"']+/gu,
      "<tmp>",
    )
    .replace(
      /\b(?:pid|process|request[_ -]?id|call[_ -]?id)\s*[:=#]?\s*\d+\b/giu,
      "<id>",
    )
    .replace(/\b\d{4,}\b/gu, "<id>")
    .replace(/\s+/gu, " ")
    .trim();
}

function humanErrorHead(error: string): string {
  const markup = /<[!/a-z][^>]*>/iu.test(error);
  const firstTag = error.indexOf("<");
  const firstLine = error.search(/[\r\n]/u);
  const cut = markup
    ? Math.min(
        firstTag < 0 ? error.length : firstTag,
        firstLine < 0 ? error.length : firstLine,
      )
    : error.length;
  const head = error.slice(0, cut).trim();
  return (head || tr("HTML response", "Ответ HTML")).slice(0, 160);
}

function stopMessage(tool: string, count: number, errorHead: string): string {
  const shortError = errorHead.slice(0, 150);
  return tr(
    `Tool ${tool} failed ${count} times in a row: ${shortError}. I stopped this turn to save tokens. You can rephrase your request.`,
    `Инструмент ${tool} завершился ошибкой ${count} ${count === 3 ? "раза" : "раз"} подряд: ${shortError}. Ход остановлен, чтобы не тратить токены. Можно переформулировать просьбу.`,
  );
}

function lastUserIndex(prompt: LanguageModelV4Prompt): number {
  for (let i = prompt.length - 1; i >= 0; i--) {
    if (prompt[i]?.role === "user") return i;
  }
  return -1;
}

type Scan = {
  calls: Map<string, Call>;
  attempts: Attempt[];
  newestCallAt: number;
  endsInResult: boolean;
};

function consumeResult(
  part: { toolCallId: string; toolName: string; output: unknown },
  scan: Scan,
): boolean {
  const call = scan.calls.get(part.toolCallId);
  if (!call || call.toolName !== part.toolName) return false;
  scan.calls.delete(part.toolCallId);
  const error = failureFromOutput(part.output);
  scan.attempts.push({
    toolCallId: call.toolCallId,
    tool: call.toolName,
    at: call.at,
    ...(error === undefined
      ? {}
      : {
          failure: {
            toolCallId: call.toolCallId,
            tool: call.toolName,
            signature: `${call.toolName}\n${canonicalInput(call.input)}\n${normalizedError(error)}`,
            errorHead: humanErrorHead(error),
            at: call.at,
          },
        }),
  });
  return true;
}

function scanMessage(
  message: LanguageModelV4Prompt[number],
  at: number,
  scan: Scan,
): void {
  if (message.role !== "assistant" && message.role !== "tool") return;
  for (const part of message.content) {
    if (message.role === "assistant" && part.type === "tool-call") {
      scan.calls.set(part.toolCallId, {
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: part.input,
        at,
      });
      scan.newestCallAt = at;
      scan.endsInResult = false;
    } else if (part.type === "tool-result") {
      if (consumeResult(part, scan)) scan.endsInResult = true;
    } else if (message.role === "assistant" && part.type === "text") {
      scan.endsInResult = false;
    }
  }
}

function scanPrompt(prompt: LanguageModelV4Prompt): Scan {
  const scan: Scan = {
    calls: new Map(),
    attempts: [],
    newestCallAt: -1,
    endsInResult: false,
  };
  for (let i = lastUserIndex(prompt) + 1; i < prompt.length; i++)
    scanMessage(prompt[i], i, scan);
  return scan;
}

function stepsFromAttempts(attempts: Attempt[]): Attempt[][] {
  const steps = new Map<number, Attempt[]>();
  for (const attempt of attempts) {
    const step = steps.get(attempt.at) ?? [];
    step.push(attempt);
    steps.set(attempt.at, step);
  }
  return [...steps.entries()].sort(([a], [b]) => a - b).map(([, step]) => step);
}

function failedForTool(step: Attempt[], tool: string): boolean {
  return (
    step.length > 0 &&
    !step.some((attempt) => !attempt.failure) &&
    step.some((attempt) => attempt.tool === tool)
  );
}

function sameSignatureInStep(
  step: Attempt[],
  tool: string,
  signature: string,
): boolean {
  return step
    .filter((attempt) => attempt.tool === tool)
    .every((attempt) => attempt.failure?.signature === signature);
}

function failureCount(steps: Attempt[][], latest: Failure): number {
  let same = 0;
  let sameTool = 0;
  for (let i = steps.length - 1; i >= 0; i--) {
    if (!failedForTool(steps[i], latest.tool)) break;
    sameTool++;
    if (
      same === sameTool - 1 &&
      sameSignatureInStep(steps[i], latest.tool, latest.signature)
    )
      same++;
    if (sameTool >= 8) break;
  }
  return same >= 3 ? same : sameTool >= 8 ? sameTool : 0;
}

function stopFromAttempts(attempts: Attempt[]): Stop | undefined {
  const steps = stepsFromAttempts(attempts);
  const last = steps.at(-1);
  if (!last || last.some((attempt) => !attempt.failure)) return undefined;
  for (const attempt of last) {
    const failure = attempt.failure;
    if (!failure) continue;
    const count = failureCount(steps, failure);
    if (count > 0)
      return {
        tool: failure.tool,
        count,
        errorHead: failure.errorHead,
        message: stopMessage(failure.tool, count, failure.errorHead),
      };
  }
  return undefined;
}

/** Решение только по истории текущего хода. Никакого счётчика между вызовами модели. */
export function inspectRepeatGuard(prompt: LanguageModelV4Prompt): {
  rejected: Failure[];
  stop?: Stop;
} {
  const scan = scanPrompt(prompt);
  const rejected = scan.attempts
    .filter(
      (attempt) =>
        attempt.at === scan.newestCallAt && attempt.failure !== undefined,
    )
    .map((attempt) => attempt.failure!);
  if (!scan.endsInResult || scan.calls.size > 0) return { rejected };
  const stop = stopFromAttempts(scan.attempts);
  return stop ? { rejected, stop } : { rejected };
}

const zeroUsage: LanguageModelV4Usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
};

// Только журналу нужен учёт ID; решение о стопе целиком выводится из prompt. Ограничение
// размера не даёт журналу расти в памяти вместе с длинной сессией.
const loggedIds = new Set<string>();
function logVerdict(verdict: ReturnType<typeof inspectRepeatGuard>): void {
  for (const failure of verdict.rejected) {
    if (loggedIds.has(failure.toolCallId)) continue;
    traceRepeatGuard("tool.rejected", {
      tool: failure.tool,
      errorHead: failure.errorHead,
    });
    loggedIds.add(failure.toolCallId);
    if (loggedIds.size > 1024)
      loggedIds.delete(loggedIds.values().next().value!);
  }
  if (verdict.stop)
    traceRepeatGuard("guard.repeat_stop", {
      tool: verdict.stop.tool,
      count: verdict.stop.count,
      errorHead: verdict.stop.errorHead,
    });
}

export const repeatGuardMiddleware: LanguageModelMiddleware = {
  wrapGenerate({ doGenerate, params }) {
    const verdict = inspectRepeatGuard(params.prompt);
    logVerdict(verdict);
    if (!verdict.stop) return doGenerate();
    return Promise.resolve({
      content: [{ type: "text", text: verdict.stop.message }],
      finishReason: { unified: "stop", raw: "repeat-guard" },
      usage: zeroUsage,
      warnings: [],
    });
  },
  wrapStream({ doStream, params }) {
    const verdict = inspectRepeatGuard(params.prompt);
    logVerdict(verdict);
    if (!verdict.stop) return doStream();
    const message = verdict.stop.message;
    return Promise.resolve({
      stream: new ReadableStream<LanguageModelV4StreamPart>({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "repeat-guard" });
          controller.enqueue({
            type: "text-delta",
            id: "repeat-guard",
            delta: message,
          });
          controller.enqueue({ type: "text-end", id: "repeat-guard" });
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "stop", raw: "repeat-guard" },
            usage: zeroUsage,
          });
          controller.close();
        },
      }),
    });
  },
};
