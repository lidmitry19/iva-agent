// Пробник «видит ли модель чата картинки». Сеть в него приходит аргументом, поэтому
// решение, кэш и пауза после сбоя проверяются без единого запроса.
import test from "node:test";
import assert from "node:assert/strict";
import { APICallError } from "ai";

// codex-ветка chatModelSeesImages отвечает без сети — на нём и проверяем её.
process.env.MODEL_PROVIDER = "codex";
const { chatModelSeesImages, makeVisionProbe } = await import("./vision.ts");

type Answer = Awaited<ReturnType<Parameters<typeof makeVisionProbe>[0]>>;

const answer = (text: string, finishReason = "stop"): Promise<Answer> =>
  Promise.resolve({ text, finishReason });

// Пауза после транзиентного сбоя — минута; тесты двигают часы сами.
const AFTER_COOLDOWN = 60_001;

function muteErrors(t: { after: (fn: () => void) => void }): string[] {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  t.after(() => {
    console.error = original;
  });
  return lines;
}

function apiError(statusCode: number): APICallError {
  return new APICallError({
    message: "this model does not support image input",
    url: "https://example.invalid/v1/chat/completions",
    requestBodyValues: {},
    statusCode,
  });
}

/** Пробник на очереди исходов и на управляемых часах. */
function probeOver(
  outcomes: (() => Promise<Answer>)[],
  model = "glm-5.3-flash",
) {
  const state = { calls: 0, clock: 0 };
  const probe = makeVisionProbe(
    () => {
      const next = outcomes[state.calls];
      state.calls += 1;
      return next();
    },
    () => model,
    () => state.clock,
  );
  return { probe, state };
}

await test("модель назвала цвет квадрата = видит картинки, и второй раз не спрашиваем", async (t) => {
  const logs = muteErrors(t);
  const { probe, state } = probeOver([() => answer("Red.")]);

  assert.equal(await probe(), true);
  assert.equal(await probe(), true);
  assert.equal(state.calls, 1);
  assert.deepEqual(
    logs.filter((line) => line.includes("sees images")),
    ["[vision] chat model glm-5.3-flash sees images: true"],
  );
});

// «a valid image is required» несёт red подстрокой: по includes слепая модель объявила бы
// себя зрячей, и картинки уходили бы в пустоту.
await test("red только словом: «required» в ответе — не цвет", async (t) => {
  muteErrors(t);
  const { probe, state } = probeOver([
    () => answer("Error: a valid image is required."),
  ]);

  assert.equal(await probe(), false);
  assert.equal(await probe(), false);
  assert.equal(state.calls, 1, "вердикт по содержимому кэшируется");
});

await test("400 от провайдера = не видит, и это тоже помним", async (t) => {
  const logs = muteErrors(t);
  const { probe, state } = probeOver(
    [() => Promise.reject(apiError(400))],
    "deepseek-v4-pro",
  );

  assert.equal(await probe(), false);
  assert.equal(await probe(), false);
  assert.equal(state.calls, 1);
  assert.ok(
    logs.some((line) =>
      line.includes("[vision] chat model deepseek-v4-pro sees images: false"),
    ),
  );

  // 415 и 422 говорят ровно о том же: картинку как таковую не приняли.
  for (const status of [415, 422]) {
    const strict = probeOver([() => Promise.reject(apiError(status))]);
    assert.equal(await strict.probe(), false);
    assert.equal(await strict.probe(), false);
    assert.equal(strict.state.calls, 1, `статус ${status} обязан кэшироваться`);
  }
});

// 429 — это лимит провайдера, а не приговор модели: закэшируй его, и зрение чата
// выключится до перезапуска процесса из-за одной перегрузки. То же у 401/403/404/408.
await test("429 и прочие 4xx не про модель: кэша нет, попытка повторяется после паузы", async (t) => {
  const logs = muteErrors(t);
  const statuses = [429, 401, 403, 404, 408];
  const { probe, state } = probeOver([
    ...statuses.map((status) => () => Promise.reject(apiError(status))),
    () => answer("Red."),
  ]);

  for (let attempt = 0; attempt < statuses.length; attempt += 1) {
    assert.equal(await probe(), false);
    state.clock += AFTER_COOLDOWN;
  }
  assert.equal(await probe(), true);
  assert.equal(await probe(), true);
  assert.equal(
    state.calls,
    statuses.length + 1,
    "после успеха вердикт закэширован",
  );
  assert.equal(
    logs.filter((line) => line.includes("пробник не дал ответа")).length,
    statuses.length,
  );
});

