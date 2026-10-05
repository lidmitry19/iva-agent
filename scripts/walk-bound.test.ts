/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registration promises. */
// grep и glob не вешают ход: 29.09.2026 на c1 grep по /home/shima обходил дом 4,5 минуты,
// ход сняли по тишине через 180 с. Обход ограничен временем и числом файлов, уважает отмену
// хода и отдаёт найденное с подсказкой сузить путь. Часы в тестах закреплены: срок
// наступает по счёту обращений к Date.now, а не по скорости машины.
import "./lib/ts-esm-hooks.ts";
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import fc from "fast-check";
import type { ToolContext } from "eve/tools";
import { settled } from "./fixtures/tool-result.ts";

const { default: grepTool } = await import("../agent/tools/grep.ts");
const { default: globTool } = await import("../agent/tools/glob.ts");
const { WALK_HINT, walkBound, walkFiles } =
  await import("../agent/lib/vault-file-search.ts");

const SEED = 20260929;

function ctx(toolName: string, signal = new AbortController().signal) {
  return {
    abortSignal: signal,
    callId: "walk-bound",
    toolName,
  } as unknown as ToolContext;
}

// n файлов по 10 каталогам, строка-метка в каждом седьмом: метки есть в каждом каталоге.
function tree(n: number): string {
  const root = mkdtempSync(join(tmpdir(), "iva-walk-bound-"));
  for (let d = 0; d < 10; d++) mkdirSync(join(root, `d${d}`));
  for (let i = 0; i < n; i++)
    writeFileSync(
      join(root, `d${i % 10}`, `f${i}.md`),
      i % 7 ? "x\n" : "218e69\n",
    );
  return root;
}

// Каждое обращение к часам сдвигает их на step мс: срок 20 с наступает через 20000/step
// обращений на любой машине.
function tickingClock(step: number): void {
  let now = 1_800_000_000_000;
  mock.method(Date, "now", () => (now += step));
}

type GrepOut = { count: number; truncated: boolean; hint?: string };

test("grep по дереву в 3000 файлов упирается в срок и отдаёт найденное с подсказкой", async () => {
  const root = tree(3000);
  tickingClock(10);
  try {
    const out = settled(
      await grepTool.execute({ pattern: "218e69", path: root }, ctx("grep")),
    ) as GrepOut;
    assert.equal(typeof WALK_HINT, "string");
    assert.equal(out.truncated, true);
    assert.equal(out.hint, WALK_HINT);
    // Совпадений в дереве 429: найденное до срока отдано, до конца обход не дошёл.
    assert.ok(out.count > 0, "найденное до срока потеряно");
    assert.ok(out.count < 429, `прочитаны все файлы: ${out.count}`);
  } finally {
    mock.restoreAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("glob по дереву в 3000 файлов упирается в срок и последней строкой просит сузить путь", async () => {
  const root = tree(3000);
  tickingClock(10);
  try {
    const out = settled(
      await globTool.execute({ pattern: "**/f??.md", cwd: root }, ctx("glob")),
    );
    assert.equal(out.at(-1), `… ${WALK_HINT}`);
    // Двузначных имён f10…f99 в дереве 90, по всем каталогам.
    const paths = out.slice(0, -1);
    assert.ok(paths.length > 0, "найденное до срока потеряно");
    assert.ok(paths.length < 90, `обход дошёл до конца: ${paths.length}`);
  } finally {
    mock.restoreAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("снятый ход останавливает обход grep", async () => {
  const root = tree(200);
  const controller = new AbortController();
  controller.abort();
  try {
    const out = settled(
      await grepTool.execute(
        { pattern: "218e69", path: root },
        ctx("grep", controller.signal),
      ),
    ) as GrepOut;
    assert.equal(out.truncated, true);
    assert.equal(out.count, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("node_modules, .git и карантины *.trash-* пропускаются, если путь не указывает внутрь", async () => {
  const root = mkdtempSync(join(tmpdir(), "iva-walk-skip-"));
  const quarantine = "notes.trash-20260929T035900";
  const trash = join(root, quarantine);
  for (const dir of ["node_modules/pkg", ".git/objects", quarantine, "notes"])
    mkdirSync(join(root, dir), { recursive: true });
  for (const file of [
    "node_modules/pkg/a.md",
    ".git/objects/b.md",
    `${quarantine}/c.md`,
    "notes/d.md",
  ])
    writeFileSync(join(root, file), "x");
  try {
    const all = (await walkFiles(root)).map((f) => relative(root, f));
    assert.deepEqual(all, ["notes/d.md"]);
    const inside = (await walkFiles(trash)).map((f) => relative(root, f));
    assert.deepEqual(inside, [`${quarantine}/c.md`]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(`обход не просматривает больше границы файлов, truncated ровно при n > границы (seed ${SEED})`, async () => {
  mock.method(Date, "now", () => 1_800_000_000_000);
  try {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 120 }),
        fc.integer({ min: 1, max: 100 }),
        async (n, maxFiles) => {
          const root = tree(n);
          try {
            const bound = walkBound(undefined, maxFiles);
            const files = await walkFiles(root, bound);
            assert.equal(files.length, Math.min(n, maxFiles));
            assert.equal(bound.truncated, n > maxFiles);
          } finally {
            rmSync(root, { recursive: true, force: true });
          }
        },
      ),
      { seed: SEED, numRuns: 40 },
    );
  } finally {
    mock.restoreAll();
  }
});
