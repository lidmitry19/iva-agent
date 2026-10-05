// Ночь грузится на Node 24 (c1): каждый относительный и `#` импорт файлов, достижимых из
// night.ts, указывает на существующий файл. Node 26 молча подставляет .ts вместо .js,
// Node 24 падает ERR_MODULE_NOT_FOUND — на эту подстановку тест не надеется.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "../..");
const PACKAGE = JSON.parse(
  readFileSync(resolve(ROOT, "package.json"), "utf8"),
) as { imports: Record<string, string> };
const IMPORTS = PACKAGE.imports;
// import/export … from "x", import "x", import("x"); type-only тоже: tsc их не стирает сам.
const SPECIFIER =
  /(?:\bfrom\s+|\bimport\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gmu;

/** Путь файла по спецификатору или null для пакета из node_modules и node:. */
function target(from: string, specifier: string): string | null {
  if (specifier.startsWith(".")) return resolve(dirname(from), specifier);
  if (!specifier.startsWith("#")) return null;
  const [key, value] = Object.entries(IMPORTS)
    .filter(([key]) => specifier.startsWith(key.replace("*", "")))
    .sort(([a], [b]) => b.length - a.length)[0];
  return resolve(ROOT, value.replace("*", specifier.slice(key.length - 1)));
}

/** Файлы, достижимые из night.ts, и импорты, которые не ведут на существующий файл. */
function walk(entry: string) {
  const seen = new Set<string>();
  const missing: string[] = [];
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const [, specifier] of readFileSync(file, "utf8").matchAll(
      SPECIFIER,
    )) {
      const path = target(file, specifier);
      if (path === null) continue;
      if (existsSync(path)) queue.push(path);
      else missing.push(`${relative(ROOT, file)} -> ${specifier}`);
    }
  }
  return { seen, missing: missing.sort() };
}

void test("все импорты, достижимые из night.ts, ведут на существующие файлы (Node 24)", () => {
  const { seen, missing } = walk(resolve(ROOT, "scripts/memory/night.ts"));
  assert.ok(
    seen.has(resolve(ROOT, "agent/lib/card-store.ts")),
    "обход дошёл до card-store",
  );
  assert.ok(
    seen.has(resolve(ROOT, "scripts/memory/night-periods.ts")),
    "и до динамических",
  );
  assert.deepEqual(missing, []);
});