await test("сбой сети и 5xx не запоминаются: следующая попытка идёт заново", async (t) => {
  const logs = muteErrors(t);
  const { probe, state } = probeOver([
    () => Promise.reject(new TypeError("fetch failed")),
    () => Promise.reject(apiError(503)),
    () => answer("Red."),
  ]);

  assert.equal(await probe(), false);
  state.clock += AFTER_COOLDOWN;
  assert.equal(await probe(), false);
  state.clock += AFTER_COOLDOWN;
  assert.equal(await probe(), true);
  assert.equal(await probe(), true);
  assert.equal(state.calls, 3, "после успеха вердикт закэширован");
  assert.equal(
    logs.filter((line) => line.includes("пробник не дал ответа")).length,
    2,
  );
});

// Без паузы каждый шаг tool-loop платил бы за новый поход к молчащему провайдеру: до
// тридцати секунд на шаг, и так до конца хода.
await test("после сбоя пробник не ходит в сеть, пока не пройдёт пауза", async (t) => {
  muteErrors(t);
  const { probe, state } = probeOver([
    () => Promise.reject(new TypeError("fetch failed")),
    () => answer("Red."),
  ]);

  assert.equal(await probe(), false);
  assert.equal(state.calls, 1);

  assert.equal(await probe(), false, "внутри паузы ответ тот же");
  assert.equal(await probe(), false);
  assert.equal(state.calls, 1, "в сеть не ходили");

  state.clock += AFTER_COOLDOWN;
  assert.equal(await probe(), true);
  assert.equal(state.calls, 2);
});

// Шлюз может молча выбросить картинку из тела и ответить 200 по одному тексту. Ответ без
// цвета — тот же «не видит», и это свойство пути, а не сети: помним.
await test("200 без цвета = не видит, и это помним", async (t) => {
  const logs = muteErrors(t);
  const { probe, state } = probeOver(
    [() => answer("I can't see images, please describe it.")],
    "gpt-5.6-luna",
  );

  assert.equal(await probe(), false);
  assert.equal(await probe(), false);
  assert.equal(state.calls, 1);
  assert.ok(
    logs.some((line) =>
      line.includes("[vision] chat model gpt-5.6-luna sees images: false"),
    ),
  );
});

// Думающая модель тратит потолок на reasoning и до ответа не доходит. Пустой текст с
// finishReason "length" — про потолок, а не про зрение.
await test("ответ, упёршийся в потолок токенов, не выносит вердикта", async (t) => {
  const logs = muteErrors(t);
  const { probe, state } = probeOver([
    () => answer("", "length"),
    () => answer("Red"),
  ]);

  assert.equal(await probe(), false);
  assert.equal(state.calls, 1);
  assert.ok(logs.some((line) => line.includes("упёрся в потолок токенов")));
  assert.equal(
    logs.filter((line) => line.includes("sees images")).length,
    0,
    "вердикта нет — и строки о нём нет",
  );

  state.clock += AFTER_COOLDOWN;
  assert.equal(await probe(), true);
  assert.equal(state.calls, 2);
});

await test("обрыв по таймауту не запоминается", async (t) => {
  const logs = muteErrors(t);
  const { probe, state } = probeOver([
    () => Promise.reject(new DOMException("signal timed out", "TimeoutError")),
    () => Promise.reject(new DOMException("aborted", "AbortError")),
    () => answer("Red"),
  ]);

  assert.equal(await probe(), false);
  state.clock += AFTER_COOLDOWN;
  assert.equal(await probe(), false);
  state.clock += AFTER_COOLDOWN;
  assert.equal(await probe(), true);
  assert.equal(state.calls, 3);
  assert.equal(
    logs.filter((line) => line.includes("пробник не дал ответа")).length,
    2,
  );
});

// Спросить могут одновременно: ходы разных чатов идут параллельно, и шаги tool-loop тоже.
await test("одновременные вопросы будят пробник один раз", async (t) => {
  muteErrors(t);
  let calls = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const probe = makeVisionProbe(
    async () => {
      calls += 1;
      await gate;
      return { text: "Red", finishReason: "stop" };
    },
    () => "glm-5.3-flash",
  );

  const both = Promise.all([probe(), probe()]);
  release?.();
  assert.deepEqual(await both, [true, true]);
  assert.equal(calls, 1);
});

await test("codex отвечает да без единого запроса", async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("пробник не должен ходить в сеть на codex");
  };
  t.after(() => {
    globalThis.fetch = original;
  });

  assert.equal(await chatModelSeesImages(), true);
});
