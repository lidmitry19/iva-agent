// Где лежит плагин и что о нём известно (ADR-0009).
//
// Папка плагинов одна — `data/custom/plugins/<name>/`. Плагин живёт в Custom layer,
// поэтому переживает `iva update` и не трогает Authored tree. Файл состояния один —
// `data/custom/plugins.json`: намерение (что владелец поставил) и факт (какой sha
// стоит) лежат рядом, отдельного lock-файла нет. Файл — источник истины: `iva plugin
// sync` восстанавливает по нему установку, если папку снесли или инсталляцию переехали.
//
// `PLUGIN_DATA` (`data/plugin-data/<name>/`) обязан переживать обновление плагина
// (спека §9.1), поэтому лежит рядом, а не внутри, и при `remove` не удаляется.
//
// Чтение НИЧЕГО не пишет. Это правило, а не деталь: состояние читает каждый ход
// агента, и «починка» битого файла на горячем пути однажды уже означала бы, что
// владелец теряет список плагинов молча, посреди разговора. Битую запись выбрасываем,
// битый файл отдаём вызывающему как ошибку — решать, что с ним делать, ему.
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { saveJsonAtomic } from "./json-store.ts";
import { pluginNameProblem } from "./plugin-reader.ts";

export type PluginEntry = {
  readonly name: string;
  /** Строка источника ровно в том виде, в каком её ввёл владелец. */
  readonly source: string;
  /** Что отслеживаем: ветка, тег, sha или `HEAD`; для локальной папки — пусто. */
  readonly ref: string;
  /** Что стоит: sha коммита; для локальной папки — пусто. */
  readonly sha: string;
  /** Отпечаток содержимого папки на момент установки; пусто — неизвестен. */
  readonly digest: string;
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

/** Что дало чтение файла: состояние всегда, ошибка — если файл не читается. */
export type PluginsStateRead = {
  readonly state: PluginsState;
  readonly damaged: Error | null;
};

export const EMPTY_PLUGINS_STATE: PluginsState = {
  marketplaces: [],
  plugins: [],
};

/** Каталог с плагинами: `data/custom/plugins/`. */
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
    digest: string(raw.digest),
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
 * Состояние из конкретного файла, без единой записи на диск. Файла нет — пустое
 * состояние без ошибки; файл битый — пустое состояние ПЛЮС ошибка, а сам файл
 * остаётся лежать как есть: его ещё чинить.
 */
export async function readPluginsStateFile(
  file: string,
): Promise<PluginsStateRead> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { state: EMPTY_PLUGINS_STATE, damaged: null };
    return {
      state: EMPTY_PLUGINS_STATE,
      damaged: new Error(`${file} unreadable: ${(error as Error).message}`),
    };
  }
  try {
    return { state: normalizePluginsState(JSON.parse(raw)), damaged: null };
  } catch (error) {
    return {
      state: EMPTY_PLUGINS_STATE,
      damaged: new Error(
        `${file} is not valid JSON (${(error as Error).message}) — fix it or run: iva plugin sync`,
      ),
    };
  }
}

/**
 * Тот же текст без лишних запятых: дубли, висячая перед `}`/`]` и ведущая сразу
 * после `[`/`{`. Сканер идёт по символам и знает про строки, поэтому запятая внутри
 * `"a,,b"` остаётся на месте — чинить надо разметку, а не данные владельца.
 */
function withoutStrayCommas(raw: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < raw.length; index++) {
    const character = raw[index];
    if (inString) {
      out += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      out += character;
      continue;
    }
    if (character === ",") {
      let next = index + 1;
      while (next < raw.length && /\s/u.test(raw[next])) next++;
      if (raw[next] === "," || raw[next] === "}" || raw[next] === "]") continue;
      let previous = out.length - 1;
      while (previous >= 0 && /\s/u.test(out[previous])) previous--;
      if (previous < 0 || out[previous] === "[" || out[previous] === "{")
        continue;
    }
    out += character;
  }
  return out;
}

/**
 * Спасти состояние из файла, который уже не читается как JSON. Сначала честный
 * разбор, затем один проход починки разметки. Ничего не вышло — `null`, и решать,
 * что делать дальше, вызывающему.
 */
export async function salvagePluginsStateFile(
  file: string,
): Promise<PluginsState | null> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return null;
  }
  for (const text of [raw, withoutStrayCommas(raw)]) {
    try {
      return normalizePluginsState(JSON.parse(text));
    } catch {
      // Следующая попытка; последняя вернёт null.
    }
  }
  return null;
}

/** То же для инсталляции: `data/custom/plugins.json`. */
export function readPluginsStateSafe(
  dataDir: string,
): Promise<PluginsStateRead> {
  return readPluginsStateFile(pluginsStateFile(dataDir));
}

/**
 * Состояние для команды владельца: битый файл — ошибка наружу. Команда, которая
 * молча пошла бы дальше на пустом состоянии, сказала бы «плагин не установлен» про
 * стоящий плагин и предложила поставить его заново поверх.
 */
export async function readPluginsState(dataDir: string): Promise<PluginsState> {
  const { state, damaged } = await readPluginsStateSafe(dataDir);
  if (damaged) throw damaged;
  return state;
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
