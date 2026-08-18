// Provider/model/effort metadata for the /model and /think Telegram wizards.
// Static lists are suggestions only; selectable catalog providers must come from
// a successful live response. Codex also returns model-specific reasoning levels.
import { listCodexModelCatalog } from "./codex-oauth.ts";
import {
  CANONICAL_REASONING_EFFORTS,
  FALLBACK_REASONING_EFFORTS,
} from "./reasoning-levels.ts";

export interface ProviderCatalogEntry {
  label: string;
  auth: "key" | "oauth";
  base?: string;
  keyVar: string | null;
  modelVar: string;
  def: string;
  // Vision-модель: своя переменная и свой дефолт. null у провайдера, который смотрит
  // картинку выбранной текстовой моделью (codex — подписка мультимодальна).
  visionVar: string | null;
  visionDef: string | null;
  models: string[];
}

export interface ModelOption {
  id: string;
  reasoningLevels: string[];
}

export interface FetchModelOptions {
  dataDir?: string;
  listCodexCatalog?: (options?: { dataDir?: string }) => Promise<ModelOption[]>;
  fetchFn?: typeof fetch;
}

// Runtime accepts the stable protocol vocabulary. Telegram only offers the live
// model-specific subset; when the response is missing/broken it uses the conservative
// three-button fallback. `ultra` is intentionally absent from both lists.
export const EFFORTS = CANONICAL_REASONING_EFFORTS;
export const FALLBACK_EFFORTS = FALLBACK_REASONING_EFFORTS;

// A hung provider endpoint must not stall the bridge's single getUpdates loop.
const FETCH_TIMEOUT_MS = 10_000;

export class ModelCatalogError extends Error {
  declare readonly code: string;
  declare readonly status?: number;

  constructor(
    code: string,
    message: string,
    { status, cause }: { status?: number; cause?: unknown } = {},
  ) {
    super(message, { cause });
    this.name = "ModelCatalogError";
    this.code = code;
    this.status = status;
  }
}

// Зеркало MODEL_PROVIDERS из agent/lib/model-provider.ts: те же имена, те же переменные и
// те же дефолты обеих моделей. Импортировать оригинал нельзя (ADR-0003: эта половина грузится
// на инсталле, где authored tree может не быть), поэтому расхождение ловит тест по соседству.
export const CATALOG: Record<string, ProviderCatalogEntry> = {
  ollama: {
    label: "Ollama Cloud",
    auth: "key",
    base: "https://ollama.com/v1",
    keyVar: "OLLAMA_API_KEY",
    modelVar: "OLLAMA_MODEL",
    def: "deepseek-v4-pro",
    visionVar: "OLLAMA_VISION_MODEL",
    visionDef: "gemma4:31b",
    // Mirrors the live GET /models list (checked 2026-07-28). Ollama Cloud retires tags without
    // notice — gemma3:12b went 410 on 2026-07-15 — so keep only IDs seen in the live response.
    // kimi-k3 is billed as "extra usage" on top of the plan (402 with an empty extra balance).
    models: [
      "deepseek-v4-pro",
      "deepseek-v4-flash",
      "kimi-k3",
      "glm-5.2",
      "minimax-m3",
      "gemma4:31b",
      "gpt-oss:120b",
    ],
  },
  opencode: {
    label: "OpenCode Go",
    auth: "key",
    base: "https://opencode.ai/zen/go/v1",
    keyVar: "OPENCODE_API_KEY",
    modelVar: "OPENCODE_MODEL",
    def: "deepseek-v4-pro",
    // Живая проверка 2026-08-18: minimax-m3 описывает картинку, gpt-5.6-luna отвечает 400.
    visionVar: "OPENCODE_VISION_MODEL",
    visionDef: "minimax-m3",
    // Mirrors OPENCODE_MODELS in scripts/setup/main.ts (bare IDs, no "opencode-go/" prefix).
    models: [
      "deepseek-v4-pro",
      "deepseek-v4-flash",
      "kimi-k3",
      "kimi-k2.7-code",
      "glm-5.2",
      "minimax-m3",
      "qwen3.7-max",
      "grok-4.5",
    ],
  },
  codex: {
    label: "OpenAI (подписка)",
    auth: "oauth",
    keyVar: null,
    modelVar: "CODEX_MODEL",
    def: "gpt-5.5",
    // Картинку смотрит выбранная текстовая модель подписки — своей переменной нет.
    visionVar: null,
    visionDef: null,
    models: ["gpt-5.5", "gpt-5.1", "gpt-5"],
  },
  openrouter: {
    label: "OpenRouter",
    auth: "key",
    base: "https://openrouter.ai/api/v1",
    keyVar: "OPENROUTER_API_KEY",
    modelVar: "OPENROUTER_MODEL",
    def: "openai/gpt-5.1",
    visionVar: "OPENROUTER_VISION_MODEL",
    visionDef: "google/gemini-2.5-flash",
    // Always static (300+ live models don't fit inline buttons). Curated known-good
    // slugs only: every model here must support tool calling — Iva sends tool
    // definitions each turn (see the live test in scripts/setup/main.ts for the full check).
    models: [
      "openai/gpt-5.1",
      "anthropic/claude-sonnet-4.5",
      "google/gemini-2.5-pro",
      "google/gemini-2.5-flash",
      "deepseek/deepseek-chat",
      "moonshotai/kimi-k3",
    ],
  },
};

