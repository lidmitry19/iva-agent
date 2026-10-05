import { randomUUID } from "node:crypto";
import { streamText } from "ai";
import type { ZodType } from "zod";
import { makeTextModel, providerConfig, providerName } from "#provider.ts";
import { appendUsage, usageRecord } from "#lib/usage.ts";
import { sdkUsageTokens } from "#lib/usage-tap.ts";
import { NIGHT_CEILING } from "#lib/memory-night-constants.ts";
import { parseJson } from "./night-input.ts";

// Один способ вызова модели для всей ночи у всех провайдеров: формат ответа словами и
// примером в инструкции шага, ответ — JSON в тексте, разбор мягкий. Инструментов нет. Не
// прошёл схему — один повтор с текстом ошибки, потом NightSchemaError. Своих сетевых
// повторов нет. Ceiling проверяется до вызова; неизвестный usage закрывает следующие.

export class NightCeilingError extends Error {}
export class NightSchemaError extends Error {}
class NightNetworkError extends Error {}

export const nightModelName = providerConfig.textModel;
const model = makeTextModel({
  chatModelSeesImages: () => Promise.resolve(false),
});
const SYSTEM =
  "Ты выполняешь один шаг ночной памяти. Ответ — один JSON-объект по формату из инструкции, без пояснений.";
// Низкое рассуждение там, где провайдер его принимает.
const openai = { reasoningEffort: "low", reasoningSummary: null };
const low = providerName === "codex" ? { providerOptions: { openai } } : {};

export const ceiling = {
  calls: 0,
  inputTokens: 0,
  unknownUsage: false,
  usageLost: "",
};

/** validate бросает с текстом, который уйдёт модели в повторе. */
export type SchemaCall<T> = {
  skill: string;
  input: unknown;
  schema: ZodType<T>;
  signal: AbortSignal;
  validate?: (value: T) => void;
};

/** Расход в usage.jsonl тем же путём, что у чата; нет usage — ночь дальше не зовёт. */
function recordUsage(
  usage: Parameters<typeof sdkUsageTokens>[0],
  estimate: number,
) {
  const tokens = Number.isSafeInteger(usage?.inputTokens)
    ? sdkUsageTokens(usage)
    : null;
  ceiling.inputTokens += tokens?.in ?? estimate * 2;
  ceiling.unknownUsage ||= !tokens;
  const turnId = `memory-night#${randomUUID()}`;
  const meta = {
    source: "memory-night",
    provider: providerName,
    model: nightModelName,
    sessionId: "",
    turnId,
    step: ceiling.calls,
  };
  const row = tokens && usageRecord(meta, tokens);
  try {
    if (row) appendUsage(row);
  } catch (error) {
    // Расход считается в памяти до конца ночи; потерянная строка видна в её итоге.
    ceiling.usageLost = String(error);
  }
}

async function oneCall<T>(call: SchemaCall<T>, hint: string): Promise<T> {
  const prompt = `${call.skill}${hint ? `\nОшибка прошлого ответа: ${hint}` : ""}\nВход:\n${JSON.stringify(call.input)}`;
  const estimate = Math.ceil(prompt.length / 3);
  if (
    ceiling.unknownUsage ||
    ceiling.calls + 1 > NIGHT_CEILING.calls ||
    ceiling.inputTokens + estimate > NIGHT_CEILING.inputTokens
  )
    throw new NightCeilingError("memory night ceiling reached");
  ceiling.calls++;
  let result;
  try {
    const response = streamText({
      model,
      abortSignal: call.signal,
      maxRetries: 0,
      system: SYSTEM,
      prompt,
      ...low,
      // Ошибка идёт вызывающему коду через text/usage, без побочной печати промпта.
      onError: () => {},
    });
    const [text, usage] = await Promise.all([response.text, response.usage]);
    call.signal.throwIfAborted();
    result = { text, usage };
  } catch (error) {
    ceiling.inputTokens += estimate;
    if (call.signal.aborted) throw error;
    throw new NightNetworkError(String(error), { cause: error });
  }
  recordUsage(result.usage, estimate);
  const parsed = call.schema.safeParse(parseJson(result.text));
  if (!parsed.success)
    throw new Error(`ответ не по формату: ${parsed.error.message}`);
  call.validate?.(parsed.data);
  return parsed.data;
}

/** Ошибка ответа (форма, проверка), а не сеть, Ceiling или обрыв по сроку: один повтор
 * с текстом ошибки, второй отказ — NightSchemaError. */
export async function callBySchema<T>(call: SchemaCall<T>): Promise<T> {
  let hint = "";
  for (let attempt = 0; ; attempt++)
    try {
      return await oneCall(call, hint);
    } catch (error) {
      const network =
        error instanceof NightCeilingError ||
        error instanceof NightNetworkError;
      if (network || call.signal.aborted) throw error;
      hint = error instanceof Error ? error.message : String(error);
      if (attempt === 1) throw new NightSchemaError(hint);
    }
}
