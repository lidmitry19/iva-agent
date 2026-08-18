import { wrapLanguageModel, type LanguageModelMiddleware } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { CODEX_BASE_URL, codexAuthHeaders } from "./lib/codex-auth.ts";
import { resolveContextWindow } from "./lib/context-window.ts";
import {
  resolveModelProvider,
  type ModelProviderName,
} from "./lib/model-provider.ts";
import { CANONICAL_REASONING_EFFORTS as EFFORTS } from "./lib/reasoning-levels.ts";

type WrappableModel = Parameters<typeof wrapLanguageModel>[0]["model"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Единый источник конфигурации провайдера модели. Имя, текстовую и vision-модель выбирает
// resolveModelProvider — раз при старте и одинаково для рантайма и учёта расхода; неизвестное
// MODEL_PROVIDER валит загрузку модуля здесь же, до первого запроса к провайдеру.
// ollama/opencode/openrouter — OpenAI-совместимы (chat/completions, статичный ключ из .env).
// codex — личная подписка OpenAI (ChatGPT): Responses API + OAuth-токен (data/codex-auth.json,
// `iva login`). Имена моделей и их дефолты живут в agent/lib/model-provider.ts (там же и
// переменные *_VISION_MODEL); здесь остаётся то, что из .env не задаётся: адрес, ключ и
// окно контекста.
const selected = resolveModelProvider();
const PROVIDER = selected.name;

// Читается ровно в одном месте — PROVIDERS[PROVIDER] ниже, поэтому запись выбранного
// провайдера в поле соседа невозможна. satisfies держит таблицу полной.
const PROVIDERS = {
  ollama: {
    // OLLAMA_BASE_URL — не пользовательская настройка, а шов для тестов: replica-смоук
    // подставляет сюда локальный mock-провайдер (scripts/lib/mock-openai-server.ts).
    baseURL: process.env.OLLAMA_BASE_URL ?? "https://ollama.com/v1",
    apiKey: process.env.OLLAMA_API_KEY,
    contextWindow: 131072,
  },
  opencode: {
    // Продукт переименован Zen → Go, но API живёт на легаси-пути /zen/ (у /go/v1 — 404).
    baseURL: "https://opencode.ai/zen/go/v1",
    apiKey: process.env.OPENCODE_API_KEY,
    contextWindow: 131072,
  },
  openrouter: {
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY,
    contextWindow: 131072,
  },
  codex: {
    baseURL: CODEX_BASE_URL,
    apiKey: undefined, // авторизация — OAuth-токен подписки, не статичный ключ (см. codexFetch)
    contextWindow: 272000,
  },
} as const satisfies Record<
  ModelProviderName,
  {
    baseURL: string;
    apiKey: string | undefined;
    contextWindow: number;
  }
>;

export const providerName = PROVIDER;
const contextWindowVariable =
  `${PROVIDER.toUpperCase()}_CONTEXT_WINDOW` as const;
export const providerConfig = {
  ...PROVIDERS[PROVIDER],
  contextWindow: resolveContextWindow(
    contextWindowVariable,
    process.env[contextWindowVariable],
    PROVIDERS[PROVIDER].contextWindow,
  ),
  textModel: selected.model,
  // Модель для картинок — из того же резолвера (переменные *_VISION_MODEL, дефолты там же).
  // У codex это та же текстовая модель: подписка мультимодальна.
  visionModel: selected.visionModel,
};

// THINKING_EFFORT (.env, пишут /model и /think в Telegram): reasoning-усилие модели.
// Codex получает его через providerOptions.openai.reasoningEffort ниже. Ollama Cloud
// и OpenCode Go говорят на OpenAI-compatible chat/completions; eve передаёт им
// provider-agnostic reasoning как reasoning_effort (см. compatibleThinkingEffort).
// Уровни — из общего каталога мастера, чтобы кнопки и рантайм не разъезжались.
const effortRaw = (process.env.THINKING_EFFORT ?? "").toLowerCase();
export const thinkingEffort = EFFORTS.includes(effortRaw)
  ? effortRaw
  : undefined;
const COMPATIBLE_EFFORTS = ["low", "medium", "high"] as const;
type CompatibleEffort = (typeof COMPATIBLE_EFFORTS)[number];
export const compatibleThinkingEffort: CompatibleEffort | undefined =
  selected.compatibleReasoning &&
  (COMPATIBLE_EFFORTS as readonly string[]).includes(effortRaw)
    ? (effortRaw as CompatibleEffort)
    : undefined;

// --- Codex (подписка ChatGPT): Responses API через @ai-sdk/openai ----------------------------
// Кастомный fetch: перед КАЖДЫМ запросом подставляет свежий Bearer + ChatGPT-Account-ID
// (getAccessToken рефрешит истёкший токен) и форсит store:false — бэкенд подписки stateless,
// историю eve шлёт целиком каждый ход. Тело патчим здесь же (точка правки, если бэкенд строже).
const codexFetch: typeof fetch = async (input, init) => {
  const headers = new Headers(init?.headers);
  for (const [k, v] of Object.entries(await codexAuthHeaders()))
    headers.set(k, v);
  let body = init?.body;
  if (
    typeof body === "string" &&
    String((input as Request).url ?? input).endsWith("/responses")
  ) {
    try {
      const j: unknown = JSON.parse(body);
      if (!isRecord(j)) throw new TypeError("Responses body is not an object");
      j.store = false;
      delete j.previous_response_id;
      // store:false → бэкенд ничего не персистит, поэтому любой server-side id в input — это эхо
      // прошлого ответа, которого на сервере уже нет: item_reference (ссылка без контента) и даже
      // echoed id у инлайн-item ловят "Item '<id>' not found. Items are not persisted...".
      // Контент истории уже инлайнится целиком (store:false задан на этапе сборки тела, см.
      // codexProviderOptions), поэтому ссылки режем, а id-эхо у остальных item'ов вычищаем.
      const input = j.input;
      if (Array.isArray(input)) {
        const filteredInput = input.filter(
          (item) => !isRecord(item) || item.type !== "item_reference",
        );
        for (const item of filteredInput) if (isRecord(item)) delete item.id;
        j.input = filteredInput;
      }
      body = JSON.stringify(j);
    } catch {
      /* не JSON — не трогаем */
    }
  }
  return fetch(input, { ...init, headers, body });
};

// Провайдер-опции codex на этапе СБОРКИ тела (не пост-фактум в codexFetch): store:false
// и reasoning-усилие из THINKING_EFFORT.
// store:false: без него @ai-sdk/openai берёт store:true по умолчанию и реплеит прошлые ответы
// ассистента как item_reference (голая ссылка на msg_-item, без контента); codexFetch затем
// ставит store:false — и stateless-бэкенд подписки не находит item → сессия падает со второго
// запроса ("Item ... not found. Items are not persisted when store is set to false").
// store:false заставляет SDK инлайнить историю целиком.
// reasoningSummary:null гасит побочный эффект SDK: при заданном reasoningEffort он сам
// добавляет summary:"detailed" в reasoning-блок. Summary нам не нужен (reasoning всё равно
// вырезается withReasoningStripped), а лишний параметр — лишний шанс на 400 от бэкенда.
const codexProviderOptions: LanguageModelMiddleware = {
  transformParams({ params }) {
    return Promise.resolve({
      ...params,
      providerOptions: {
        ...params.providerOptions,
        openai: {
          ...params.providerOptions?.openai,
          store: false,
          ...(thinkingEffort
            ? { reasoningEffort: thinkingEffort, reasoningSummary: null }
            : {}),
        },
      },
    });
  },
};

/** Строит Codex-модель (Responses API подписки). Общая для agent.ts и vision.ts. */
export function makeCodexModel(model: string = providerConfig.textModel) {
  const openai = createOpenAI({
    baseURL: CODEX_BASE_URL,
    apiKey: "chatgpt-subscription",
    fetch: codexFetch,
  });
  return wrapLanguageModel({
    model: openai.responses(model),
    middleware: codexProviderOptions,
  });
}

/**
 * Текстовая модель активного провайдера. Общая для КАЖДОГО узла графа: корень и субагенты
 * обязаны говорить с одним провайдером, свои createOpenAICompatible/env в субагентах не заводим.
 */
export function makeTextModel() {
  // Codex-подписка говорит на Responses API — отдельная модель-фабрика (@ai-sdk/openai).
  // Остальные провайдеры — OpenAI-совместимый chat/completions через openai-compatible.
  if (providerName === "codex") return makeCodexModel();
  return createOpenAICompatible({
    name: `iva-${providerName}`,
    baseURL: providerConfig.baseURL,
    apiKey: providerConfig.apiKey,
    // Без этого стрим OpenAI-совместимых провайдеров НЕ несёт usage (нет stream_options:
    // {include_usage:true}) → событие step.completed приходит без поля usage, и учёт токенов
    // (agent/hooks/usage.ts) пуст. Включаем, чтобы провайдер отдавал расход в финальном чанке.
    includeUsage: true,
  })(providerConfig.textModel);
}

// --- Анти-InvalidPrompt: срезаем reasoning из вывода модели ---------------------------------
// deepseek (openai-compatible) иногда отдаёт reasoning-часть без поля `text`. eve хранит reasoning
// в истории и реплеит её каждый ход, а ai@7 ModelMessage-схема требует у reasoning непустой string
// `text` → одна такая часть бросает AI_InvalidPromptError в standardizePrompt и отравляет сессию
// навсегда (Iva молчит в треде до ручного сброса). reasoning в реплее не нужен — это приватное
// «мышление», юзеру не видно — поэтому выкидываем его из ВЫВОДА целиком, и в историю он не попадает.
// Подтверждено репродукцией: reasoning с text:"" проходит, без text — FAIL (см. implementation-notes, вне публичного дерева).
const REASONING_PART_TYPES = new Set([
  "reasoning",
  "reasoning-start",
  "reasoning-delta",
  "reasoning-end",
  "reasoning-file",
]);

const stripReasoningMiddleware: LanguageModelMiddleware = {
  async wrapGenerate({ doGenerate }) {
    const result = await doGenerate();
    return {
      ...result,
      content: result.content.filter((p) => p.type !== "reasoning"),
    };
  },
  async wrapStream({ doStream }) {
    const { stream, ...rest } = await doStream();
    return {
      ...rest,
      stream: stream.pipeThrough(
        new TransformStream({
          transform(part, controller) {
            if (!REASONING_PART_TYPES.has(part.type)) controller.enqueue(part);
          },
        }),
      ),
    };
  },
};

/** Оборачивает текстовую модель так, чтобы reasoning не попадал в реплеемую историю. */
export function withReasoningStripped(model: WrappableModel): WrappableModel {
  return wrapLanguageModel({ model, middleware: stripReasoningMiddleware });
}