// The one place the CLI half turns a configured MODEL_PROVIDER into a provider. Exact match,
// like the runtime resolver (agent/lib/model-provider.ts): an unknown name resolves to nothing
// rather than collapsing into Ollama, so the wizard, doctor, the update and the /menu screens
// all see the same broken configuration the agent refuses to start on (issue #161).
export function catalogProvider(
  name: string | undefined,
): ProviderCatalogEntry | undefined {
  return name !== undefined && Object.hasOwn(CATALOG, name)
    ? CATALOG[name]
    : undefined;
}

// The model a provider will actually be asked for, by the same rule the runtime uses
// (agent/lib/model-provider.ts `modelProviderModel`): trimmed, and blank means "not set",
// so the provider's own default answers. Every screen reads this instead of its own
// `|| default` or `|| "?"`, because one .env may not produce three different answers.
// The two halves are pinned together in the test next door.
export function catalogModel(
  name: string,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const provider = catalogProvider(name);
  if (!provider) return undefined;
  const configured = (env[provider.modelVar] ?? "").trim();
  const stripped =
    name === "opencode" ? configured.replace(/^opencode-go\//, "") : configured;
  return stripped || provider.def;
}

// The .env keys a provider cannot work without. codex has no key — it signs in over OAuth
// (data/codex-auth.json), which is checked separately. Shared by `iva doctor` and the setup
// wizard so one of them can never call a configuration complete that the other rejects.
export function providerEnvKeys(provider: ProviderCatalogEntry): string[] {
  return provider.keyVar
    ? [provider.keyVar, provider.modelVar]
    : [provider.modelVar];
}

// Ollama Cloud and OpenCode Go both expose OpenAI-compatible reasoning_effort.
// Their /models payloads contain IDs only, so the API's common low/medium/high
// contract is the best available capability signal. Codex is richer: its live
// catalog carries a model-specific subset.
const REASONING_PROVIDERS = new Set(["ollama", "opencode", "codex"]);

export const providerSupportsReasoning = (provider: string): boolean =>
  REASONING_PROVIDERS.has(provider);
export const providerFallbackReasoningLevels = (provider: string): string[] =>
  providerSupportsReasoning(provider) ? [...FALLBACK_EFFORTS] : [];

const optionsFor = (
  provider: string,
  models: readonly string[],
): ModelOption[] =>
  models.map((id) => ({
    id,
    reasoningLevels: providerFallbackReasoningLevels(provider),
  }));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";

const validOptions = (provider: string, entries: unknown): ModelOption[] => {
  if (!Array.isArray(entries)) {
    throw new ModelCatalogError(
      "catalog_invalid",
      "provider returned a malformed model catalog",
    );
  }
  const seen = new Set<string>();
  const options: ModelOption[] = [];
  for (const value of entries as unknown[]) {
    const entry = isRecord(value) ? value : null;
    const id = entry && typeof entry.id === "string" ? entry.id.trim() : "";
    if (!id) {
      throw new ModelCatalogError(
        "catalog_invalid",
        "provider returned a malformed model entry",
      );
    }
    if (seen.has(id)) continue;
    seen.add(id);
    options.push({
      id,
      reasoningLevels:
        entry && Array.isArray(entry.reasoningLevels)
          ? ([...(entry.reasoningLevels as unknown[])] as string[])
          : providerFallbackReasoningLevels(provider),
    });
  }
  if (!options.length) {
    throw new ModelCatalogError(
      "catalog_invalid",
      "provider returned an empty model catalog",
    );
  }
  return options;
};

// Selectable options come only from the live provider catalog. Static lists remain
// display metadata and OpenRouter suggestions; they must never resurrect retired models.
export async function fetchModelOptions(
  provider: string,
  key?: string,
  {
    dataDir,
    listCodexCatalog = listCodexModelCatalog,
    fetchFn = fetch,
  }: FetchModelOptions = {},
): Promise<ModelOption[]> {
  const cat = CATALOG[provider];
  if (!cat) return [];
  try {
    if (provider === "codex") {
      const live = await listCodexCatalog(dataDir ? { dataDir } : {});
      return validOptions(provider, live);
    }
    if (cat.base && provider !== "openrouter") {
      const res = await fetchFn(`${cat.base}/models`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.status === 401 || res.status === 403) {
        throw new ModelCatalogError(
          "auth_rejected",
          `provider rejected credentials (${res.status})`,
          {
            status: res.status,
          },
        );
      }
      if (!res.ok) {
        throw new ModelCatalogError(
          "catalog_unavailable",
          `model catalog returned HTTP ${res.status}`,
          {
            status: res.status,
          },
        );
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch (cause) {
        throw new ModelCatalogError(
          "catalog_invalid",
          "provider returned invalid catalog JSON",
          {
            cause,
          },
        );
      }
      if (
        !body ||
        typeof body !== "object" ||
        !Array.isArray((body as Record<string, unknown>).data)
      ) {
        throw new ModelCatalogError(
          "catalog_invalid",
          "provider returned a malformed model catalog",
        );
      }
      return validOptions(
        provider,
        (body as Record<string, unknown>).data,
      ).sort((a, b) => a.id.localeCompare(b.id));
    }
  } catch (e) {
    if (e instanceof ModelCatalogError) throw e;
    throw new ModelCatalogError(
      "catalog_unavailable",
      "couldn't load the live model catalog",
      {
        cause: e,
      },
    );
  }
  return optionsFor(provider, cat.models); // openrouter and anything else: static curated list
}

// Compatibility for setup or future CLI consumers that only need IDs.
export async function fetchModels(
  provider: string,
  key?: string,
  opts: FetchModelOptions = {},
): Promise<string[]> {
  return (await fetchModelOptions(provider, key, opts)).map(
    (option) => option.id,
  );
}

// Cheap key validity probe (same lenient policy as scripts/setup/main.ts: network flake ⇒ accept).
// Returns null when the key looks fine, or a short human-readable reason.
export async function checkKey(
  provider: string,
  key: string,
): Promise<string | null> {
  const cat = CATALOG[provider];
  if (!cat?.base) return null;
  // OpenRouter has a dedicated auth-only endpoint; the others validate via /models.
  const url =
    provider === "openrouter" ? `${cat.base}/key` : `${cat.base}/models`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403)
      return `провайдер отверг ключ (${res.status})`;
    return null;
  } catch {
    return null;
  }
}
