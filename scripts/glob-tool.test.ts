/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registration promises. */
// glob отдаёт не больше 1000 путей: на c1 `**/*` от ~/iva вернул 43584 пути в контекст.
// Тесты тулов живут в scripts/: файл рядом с тулами eve счёл бы ещё одним тулом и сборка
// упала бы. Хук резолвинга идёт первым — тулы тянут соседей NodeNext-спецификаторами.
import "./lib/ts-esm-hooks.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import type { ToolContext } from "eve/tools";
import { settled } from "./fixtures/tool-result.ts";

const { default: globTool } = await import("../agent/tools/glob.ts");

const SEED = 20260924;
const CAP = 1000;

const ctx = {
  abortSignal: new AbortController().signal,
  callId: "glob-tool",
  toolName: "glob",
} as unknown as ToolContext;

// n файлов в двух каталогах, имена с разной длиной номера, чтобы порядок сортировки
// отличался от порядка создания.
function tree(n: number): { root: string; paths: string[] } {
  const root = mkdtempSync(join(tmpdir(), "iva-glob-cap-"));
  mkdirSync(join(root, "a"));
  mkdirSync(join(root, "b"));
  const paths: string[] = [];
  for (let i = 0; i < n; i++) {
    const rel = `${i % 2 ? "a" : "b"}/f${i}.md`;
    writeFileSync(join(root, rel), "");
    paths.push(rel);
  }
  return { root, paths: paths.sort() };
}

async function glob(root: string, pattern = "**/*"): Promise<unknown> {
  return settled(await globTool.execute({ pattern, cwd: root }, ctx));
}

function hint(rest: number, total: number): string {
  return `… ещё ${rest} путей из ${total}: сузь pattern или cwd`;
}

test("glob отдаёт 1000 путей как есть, без подсказки", async () => {
  const { root, paths } = tree(CAP);
  try {
    const out = await glob(root);
    assert.deepEqual(out, paths);
    assert.equal(JSON.stringify(out), JSON.stringify(paths));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const n of [CAP + 1, 2500]) {
  test(`glob режет ${n} путей до 1000 и называет остаток`, async () => {
    const { root, paths } = tree(n);
    try {
      const out = await glob(root);
      assert.deepEqual(out, [...paths.slice(0, CAP), hint(n - CAP, n)]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("glob считает остаток от совпавших с pattern, а не от всех файлов", async () => {
  const { root, paths } = tree(2500);
  try {
    const matched = paths.filter((p) => p.startsWith("a/"));
    const out = await glob(root, "a/*.md");
    assert.deepEqual(out, [
      ...matched.slice(0, CAP),
      hint(matched.length - CAP, matched.length),
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(`glob: min(n, 1000) путей и подсказка ровно при n > 1000 (seed ${SEED})`, async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.oneof(
        fc.integer({ min: 0, max: 1100 }),
        fc.constantFrom(0, 1, CAP - 1, CAP, CAP + 1),
      ),
      async (n) => {
        const { root, paths } = tree(n);
        try {
          const out = await glob(root);
          const expected =
            n > CAP ? [...paths.slice(0, CAP), hint(n - CAP, n)] : paths;
          assert.deepEqual(out, expected);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      },
    ),
    { seed: SEED, numRuns: 25 },
  );
});
