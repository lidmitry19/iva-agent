import assert from "node:assert/strict";
import test from "node:test";

type CapturedRequest = {
  url: string;
  body: Record<string, unknown>;
};

function parseRequestBody(body: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(body);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new TypeError("Expected a JSON object request body");
  return Object.fromEntries(Object.entries(parsed));
}

function captureRequest(
  url: URL | RequestInfo,
  options?: RequestInit,
): CapturedRequest {
  const body = options?.body;
  if (typeof body !== "string")
    throw new TypeError("Expected a JSON request body");
  const requestUrl =
    typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
  return { url: requestUrl, body: parseRequestBody(body) };
}

void test("telegram-send loads under bare Node and redacts outbound secrets", async (t) => {
  const originalFetch = globalThis.fetch;
  const requests: CapturedRequest[] = [];
  globalThis.fetch = (url: URL | RequestInfo, options?: RequestInit) => {
    requests.push(captureRequest(url, options));
    return Promise.resolve(new Response("", { status: 200 }));
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { sendTelegramHtml } = await import("./telegram-send.ts");
  const result = await sendTelegramHtml(
    "test-bot",
    "test-chat",
    `api_key=${"x".repeat(24)}`,
  );

  assert.deepEqual(result, { ok: true, fellBack: false, error: "" });
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    "https://api.telegram.org/bottest-bot/sendMessage",
  );
  assert.equal(requests[0].body.chat_id, "test-chat");
  assert.equal(requests[0].body.text, "[REDACTED]");
});

void test("telegram-send keeps redaction when retrying a rejected HTML message", async (t) => {
  const originalFetch = globalThis.fetch;
  const requests: CapturedRequest[] = [];
  globalThis.fetch = (url: URL | RequestInfo, options?: RequestInit) => {
    requests.push(captureRequest(url, options));
    const status = requests.length === 1 ? 400 : 200;
    return Promise.resolve(
      new Response(status === 400 ? "bad entities" : "", { status }),
    );
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { sendTelegramHtml } = await import("./telegram-send.ts");
  const result = await sendTelegramHtml(
    "test-bot",
    "test-chat",
    `api_key=${"x".repeat(24)}`,
  );

  assert.deepEqual(result, { ok: true, fellBack: true, error: "" });
  assert.equal(requests.length, 2);
  assert.equal(
    requests[1].url,
    "https://api.telegram.org/bottest-bot/sendMessage",
  );
  assert.equal(requests[1].body.chat_id, "test-chat");
  assert.equal(requests[1].body.text, "[REDACTED]");
  assert.equal("parse_mode" in requests[1].body, false);
});

void test("the Bot API base is api.telegram.org unless TELEGRAM_API_BASE says otherwise", async () => {
  const { telegramApiBase } = await import("./telegram-send.ts");

  assert.equal(telegramApiBase({}), "https://api.telegram.org");
  assert.equal(
    telegramApiBase({ TELEGRAM_API_BASE: "http://127.0.0.1:8081" }),
    "http://127.0.0.1:8081",
  );
  assert.equal(
    telegramApiBase({ TELEGRAM_API_BASE: "  http://127.0.0.1:8081  " }),
    "http://127.0.0.1:8081",
  );
  assert.equal(
    telegramApiBase({ TELEGRAM_API_BASE: "http://127.0.0.1:8081///" }),
    "http://127.0.0.1:8081",
  );
  assert.equal(
    telegramApiBase({ TELEGRAM_API_BASE: "https://tg.example.com/proxy/" }),
    "https://tg.example.com/proxy",
  );
});

void test("junk in TELEGRAM_API_BASE falls back to the production base", async (t) => {
  const { telegramApiBase } = await import("./telegram-send.ts");
  const errors: unknown[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]): void => {
    errors.push(args[0]);
  };
  t.after(() => {
    console.error = originalError;
  });

  for (const value of [
    "",
    "   ",
    "api.telegram.org",
    "ftp://api.telegram.org",
    "javascript:alert(1)",
    "//api.telegram.org",
    "http://",
  ]) {
    assert.equal(
      telegramApiBase({ TELEGRAM_API_BASE: value }),
      "https://api.telegram.org",
      `base for ${JSON.stringify(value)}`,
    );
  }
  // Пустая строка молчит (переменной просто нет), остальной мусор обязан быть виден.
  assert.equal(errors.length, 5);
});

void test("telegram-send sends to the overridden Bot API base", async (t) => {
  const previousBase = process.env.TELEGRAM_API_BASE;
  const originalFetch = globalThis.fetch;
  const requests: CapturedRequest[] = [];
  globalThis.fetch = (url: URL | RequestInfo, options?: RequestInit) => {
    requests.push(captureRequest(url, options));
    return Promise.resolve(new Response("", { status: 200 }));
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (previousBase === undefined) delete process.env.TELEGRAM_API_BASE;
    else process.env.TELEGRAM_API_BASE = previousBase;
  });

  const { sendTelegramHtml } = await import("./telegram-send.ts");

  process.env.TELEGRAM_API_BASE = "http://127.0.0.1:8081/";
  assert.deepEqual(await sendTelegramHtml("test-bot", "555", "привет"), {
    ok: true,
    fellBack: false,
    error: "",
  });

  delete process.env.TELEGRAM_API_BASE;
  assert.deepEqual(await sendTelegramHtml("test-bot", "555", "привет"), {
    ok: true,
    fellBack: false,
    error: "",
  });

  assert.deepEqual(
    requests.map((request) => request.url),
    [
      "http://127.0.0.1:8081/bottest-bot/sendMessage",
      "https://api.telegram.org/bottest-bot/sendMessage",
    ],
  );
  // База читается на каждой отправке: процесс-долгожитель (мост) не обязан перезапускаться.
  assert.deepEqual(
    requests.map((request) => request.body.chat_id),
    ["555", "555"],
  );
});
