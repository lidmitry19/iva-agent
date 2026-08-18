// Iva interactive setup: writes .env.
// Step-by-step guide with per-key instructions, live validation, and a loop —
// the script will NOT exit until every required secret is entered.
// No external dependencies.
import { createInterface } from "node:readline/promises";
import { createReadStream, existsSync, openSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  confirmOccupiedCurrentPort,
  defaultChecker,
  PortSelector,
} from "../lib/ports.ts";
import {
  generateAssistantBearer,
  isAssistantBearer,
} from "../lib/assistant-auth.ts";
import { writeEnvAtomicSync } from "../lib/env-file.ts";
import {
  authFilePath,
  readAuth,
  runDeviceCodeLogin,
  runBrowserLogin,
  listCodexModels,
} from "../lib/codex-oauth.ts";
import {
  probeOpenRouterModel,
  validateModelSelection,
} from "../lib/model-validation.ts";
import {
  CATALOG,
  catalogProvider,
  providerEnvKeys,
} from "../lib/model-catalog.ts";
import { keptSetupWritePlan } from "../lib/setup-keep.ts";
import { validateTimeZone } from "../lib/timezone.ts";
import { resolveMemorySearchMode } from "../lib/memory-mode.ts";
import { resolveDataDir } from "../lib/data-dir.ts";
import { openrouterErrReason } from "./openrouter.ts";

type Env = Record<string, string>;
type Validator = (value: string) => Promise<string | null>;
type AskRequiredOptions = {
  help?: string;
  existing?: string;
  validate?: Validator;
};
type TelegramUser = { id: string; name: string };
// These response types document the happy path without changing the former
// JavaScript property-access behaviour for malformed provider responses.
type ModelListResponse = { data?: Array<{ id: string }> };
type TelegramBot = { username?: string };
type TelegramGetMeResponse = {
  ok?: boolean;
  description?: string;
  result?: TelegramBot;
};
type TelegramFrom = {
  id: string | number;
  first_name?: string;
  last_name?: string;
  username?: string;
};
type TelegramMessage = { from?: TelegramFrom };
type TelegramUpdate = {
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
};
type TelegramUpdatesResponse = {
  ok?: boolean;
  description?: string;
  result?: TelegramUpdate[];
};
type ThrownSetupError = { code?: string; auth?: unknown; message: string };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
// The configuration this run starts from. Normally the live .env of the installation;
// `IVA_CONFIG_INPUT` points it elsewhere, which is what lets the wizard be run against a
// fixture instead of the machine's own configuration - the reason its "already configured"
// branch went untested until it shipped a bug (issue #161). Symmetric with the output side
// below, and the two are independent: reading a fixture does not decide where it writes.
const SOURCE_ENV_PATH = process.env.IVA_CONFIG_INPUT
  ? resolve(process.env.IVA_CONFIG_INPUT)
  : join(ROOT, ".env");
// `iva config` stages a complete candidate outside the live .env, then applies it
// transactionally. Direct setup/install keeps the historical live path.
const ENV_PATH = process.env.IVA_CONFIG_OUTPUT
  ? resolve(process.env.IVA_CONFIG_OUTPUT)
  : SOURCE_ENV_PATH;
const STAGING_CONFIG = ENV_PATH !== SOURCE_ENV_PATH;
// Абсолютный каталог data (тот же, что видит агент из cwd=ROOT). Хранит codex-auth.json (OAuth).
const dataDirAbs = (env: Env | null | undefined) => {
  return resolveDataDir(ROOT, env?.ASSISTANT_DATA_DIR);
};
const OLLAMA_BASE = "https://ollama.com/v1";
const OPENCODE_BASE = "https://opencode.ai/zen/go/v1";
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
// OpenCode Go (ex-Zen; the /zen/ API path is legacy and still the live one) — bare model ID
// without the "opencode-go/" prefix: that's exactly what the /v1 endpoint expects in the request
// body (with the prefix it answers "Model ... is not supported"). The wizard fetches the live
// list from GET /models; this is only the offline fallback.
const OPENCODE_MODELS = [
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "kimi-k3",
  "kimi-k2.7-code",
  "glm-5.2",
  "minimax-m3",
  "qwen3.7-max",
  "grok-4.5",
];

const C = {
  g: "\x1b[32m",
  y: "\x1b[33m",
  c: "\x1b[36m",
  b: "\x1b[1m",
  r: "\x1b[31m",
  x: "\x1b[0m",
};
const TOTAL = 5;

// UI language (en|ru) — also becomes the agent's default reply language (AGENT_LANGUAGE).
// Set in main() once the choice is known; helpers below read it.
let LANG = "ru";
const t = (en: string, ru: string) => (LANG === "en" ? en : ru);
const KEEP = () => t("…(keep)", "…(оставить)");

// Read from tty even when launched via `curl | bash`: there stdin is the script itself,
// so the answers have to come from the terminal. Where there is no controlling terminal
// at all (a plain spawn without a pty), opening /dev/tty fails with ENXIO and used to kill
// the wizard on an unhandled error event - read whatever stdin is instead. Opened with
// openSync, because a createReadStream failure arrives asynchronously and cannot be caught
// here.
function promptInput(): NodeJS.ReadableStream {
  if (process.stdin.isTTY) return process.stdin;
  try {
    return createReadStream("", { fd: openSync("/dev/tty", "r") });
  } catch {
    return process.stdin;
  }
}
const rl = createInterface({ input: promptInput(), output: process.stdout });

const ask = async (q: string, def = "") => {
  const a = (await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim();
  return a || def;
};
const askYesNo = async (q: string, def = false) => {
  const a = (await ask(`${q} (${def ? "Y/n" : "y/N"})`)).toLowerCase();
  return a ? a.startsWith("y") : def;
};

// Free-port selection: ask for the desired port, check availability with the same Probe as
// `check-port` (scripts/lib/ports.ts); if taken, offer the nearest free one. Closes the root of a
// bug at setup time — the server won't start on an occupied port.
async function pickPort(def: string) {
  const checker = defaultChecker();
  for (;;) {
    const port = Number(
      await ask(
        `  ${t("Local eve-server port", "Порт локального eve-сервера")}`,
        String(def),
      ),
    );
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      console.log(
        `  ${C.r}${t("Invalid port", "Некорректный порт")}${C.x} — ${t("must be a number 1..65535.", "нужно число 1..65535.")}`,
      );
      continue;
    }
    const { occupied, holders } = await checker.check(port);
    if (!occupied) return String(port);
    const reuse = await confirmOccupiedCurrentPort({
      port,
      currentPort: def,
      holders,
      confirm: async ({ port: current, holders: found }) => {
        const who = found.length ? ` (${found.join("; ")})` : "";
        console.log(
          `  ${C.y}${t(
            `Port ${current} is already occupied${who}. Ownership cannot be verified.`,
            `Порт ${current} уже занят${who}. Проверить владельца надёжно нельзя.`,
          )}${C.x}`,
        );
        return askYesNo(
          `  ${t(
            `Keep occupied port ${current}? Only confirm if it is the running Iva`,
            `Оставить занятый порт ${current}? Подтверди, только если это запущенная Iva`,
          )}`,
          false,
        );
      },
    });
    if (reuse) return String(port);
    const free = await new PortSelector(checker).firstFree(port + 1);
    const who = holders.length ? ` (${holders.join("; ")})` : "";
    console.log(
      `  ${C.y}${t(`Port ${port} is busy${who}.`, `Порт ${port} занят${who}.`)}${C.x}${free ? ` ${t("Nearest free", "Ближайший свободный")}: ${C.g}${free}${C.x}.` : ""}`,
    );
    if (
      free &&
      (await askYesNo(`  ${t(`Take ${free}?`, `Взять ${free}?`)}`, true))
    )
      return String(free);
    // otherwise loop — the user enters another port manually
  }
}
const mask = (s: string) => (s ? s.slice(0, 6) + KEEP() : "");
const hr = () =>
  console.log(`${C.c}  ────────────────────────────────────────────${C.x}`);
