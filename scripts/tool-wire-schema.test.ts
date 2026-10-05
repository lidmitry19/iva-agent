/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Контракт провода: каждый наш тул уходит провайдеру схемой, которую примет любой из них.
// Схему строит тот же сериализатор eve, что и в проде. Корень - объект с properties, без
// oneOf/anyOf/allOf: Anthropic требует input_schema.type, OpenAI и Gemini не берут
// комбинаторы в корне. Одна сломанная схема роняет каждый ход дня, а не только свой тул.

import "./lib/ts-esm-hooks.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const COMBINATORS = ["oneOf", "anyOf", "allOf", "not", "$ref"];

// Сериализатор eve не экспортирован публично; берём его из того же пакета, что и рантайм.
const eveTools = import.meta.resolve("eve/tools");
const { serializeInputSchema } = (await import(
  new URL("../../tools/schema.js", eveTools).href
)) as { serializeInputSchema: (schema: unknown) => Record<string, unknown> };

function toolFiles(): string[] {
  const dirs = [join(ROOT, "agent/tools")];
  const subagents = join(ROOT, "agent/subagents");
  for (const name of readdirSync(subagents))
    dirs.push(join(subagents, name, "tools"));
  return dirs.flatMap((dir) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    return names
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .map((name) => join(dir, name));
  });
}

test("каждая схема тула на проводе - плоский объект, который примет любой провайдер", async () => {
  const files = toolFiles();
  assert.ok(files.length >= 12, `найдено тулов: ${files.length}`);
  for (const file of files) {
    const name = relative(ROOT, file);
    const tool = (await import(pathToFileURL(file).href)) as {
      default: { inputSchema?: unknown };
    };
    if (tool.default.inputSchema === undefined) continue;
    const wire = serializeInputSchema(tool.default.inputSchema);
    assert.equal(wire.type, "object", `${name}: в корне нет type: "object"`);
    assert.equal(
      typeof wire.properties,
      "object",
      `${name}: в корне нет properties`,
    );
    for (const key of COMBINATORS)
      assert.ok(!(key in wire), `${name}: ${key} в корне схемы`);
  }
});
