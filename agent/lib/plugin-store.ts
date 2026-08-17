// Стор плагинов и его состояние: где лежит плагин и что о нём известно (ADR-0009).
//
// Один стор — `data/custom/plugins/<name>/`. Плагин живёт в Custom layer, поэтому
// переживает `iva update` и не трогает Authored tree. Один файл состояния —
// `data/custom/plugins.json`: намерение (что владелец поставил) и факт (какой sha
// стоит) лежат рядом, отдельного lock-файла нет. Файл — источник истины: `iva plugin
// sync` восстанавливает по нему стор, если папку снесли или инсталляцию переехали.
//
// `PLUGIN_DATA` (`data/plugin-data/<name>/`) обязан переживать обновление плагина
// (спека §9.1), поэтому лежит ВНЕ стора и при `remove` не удаляется.
//
// Чтение состояния терпит мусор: битая запись выбрасывается, остальные остаются.
// Так резолвер скиллов не теряет ход из-за одной руками поправленной строки.
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadJsonStrict, saveJsonAtomic } from "./json-store.ts";
import { pluginNameProblem } from "./plugin-reader.ts";

export type PluginEntry = {
  readonly name: string;
  /** Строка источника ровно в том виде, в каком её ввёл владелец. */
  readonly source: string;
  /** Что отслеживаем: ветка, тег, sha или `HEAD`; для локальной папки — пусто. */
  readonly ref: string;
  /** Что стоит: sha коммита; для локальной папки — пусто. */
  readonly sha: string;
  readonly enabled: boolean;
  /** Разрешение поднимать MCP-серверы плагина. Тумблер отдельный (ADR-0009). */
  readonly trusted: boolean;
  readonly installedAt: string;
};

export type PluginsState = {
  readonly marketplaces: readonly string[];
  readonly plugins: readonly PluginEntry[];
  /** Когда владельцу один раз показали принятый риск ADR-0008. */
  readonly riskNoticeShownAt?: string;
};

export const EMPTY_PLUGINS_STATE: PluginsState = {
  marketplaces: [],
  plugins: [],
};

/** Каталог стора: `data/custom/plugins/`. */
export function pluginsDir(dataDir: string): string {
  return join(dataDir, "custom", "plugins");
}

/** Корень одного плагина: `data/custom/plugins/<name>/`. */
export function pluginRoot(dataDir: string, name: string): string {
  return join(pluginsDir(dataDir), name);
}

/** `PLUGIN_DATA` плагина: переживает и обновление, и удаление плагина. */
export function pluginDataDir(dataDir: string, name: string): string {
  return join(dataDir, "plugin-data", name);
}

/** Файл состояния: `data/custom/plugins.json`. */
export function pluginsStateFile(dataDir: string): string {
  return join(dataDir, "custom", "plugins.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function string(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function normalizeEntry(raw: unknown): PluginEntry | null {
  if (!isRecord(raw)) return null;
  if (pluginNameProblem(raw.name) !== null) return null;
  return {
    name: raw.name as string,
    source: string(raw.source),
    ref: string(raw.ref),
    sha: string(raw.sha),
    // Отсутствующий тумблер читается как «включён»: запись есть — плагин поставлен.
    enabled: raw.enabled !== false,
    trusted: raw.trusted === true,
    installedAt: string(raw.installedAt),
  };
}

/** Любой JSON → состояние. Никогда не кидает: битая запись просто выпадает. */
export function normalizePluginsState(raw: unknown): PluginsState {
  if (!isRecord(raw)) return EMPTY_PLUGINS_STATE;
  const marketplaces = Array.isArray(raw.marketplaces)
    ? raw.marketplaces.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  const seen = new Set<string>();
  const plugins: PluginEntry[] = [];
  if (Array.isArray(raw.plugins)) {
    for (const item of raw.plugins) {
      const entry = normalizeEntry(item);
      if (!entry || seen.has(entry.name)) continue;
      seen.add(entry.name);
      plugins.push(entry);
    }
  }
  plugins.sort((a, b) => (a.name < b.name ? -1 : 1));
  return {
    marketplaces,
    plugins,
    ...(typeof raw.riskNoticeShownAt === "string"
      ? { riskNoticeShownAt: raw.riskNoticeShownAt }
      : {}),
  };
}

/**
 * Состояние с диска. Файла нет — пустое состояние; файл битый — ошибка наружу с
 * бэкапом (loadJsonStrict), потому что молча начать с пустого значило бы стереть
 * следующей записью все плагины владельца.
 */
export async function readPluginsState(dataDir: string): Promise<PluginsState> {
  const raw = await loadJsonStrict<unknown>(pluginsStateFile(dataDir), null);
  return normalizePluginsState(raw);
}

/** Атомарная запись состояния (tmp + rename): читатель не увидит полуфайл. */
export async function writePluginsState(
  dataDir: string,
  state: PluginsState,
): Promise<void> {
  const file = pluginsStateFile(dataDir);
  await mkdir(dirname(file), { recursive: true });
  await saveJsonAtomic(file, normalizePluginsState(state));
}

export function findPlugin(
  state: PluginsState,
  name: string,
): PluginEntry | undefined {
  return state.plugins.find((entry) => entry.name === name);
}

/** Добавить или заменить запись. Чистая функция: состояние не мутируется. */
export function upsertPlugin(
  state: PluginsState,
  entry: PluginEntry,
): PluginsState {
  return {
    ...state,
    plugins: [
      ...state.plugins.filter((item) => item.name !== entry.name),
      entry,
    ].sort((a, b) => (a.name < b.name ? -1 : 1)),
  };
}

export function removePlugin(state: PluginsState, name: string): PluginsState {
  return {
    ...state,
    plugins: state.plugins.filter((entry) => entry.name !== name),
  };
}

export function enabledPlugins(state: PluginsState): readonly PluginEntry[] {
  return state.plugins.filter((entry) => entry.enabled);
}