const head = (n: number, title: string) =>
  console.log(
    `\n${C.b}${C.c}  ${t("Step", "Шаг")} ${n}/${TOTAL}: ${title}${C.x}`,
  );

// Repeats the question until it gets a non-empty and (if set) valid value.
async function askRequired(
  label: string,
  { help = "", existing = "", validate }: AskRequiredOptions = {},
) {
  for (;;) {
    if (help) console.log(help);
    let a = await ask(label, existing ? mask(existing) : "");
    if (existing && (!a || a.endsWith(KEEP()))) a = existing;
    a = (a || "").trim();
    if (!a) {
      console.log(
        `${C.y}  ⚠ ${t("Required field — Iva won't run without it. Enter a value.", "Обязательное поле — без него Iva не заработает. Введите значение.")}${C.x}\n`,
      );
      continue;
    }
    if (validate) {
      process.stdout.write(`  ${t("checking…", "проверяю…")} `);
      const err = await validate(a);
      if (err) {
        console.log(
          `${C.r}${t("not ok", "не ок")}${C.x}\n${C.y}  ⚠ ${err}${C.x}\n`,
        );
        continue;
      }
      console.log(`${C.g}${t("ok", "ок")}${C.x}`);
    }
    return a;
  }
}

function parseEnv(text: string): Env {
  const env: Env = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}
async function loadExistingEnv(): Promise<Env> {
  try {
    return parseEnv(await readFile(SOURCE_ENV_PATH, "utf8"));
  } catch (error) {
    if ((error as ThrownSetupError | null | undefined)?.code === "ENOENT")
      return {};
    throw error;
  }
}

// Writes .env in a stable key order.
// eslint-disable-next-line @typescript-eslint/require-await -- preserve the original setup microtask boundary.
async function writeEnv(out: Env): Promise<void> {
  const order = [
    "AGENT_LANGUAGE",
    "MODEL_PROVIDER",
    "OLLAMA_API_KEY",
    "OLLAMA_MODEL",
    "OLLAMA_VISION_MODEL",
    "OLLAMA_CONTEXT_WINDOW",
    "OPENCODE_API_KEY",
    "OPENCODE_MODEL",
    "OPENCODE_VISION_MODEL",
    "OPENCODE_CONTEXT_WINDOW",
    "OPENROUTER_API_KEY",
    "OPENROUTER_MODEL",
    "OPENROUTER_VISION_MODEL",
    "OPENROUTER_CONTEXT_WINDOW",
    "CODEX_MODEL",
    "CODEX_CONTEXT_WINDOW",
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_BOT_USERNAME",
    "TELEGRAM_WEBHOOK_SECRET_TOKEN",
    "TELEGRAM_ALLOWED_USER_IDS",
    "TELEGRAM_DIGEST_CHAT_ID",
    "DEEPGRAM_API_KEY",
    "DEEPGRAM_LANGUAGE",
    "SEARCH_PROVIDER",
    "TAVILY_API_KEY",
    "BRAVE_API_KEY",
    "EXA_API_KEY",
    "PARALLEL_API_KEY",
    "MEMORY_SEARCH_MODE",
    "JINA_API_KEY",
    "DEEPINFRA_API_KEY",
    "ASSISTANT_TIMEZONE",
    "ASSISTANT_VAULT_DIR",
    "ASSISTANT_DATA_DIR",
    "IVA_PORT",
    "ASSISTANT_HOST",
    "ASSISTANT_BEARER",
  ];
  const keys = [
    ...order.filter((k) => out[k] != null),
    ...Object.keys(out).filter((k) => !order.includes(k)),
  ];
  writeEnvAtomicSync(
    ENV_PATH,
    keys.map((k) => `${k}=${out[k]}`).join("\n") + "\n",
  );
}

