// Зрение тратит токены провайдера мимо шага хода. Описание картинки vision-моделью
// OpenAI-совместимого провайдера обязано оставить строку source=vision с usage из ответа.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MODEL_PROVIDER = "ollama";
process.env.OLLAMA_API_KEY = "test-key";
process.env.OLLAMA_BASE_URL = "https://vision.invalid/v1";
process.env.OLLAMA_VISION_MODEL = "gemma4:31b";
const { describeImage } = await import("./vision.ts");

await test("описание картинки пишет строку source=vision с расходом провайдера", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "iva-vision-usage-"));
  const previousDir = process.env.ASSISTANT_DATA_DIR;
  const previousFetch = globalThis.fetch;
  process.env.ASSISTANT_DATA_DIR = dir;
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousDir === undefined) delete process.env.ASSISTANT_DATA_DIR;
    else process.env.ASSISTANT_DATA_DIR = previousDir;
    rmSync(dir, { recursive: true, force: true });
  });
  globalThis.fetch = () =>
    Promise.resolve(
      Response.json({
        choices: [{ message: { content: "красный квадрат" } }],
        usage: {
          prompt_tokens: 1450,
          completion_tokens: 60,
          prompt_tokens_details: { cached_tokens: 200 },
        },
      }),
    );

  const text = await describeImage(new ArrayBuffer(8), "image/png");

  assert.equal(text, "красный квадрат");
  const rows = readFileSync(join(dir, "usage.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.source, "vision");
  assert.equal(row.provider, "ollama");
  assert.equal(row.model, "gemma4:31b");
  assert.deepEqual(
    [row.in, row.out, row.cacheRead, row.cacheWrite, row.total],
    [1450, 60, 200, 0, 1510],
  );
});

await test("сбой записи учёта не отнимает у пользователя описание картинки", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "iva-vision-usage-"));
  const previousDir = process.env.ASSISTANT_DATA_DIR;
  const previousFetch = globalThis.fetch;
  const previousError = console.error;
  process.env.ASSISTANT_DATA_DIR = dir;
  console.error = () => undefined;
  t.after(() => {
    globalThis.fetch = previousFetch;
    console.error = previousError;
    if (previousDir === undefined) delete process.env.ASSISTANT_DATA_DIR;
    else process.env.ASSISTANT_DATA_DIR = previousDir;
    rmSync(dir, { recursive: true, force: true });
  });
  // Каталог на месте файла лога: дозапись упадёт с EISDIR.
  mkdirSync(join(dir, "usage.jsonl"));
  globalThis.fetch = () =>
    Promise.resolve(
      Response.json({
        choices: [{ message: { content: "синий круг" } }],
        usage: { prompt_tokens: 900, completion_tokens: 30 },
      }),
    );

  assert.equal(
    await describeImage(new ArrayBuffer(8), "image/png"),
    "синий круг",
  );
});
