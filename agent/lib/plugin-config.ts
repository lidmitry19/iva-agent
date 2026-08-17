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
import { dataDir } from "./data-dir.ts";
import { pluginConfigFile } from "./plugin-store.ts";

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