async function ollamaModels(key: string): Promise<string[]> {
  const res = await fetch(`${OLLAMA_BASE}/models`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (res.status === 401 || res.status === 403) {
    throw Object.assign(new Error("key rejected"), { auth: true });
  }
  if (!res.ok) throw new Error(`Ollama API returned ${res.status}`);
  const body = (await res.json()) as ModelListResponse;
  return (body.data || []).map((model) => model.id).sort();
}
async function opencodeCheck(key: string): Promise<string | null> {
  try {
    const res = await fetch(`${OPENCODE_BASE}/models`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (res.status === 401 || res.status === 403) {
      return t(
        "OpenCode rejected the key (401/403). Check your Go subscription and that the key was copied in full.",
        "OpenCode не принял ключ (401/403). Проверьте подписку Go и что ключ скопирован целиком.",
      );
    }
    return null; // 200/404 — key is at least well-formed
  } catch {
    return null; // network flaky — don't block
  }
}
// Live Go model list (bare IDs). The catalog drifts (kimi-k3 appeared, qwen3.7 was retired),
// so the hardcoded list is only a fallback for when the endpoint is unreachable.
async function opencodeModels(key: string): Promise<string[]> {
  try {
    const res = await fetch(`${OPENCODE_BASE}/models`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) return OPENCODE_MODELS;
    const body = (await res.json()) as ModelListResponse;
    const ids = (body.data || []).map((model) => model.id).sort();
    return ids.length ? ids : OPENCODE_MODELS;
  } catch {
    return OPENCODE_MODELS;
  }
}
// OpenRouter: ключ проверяем через GET /key (требует auth, токенов не тратит).
async function openrouterKeyCheck(key: string): Promise<string | null> {
  try {
    const res = await fetch(`${OPENROUTER_BASE}/key`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (res.status === 401 || res.status === 403) {
      return t(
        "OpenRouter rejected the key (401/403). Copy it in full from https://openrouter.ai/keys (starts with sk-or-).",
        "OpenRouter не принял ключ (401/403). Скопируйте целиком с https://openrouter.ai/keys (начинается с sk-or-).",
      );
    }
    return null; // 200 (или иной не-401) — ключ well-formed
  } catch {
    return null; // сеть флапнула — не блокируем
  }
}
// OpenRouter: ЖИВОЙ тест модели — реальный вызов chat/completions выбранным слагом.
// Запрос НЕСЁТ минимальный tools-блок: Iva — агент, каждый ход шлёт tool-definitions, поэтому
// chat-only модель (без function calling) сломается на первом же ходе. Один запрос ловит всё:
//   кривой слаг → 400 "not a valid model id";  битый ключ → 401;
//   модель без tool-эндпоинта → 404 "No endpoints found that support tool use".
// Не-200 → возвращаем строку → мастер зациклит ввод. Именно это ловит «принято, а агент молчит».
// OpenRouter оборачивает upstream-ошибку провайдера: error.message = generic "Provider returned error",
// а настоящая причина (напр. "not available in your region") лежит в error.metadata.raw как JSON-строка.
// Разворачиваем её, иначе пользователь видит бессмысленную обёртку.
async function openrouterModelCheck(
  key: string,
  model: string,
): Promise<string | null> {
  try {
    const result = await probeOpenRouterModel(
      { model, key },
      {
        errorReason: openrouterErrReason,
      },
    );
    if (!result.answered) {
      console.log(
        `${C.y}${t("(model replied empty — maybe a reasoning model / max_tokens; proceeding)", "(модель ответила пусто — возможно reasoning-модель / max_tokens; продолжаю)")}${C.x}`,
      );
    }
    return null;
  } catch (error) {
    const caught = error as ThrownSetupError | null | undefined;
    if (
      caught?.code === "model_unavailable" ||
      caught?.code === "auth_rejected"
    ) {
      const reason = caught.message;
      const toolIssue =
        /tool use|function call|no endpoints found that support tool/i.test(
          reason,
        );
      const hint = toolIssue
        ? t(
            "Iva needs a chat model with tool/function calling — pick one on https://openrouter.ai/models (form vendor/model).",
            "Iva нужна chat-модель с поддержкой инструментов (function calling) — выберите такую на https://openrouter.ai/models (вид vendor/model).",
          )
        : t(
            "pick another model on https://openrouter.ai/models (form vendor/model).",
            "выберите другую модель на https://openrouter.ai/models (вид vendor/model).",
          );
      return t(
        `the model can't be used: ${reason}. ${hint}`,
        `модель не подходит: ${reason}. ${hint}`,
      );
    }
    return t(
      `request failed: ${(error as ThrownSetupError).message}`,
      `запрос не прошёл: ${(error as ThrownSetupError).message}`,
    );
  }
}
async function deepgramCheck(key: string): Promise<string | null> {
  try {
    const res = await fetch("https://api.deepgram.com/v1/projects", {
      headers: { Authorization: `Token ${key}` },
    });
    if (res.status === 401 || res.status === 403) {
      return t(
        "Deepgram rejected the key (401/403). Copy the key in full from the API Keys page.",
        "Deepgram не принял ключ (401/403). Скопируйте ключ целиком со страницы API Keys.",
      );
    }
    return null;
  } catch {
    return null;
  }
}
async function telegramGetMe(token: string): Promise<TelegramBot | undefined> {
  const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  const body = (await res.json()) as TelegramGetMeResponse;
  if (!body.ok) throw new Error(body.description || "token rejected");
  return body.result;
}
async function fetchTelegramUserIds(token: string): Promise<TelegramUser[]> {
  const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
  const body = (await res.json()) as TelegramUpdatesResponse;
  if (!body.ok) throw new Error(body.description || "getUpdates failed");
  const seen = new Map<string, TelegramUser>();
  for (const update of body.result || []) {
    const message = update.message || update.edited_message;
    const from = message?.from;
    if (from && !seen.has(String(from.id))) {
      const name = [
        from.first_name,
        from.last_name,
        from.username ? `@${from.username}` : "",
      ]
        .filter(Boolean)
        .join(" ");
      seen.set(String(from.id), {
        id: String(from.id),
        name: name || t("(no name)", "(без имени)"),
      });
    }
  }
  return [...seen.values()];
}

// Pick from a list by number (with a default). Returns the chosen item.
async function pickFromList(
  items: string[],
  current: string,
  recommended: string,
): Promise<string> {
  items.forEach((id, i) =>
    console.log(
      `   ${String(i + 1).padStart(2)}. ${id}${id === recommended ? `  ${C.g}★${C.x}` : ""}`,
    ),
  );
  const curIdx = items.indexOf(current);
  const recIdx = items.indexOf(recommended);
  const defNum = (curIdx >= 0 ? curIdx : Math.max(0, recIdx)) + 1;
  const ch = await ask(
    `\n  ${t("Model number", "Номер модели")}`,
    String(defNum || 1),
  );
  let idx = parseInt(ch, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= items.length) idx = defNum - 1;
  return items[idx];
}

async function main() {
  const existing = await loadExistingEnv();
  const out = { ...existing };
  out.ASSISTANT_BEARER = isAssistantBearer(existing.ASSISTANT_BEARER)
    ? existing.ASSISTANT_BEARER.trim()
    : generateAssistantBearer();

  // ── Language: UI + agent's default reply language ─────────────────
  // install.sh asks for the language FIRST and passes it through the environment (AGENT_LANGUAGE) —
  // in that case don't ask again. On a standalone `npm run setup` the env is empty → we ask.
  const envLang = (process.env.AGENT_LANGUAGE || "").toLowerCase();
  if (envLang === "en" || envLang === "ru") {
    LANG = envLang;
  } else {
    console.log(`\n${C.b}${C.c}  🌐 Language / Язык${C.x}`);
    console.log("    1) English");
    console.log("    2) Русский");
    const langChoice = await ask(
      "  Choose / Выбор (1/2)",
      existing.AGENT_LANGUAGE === "ru" ? "2" : "1",
    );
    LANG = langChoice.trim() === "2" ? "ru" : "en";
  }
  out.AGENT_LANGUAGE = LANG;
  console.log(
    `  → ${t("Iva will reply in English by default.", "Iva будет отвечать по-русски по умолчанию.")}`,
  );

  // Already configured? Don't walk every step — ask once.
  // Провайдер берётся ТОЧНЫМ именем из общего каталога — того же, на который смотрят рантайм
  // и доктор. Неизвестное имя (опечатка `ollmaa`) не сходится ни с одним ключом: раньше карты
  // промахивались, API-ключ выпадал из REQUIRED, мастер объявлял сломанный .env настроенным и
  // выходил — а это тот самый мастер, к которому отказ агента и отправляет (issue #161).
  // `??`, не `||`: `MODEL_PROVIDER=` в .env — это заданное пустое значение, и рантайм,
  // доктор, статус и апдейт его отвергают. Схлопни его здесь в ollama — и единственный
  // экран, который умеет починить, снова объявил бы сломанный .env настроенным.
  const prov0 = existing.MODEL_PROVIDER ?? "ollama";
  const cat0 = catalogProvider(prov0);
  const provModel = cat0?.modelVar ?? "OLLAMA_MODEL";
  // codex — доступ по OAuth-токену (data/codex-auth.json), у ollama/opencode/openrouter — API-ключ в .env.
  // Список ключей общий с `iva doctor`: иначе один объявил бы .env полным, а второй — нет.
  const provKey = cat0?.keyVar ?? null;
  const REQUIRED = [
    ...(cat0 ? providerEnvKeys(cat0) : []),
    "DEEPGRAM_API_KEY",
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_ALLOWED_USER_IDS",
  ];
  const loggedInCodex =
    prov0 !== "codex" || existsSync(authFilePath(dataDirAbs(existing)));
  const isComplete =
    Boolean(cat0) &&
    loggedInCodex &&
    REQUIRED.every((k) => (existing[k] || "").trim());
  if (!cat0)
    console.log(
      `\n${C.y}  ⚠ ${t(
        `MODEL_PROVIDER is invalid (${prov0}) — Iva won't start until you pick one below.`,
        `MODEL_PROVIDER невалиден (${prov0}) — Iva не стартует, пока не выберешь провайдера ниже.`,
      )}${C.x}`,
    );
  if (isComplete) {
    console.log(
      `\n${C.b}${C.g}  ${t("Iva is already configured:", "Iva уже настроена:")}${C.x}`,
    );
    console.log(`  • ${t("Provider", "Провайдер")}: ${prov0}`);
    console.log(`  • ${t("Model", "Модель")}:    ${existing[provModel]}`);
    console.log(
      `  • ${t("Bot", "Бот")}:       @${existing.TELEGRAM_BOT_USERNAME || "?"}`,
    );
    console.log(
      `  • ${t("Access", "Доступ")}:    ${existing.TELEGRAM_ALLOWED_USER_IDS}`,
    );
    console.log(
      `  • Deepgram:  ${existing.DEEPGRAM_LANGUAGE || "multi"}   ·   TZ: ${existing.ASSISTANT_TIMEZONE || "?"}`,
    );
    if (
      !(await askYesNo(
        `\n  ${t("Reconfigure from scratch?", "Перенастроить заново?")}`,
        false,
      ))
    ) {
      if (keptSetupWritePlan(existing, out) === "validate-and-write") {
        await validateModelSelection({
          provider: prov0,
          model: existing[provModel],
          key: provKey ? existing[provKey] : undefined,
          dataDir: dataDirAbs(existing),
        });
        await writeEnv(out);
      }
      console.log(
        `${C.g}  ${t("Keeping current settings — nothing to enter.", "Оставляю текущие настройки как есть — ничего вводить не нужно.")}${C.x}`,
      );
      rl.close();
      return;
    }
    console.log(
      `\n  ${t("Going step by step.", "Идём по шагам.")} ${C.y}${t("Enter at each step keeps the current value.", "Enter на каждом шаге оставит текущее значение.")}${C.x}`,
    );
  } else {
    console.log(
      `\n${C.b}${C.g}  ${t("Iva setup — entering secrets step by step", "Настройка Iva — вводим секреты по шагам")}${C.x}`,
    );
    console.log(
      `  ${t("Takes a couple of minutes. For each key I'll tell you where to get it and check it on the spot.", "Займёт пару минут. Для каждого ключа подскажу, где его взять, и проверю на месте.")}`,
    );
    console.log(
      `  ${C.y}${t("The script won't exit until you've entered every required secret.", "Скрипт не завершится, пока вы не введёте все обязательные секреты.")}${C.x}`,
    );
  }

  // ── Step 1: model provider + model ────────────────────────────────
  head(
    1,
    t("Provider and model — Iva's brain", "Провайдер и модель — мозг Iva"),
  );
  console.log(
    `  ${t("Who to reach the model through:", "Через кого ходить к модели:")}`,
  );
  console.log(
    `    1) Ollama Cloud — ${C.c}https://ollama.com${C.x} ${t("(~$20/mo, higher limits)", "(~$20/мес, лимиты побольше)")}`,
  );
  console.log(
    `    2) OpenCode Go — ${C.c}https://opencode.ai/go${C.x} ${t("(~$5/mo, cheaper)", "(~$5/мес, дешевле)")}`,
  );
  console.log(
    `    3) OpenAI ${t("(ChatGPT subscription)", "(подписка ChatGPT)")} — ${C.c}chatgpt.com${C.x} ${t("(sign in, no API key)", "(вход по подписке, без API-ключа)")}`,
  );
  console.log(
    `    4) OpenRouter — ${C.c}https://openrouter.ai${C.x} ${t("(one key → 300+ models, pay-as-you-go)", "(один ключ → 300+ моделей, оплата по факту)")}`,
  );
  const provDef = { opencode: "2", codex: "3", openrouter: "4" }[prov0] || "1";
  const provChoice = (
    await ask(`  ${t("Provider", "Провайдер")} (1/2/3/4)`, provDef)
  ).trim();
  const provider =
    provChoice === "2"
      ? "opencode"
      : provChoice === "3"
        ? "codex"
        : provChoice === "4"
          ? "openrouter"
          : "ollama";
  out.MODEL_PROVIDER = provider;

  if (provider === "ollama") {
    console.log(
      `\n  ${t("Ollama key", "Ключ Ollama")}: ${C.c}https://ollama.com/settings/keys${C.x} (Settings → Keys → Create key)`,
    );
    let models: string[] = [];
    out.OLLAMA_API_KEY = await askRequired(
      `  ${t("Paste the Ollama key", "Вставьте ключ Ollama")}`,
      {
        existing: process.env.OLLAMA_API_KEY || existing.OLLAMA_API_KEY || "",
        validate: async (k) => {
          try {
            models = await ollamaModels(k);
            return null;
          } catch (error) {
            const caught = error as ThrownSetupError;
            return caught.auth
              ? t(
                  "Ollama rejected the key. Copy it again (no spaces).",
                  "Ollama не принял ключ. Скопируйте заново (без пробелов).",
                )
              : t(
                  `couldn't verify: ${caught.message}`,
                  `не смог проверить: ${caught.message}`,
                );
          }
        },
      },
    );
    console.log(
      `\n  ${t("Models available", "Доступно моделей")}: ${models.length}. ${t("I recommend", "Рекомендую")} ${C.g}deepseek-v4-pro${C.x}.`,
    );
    out.OLLAMA_MODEL = await pickFromList(
      models,
      out.OLLAMA_MODEL,
      "deepseek-v4-pro",
    );
    console.log(
      `\n  ${t("Vision model (photos)", "Vision-модель (фото)")}: ${t("describes incoming pictures — the text model above is usually blind.", "описывает входящие картинки — текстовая модель выше обычно их не видит.")} ${t("I recommend", "Рекомендую")} ${C.g}${CATALOG.ollama.visionDef ?? ""}${C.x}.`,
    );
    out.OLLAMA_VISION_MODEL = await pickFromList(
      models,
      out.OLLAMA_VISION_MODEL,
      CATALOG.ollama.visionDef ?? "",
    );
    out.OLLAMA_CONTEXT_WINDOW = out.OLLAMA_CONTEXT_WINDOW || "131072";
    console.log(`  → ${t("model", "модель")}: ${C.g}${out.OLLAMA_MODEL}${C.x}`);
    console.log(`  → vision: ${C.g}${out.OLLAMA_VISION_MODEL}${C.x}`);
  } else if (provider === "opencode") {
    console.log(
      `\n  ${t("OpenCode key", "Ключ OpenCode")}: ${C.c}https://opencode.ai/auth${C.x} ${t("(subscribe to Go → copy the API key).", "(подпишитесь на Go → скопируйте API key).")}`,
    );
    out.OPENCODE_API_KEY = await askRequired(
      `  ${t("Paste the OpenCode API key", "Вставьте OpenCode API key")}`,
      {
        existing:
          process.env.OPENCODE_API_KEY || existing.OPENCODE_API_KEY || "",
        validate: opencodeCheck,
      },
    );
    const models = await opencodeModels(out.OPENCODE_API_KEY);
    console.log(
      `\n  ${t("OpenCode Go models", "Модели OpenCode Go")}: ${models.length}. ${t("I recommend", "Рекомендую")} ${C.g}deepseek-v4-pro${C.x}.`,
    );
    // Strip the stale prefix from older .env files so the current model pre-selects from the bare list.
    const curModel = (out.OPENCODE_MODEL || "").replace(/^opencode-go\//, "");
    out.OPENCODE_MODEL = await pickFromList(
      models,
      curModel,
      "deepseek-v4-pro",
    );
    console.log(
      `\n  ${t("Vision model (photos)", "Vision-модель (фото)")}: ${t("describes incoming pictures — the text model above is usually blind.", "описывает входящие картинки — текстовая модель выше обычно их не видит.")} ${t("I recommend", "Рекомендую")} ${C.g}${CATALOG.opencode.visionDef ?? ""}${C.x}.`,
    );
    // Тот же срез устаревшего префикса, что и у текстовой модели выше.
    const curVision = (out.OPENCODE_VISION_MODEL || "").replace(
      /^opencode-go\//,
      "",
    );
    out.OPENCODE_VISION_MODEL = await pickFromList(
      models,
      curVision,
      CATALOG.opencode.visionDef ?? "",
    );
    out.OPENCODE_CONTEXT_WINDOW = out.OPENCODE_CONTEXT_WINDOW || "131072";
    console.log(
      `  → ${t("model", "модель")}: ${C.g}${out.OPENCODE_MODEL}${C.x}`,
    );
    console.log(`  → vision: ${C.g}${out.OPENCODE_VISION_MODEL}${C.x}`);
  } else if (provider === "openrouter") {
    console.log(
      `\n  ${t("OpenRouter key", "Ключ OpenRouter")}: ${C.c}https://openrouter.ai/keys${C.x} ${t("(Create Key → copy sk-or-…).", "(Create Key → скопируйте sk-or-…).")}`,
    );
    out.OPENROUTER_API_KEY = await askRequired(
      `  ${t("Paste the OpenRouter key", "Вставьте ключ OpenRouter")}`,
      {
        existing:
          process.env.OPENROUTER_API_KEY || existing.OPENROUTER_API_KEY || "",
        validate: openrouterKeyCheck,
      },
    );
    // 300+ моделей — пикер не подходит. Инструкция: откуда взять слаг и в каком виде, + живой тест.
    console.log(
      `\n  ${t("Now the model.", "Теперь модель.")} ${t("Open", "Откройте")} ${C.c}https://openrouter.ai/models${C.x}, ${t("pick a model and copy its slug", "выберите модель и скопируйте её слаг")}`,
    );
    console.log(
      `  ${t("— the id under the name, form", "— id под названием, вид")} ${C.g}vendor/model${C.x} (${t("e.g.", "напр.")} ${C.g}anthropic/claude-sonnet-4.5${C.x}, ${C.g}openai/gpt-5.1${C.x}, ${C.g}google/gemini-2.5-pro${C.x}).`,
    );
    console.log(
      `  ${C.y}${t("I'll send a live test (incl. tool/function calling, which Iva needs) — so a wrong or chat-only model can't slip through and leave the bot mute.", "Сразу отправлю живой тест (включая поддержку инструментов — она нужна Iva) — чтобы кривая или chat-only модель не проскочила и бот не остался немым.")}${C.x}`,
    );
    for (;;) {
      const m = (
        await ask(
          `  ${t("OpenRouter model slug", "Слаг модели OpenRouter")}`,
          out.OPENROUTER_MODEL || "",
        )
      ).trim();
      if (!m) {
        console.log(
          `${C.y}  ⚠ ${t("Required — paste a slug from openrouter.ai/models.", "Обязательно — вставьте слаг с openrouter.ai/models.")}${C.x}\n`,
        );
        continue;
      }
      process.stdout.write(
        `  ${t("testing the model answers…", "проверяю, что модель отвечает…")} `,
      );
      const err = await openrouterModelCheck(out.OPENROUTER_API_KEY, m);
      if (err) {
        console.log(
          `${C.r}${t("not ok", "не ок")}${C.x}\n${C.y}  ⚠ ${err}${C.x}\n`,
        );
        continue;
      }
      console.log(
        `${C.g}${t("ok — the model answered", "ок — модель ответила")}${C.x}`,
      );
      out.OPENROUTER_MODEL = m;
      break;
    }
    // Vision — отдельный слаг: выбранная текстовая модель может быть text-only.
    // Живого теста тут нет (мастер не шлёт картинку) — только дефолт и то, что вписали.
    const visionDef = CATALOG.openrouter.visionDef ?? "";
    console.log(
      `\n  ${t("Vision model (photos)", "Vision-модель (фото)")}: ${t("a slug that accepts images, any vendor.", "слаг модели, принимающей картинки, любого вендора.")} ${t("Enter keeps", "Enter оставит")} ${C.g}${visionDef}${C.x}.`,
    );
    out.OPENROUTER_VISION_MODEL =
      (
        await ask(
          `  ${t("OpenRouter vision slug", "Слаг vision-модели OpenRouter")}`,
          out.OPENROUTER_VISION_MODEL || visionDef,
        )
      ).trim() || visionDef;
    out.OPENROUTER_CONTEXT_WINDOW = out.OPENROUTER_CONTEXT_WINDOW || "131072";
    console.log(
      `  → ${t("model", "модель")}: ${C.g}${out.OPENROUTER_MODEL}${C.x}`,
    );
    console.log(`  → vision: ${C.g}${out.OPENROUTER_VISION_MODEL}${C.x}`);
  } else {
    // codex — вход по подписке OpenAI (OAuth), без API-ключа. Токен → data/codex-auth.json.
    const dataDir = dataDirAbs({ ...existing, ...out });
    let auth = readAuth(dataDir);
    if (auth) {
      console.log(
        `\n  ${C.g}${t("Already signed in", "Вход уже выполнен")}${auth.planType ? ` (${t("plan", "план")}: ${auth.planType})` : ""}.${C.x} ${t("Re-login: iva login", "Перелогиниться: iva login")}`,
      );
    } else {
      console.log(
        `\n  ${t("Sign in to your OpenAI (ChatGPT) subscription. No API key — auth like the codex CLI.", "Вход по подписке OpenAI (ChatGPT). Без API-ключа — авторизация как у codex CLI.")}`,
      );
      const useBrowser = await askYesNo(
        `  ${t("Sign in via a browser on THIS machine? (No = by link + code, best for a headless VPS)", "Войти через браузер на ЭТОЙ машине? (Нет = по ссылке и коду, для headless-VPS)")}`,
        false,
      );
      while (!auth) {
        try {
          auth = useBrowser
            ? await runBrowserLogin({
                dataDir,
                lang: LANG,
                log: (m) => console.log(m),
              })
            : await runDeviceCodeLogin({
                dataDir,
                lang: LANG,
                log: (m) => console.log(m),
              });
          console.log(
            `  ${C.g}${t("signed in", "вход выполнен")}${auth.planType ? ` — ${t("plan", "план")}: ${auth.planType}` : ""}${C.x}`,
          );
        } catch (error) {
          const caught = error as ThrownSetupError;
          console.log(
            `  ${C.r}${t("sign-in failed", "не удалось войти")}: ${caught.message}${C.x}`,
          );
          if (
            !(await askYesNo(
              `  ${t("Try again?", "Попробовать снова?")}`,
              true,
            ))
          )
            break;
        }
      }
    }
    // Список моделей подписки — тянем с бэкенда (как ollama/opencode). Fallback — ручной ввод.
    let models: string[] = [];
    if (auth) {
      try {
        models = await listCodexModels({ dataDir });
      } catch (error) {
        const caught = error as ThrownSetupError;
        console.log(
          `  ${C.y}${t("couldn't fetch the model list", "не смог получить список моделей")}: ${caught.message}${C.x}`,
        );
      }
    }
    if (models.length) {
      console.log(
        `\n  ${t("Models available", "Доступно моделей")}: ${models.length}.`,
      );
      out.CODEX_MODEL = await pickFromList(
        models,
        out.CODEX_MODEL || "",
        models[0],
      );
    } else {
      out.CODEX_MODEL = await ask(
        `  ${t("Codex model id", "ID модели Codex")}`,
        out.CODEX_MODEL || "gpt-5.1",
      );
    }
    out.CODEX_CONTEXT_WINDOW = out.CODEX_CONTEXT_WINDOW || "272000";
    console.log(`  → ${t("model", "модель")}: ${C.g}${out.CODEX_MODEL}${C.x}`);
  }
  console.log(
    `  ${C.y}${t("Don't inflate the context window:", "Окно контекста не завышайте:")}${C.x} ${t("compaction computes its threshold from it; an inflated window risks overflow.", "компактация считает порог от него; завышенное окно = риск переполнения.")}`,
  );

  // ── Step 2: Deepgram (voice/video) ────────────────────────────────
  head(
    2,
    t(
      "Deepgram — voice and video transcription",
      "Deepgram — расшифровка голоса и видео",
    ),
  );
  console.log(
    `  ${t("Where to get the key", "Где взять ключ")}: ${C.c}https://console.deepgram.com${C.x}`,
  );
  console.log(
    `    1) ${t("sign up (free starter credit)", "зарегистрируйтесь (дают бесплатный стартовый кредит)")}`,
  );
  console.log("    2) API Keys → Create a New API Key");
  console.log(`    3) ${t("copy the key", "скопируйте ключ")}`);
  out.DEEPGRAM_API_KEY = await askRequired(
    `  ${t("Paste the Deepgram API key", "Вставьте Deepgram API key")}`,
    {
      existing: process.env.DEEPGRAM_API_KEY || existing.DEEPGRAM_API_KEY || "",
      validate: deepgramCheck,
    },
  );
  out.DEEPGRAM_LANGUAGE = await ask(
    `  ${t("Recognition language (multi = auto ru/uz/en)", "Язык распознавания (multi = авто ru/uz/en)")}`,
    out.DEEPGRAM_LANGUAGE || "multi",
  );

  // ── Web search: provider + key ────────────────────────────────────
  // Without a key for the chosen provider web_search is off (DuckDuckGo gives a captcha from a server IP).
  console.log(
    `\n  ${C.b}${t("Web search", "Веб-поиск")}${C.x} — ${t("so Iva can search the internet (Enter on the key — skip, search stays off).", "чтобы Iva искала в интернете (Enter на ключе — пропустить, поиск будет выключен).")}`,
  );
  const SEARCH = [
    {
      id: "tavily",
      key: "TAVILY_API_KEY",
      url: "https://app.tavily.com",
      note: t(
        "free ~1000/mo, no card, has answer ★",
        "free ~1000/мес, без карты, есть answer ★",
      ),
    },
    {
      id: "exa",
      key: "EXA_API_KEY",
      url: "https://dashboard.exa.ai",
      note: t("free ~20k/mo, no card", "free ~20k/мес, без карты"),
    },
    {
      id: "parallel",
      key: "PARALLEL_API_KEY",
      url: "https://platform.parallel.ai",
      note: t("starter credits, no card", "стартовые кредиты, без карты"),
    },
    {
      id: "brave",
      key: "BRAVE_API_KEY",
      url: "https://api-dashboard.search.brave.com",
      note: t(
        "card required (verification), ~$5/mo credit",
        "нужна карта (идентификация), ~$5/мес кредит",
      ),
    },
  ];
  SEARCH.forEach((s, i) =>
    console.log(
      `   ${i + 1}. ${s.id}  ${C.c}${s.url}${C.x}  ${C.y}(${s.note})${C.x}`,
    ),
  );
  const curSearch = existing.SEARCH_PROVIDER || out.SEARCH_PROVIDER || "tavily";
  const defIdx = Math.max(
    0,
    SEARCH.findIndex((s) => s.id === curSearch),
  );
  const chSearch = await ask(
    `  ${t("Search provider (number)", "Провайдер поиска (номер)")}`,
    String(defIdx + 1),
  );
  let si = parseInt(chSearch, 10) - 1;
  if (isNaN(si) || si < 0 || si >= SEARCH.length) si = defIdx;
  const sprov = SEARCH[si];
  out.SEARCH_PROVIDER = sprov.id;
  console.log(
    `  ${t("Key for", "Ключ")} ${sprov.id}: ${C.c}${sprov.url}${C.x}${sprov.id === "brave" ? `  ${C.y}${t("(card required)", "(потребуется карта)")}${C.x}` : ""}. ${t("Enter — skip.", "Enter — пропустить.")}`,
  );
  const keyExisting =
    process.env[sprov.key] || existing[sprov.key] || out[sprov.key] || "";
  let kv = await ask(
    `  ${sprov.id} API key`,
    keyExisting ? mask(keyExisting) : "",
  );
  if (keyExisting && (!kv || kv.endsWith(KEEP()))) kv = keyExisting;
  out[sprov.key] = (kv || "").trim();

  // ── Enhanced memory (optional hybrid plugin) ──────────────────────
  // База (BM25 + граф связей) уже включена всегда, бесплатно, без ключа. Здесь — только
  // opt-in на семантический hybrid, который стоит внешнего ключа.
  console.log(
    `\n  ${t("Enhanced memory (hybrid search) — optional", "Улучшенная память (hybrid-поиск) — по желанию")}`,
  );
  console.log(
    `  ${C.y}${t(
      "Base search (BM25 + link graph) is already on — free, no key. Hybrid adds semantic search via ONE external key (~cents/mo), better for a large vault or fuzzy/cross-language queries.",
      "Базовый поиск (BM25 + граф связей) уже включён — бесплатно, без ключа. Hybrid добавляет семантику через ОДИН внешний ключ (~центы/мес), лучше для большого вольта и нечётких/межъязычных запросов.",
    )}${C.x}`,
  );
  if (
    await askYesNo(
      `  ${t("Enable hybrid memory?", "Включить hybrid-память?")}`,
      existing.MEMORY_SEARCH_MODE === "hybrid",
    )
  ) {
    const EMB = [
      {
        id: "jina",
        key: "JINA_API_KEY",
        url: "https://jina.ai/embeddings",
        note: t("no-train, EU, ~$0.02/1M", "no-train, EU, ~$0.02/1M"),
      },
      {
        id: "deepinfra",
        key: "DEEPINFRA_API_KEY",
        url: "https://deepinfra.com/dash/api_keys",
        note: t("cheapest, BGE-M3", "дешевле всех, BGE-M3"),
      },
    ];
    EMB.forEach((e, i) =>
      console.log(
        `   ${i + 1}. ${e.id}  ${C.c}${e.url}${C.x}  ${C.y}(${e.note})${C.x}`,
      ),
    );
    const chEmb = await ask(
      `  ${t("Embedding provider (number)", "Провайдер эмбеддингов (номер)")}`,
      existing.DEEPINFRA_API_KEY && !existing.JINA_API_KEY ? "2" : "1",
    );
    let ei = parseInt(chEmb, 10) - 1;
    if (isNaN(ei) || ei < 0 || ei >= EMB.length) ei = 0;
    const eprov = EMB[ei];
    const eExisting =
      process.env[eprov.key] || existing[eprov.key] || out[eprov.key] || "";
    console.log(
      `  ${t("Key for", "Ключ")} ${eprov.id}: ${C.c}${eprov.url}${C.x}. ${t("Enter — skip.", "Enter — пропустить.")}`,
    );
    let ek = await ask(
      `  ${eprov.id} API key`,
      eExisting ? mask(eExisting) : "",
    );
    if (eExisting && (!ek || ek.endsWith(KEEP()))) ek = eExisting;
    out[eprov.key] = (ek || "").trim();
    out.MEMORY_SEARCH_MODE = resolveMemorySearchMode(true, out);
    if (out.MEMORY_SEARCH_MODE === "hybrid") {
      console.log(
        `  ${C.y}${t("Index will build on the next nightly maintenance (or run: node scripts/memory/embed-index.ts).", "Индекс соберётся при ближайшем ночном обслуживании (или вручную: node scripts/memory/embed-index.ts).")}${C.x}`,
      );
    } else {
      console.log(
        `  ${C.y}${t("No key — hybrid skipped. Memory search stays on free BM25. Enable later: iva config.", "Ключа нет — hybrid пропущен. Поиск памяти остаётся на бесплатном BM25. Включить позже: iva config.")}${C.x}`,
      );
    }
  } else {
    out.MEMORY_SEARCH_MODE = resolveMemorySearchMode(false, out);
  }

  // ── Step 3: Telegram bot ──────────────────────────────────────────
  head(
    3,
    t(
      "Telegram bot — how you talk to Iva",
      "Telegram-бот — через него вы говорите с Iva",
    ),
  );
  console.log(
    `  ${t("Create a bot via @BotFather in Telegram:", "Создайте бота у @BotFather в Telegram:")}`,
  );
  console.log(
    `    1) ${t("open a chat with @BotFather", "откройте чат с @BotFather")}`,
  );
  console.log(`    2) ${t("send /newbot", "отправьте /newbot")}`);
  console.log(
    `    3) ${t("set the bot's name and username", "задайте имя и username бота")}`,
  );
  console.log(
    `    4) ${t("copy the token like 123456789:ABCdef...", "скопируйте token вида 123456789:ABCdef...")}`,
  );
  let me: TelegramBot | null | undefined = null;
  out.TELEGRAM_BOT_TOKEN = await askRequired(
    `  ${t("Paste the Bot token", "Вставьте Bot token")}`,
    {
      existing: existing.TELEGRAM_BOT_TOKEN || "",
      validate: async (token) => {
        try {
          me = await telegramGetMe(token);
          return null;
        } catch (error) {
          const caught = error as ThrownSetupError;
          return t(
            `Telegram rejected the token (${caught.message}). Copy it again from @BotFather.`,
            `Telegram не принял токен (${caught.message}). Скопируйте заново у @BotFather.`,
          );
        }
      },
    },
  );
  const telegramBot = me as TelegramBot | null | undefined;
  out.TELEGRAM_BOT_USERNAME =
    telegramBot?.username ||
    out.TELEGRAM_BOT_USERNAME ||
    (await ask(
      `  ${t("Bot username (without @)", "Username бота (без @)")}`,
      existing.TELEGRAM_BOT_USERNAME || "",
    ));
  if (telegramBot?.username)
    console.log(`  → ${t("bot", "бот")}: ${C.g}@${telegramBot.username}${C.x}`);
  out.TELEGRAM_WEBHOOK_SECRET_TOKEN =
    existing.TELEGRAM_WEBHOOK_SECRET_TOKEN || randomBytes(24).toString("hex");

  // ── Step 4: trusted users (loop until ≥1 ID) ──────────────────────
  head(
    4,
    t(
      "Access — who the bot answers at all",
      "Доступ — кому бот вообще отвечает",
    ),
  );
  console.log(
    `  ${C.y}${t("IMPORTANT:", "ВАЖНО:")}${C.x} ${t("Iva answers ONLY trusted Telegram IDs.", "Iva отвечает ТОЛЬКО доверенным Telegram ID.")}`,
  );
  console.log(
    `  ${t("Without at least one ID the bot stays silent to everyone (that's how your data is protected).", "Без хотя бы одного ID бот промолчит всем (так ваши данные защищены).")}`,
  );
  const ids = new Set(
    (existing.TELEGRAM_ALLOWED_USER_IDS || "")
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
  while (ids.size === 0) {
    console.log(
      `\n  ${t("Let's find your ID.", "Определим ваш ID.")} ${C.c}${t(`Open Telegram, find @${out.TELEGRAM_BOT_USERNAME || "your_bot"} and send it any message`, `Откройте Telegram, найдите @${out.TELEGRAM_BOT_USERNAME || "своего_бота"} и напишите ему любое сообщение`)}${C.x} ${t('(e.g. "hi").', "(напр. «привет»).")}`,
    );
    await ask(
      `  ${t("Sent the bot a message? press Enter", "Написали боту? нажмите Enter")}`,
    );
    try {
      const found = await fetchTelegramUserIds(out.TELEGRAM_BOT_TOKEN);
      if (found.length) {
        console.log(
          `  ${t("Found who messaged the bot:", "Нашёл, кто писал боту:")}`,
        );
        found.forEach((u, i) => console.log(`   ${i + 1}. ${u.id}  ${u.name}`));
        const pick = await ask(
          `  ${t("Which IDs to add? numbers comma-separated (Enter — add all)", "Чьи ID добавить? номера через запятую (Enter — добавить всех)")}`,
          "",
        );
        const chosen = pick
          ? pick
              .split(/[,\s]+/)
              .map((n) => found[parseInt(n, 10) - 1])
              .filter(Boolean)
          : found;
        chosen.forEach((u) => ids.add(u.id));
      } else {
        console.log(
          `${C.y}  ${t("I see no messages to the bot. Did you definitely send one? (if a webhook is set, getUpdates returns nothing)", "Не вижу сообщений боту. Точно написали? (если уже стоит вебхук — getUpdates не отдаёт апдейты)")}${C.x}`,
        );
      }
    } catch (error) {
      const caught = error as ThrownSetupError;
      console.log(
        `${C.y}  ${t(`Couldn't fetch updates: ${caught.message}`, `Не смог получить апдейты: ${caught.message}`)}${C.x}`,
      );
    }
    if (ids.size === 0) {
      const manual = await ask(
        `  ${t("Enter your Telegram ID manually (find it: message @userinfobot), or Enter — try again", "Введите свой Telegram ID вручную (узнать: напишите @userinfobot), или Enter — попробовать снова")}`,
        "",
      );
      manual
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .forEach((s) => ids.add(s));
    }
  }
  out.TELEGRAM_ALLOWED_USER_IDS = [...ids].join(",");
  out.TELEGRAM_DIGEST_CHAT_ID =
    existing.TELEGRAM_DIGEST_CHAT_ID || [...ids][0] || "";
  console.log(
    `  → ${t("access granted to ID", "доступ разрешён ID")}: ${C.g}${out.TELEGRAM_ALLOWED_USER_IDS}${C.x}`,
  );

  // ── Step 5: timezone, vault, port ─────────────────────────────────
  head(5, t("Timezone and memory storage", "Часовой пояс и хранилище памяти"));
  console.log(
    `  ${t("The timezone lets Iva use your real local time, not the server's.", "Часовой пояс нужен, чтобы Iva понимала ваше реальное время, а не время сервера.")}`,
  );
  for (;;) {
    const candidate = await ask(
      `  ${t("Timezone (IANA, e.g. Asia/Almaty, Asia/Tashkent, Europe/Berlin)", "Часовой пояс (IANA, напр. Asia/Almaty, Asia/Tashkent, Europe/Moscow)")}`,
      out.ASSISTANT_TIMEZONE || "Asia/Almaty",
    );
    const timezone = validateTimeZone(candidate);
    if (timezone) {
      out.ASSISTANT_TIMEZONE = timezone;
      break;
    }
    console.log(
      `${C.r}  ${t("Unknown IANA timezone. Try again.", "Неизвестный часовой пояс IANA. Введите ещё раз.")}${C.x}`,
    );
  }
  out.ASSISTANT_VAULT_DIR = await ask(
    `  ${t("Vault directory (memory + git backup)", "Каталог vault (память + git-бэкап)")}`,
    out.ASSISTANT_VAULT_DIR || "vault",
  );
  out.ASSISTANT_DATA_DIR = out.ASSISTANT_DATA_DIR || "data";
  // Off-the-beaten-path port: 3000/8000/8080 are often taken on a typical VPS (docker etc.). The server
  // listens on IVA_PORT and clients (poll bridge, digest, rollups) reach it via ASSISTANT_HOST. We check
  // the chosen port is free — otherwise the server would die with EADDRINUSE (silent exit → bot is mute).
  out.IVA_PORT = await pickPort(out.IVA_PORT || "8723");
  // For localhost, ASSISTANT_HOST MUST follow IVA_PORT: otherwise changing the port here
  // leaves bridge/cron clients on the old port (server moved, clients didn't) → the bot goes
  // mute. A custom non-localhost host (remote server) is kept as is.
  const localHost = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/i.test(
    out.ASSISTANT_HOST || "",
  );
  out.ASSISTANT_HOST =
    !out.ASSISTANT_HOST || localHost
      ? `http://127.0.0.1:${out.IVA_PORT}`
      : out.ASSISTANT_HOST;
  // ── Write .env ────────────────────────────────────────────────────
  const selected: { model: string; key: string | null } = {
    ollama: { model: "OLLAMA_MODEL", key: "OLLAMA_API_KEY" },
    opencode: { model: "OPENCODE_MODEL", key: "OPENCODE_API_KEY" },
    openrouter: { model: "OPENROUTER_MODEL", key: "OPENROUTER_API_KEY" },
    codex: { model: "CODEX_MODEL", key: null },
  }[provider];
  process.stdout.write(
    `  ${t("validating the selected model again…", "ещё раз проверяю выбранную модель…")} `,
  );
  await validateModelSelection({
    provider: out.MODEL_PROVIDER,
    model: out[selected.model],
    key: selected.key ? out[selected.key] : undefined,
    dataDir: dataDirAbs(out),
  });
  console.log(`${C.g}${t("ok", "ок")}${C.x}`);
  await writeEnv(out);

  const chosenModel = {
    ollama: out.OLLAMA_MODEL,
    opencode: out.OPENCODE_MODEL,
    openrouter: out.OPENROUTER_MODEL,
    codex: out.CODEX_MODEL,
  }[provider];
  console.log();
  hr();
  console.log(
    `${C.g}${C.b}  ✓ ${
      STAGING_CONFIG
        ? t(
            "Ready — settings validated for apply",
            "Готово к применению — настройки проверены",
          )
        : t("Done — everything written to .env", "Готово — всё записано в .env")
    }${C.x}`,
  );
  console.log(
    `  ${t("Provider", "Провайдер")}: ${provider} · ${t("Model", "Модель")}: ${C.g}${chosenModel}${C.x} · Deepgram: ${out.DEEPGRAM_LANGUAGE} · ${t("Bot", "Бот")}: ${C.g}@${out.TELEGRAM_BOT_USERNAME}${C.x}`,
  );
  console.log(
    `  ${t("Access", "Доступ")}: ${out.TELEGRAM_ALLOWED_USER_IDS} · TZ: ${out.ASSISTANT_TIMEZONE} · vault: ${out.ASSISTANT_VAULT_DIR} · ${t("lang", "язык")}: ${out.AGENT_LANGUAGE}`,
  );
  hr();
  rl.close();
}

main().catch((error) => {
  const caught = error as ThrownSetupError | null | undefined;
  console.error(
    `${C.r}${t("Setup aborted:", "Настройка прервана:")}${C.x}`,
    caught?.message || error,
  );
  process.exit(1);
});
