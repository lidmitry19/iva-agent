// Единственный резолвер MODEL_PROVIDER: имя провайдера, текстовая модель, vision-модель
// (её зовёт agent/vision.ts на картинке) и поддержка OpenAI-совместимого reasoning_effort
// решаются РАЗ и одинаково для рантайма (agent/provider.ts) и учёта расхода
// (agent/hooks/usage.ts).
//
// Выбор fail-closed. Неизвестное значение (опечатка `ollmaa`, лишний пробел, другой
// регистр, пустая строка) валит старт с перечнем принятых имён вместо того, чтобы
// подставить конфигурацию ollama под чужим именем: иначе клиент ходит к одному
// провайдеру, а имя, reasoning и учёт токенов живут от другого (issue #161).
// ОТСУТСТВИЕ переменной — не опечатка, а дефолт: ollama, как было всегда.
// Нормализации нет намеренно: `.trim().toLowerCase()` принял бы значение, которого нет
// ни в одном мастере, и вернул бы ту же расходящуюся правду под другим соусом.
//
// Тот же перечень имён повторён ключами CATALOG в scripts/lib/model-catalog.ts: кнопки
// /model и `iva doctor` грузятся на инсталле, где авторского дерева может не быть
// (ADR-0003), поэтому импортировать этот модуль оттуда нельзя. Разъехаться копии не
// могут — их сверяет scripts/lib/model-catalog.test.ts. Зеркало несёт ОБЕ модели
// провайдера: и текстовую, и vision.
//
// Зависимостей у модуля нет намеренно: он читает env и больше ничего.

type Env = Readonly<Record<string, string | undefined>>;

// Порядок — тот же, что у кнопок мастера (scripts/setup/main.ts: 1-4) и ключей CATALOG,
// поэтому список в ошибке читается как список в интерфейсе.
export const MODEL_PROVIDER_NAMES = [
  "ollama",
  "opencode",
  "codex",
  "openrouter",
] as const;

export type ModelProviderName = (typeof MODEL_PROVIDER_NAMES)[number];

export interface ModelProviderSelection {
  readonly name: ModelProviderName;
  readonly model: string;
  // Модель, которой agent/vision.ts описывает картинку. Отдельная от текстовой: та
  // сплошь и рядом text-only. У codex своей переменной нет — подписка мультимодальна,
  // поэтому здесь оказывается та же текстовая модель.
  readonly visionModel: string;
  // Провайдер понимает reasoning_effort прямо в OpenAI-совместимом chat/completions.
  // Это не то же самое, что providerSupportsReasoning в scripts/lib/model-catalog.ts:
  // codex тоже умеет reasoning, но получает его через providerOptions Responses API.
  readonly compatibleReasoning: boolean;
}

// Record<ModelProviderName, …> держит таблицу полной: новое имя в MODEL_PROVIDER_NAMES
// не соберётся, пока ему не задали модель, ответ про reasoning и ответ про vision.
// Экспортируется ради шва: CATALOG в scripts/lib/model-catalog.ts несёт те же modelVar и
// те же дефолты для кнопок /model и мастера, и разъехаться им нельзя — расхождение значит,
// что мастер предлагает не ту модель, которую возьмёт рантайм. Сверяет model-catalog.test.ts.
export const MODEL_PROVIDERS = {
  ollama: {
    modelVar: "OLLAMA_MODEL",
    defaultModel: "deepseek-v4-pro",
    compatibleReasoning: true,
    // Дешёвая мультимодалка того же провайдера (проверено на проде: принимает image_url,
    // http 200). Ollama Cloud снимает теги с раздачи: gemma3:12b отвечает
    // 410 "retired at 2026-07-15" — заменён на gemma4:31b (проверено 2026-07-28).
    // Текстовые модели (deepseek, glm, gpt-oss) отдают 400 "does not support image input",
    // так что подменять vision на них нельзя. Переопределяется OLLAMA_VISION_MODEL.
    visionModelVar: "OLLAMA_VISION_MODEL",
    defaultVisionModel: "gemma4:31b",
  },
  opencode: {
    modelVar: "OPENCODE_MODEL",
    defaultModel: "deepseek-v4-pro",
    compatibleReasoning: true,
    // Каталог Go течёт, и «есть в GET /models» картинки не обещает: gemini-3-flash выпал
    // (401 "Model gemini-3-flash is not supported"), а gpt-5.6-luna на любую картинку
    // отвечает 400 с пустым телом — текст берёт, кадр не видит. reasoning_effort на Go
    // тоже не вариант: max → 400 invalid_request_error. Дефолт minimax-m3: 200 и описание
    // в message.content, самое подробное из проверенных (~11 с). Годен и qwen3.7-plus —
    // вдвое быстрее и чуть беднее. Всё проверено живыми запросами 2026-08-18.
    // У mimo-v2.5 слабый OCR; glm-*, deepseek-*, grok-4.5, qwen3.7-max картинок не видят.
    // Переопределяется OPENCODE_VISION_MODEL.
    visionModelVar: "OPENCODE_VISION_MODEL",
    defaultVisionModel: "minimax-m3",
  },
  codex: {
    modelVar: "CODEX_MODEL",
    defaultModel: "gpt-5.5",
    compatibleReasoning: false,
    // gpt-5* мультимодальны — картинки идут через ту же подписку (agent/vision.ts гонит их
    // по Responses API), поэтому отдельной переменной нет вовсе: vision-модель подписки —
    // это и есть выбранная текстовая.
    visionModelVar: null,
    defaultVisionModel: null,
  },
  openrouter: {
    // Слаг модели вида vendor/model (напр. anthropic/claude-sonnet-4.5) — задаётся мастером.
    // Дефолт — лишь заглушка на случай ручного .env; мастер всегда перезапишет живой проверкой.
    modelVar: "OPENROUTER_MODEL",
    defaultModel: "openai/gpt-5.1",
    compatibleReasoning: false,
    // Дешёвая гарантированно-мультимодальная модель для картинок: vision работает независимо
    // от выбранной текстовой (та может быть text-only). Сюда вписывается любой слаг
    // OpenRouter с поддержкой картинок. Переопределяется OPENROUTER_VISION_MODEL.
    visionModelVar: "OPENROUTER_VISION_MODEL",
    defaultVisionModel: "google/gemini-2.5-flash",
  },
} as const satisfies Record<
  ModelProviderName,
  {
    modelVar: string;
    defaultModel: string;
    compatibleReasoning: boolean;
    visionModelVar: string | null;
    defaultVisionModel: string | null;
  }
