// Конфиг плагина в РАНТАЙМЕ: то, чем сгенерированный mount поднимает eve Extension.
//
// Значения владельца лежат в `data/custom/plugins/<name>.config.json` и читаются при
// загрузке модуля, а НЕ во время сборки версии. Разница принципиальная: запечённый в
// бандл ключ пришлось бы пересобирать версией на каждую правку конфига, и он остался бы
// лежать в `.output` даже после того, как владелец его убрал.
//
// Функция НИКОГДА не кидает. Mount загружается в процессе агента, и исключение здесь
// уронило бы весь ход, а не один плагин: битый или отсутствующий файл — это пустой
// конфиг, а жаловаться на значения будет схема самого расширения.
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { dataDir } from "./data-dir.ts";
import { pluginConfigFile, pluginEnvFile } from "./plugin-store.ts";

/**
 * Значения конфига плагина `name`, как их написал владелец. Файла нет, он не читается
 * или в нём не объект — пустой конфиг.
 *
 * Тип выводится из места вызова: проверяет значения схема расширения (Standard Schema
 * у eve), и второй валидации здесь быть не должно — она разошлась бы с первой.
 */
export function readPluginConfig<T = Record<string, unknown>>(name: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      readFileSync(pluginConfigFile(dataDir(), name), "utf8"),
    );
  } catch {
    return {} as T;
  }
  return (
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed
      : {}
  ) as T;
}

/**
 * Env плагина: `data/custom/plugins/<name>.env`, как его написал владелец. Это
 * ЕДИНСТВЕННЫЙ источник секретов для MCP-серверов плагина (ADR-0009): env агента им
 * не передаётся. Файла нет или он не читается — пустой набор, без исключения наружу.
 *
 * Разбор — `parseEnv` из `node:util`: тот же формат, что у `--env-file` самого Node,
 * и своего парсера dotenv у нас не будет.
 */
export function readPluginEnv(
  name: string,
  /** Каталог данных. Задаёт его только прокси: у него свой процесс и свой аргумент. */
  dir: string = dataDir(),
): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(pluginEnvFile(dir, name), "utf8");
  } catch {
    return {};
  }
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(parseEnv(raw))) {
    if (typeof value === "string") values[key] = value;
  }
  return values;
}

/** О какой переменной уже предупреждали: одна строка в журнал на весь процесс. */
const warned = new Set<string>();

/**
 * Подставить в шаблон значения из `<name>.env` — ОДИН проход, без рекурсии.
 * Неизвестная переменная даёт пустую строку и одно предупреждение в журнал: заголовок
 * с пустым токеном сервер отвергнет понятной ошибкой, а ход из-за опечатки в env
 * падать не должен.
 *
 * Читается при КАЖДОМ вызове: владелец правит `<name>.env` без рестарта агента.
 */
export function expandPluginEnv(name: string, template: string): string {
  if (!template.includes("${")) return template;
  const values = readPluginEnv(name);
  return template.replaceAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu, (_, key) => {
    const value = values[key as string];
    if (value !== undefined) return value;
    const seen = `${name}\0${key as string}`;
    if (!warned.has(seen)) {
      warned.add(seen);
      console.warn(
        `[plugin ${name}] ${key as string} is not set in ${name}.env; using an empty value`,
      );
    }
    return "";
  });
}