>;

// Текст отказа: одно предложение с заданным значением, принятыми именами и починкой.
// Его же собирает `iva doctor` из своей половины перечня — совпадение двух строк
// пинует scripts/cli/doctor.test.ts.
export function invalidModelProviderMessage(raw: string): string {
  return `Invalid MODEL_PROVIDER ${JSON.stringify(raw)}; expected one of: ${MODEL_PROVIDER_NAMES.join(", ")} — run: iva config`;
}

// Одно правило чтения на ОБЕ модели провайдера — текстовую и vision. Разными их делает
// только дефолт, поэтому он и приходит аргументом: две копии этой функции разъехались бы
// ровно так же, как раньше расходились три ответа на одну строку .env.
function configuredModel(
  name: ModelProviderName,
  raw: string | undefined,
  fallback: string,
): string {
  const configured = (raw ?? "").trim();
  // Эндпоинт OpenCode ждёт bare-ID — срезаем внутренний UI-префикс "opencode-go/"
  // из дефолта и старых .env. Срез идёт ДО проверки на пустоту: голый "opencode-go/"
  // тоже «не задано», а не пустое имя модели в запросе.
  const stripped =
    name === "opencode" ? configured.replace(/^opencode-go\//, "") : configured;
  return stripped || fallback;
}

/**
 * Модель провайдера из сырого значения переменной. Одно правило на всех, потому что раньше
 * ответов на один и тот же `.env` было три: рантайм брал пустую строку как есть, экран
 * статуса подставлял дефолт, а экран обновления рисовал «?».
 *
 * Пробелы срезаются, пустое (и пробельное) значение — это «не задано», то есть дефолт
 * провайдера. Свою модель нельзя «стереть», оставив агента без имени модели в запросе.
 *
 * Повторено в scripts/lib/model-catalog.ts (`catalogModel`) для половины, которая грузится
 * без authored tree; равенство двух правил сверяет scripts/lib/model-catalog.test.ts.
 */
export function modelProviderModel(
  name: ModelProviderName,
  raw: string | undefined,
): string {
  return configuredModel(name, raw, MODEL_PROVIDERS[name].defaultModel);
}

/**
 * Vision-модель провайдера — тем же правилом trim/blank→дефолт, что и текстовая.
 * У провайдера без своей переменной (codex) vision-модель — это выбранная текстовая:
 * подписка мультимодальна, отдельного имени спрашивать не у кого.
 */
function visionModelFor(
  name: ModelProviderName,
  raw: string | undefined,
  textModel: string,
): string {
  const fallback: string | null = MODEL_PROVIDERS[name].defaultVisionModel;
  return fallback === null ? textModel : configuredModel(name, raw, fallback);
}

/**
 * Разрешает MODEL_PROVIDER в одну согласованную четвёрку «имя · модель · vision · reasoning».
 * Бросает на любом значении, которого нет в MODEL_PROVIDER_NAMES.
 */
export function resolveModelProvider(
  env: Env = process.env,
): ModelProviderSelection {
  const raw = env.MODEL_PROVIDER ?? "ollama";
  if (!(MODEL_PROVIDER_NAMES as readonly string[]).includes(raw))
    throw new Error(invalidModelProviderMessage(raw));

  const name = raw as ModelProviderName;
  const { modelVar, visionModelVar, compatibleReasoning } =
    MODEL_PROVIDERS[name];
  const model = modelProviderModel(name, env[modelVar]);
  return {
    name,
    model,
    // Переменную соседа не читаем: у codex её нет вовсе, и подставить её нечем.
    visionModel: visionModelFor(
      name,
      visionModelVar === null ? undefined : env[visionModelVar],
      model,
    ),
    compatibleReasoning,
  };
}
