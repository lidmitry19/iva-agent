/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- legacy Node test registration and dynamic JavaScript bridge fixtures */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readlinkSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MODEL_PROVIDER_NAMES } from "#lib/model-provider.ts";
import {
  CONTEXT_WINDOW_CONFIGURATION_ERROR,
  ContextWindowConfigurationError,
} from "../../agent/lib/context-window.ts";
import { SUMMARY_PROVIDER_NAMES, modelSummary } from "./model-summary.ts";
import { createTerminalProgress } from "./progress.ts";
import {
  createTelegramUpdateReporter,
  UPDATE_LOADER,
} from "./telegram-status.ts";
import { REPAIR_COMMAND } from "./update-check.ts";
import {
  acquireUpdateLock,
  createUpdateTransaction,
  releaseUpdateLock,
} from "./update-safety.ts";

type TelegramBody = {
  message_id?: number;
  text?: string;
  entities?: { custom_emoji_id?: string }[];
  reply_markup?: {
    inline_keyboard: { text?: string; callback_data: string }[][];
  };
};
type TelegramCall = { method: string | undefined; body: TelegramBody };
type MockResponse = {
  ok: boolean;
  status: number;
  json(): Promise<{
    ok?: boolean;
    result?: unknown;
    description?: string;
    parameters?: { retry_after?: number };
  }>;
};
type MockFetch = (url: string, init: { body: string }) => Promise<MockResponse>;
const mutableGlobal = globalThis as unknown as { fetch: MockFetch };

test("modelSummary uses configured provider values without runtime defaults", () => {
  assert.deepEqual(
    modelSummary({
      MODEL_PROVIDER: "codex",
      CODEX_MODEL: "gpt-5.5",
      CODEX_CONTEXT_WINDOW: "272000",
    }),
    {
      provider: "OpenAI",
      model: "gpt-5.5",
      contextWindow: 272000,
      line: "OpenAI · gpt-5.5",
    },
  );
});

test("modelSummary uses the exact context-window resolver", () => {
  const cases = [
    ["ollama", "OLLAMA_CONTEXT_WINDOW"],
    ["opencode", "OPENCODE_CONTEXT_WINDOW"],
    ["openrouter", "OPENROUTER_CONTEXT_WINDOW"],
    ["codex", "CODEX_CONTEXT_WINDOW"],
  ] as const;

  for (const [provider, variable] of cases) {
    assert.equal(
      modelSummary({ MODEL_PROVIDER: provider }).contextWindow,
      null,
    );
    assert.equal(
      modelSummary({ MODEL_PROVIDER: provider, [variable]: "1" }).contextWindow,
      1,
    );
    for (const raw of ["1.5", "1e3", " ", "9007199254740990.5"]) {
      assert.throws(
        () => modelSummary({ MODEL_PROVIDER: provider, [variable]: raw }),
        (error: unknown) => {
          assert.ok(error instanceof ContextWindowConfigurationError);
          assert.equal(error.code, CONTEXT_WINDOW_CONFIGURATION_ERROR);
          assert.equal(error.variable, variable);
          assert.equal(error.value, raw);
          return true;
        },
        `${provider}:${JSON.stringify(raw)}`,
      );
    }
  }
});

// Экран обновления показывает эту строку рядом с версией. Знай он свой набор имён —
// после опечатки он спокойно назвал бы Ollama, пока агент отказывается стартовать.
// Сверка идёт в ОБЕ стороны: лишний ключ здесь так же врёт, как недостающий.
test("modelSummary knows exactly the provider names the runtime accepts", () => {
  assert.deepEqual(
    [...SUMMARY_PROVIDER_NAMES].sort(),
    [...MODEL_PROVIDER_NAMES].sort(),
  );
  for (const name of MODEL_PROVIDER_NAMES) {
    assert.doesNotMatch(
      modelSummary({ MODEL_PROVIDER: name }).line,
      /invalid/,
      name,
    );
  }
  for (const value of ["ollmaa", " ollama", "OLLAMA", ""]) {
    assert.equal(
      modelSummary({ MODEL_PROVIDER: value }).line,
      `invalid (${value}) · ?`,
      JSON.stringify(value),
    );
  }
  // Отсутствие переменной — по-прежнему Ollama, а не отказ.
  assert.equal(modelSummary({}).provider, "Ollama");
});

test("terminal progress is deterministic outside a TTY", () => {
  let output = "";
  const stream = {
    isTTY: false,
    write: (chunk: string) => {
      output += chunk;
    },
  };
  const progress = createTerminalProgress({ stream, env: {} });
  progress.start("Saving changes");
  progress.done("Changes saved");
  progress.dispose();
  assert.equal(output, "◇ Saving changes\n✓ Changes saved\n");
});

test("terminal progress restores the cursor when disposed", () => {
  let output = "";
  const stream = {
    isTTY: true,
    write: (chunk: string) => {
      output += chunk;
    },
  };
  const progress = createTerminalProgress({
    stream,
    env: { TERM: "xterm" },
    intervalMs: 60_000,
  });
  progress.start("Building");
  progress.dispose();
  // eslint-disable-next-line no-control-regex -- The assertion verifies the ANSI hide-cursor sequence.
  assert.match(output, /\x1b\[\?25l/);
  // eslint-disable-next-line no-control-regex -- The assertion verifies the ANSI show-cursor sequence.
  assert.match(output, /\x1b\[\?25h/);
});

test("Telegram update edits one message through every phase and final result", async () => {
  const calls: TelegramCall[] = [];
  const fetchImpl: MockFetch = async (url, init) => {
    const method = url.split("/").at(-1);
    const body = JSON.parse(init.body);
    calls.push({ method, body });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: {} }),
    };
  };
  const reporter = createTelegramUpdateReporter({
    token: "token",
    job: { chatId: 1, messageId: 100, locale: "ru" },
    env: { MODEL_PROVIDER: "codex", CODEX_MODEL: "gpt-5.5" },
    fetchImpl,
  });
  assert.ok(reporter);
  await reporter.start("protect");
  await reporter.done("protect");
  await reporter.start("fetch");
  await reporter.done("fetch");
  await reporter.start("build");
  await reporter.done("build");
  await reporter.complete({
    beforeVersion: "v1",
    afterVersion: "v2",
    changedLocal: true,
  });
  reporter.dispose();

  assert.equal(calls.filter((call) => call.method === "sendMessage").length, 0);
  const edits = calls.filter((call) => call.method === "editMessageText");
  assert.equal(edits.length, 4);
  assert.deepEqual(
    edits.map((call) => call.body.message_id),
    [100, 100, 100, 100],
  );
  assert.deepEqual(
    edits.slice(0, 3).map((call) => call.body.entities?.[0]?.custom_emoji_id),
    [
      UPDATE_LOADER.customEmojiId,
      UPDATE_LOADER.customEmojiId,
      UPDATE_LOADER.customEmojiId,
    ],
  );
  assert.deepEqual(
    edits.slice(0, 3).map((call) => call.body.text),
    [
      `${UPDATE_LOADER.alt} Сохраняю ваши изменения`,
      `${UPDATE_LOADER.alt} Получаю обновление`,
      `${UPDATE_LOADER.alt} Собираю Iva`,
    ],
  );
  assert.match(edits[3]?.body.text ?? "", /Iva обновлена/);
  assert.match(edits[3]?.body.text ?? "", /OpenAI · gpt-5.5/);
  assert.equal(edits[3].body.entities, undefined);
});

test("Telegram reports a successful core update when local files conflict", async () => {
  const calls: TelegramCall[] = [];
  const fetchImpl: MockFetch = async (url, init) => {
    calls.push({ method: url.split("/").at(-1), body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: {} }),
    };
  };
  const reporter = createTelegramUpdateReporter({
    token: "token",
    job: { chatId: 1, messageId: 100, locale: "ru" },
    fetchImpl,
  });
  assert.ok(reporter);
  await reporter.complete({
    beforeVersion: "v0.3.13",
    afterVersion: "v0.3.13",
    changedLocal: true,
    restoreReport: {
      status: "conflicted",
      stashOid: "abc",
      recoveryDir:
        "/srv/iva/data/update-conflicts/2026-08-06T12-00-00-000Z-deadbeef1234",
      conflicts: [
        {
          path: "docs/index.html",
          baseMode: "100644",
          localMode: "100644",
          upstreamMode: "100644",
        },
        {
          path: "docs/ru/index.html",
          baseMode: "100644",
          localMode: "100644",
          upstreamMode: "100644",
        },
      ],
    },
  });

  const final = calls.at(-1)?.body;
  assert.match(final?.text ?? "", /✅ Iva обновлена/);
  assert.match(final?.text ?? "", /Новое ядро активно/);
  assert.doesNotMatch(final?.text ?? "", /Не удалось собрать/);
  assert.equal(
    final?.reply_markup?.inline_keyboard[0]?.[0]?.callback_data,
    "iva_update:conflicts:2026-08-06T12-00-00-000Z-deadbeef1234",
  );
});

test("Telegram omits an oversized recovery callback", async () => {
  const calls: TelegramCall[] = [];
  const fetchImpl: MockFetch = async (url, init) => {
    calls.push({ method: url.split("/").at(-1), body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: {} }),
    };
  };
  const reporter = createTelegramUpdateReporter({
    token: "token",
    job: { chatId: 1, messageId: 100, locale: "en" },
    fetchImpl,
  });
  assert.ok(reporter);
  await reporter.complete({
    beforeVersion: "v0.3.13",
    afterVersion: "v0.3.13",
    changedLocal: true,
    restoreReport: {
      status: "preserved",
      stashOid: "abc",
      recoveryDir: `/srv/iva/data/update-conflicts/${"x".repeat(64)}`,
      conflicts: [],
    },
  });

  const final = calls.at(-1)?.body;
  assert.match(final?.text ?? "", /Iva updated/);
  assert.equal(final?.reply_markup, undefined);
});

test("Telegram does not recreate phase messages after the active message was deleted", async () => {
  const calls: TelegramCall[] = [];
  const fetchImpl: MockFetch = async (url, init) => {
    const method = url.split("/").at(-1);
    calls.push({ method, body: JSON.parse(init.body) });
    if (method === "editMessageText") {
      return {
        ok: false,
        status: 400,
        json: async () => ({
          ok: false,
          description: "Bad Request: message to edit not found",
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 200 } }),
    };
  };
  const reporter = createTelegramUpdateReporter({
    token: "token",
    job: { chatId: 1, messageId: 100, locale: "en" },
    env: { MODEL_PROVIDER: "codex", CODEX_MODEL: "gpt-5.5" },
    fetchImpl,
  });
  assert.ok(reporter);
  await reporter.start("protect");
  await reporter.start("fetch");
  await reporter.start("build");
  await reporter.complete({ beforeVersion: "v1", afterVersion: "v2" });
  reporter.dispose();
  assert.equal(
    calls.filter((call) => call.method === "sendMessage").length,
    1,
    "only the final result is recreated",
  );
});

test("Telegram retries 429 without downgrading the custom emoji and deduplicates phase edits", async () => {
  const calls: TelegramCall[] = [];
  let first = true;
  const fetchImpl: MockFetch = async (url, init) => {
    calls.push({ method: url.split("/").at(-1), body: JSON.parse(init.body) });
    if (first) {
      first = false;
      return {
        ok: false,
        status: 429,
        json: async () => ({ ok: false, parameters: { retry_after: 1 } }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: {} }),
    };
  };
  const reporter = createTelegramUpdateReporter({
    token: "token",
    job: { chatId: 1, messageId: 100, locale: "ru" },
    env: {},
    fetchImpl,
    sleepImpl: async () => {},
  });
  assert.ok(reporter);
  await reporter.start("protect");
  await reporter.start("protect");
  await reporter.done("protect");
  await reporter.done("protect");
  reporter.dispose();
  assert.equal(calls.length, 2, "one retry and no duplicate edit");
  assert.ok(
    calls.every(
      (call) =>
        call.body.entities?.[0].custom_emoji_id === UPDATE_LOADER.customEmojiId,
    ),
  );
});

test("Telegram falls back to a simple Unicode marker when custom emoji is unavailable", async () => {
  const calls: TelegramCall[] = [];
  const fetchImpl: MockFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ method: url.split("/").at(-1), body });
    if (body.entities) {
      return {
        ok: false,
        status: 400,
        json: async () => ({
          ok: false,
          description: "Bad Request: custom emoji entities are not allowed",
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: {} }),
    };
  };
  const reporter = createTelegramUpdateReporter({
    token: "token",
    job: { chatId: 1, messageId: 100, locale: "en" },
    env: {},
    fetchImpl,
  });
  assert.ok(reporter);
  await reporter.start("protect");
  await reporter.start("fetch");
  reporter.dispose();

  assert.equal(calls.length, 3);
  assert.ok(calls[0].body.entities);
  assert.equal(
    calls[1].body.text,
    `${UPDATE_LOADER.fallback} Saving your changes`,
  );
  assert.equal(
    calls[2].body.text,
    `${UPDATE_LOADER.fallback} Getting the update`,
  );
  assert.equal(calls[1].body.entities, undefined);
  assert.equal(calls[2].body.entities, undefined);
});

test("Telegram preserves error-like status when selecting the custom emoji fallback", async () => {
  const calls: TelegramCall[] = [];
  const telegramError = {
    message: "Bad Request: custom emoji entities are not allowed",
    status: 400,
  };
  const fetchImpl: MockFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ method: url.split("/").at(-1), body });
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- Telegram adapters may reject with a structural API error instead of an Error instance
    if (body.entities) throw telegramError;
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: {} }),
    };
  };
  const reporter = createTelegramUpdateReporter({
    token: "token",
    job: { chatId: 1, messageId: 100, locale: "en" },
    env: {},
    fetchImpl,
    sleepImpl: async () => {},
  });
  assert.ok(reporter);
  await reporter.start("protect");
  reporter.dispose();

  assert.equal(calls.length, 4);
  assert.ok(calls.slice(0, 3).every((call) => call.body.entities));
  assert.equal(calls[3].body.entities, undefined);
  assert.equal(
    calls[3].body.text,
    `${UPDATE_LOADER.fallback} Saving your changes`,
  );
});

test("Telegram update failure replaces the active phase in the same message", async () => {
  const calls: TelegramCall[] = [];
  const fetchImpl: MockFetch = async (url, init) => {
    calls.push({ method: url.split("/").at(-1), body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: {} }),
    };
  };
  const reporter = createTelegramUpdateReporter({
    token: "token",
    job: { chatId: 1, messageId: 100, locale: "en" },
    env: {},
    fetchImpl,
  });
  assert.ok(reporter);
  await reporter.start("fetch");
  await reporter.fail("fetch", "v1");
  reporter.dispose();

  assert.equal(calls.filter((call) => call.method === "sendMessage").length, 0);
  assert.deepEqual(
    calls.map((call) => call.body.message_id),
    [100, 100],
  );
  assert.match(calls[1]?.body.text ?? "", /Couldn't get the update/);
  assert.match(calls[1]?.body.text ?? "", /still running v1/);
});

test("Telegram says an update is already running in the message it was asked from", async () => {
  const calls: TelegramCall[] = [];
  const fetchImpl: MockFetch = async (url, init) => {
    calls.push({ method: url.split("/").at(-1), body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: {} }),
    };
  };
  const reporter = createTelegramUpdateReporter({
    token: "token",
    job: { chatId: 1, messageId: 100, locale: "ru" },
    env: {},
    fetchImpl,
  });
  assert.ok(reporter);
  await reporter.start("fetch");
  await reporter.busy();
  reporter.dispose();

  assert.deepEqual(
    calls.map((call) => call.body.message_id),
    [100, 100],
  );
  assert.match(calls[1]?.body.text ?? "", /Обновление уже идёт/u);
});

test("a final Telegram refuses to edit is sent as its own message", async (t) => {
  const errors: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) =>
    errors.push(args.map(String).join(" ")),
  );
  const calls: TelegramCall[] = [];
  // Neither a deleted message nor a rate limit: a refusal this side has never
  // seen, which used to end the update with the phase still on screen.
  const fetchImpl: MockFetch = async (url, init) => {
    const method = url.split("/").at(-1);
    calls.push({ method, body: JSON.parse(init.body) });
    if (method === "editMessageText")
      return {
        ok: false,
        status: 400,
        json: async () => ({ ok: false, description: "Bad Request: FROZEN" }),
      };
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 200 } }),
    };
  };
  const reporter = createTelegramUpdateReporter({
    token: "token",
    job: { chatId: 1, messageId: 100, locale: "en" },
    env: {},
    fetchImpl,
  });
  assert.ok(reporter);

  assert.equal(
    await reporter.complete({ beforeVersion: "v1", afterVersion: "v2" }),
    true,
  );

  const sent = calls.filter((call) => call.method === "sendMessage");
  assert.equal(sent.length, 1, "the user is told the update finished");
  assert.match(sent[0]?.body.text ?? "", /Iva updated/);
  assert.match(sent[0]?.body.text ?? "", /v1 → v2/);
  assert.ok(
    errors.some((line) =>
      /update status edit failed: 400 .*FROZEN/u.test(line),
    ),
    errors.join("\n"),
  );
});

test("a final that cannot be delivered at all is reported, not swallowed", async (t) => {
  const errors: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) =>
    errors.push(args.map(String).join(" ")),
  );
  const fetchImpl: MockFetch = async () => ({
    ok: false,
    status: 403,
    json: async () => ({
      ok: false,
      description: "Forbidden: bot was blocked",
    }),
  });
  const reporter = createTelegramUpdateReporter({
    token: "token",
    job: { chatId: 1, messageId: 100, locale: "en" },
    env: {},
    fetchImpl,
  });
  assert.ok(reporter);

  assert.equal(await reporter.complete({ afterVersion: "v2" }), false);

  assert.equal(errors.length, 2, errors.join("\n"));
  assert.match(errors[0], /update status edit failed: 403/u);
  assert.match(errors[1], /update status message failed: 403/u);
});

test("a version reported without the one before it names the version that runs", async () => {
  const calls: TelegramCall[] = [];
  const fetchImpl: MockFetch = async (url, init) => {
    calls.push({ method: url.split("/").at(-1), body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: {} }),
    };
  };
  const reporter = createTelegramUpdateReporter({
    token: "token",
    job: { chatId: 1, messageId: 100, locale: "ru" },
    env: { MODEL_PROVIDER: "codex", CODEX_MODEL: "gpt-5.5" },
    fetchImpl,
  });
  assert.ok(reporter);

  assert.equal(await reporter.complete({ afterVersion: "0.3.19-abc" }), true);

  const final = calls.at(-1)?.body.text ?? "";
  assert.match(final, /Iva обновлена/u);
  assert.match(final, /Версия: 0\.3\.19-abc/u);
  assert.doesNotMatch(final, /→/u);
});

test("a refused phase edit is reported and the update carries on", async (t) => {
  const errors: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) =>
    errors.push(args.map(String).join(" ")),
  );
  const calls: TelegramCall[] = [];
  let failing = true;
  const fetchImpl: MockFetch = async (url, init) => {
    calls.push({ method: url.split("/").at(-1), body: JSON.parse(init.body) });
    if (failing)
      return {
        ok: false,
        status: 500,
        json: async () => ({ ok: false, description: "Internal Server Error" }),
      };
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: {} }),
    };
  };
  const reporter = createTelegramUpdateReporter({
    token: "token",
    job: { chatId: 1, messageId: 100, locale: "en" },
    env: {},
    fetchImpl,
    sleepImpl: async () => {},
  });
  assert.ok(reporter);

  await reporter.start("build");
  failing = false;
  assert.equal(
    await reporter.complete({ beforeVersion: "v1", afterVersion: "v2" }),
    true,
  );

  assert.ok(
    errors.some((line) => /update status edit failed: 500/u.test(line)),
    errors.join("\n"),
  );
  assert.match(calls.at(-1)?.body.text ?? "", /Iva updated/);
  assert.equal(calls.filter((call) => call.method === "sendMessage").length, 0);
});

test("update callback is acknowledged before any message edit", async () => {
  const previousFetch = mutableGlobal.fetch;
  const previousToken = process.env.TELEGRAM_BOT_TOKEN;
  const previousAllowed = process.env.TELEGRAM_ALLOWED_USER_IDS;
  process.env.TELEGRAM_BOT_TOKEN = "token";
  process.env.TELEGRAM_ALLOWED_USER_IDS = "42";
  const calls: string[] = [];
  mutableGlobal.fetch = async (url) => {
    calls.push(url.split("/").at(-1) ?? "");
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: {} }),
    };
  };
  try {
    const bridge = await import(`../telegram-poll.mjs?test=${Date.now()}`);
    await bridge.handleUpdateCallback({
      id: "callback",
      from: { id: 42 },
      data: "iva_update:skip",
      message: { chat: { id: 1 }, message_id: 2 },
    });
    assert.deepEqual(calls, ["answerCallbackQuery", "editMessageText"]);
    assert.deepEqual(
      bridge.resetMessageCopy(
        "/new",
        {
          MODEL_PROVIDER: "codex",
          CODEX_MODEL: "gpt-5.5",
          CODEX_CONTEXT_WINDOW: "272000",
        },
        "ru",
      ),
      {
        pending: "◇ Начинаю новый диалог",
        complete:
          "✨ Новый диалог готов\n\nМодель: OpenAI · gpt-5.5\nКонтекст очищен · окно 272k",
      },
    );
  } finally {
    mutableGlobal.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = previousToken;
    if (previousAllowed === undefined)
      delete process.env.TELEGRAM_ALLOWED_USER_IDS;
    else process.env.TELEGRAM_ALLOWED_USER_IDS = previousAllowed;
  }
});

test("up-to-date check shows the model from fresh .env, not this process's snapshot", async () => {
  const previousFetch = mutableGlobal.fetch;
  const previousEnv = Object.fromEntries(
    [
      "TELEGRAM_BOT_TOKEN",
      "TELEGRAM_ALLOWED_USER_IDS",
      "MODEL_PROVIDER",
      "OPENCODE_MODEL",
    ].map((k) => [k, process.env[k]]),
  );
  process.env.TELEGRAM_BOT_TOKEN = "token";
  process.env.TELEGRAM_ALLOWED_USER_IDS = "42";
  // The bridge's snapshot is stale: the /model wizard rewrote .env after this process started.
  process.env.MODEL_PROVIDER = "opencode";
  process.env.OPENCODE_MODEL = "stale-model";
  const calls: TelegramCall[] = [];
  mutableGlobal.fetch = async (url, init) => {
    calls.push({ method: url.split("/").at(-1), body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 10 } }),
    };
  };
  try {
    const bridge = await import(`../telegram-poll.mjs?fresh=${Date.now()}`);
    await bridge.handleUpdateCheck(1, {
      inspectImpl: async () => ({
        hasCommitUpdate: false,
        localVersion: "1.2.3",
      }),
      envImpl: async () => ({
        MODEL_PROVIDER: "codex",
        CODEX_MODEL: "fresh-model",
      }),
    });
    const edit = calls.find((call) => call.method === "editMessageText");
    assert.match(edit?.body.text ?? "", /OpenAI · fresh-model/);
  } finally {
    mutableGlobal.fetch = previousFetch;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("manual update offer keeps commit-based behavior and marks a stable release as shown", async () => {
  const previousFetch = mutableGlobal.fetch;
  const previousToken = process.env.TELEGRAM_BOT_TOKEN;
  const previousAllowed = process.env.TELEGRAM_ALLOWED_USER_IDS;
  process.env.TELEGRAM_BOT_TOKEN = "token";
  process.env.TELEGRAM_ALLOWED_USER_IDS = "42";
  const calls: TelegramCall[] = [];
  mutableGlobal.fetch = async (url, init) => {
    const method = url.split("/").at(-1);
    const body = JSON.parse(init.body);
    calls.push({ method, body });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        result:
          method === "sendMessage" ? { message_id: 10 } : { message_id: 10 },
      }),
    };
  };
  try {
    const bridge = await import(`../telegram-poll.mjs?manual=${Date.now()}`);
    const marked: string[] = [];
    await bridge.handleUpdateCheck(1, {
      inspectImpl: async () => ({
        hasCommitUpdate: true,
        hasVersionUpdate: true,
        localVersion: "1.2.3",
        remoteVersion: "1.2.4",
      }),
      markNotifiedImpl: async (_dataDir: string, version: string) =>
        marked.push(version),
    });
    assert.deepEqual(
      calls.map((call) => call.method),
      ["sendMessage", "editMessageText"],
    );
    assert.equal(calls[1]?.body.reply_markup?.inline_keyboard[0]?.length, 2);
    assert.deepEqual(marked, ["1.2.4"]);
  } finally {
    mutableGlobal.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = previousToken;
    if (previousAllowed === undefined)
      delete process.env.TELEGRAM_ALLOWED_USER_IDS;
    else process.env.TELEGRAM_ALLOWED_USER_IDS = previousAllowed;
  }
});

test("update lock is exclusive and owner-reentrant", () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-lock-"));
  const first = acquireUpdateLock(dir, "one");
  assert.equal(first.ok, true);
  assert.equal(acquireUpdateLock(dir, "one").ok, true);
  assert.equal(acquireUpdateLock(dir, "two").ok, false);
  releaseUpdateLock(first);
  assert.equal(acquireUpdateLock(dir, "two").ok, true);
});

test("verified update commits before timer activation and contains a timer failure", async () => {
  const updateSafety = await import("./update-safety.ts");
  assert.equal(typeof updateSafety.commitThenRunPostCommit, "function");

  const calls: string[] = [];
  const timerError = new Error("timer activation failed");
  const result = await updateSafety.commitThenRunPostCommit({
    commit: async () => {
      calls.push("commit");
    },
    postCommit: async () => {
      calls.push("timer");
      throw timerError;
    },
  });

  assert.deepEqual(calls, ["commit", "timer"]);
  assert.deepEqual(result, { ok: false, error: timerError });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function configureGit(cwd: string): void {
  git(cwd, "config", "user.email", "test@example.com");
  git(cwd, "config", "user.name", "Iva Test");
}

test("safe update preserves staged, unstaged and untracked user files", async () => {
  const temp = mkdtempSync(join(tmpdir(), "iva-update-"));
  const remote = join(temp, "remote.git");
  const seed = join(temp, "seed");
  const local = join(temp, "local");
  const data = join(temp, "data");
  git(temp, "init", "--bare", remote);
  git(temp, "init", "-b", "main", seed);
  configureGit(seed);
  writeFileSync(join(seed, ".gitignore"), ".env\n.output\n");
  writeFileSync(
    join(seed, "package.json"),
    JSON.stringify({ version: "1.0.0" }),
  );
  writeFileSync(join(seed, "tracked.txt"), "base\n");
  git(seed, "add", ".");
  git(seed, "commit", "-m", "base");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-u", "origin", "main");
  git(temp, "clone", "--branch", "main", remote, local);
  configureGit(local);

  writeFileSync(join(seed, "upstream.txt"), "upstream\n");
  writeFileSync(
    join(seed, "package.json"),
    JSON.stringify({ version: "1.1.0" }),
  );
  git(seed, "add", ".");
  git(seed, "commit", "-m", "upstream");
  git(seed, "push", "origin", "main");

  writeFileSync(join(local, "tracked.txt"), "user change\n");
  git(local, "add", "tracked.txt");
  writeFileSync(join(local, "unstaged.txt"), "unstaged\n");
  writeFileSync(join(local, "custom-skill.txt"), "custom\n");
  writeFileSync(join(local, ".env"), "SECRET=kept\n", { mode: 0o600 });
  mkdirSync(data, { recursive: true });
  const tx = createUpdateTransaction({
    root: local,
    dataDir: data,
    envPath: join(local, ".env"),
    logFile: join(temp, "update.log"),
  });
  await tx.protect();
  const result = await tx.fetchAndIntegrate();
  await tx.restoreLocalChanges();
  assert.equal(result.changed, true);
  assert.equal(
    readFileSync(join(local, "tracked.txt"), "utf8"),
    "user change\n",
  );
  assert.equal(readFileSync(join(local, "unstaged.txt"), "utf8"), "unstaged\n");
  assert.equal(
    readFileSync(join(local, "custom-skill.txt"), "utf8"),
    "custom\n",
  );
  assert.equal(readFileSync(join(local, ".env"), "utf8"), "SECRET=kept\n");
  assert.equal(readFileSync(join(local, "upstream.txt"), "utf8"), "upstream\n");
  assert.match(git(local, "status", "--porcelain=v1"), /^M {2}tracked\.txt/m);
  await tx.commit();
  assert.equal(git(local, "stash", "list"), "");
});

test("safe update migrates a merged legacy branch to the main channel", async () => {
  const temp = mkdtempSync(join(tmpdir(), "iva-update-channel-"));
  const remote = join(temp, "remote.git");
  const seed = join(temp, "seed");
  const local = join(temp, "local");
  const data = join(temp, "data");
  git(temp, "init", "--bare", remote);
  git(temp, "init", "-b", "main", seed);
  configureGit(seed);
  writeFileSync(
    join(seed, "package.json"),
    JSON.stringify({ version: "1.0.0" }),
  );
  writeFileSync(join(seed, "base.txt"), "base\n");
  git(seed, "add", ".");
  git(seed, "commit", "-m", "base");
  git(seed, "branch", "feat/legacy");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "origin", "main", "feat/legacy");
  git(temp, "clone", "--branch", "feat/legacy", remote, local);
  configureGit(local);

  writeFileSync(join(seed, "upstream.txt"), "main update\n");
  git(seed, "add", "upstream.txt");
  git(seed, "commit", "-m", "main update");
  git(seed, "push", "origin", "main");
  const expected = git(seed, "rev-parse", "HEAD");

  const tx = createUpdateTransaction({
    root: local,
    dataDir: data,
    envPath: join(local, ".env"),
    logFile: join(temp, "log"),
  });
  await tx.protect();
  const update = await tx.fetchAndIntegrate();
  await tx.restoreLocalChanges();
  assert.equal(update.legacyMigration, true);
  assert.equal(update.branch, "main");
  assert.equal(git(local, "rev-parse", "HEAD"), expected);
  await tx.commit();
  assert.equal(
    git(local, "config", "--local", "--get", "iva.updateBranch"),
    "main",
  );
});

function updateFixture() {
  const temp = mkdtempSync(join(tmpdir(), "iva-update-failure-"));
  const remote = join(temp, "remote.git");
  const seed = join(temp, "seed");
  const local = join(temp, "local");
  const data = join(temp, "data");
  git(temp, "init", "--bare", remote);
  git(temp, "init", "-b", "main", seed);
  configureGit(seed);
  writeFileSync(join(seed, ".gitignore"), ".env\n.output\n");
  writeFileSync(
    join(seed, "package.json"),
    JSON.stringify({ version: "1.0.0" }),
  );
  writeFileSync(join(seed, "tracked.txt"), "base\n");
  git(seed, "add", ".");
  git(seed, "commit", "-m", "base");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-u", "origin", "main");
  git(temp, "clone", "--branch", "main", remote, local);
  configureGit(local);
  mkdirSync(data, { recursive: true });
  return { temp, remote, seed, local, data };
}

type ProtectedTreeState = {
  head: string;
  status: string;
  staged: string;
  unstaged: string;
  tracked: string;
  executable: string;
  executableMode: number;
  nestedUntracked: string;
  literalPathspecUntracked: string;
};

function gitHex(cwd: string, ...args: string[]): string {
  return Buffer.from(execFileSync("git", args, { cwd })).toString("hex");
}

function prepareProtectedTree(local: string): ProtectedTreeState {
  writeFileSync(join(local, "executable.sh"), "#!/bin/sh\necho base\n");
  git(local, "add", "executable.sh");
  git(local, "commit", "-m", "add executable fixture");

  writeFileSync(join(local, "tracked.txt"), "staged bytes\n");
  git(local, "add", "tracked.txt");
  writeFileSync(join(local, "tracked.txt"), "unstaged bytes\n");
  writeFileSync(join(local, "executable.sh"), "#!/bin/sh\necho local\n");
  chmodSync(join(local, "executable.sh"), 0o755);
  git(local, "add", "executable.sh");
  mkdirSync(join(local, "nested/deep"), { recursive: true });
  writeFileSync(
    join(local, "nested/deep/untracked.bin"),
    Buffer.from([0, 1, 2, 10, 255]),
  );
  writeFileSync(join(local, ":(glob)*"), Buffer.from([255, 10, 3, 0]));
  return protectedTreeState(local);
}

function protectedTreeState(local: string): ProtectedTreeState {
  return {
    head: git(local, "rev-parse", "HEAD"),
    status: gitHex(
      local,
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ),
    staged: gitHex(local, "diff", "--binary", "--cached"),
    unstaged: gitHex(local, "diff", "--binary"),
    tracked: readFileSync(join(local, "tracked.txt")).toString("hex"),
    executable: readFileSync(join(local, "executable.sh")).toString("hex"),
    executableMode: statSync(join(local, "executable.sh")).mode & 0o777,
    nestedUntracked: readFileSync(
      join(local, "nested/deep/untracked.bin"),
    ).toString("hex"),
    literalPathspecUntracked: readFileSync(join(local, ":(glob)*")).toString(
      "hex",
    ),
  };
}

function d10Transaction(
  fixture: ReturnType<typeof updateFixture>,
  wrapperBody: string,
) {
  const bin = join(fixture.temp, "fault-git");
  const calls = join(fixture.temp, "git-calls.log");
  const wrapper = join(bin, "git");
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  mkdirSync(bin);
  writeFileSync(
    wrapper,
    "#!/bin/sh\n" +
      `calls=${JSON.stringify(calls)}\n` +
      `printf '%s\\n' "$*" >> ${JSON.stringify(calls)}\n` +
      wrapperBody.replaceAll("__REAL_GIT__", JSON.stringify(realGit)) +
      `\nexec ${JSON.stringify(realGit)} "$@"\n`,
  );
  chmodSync(wrapper, 0o755);
  return {
    calls,
    tx: createUpdateTransaction({
      root: fixture.local,
      dataDir: fixture.data,
      envPath: join(fixture.local, ".env"),
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    }),
  };
}

test("every pre-snapshot command fault leaves the live tree untouched", async (t) => {
  const faults = [
    [
      '[ "$1" = update-ref ] && [ "$#" -eq 3 ] && printf \'%s\' "$2" | grep -q \'^refs/iva/update-recovery/\'',
      "guard ref write",
    ],
    [
      '[ "$1" = rev-parse ] && [ "$2" = --verify ] && printf \'%s\' "$3" | grep -q \'^refs/iva/update-recovery/\'',
      "guard ref verification",
    ],
    ['[ "$1" = ls-files ] && [ "$2" = --cached ]', "tracked index scan"],
    ['[ "$1" = ls-files ] && [ "$2" = -v ]', "index flag scan"],
    [
      '[ "$1" = diff ] && [ "$2" = --cached ] && [ "$#" -eq 4 ]',
      "ordinary staged path scan",
    ],
    [
      '[ "$1" = diff ] && [ "$2" = --cached ] && [ "$#" -eq 5 ]',
      "intent-to-add path scan",
    ],
    ['[ "$1" = ls-files ] && [ "$2" = --others ]', "untracked path scan"],
    ['[ "$1" = write-tree ] && [ -z "$GIT_INDEX_FILE" ]', "index tree write"],
    [
      '[ "$1" = hash-object ] && [ "$3" = --no-filters ] && [ "$5" = tracked.txt ]',
      "raw worktree blob",
    ],
    [
      "[ \"$1\" = read-tree ] && printf '%s' \"$GIT_INDEX_FILE\" | grep -q 'iva-update-worktree-snapshot'",
      "worktree index init",
    ],
    [
      "[ \"$1\" = update-index ] && printf '%s' \"$GIT_INDEX_FILE\" | grep -q 'iva-update-worktree-snapshot'",
      "worktree index populate",
    ],
    [
      "[ \"$1\" = write-tree ] && printf '%s' \"$GIT_INDEX_FILE\" | grep -q 'iva-update-worktree-snapshot'",
      "worktree tree write",
    ],
    [
      '[ "$1" = rev-parse ] && [ "$2" = --verify ] && printf \'%s\' "$3" | grep -Fq \'^{tree}\'',
      "base tree lookup",
    ],
    [
      "[ \"$1\" = commit-tree ] && printf '%s' \"$*\" | grep -q ' index$'",
      "index commit",
    ],
    [
      "[ \"$1\" = read-tree ] && printf '%s' \"$GIT_INDEX_FILE\" | grep -q 'iva-update-untracked-snapshot'",
      "untracked index init",
    ],
    [
      '[ "$1" = hash-object ] && [ "$3" = --no-filters ] && [ "$5" = nested/deep/untracked.bin ]',
      "raw untracked blob",
    ],
    [
      "[ \"$1\" = update-index ] && printf '%s' \"$GIT_INDEX_FILE\" | grep -q 'iva-update-untracked-snapshot'",
      "untracked index populate",
    ],
    [
      "[ \"$1\" = write-tree ] && printf '%s' \"$GIT_INDEX_FILE\" | grep -q 'iva-update-untracked-snapshot'",
      "untracked tree write",
    ],
    [
      "[ \"$1\" = commit-tree ] && printf '%s' \"$*\" | grep -q ' untracked$'",
      "untracked commit",
    ],
    [
      "[ \"$1\" = commit-tree ] && printf '%s' \"$*\" | grep -q 'iva-update-' && ! printf '%s' \"$*\" | grep -Eq ' (index|untracked)$'",
      "recovery commit",
    ],
    [
      "[ \"$1\" = rev-parse ] && [ \"$2\" = --verify ] && printf '%s' \"$3\" | grep -Fq '^{commit}' && ! printf '%s' \"$3\" | grep -q '^refs/'",
      "recovery commit verification",
    ],
    ['[ "$1" = ls-tree ] && [ "$2" = -r ]', "tree verification"],
    ['[ "$1" = cat-file ] && [ "$2" = blob ]', "raw byte verification"],
    ['[ "$1" = show ] && [ "$2" = -s ]', "metadata verification"],
    [
      '[ "$1" = update-ref ] && [ "$#" -eq 4 ] && printf \'%s\' "$2" | grep -q \'^refs/iva/update-recovery/\'',
      "durable snapshot ref write",
    ],
    [
      '[ "$1" = rev-parse ] && [ "$2" = --verify ] && printf \'%s\' "$3" | grep -q \'^refs/iva/update-recovery/\' && [ "$(grep -c \'^update-ref refs/iva/update-recovery/\' "$calls")" -ge 2 ]',
      "durable snapshot ref verification",
    ],
  ] as const;

  for (const [condition, name] of faults) {
    await t.test(name, async (t) => {
      const fixture = updateFixture();
      t.after(() => rmSync(fixture.temp, { recursive: true, force: true }));
      const before = prepareProtectedTree(fixture.local);
      const { calls, tx } = d10Transaction(
        fixture,
        `if ${condition} && [ ! -e "$calls.injected" ]; then\n` +
          '  : > "$calls.injected"\n' +
          "  printf '%s\\n' 'injected pre-snapshot failure' >&2\n" +
          "  exit 72\n" +
          "fi\n",
      );

      await assert.rejects(
        () => tx.protect(),
        /injected pre-snapshot failure/u,
      );
      await tx.rollback();

      assert.deepEqual(protectedTreeState(fixture.local), before);
      assert.doesNotMatch(
        readFileSync(calls, "utf8"),
        /reset --hard|rebase --abort|stash apply/u,
      );
      assert.equal(
        git(
          fixture.local,
          "for-each-ref",
          "--format=%(refname)",
          "refs/iva/update-recovery",
        ),
        "",
      );
    });
  }
});

test("stash push failure rolls back from an already durable snapshot", async (t) => {
  const fixture = updateFixture();
  t.after(() => rmSync(fixture.temp, { recursive: true, force: true }));
  const before = prepareProtectedTree(fixture.local);
  const { calls, tx } = d10Transaction(
    fixture,
    'if [ "$1" = stash ] && [ "$2" = push ]; then\n' +
      "  printf '%s\\n' 'injected stash push failure' >&2\n" +
      "  exit 73\n" +
      "fi\n",
  );

  await assert.rejects(() => tx.protect(), /injected stash push failure/u);
  await tx.rollback();

  assert.deepEqual(protectedTreeState(fixture.local), before);
  const commands = readFileSync(calls, "utf8").split("\n");
  const durableRef = commands.findIndex((command) =>
    command.startsWith("update-ref refs/iva/update-recovery/"),
  );
  const firstReset = commands.findIndex((command) =>
    command.startsWith("reset --hard "),
  );
  assert.ok(durableRef >= 0 && durableRef < firstReset);
});

test("rollback restores an exact tree when stash push reports failure after writing the snapshot", async (t) => {
  const fixture = updateFixture();
  t.after(() => rmSync(fixture.temp, { recursive: true, force: true }));
  const before = prepareProtectedTree(fixture.local);
  const { tx } = d10Transaction(
    fixture,
    'if [ "$1" = stash ] && [ "$2" = push ]; then\n' +
      '  __REAL_GIT__ "$@"\n' +
      "  code=$?\n" +
      '  [ "$code" -eq 0 ] || exit "$code"\n' +
      "  printf '%s\\n' 'injected post-stash failure' >&2\n" +
      "  exit 74\n" +
      "fi\n",
  );

  await assert.rejects(() => tx.protect(), /injected post-stash failure/u);
  await tx.rollback();

  assert.deepEqual(protectedTreeState(fixture.local), before);
});

test("rollback restores the tree when reported stash failure also loses the first OID lookup", async (t) => {
  const fixture = updateFixture();
  t.after(() => rmSync(fixture.temp, { recursive: true, force: true }));
  const before = prepareProtectedTree(fixture.local);
  const { calls, tx } = d10Transaction(
    fixture,
    'if [ "$1" = stash ] && [ "$2" = push ]; then\n' +
      '  __REAL_GIT__ "$@"\n' +
      "  code=$?\n" +
      '  [ "$code" -eq 0 ] || exit "$code"\n' +
      "  printf '%s\\n' 'injected post-stash failure' >&2\n" +
      "  exit 77\n" +
      "fi\n" +
      'if [ "$1" = rev-parse ] && [ "$2" = --verify ] && [ "$3" = refs/stash ]; then\n' +
      "  printf '%s\\n' 'injected stash OID failure' >&2\n" +
      "  exit 78\n" +
      "fi\n",
  );

  await assert.rejects(() => tx.protect(), /injected post-stash failure/u);
  await tx.rollback();

  assert.deepEqual(protectedTreeState(fixture.local), before);
  const commands = readFileSync(calls, "utf8");
  assert.doesNotMatch(
    commands,
    /for-each-ref --format=%\(objectname\) refs\/stash/u,
  );
  assert.doesNotMatch(commands, /stash apply --index refs\/stash/u);
});

test("combined stash and all OID lookup failures leave the original tree live", async (t) => {
  const fixture = updateFixture();
  t.after(() => rmSync(fixture.temp, { recursive: true, force: true }));
  const before = prepareProtectedTree(fixture.local);
  const { tx } = d10Transaction(
    fixture,
    'if [ "$1" = stash ] && [ "$2" = push ]; then\n' +
      '  __REAL_GIT__ "$@"\n' +
      "  code=$?\n" +
      '  [ "$code" -eq 0 ] || exit "$code"\n' +
      "  printf '%s\\n' 'injected post-stash failure' >&2\n" +
      "  exit 79\n" +
      "fi\n" +
      'if [ "$1" = rev-parse ] && [ "$2" = --verify ] && [ "$3" = refs/stash ]; then\n' +
      "  printf '%s\\n' 'injected stash OID failure' >&2\n" +
      "  exit 80\n" +
      "fi\n" +
      'if [ "$1" = for-each-ref ] && [ "$3" = refs/stash ]; then\n' +
      "  printf '%s\\n' 'injected fallback OID failure' >&2\n" +
      "  exit 81\n" +
      "fi\n",
  );

  await assert.rejects(() => tx.protect(), /injected post-stash failure/u);
  await tx.rollback();

  assert.deepEqual(protectedTreeState(fixture.local), before);
});

test("both restore-stash OID lookups may fail after push without losing the full snapshot", async (t) => {
  const fixture = updateFixture();
  t.after(() => rmSync(fixture.temp, { recursive: true, force: true }));
  const before = prepareProtectedTree(fixture.local);
  const { tx } = d10Transaction(
    fixture,
    'if [ "$1" = rev-parse ] && [ "$2" = --verify ] && [ "$3" = refs/stash ]; then\n' +
      "  printf '%s\\n' 'injected stash OID failure' >&2\n" +
      "  exit 82\n" +
      "fi\n" +
      'if [ "$1" = for-each-ref ] && [ "$3" = refs/stash ]; then\n' +
      "  printf '%s\\n' 'injected fallback OID failure' >&2\n" +
      "  exit 83\n" +
      "fi\n",
  );

  await assert.rejects(() => tx.protect(), /injected stash OID failure/u);
  await tx.rollback();

  assert.deepEqual(protectedTreeState(fixture.local), before);
});

test("stash OID failure leaves staged, unstaged, modes and nested untracked bytes unchanged", async (t) => {
  const fixture = updateFixture();
  t.after(() => rmSync(fixture.temp, { recursive: true, force: true }));
  const before = prepareProtectedTree(fixture.local);
  const { calls, tx } = d10Transaction(
    fixture,
    'if [ "$1" = rev-parse ] && [ "$2" = --verify ] && [ "$3" = refs/stash ]; then\n' +
      "  printf '%s\\n' 'injected stash OID failure' >&2\n" +
      "  exit 75\n" +
      "fi\n",
  );

  await assert.rejects(() => tx.protect(), /injected stash OID failure/u);
  await tx.rollback();

  assert.deepEqual(protectedTreeState(fixture.local), before);
  const commands = readFileSync(calls, "utf8");
  assert.match(commands, /for-each-ref --format=%\(objectname\) refs\/stash/u);
  assert.doesNotMatch(commands, /stash apply --index refs\/stash/u);
});

test("a false-success stash push never applies a pre-existing stash", async (t) => {
  const fixture = updateFixture();
  t.after(() => rmSync(fixture.temp, { recursive: true, force: true }));
  writeFileSync(join(fixture.local, "older.txt"), "older base\n");
  git(fixture.local, "add", "older.txt");
  git(fixture.local, "commit", "-m", "add older stash fixture");
  writeFileSync(join(fixture.local, "older.txt"), "pre-existing stash\n");
  git(fixture.local, "stash", "push", "--message", "older-user-stash");
  const olderStashOid = git(fixture.local, "rev-parse", "refs/stash");
  const before = prepareProtectedTree(fixture.local);
  const { calls, tx } = d10Transaction(
    fixture,
    'if [ "$1" = stash ] && [ "$2" = push ]; then\n' + "  exit 0\n" + "fi\n",
  );

  await assert.rejects(() => tx.protect());
  await tx.rollback();
  await tx.commit();

  assert.deepEqual(protectedTreeState(fixture.local), before);
  assert.equal(
    git(fixture.local, "stash", "list", "--format=%H"),
    olderStashOid,
  );
  assert.equal(
    git(fixture.local, "show", `${olderStashOid}:older.txt`),
    "pre-existing stash",
  );
  assert.doesNotMatch(
    readFileSync(calls, "utf8"),
    /stash apply --index refs\/stash/u,
  );
});

test("a false-success stash apply cannot release the recovery owner", async (t) => {
  const fixture = updateFixture();
  t.after(() => rmSync(fixture.temp, { recursive: true, force: true }));
  writeFileSync(join(fixture.local, "tracked.txt"), "local change\n");
  writeFileSync(join(fixture.seed, "upstream.txt"), "upstream\n");
  git(fixture.seed, "add", "upstream.txt");
  git(fixture.seed, "commit", "-m", "upstream");
  git(fixture.seed, "push", "origin", "main");
  const { tx } = d10Transaction(
    fixture,
    'if [ "$1" = stash ] && [ "$2" = apply ]; then\n' + "  exit 0\n" + "fi\n",
  );

  await tx.protect();
  await tx.fetchAndIntegrate();

  await assert.rejects(
    () => tx.restoreLocalChanges(),
    /applied recovery state is incomplete: worktree/u,
  );

  assert.notEqual(
    git(
      fixture.local,
      "for-each-ref",
      "--format=%(objectname)",
      "refs/iva/update-recovery",
    ),
    "",
  );
  assert.notEqual(git(fixture.local, "stash", "list"), "");
});

test("the durable unique ref survives an external restore without verified release", async (t) => {
  const fixture = updateFixture();
  t.after(() => rmSync(fixture.temp, { recursive: true, force: true }));
  const before = prepareProtectedTree(fixture.local);
  const tx = createUpdateTransaction({
    root: fixture.local,
    dataDir: fixture.data,
    envPath: join(fixture.local, ".env"),
  });

  await tx.protect();
  const recovery = git(
    fixture.local,
    "for-each-ref",
    "--format=%(refname) %(objectname)",
    "refs/iva/update-recovery",
  );
  const [ref, oid] = recovery.split(" ");
  assert.match(ref ?? "", /^refs\/iva\/update-recovery\//u);
  assert.equal(git(fixture.local, "rev-parse", "--verify", ref ?? ""), oid);

  git(fixture.local, "stash", "apply", "--index", oid ?? "");
  assert.deepEqual(protectedTreeState(fixture.local), before);
  assert.notEqual(
    git(
      fixture.local,
      "for-each-ref",
      "--format=%(refname)",
      "refs/iva/update-recovery",
    ),
    "",
  );

  await tx.commit();
  assert.notEqual(
    git(
      fixture.local,
      "for-each-ref",
      "--format=%(refname)",
      "refs/iva/update-recovery",
    ),
    "",
  );
});

test("cleanup retains recovery when the verified applied tree changes before commit", async (t) => {
  const fixture = updateFixture();
  t.after(() => rmSync(fixture.temp, { recursive: true, force: true }));
  writeFileSync(join(fixture.local, "tracked.txt"), "local change\n");
  writeFileSync(join(fixture.seed, "upstream.txt"), "upstream\n");
  git(fixture.seed, "add", "upstream.txt");
  git(fixture.seed, "commit", "-m", "upstream");
  git(fixture.seed, "push", "origin", "main");
  const tx = createUpdateTransaction({
    root: fixture.local,
    dataDir: fixture.data,
    envPath: join(fixture.local, ".env"),
  });

  await tx.protect();
  await tx.fetchAndIntegrate();
  const restored = await tx.restoreLocalChanges();
  assert.equal(restored.status, "applied");
  const recovery = git(
    fixture.local,
    "for-each-ref",
    "--format=%(objectname)",
    "refs/iva/update-recovery",
  );
  writeFileSync(join(fixture.local, "tracked.txt"), "foreign change\n");

  await assert.rejects(
    () => tx.commit(),
    /applied recovery state is incomplete: worktree/u,
  );

  assert.equal(
    readFileSync(join(fixture.local, "tracked.txt"), "utf8"),
    "foreign change\n",
  );
  assert.equal(
    git(
      fixture.local,
      "for-each-ref",
      "--format=%(objectname)",
      "refs/iva/update-recovery",
    ),
    recovery,
  );
  assert.notEqual(git(fixture.local, "stash", "list"), "");
});

test("cleanup retains recovery when tracked permissions change after confirmation", async (t) => {
  const fixture = updateFixture();
  t.after(() => rmSync(fixture.temp, { recursive: true, force: true }));
  writeFileSync(join(fixture.local, "tracked.txt"), "local change\n");
  writeFileSync(join(fixture.seed, "upstream.txt"), "upstream\n");
  git(fixture.seed, "add", "upstream.txt");
  git(fixture.seed, "commit", "-m", "upstream");
  git(fixture.seed, "push", "origin", "main");
  const tx = createUpdateTransaction({
    root: fixture.local,
    dataDir: fixture.data,
    envPath: join(fixture.local, ".env"),
  });

  await tx.protect();
  await tx.fetchAndIntegrate();
  const restored = await tx.restoreLocalChanges();
  assert.equal(restored.status, "applied");
  const recovery = git(
    fixture.local,
    "for-each-ref",
    "--format=%(objectname)",
    "refs/iva/update-recovery",
  );
  const stashes = git(fixture.local, "stash", "list", "--format=%H");
  chmodSync(join(fixture.local, "tracked.txt"), 0o600);

  await assert.rejects(
    () => tx.commit(),
    /applied recovery state is incomplete: worktree-permissions/u,
  );

  assert.equal(
    statSync(join(fixture.local, "tracked.txt")).mode & 0o777,
    0o600,
  );
  assert.equal(
    git(
      fixture.local,
      "for-each-ref",
      "--format=%(objectname)",
      "refs/iva/update-recovery",
    ),
    recovery,
  );
  assert.equal(git(fixture.local, "stash", "list", "--format=%H"), stashes);
});

test("the durable snapshot records modes, links and literal paths when core.fileMode is false", async (t) => {
  const fixture = updateFixture();
  t.after(() => rmSync(fixture.temp, { recursive: true, force: true }));
  writeFileSync(join(fixture.local, "mode-tool.sh"), "#!/bin/sh\necho base\n");
  writeFileSync(join(fixture.local, "staged-mode.sh"), "#!/bin/sh\nexit 0\n");
  symlinkSync("tracked.txt", join(fixture.local, "tracked-link"));
  writeFileSync(join(fixture.local, "older.txt"), "older base\n");
  git(
    fixture.local,
    "add",
    "mode-tool.sh",
    "staged-mode.sh",
    "tracked-link",
    "older.txt",
  );
  git(fixture.local, "commit", "-m", "add mode fixture");
  writeFileSync(join(fixture.local, "older.txt"), "pre-existing stash\n");
  git(fixture.local, "stash", "push", "--message", "older-user-stash");
  const olderStashOid = git(fixture.local, "rev-parse", "refs/stash");
  git(fixture.local, "config", "core.fileMode", "false");
  writeFileSync(join(fixture.local, "mode-tool.sh"), "#!/bin/sh\necho local\n");
  chmodSync(join(fixture.local, "mode-tool.sh"), 0o755);
  chmodSync(join(fixture.local, "staged-mode.sh"), 0o644);
  git(fixture.local, "update-index", "--chmod=+x", "staged-mode.sh");
  rmSync(join(fixture.local, "tracked-link"));
  symlinkSync("mode-tool.sh", join(fixture.local, "tracked-link"));
  mkdirSync(join(fixture.local, "nested-mode"));
  writeFileSync(
    join(fixture.local, "nested-mode/untracked-tool.sh"),
    "#!/bin/sh\necho untracked\n",
  );
  chmodSync(join(fixture.local, "nested-mode/untracked-tool.sh"), 0o755);
  symlinkSync("../mode-tool.sh", join(fixture.local, "nested-mode/link"));
  writeFileSync(join(fixture.local, ":(glob)*"), Buffer.from([255, 0, 4]));
  chmodSync(join(fixture.local, ":(glob)*"), 0o755);
  const state = () => ({
    status: gitHex(
      fixture.local,
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ),
    staged: gitHex(fixture.local, "diff", "--binary", "--cached"),
    modeToolBytes: readFileSync(join(fixture.local, "mode-tool.sh")).toString(
      "hex",
    ),
    modeToolMode: statSync(join(fixture.local, "mode-tool.sh")).mode & 0o777,
    stagedMode: statSync(join(fixture.local, "staged-mode.sh")).mode & 0o777,
    trackedLink: readlinkSync(join(fixture.local, "tracked-link")),
    trackedIsLink: lstatSync(
      join(fixture.local, "tracked-link"),
    ).isSymbolicLink(),
    untrackedMode:
      statSync(join(fixture.local, "nested-mode/untracked-tool.sh")).mode &
      0o777,
    untrackedLink: readlinkSync(join(fixture.local, "nested-mode/link")),
    literalMode: statSync(join(fixture.local, ":(glob)*")).mode & 0o777,
    literalBytes: readFileSync(join(fixture.local, ":(glob)*")).toString("hex"),
  });
  const before = state();
  const tx = createUpdateTransaction({
    root: fixture.local,
    dataDir: fixture.data,
    envPath: join(fixture.local, ".env"),
  });

  await tx.protect();
  const recoveryOid = git(
    fixture.local,
    "for-each-ref",
    "--format=%(objectname)",
    "refs/iva/update-recovery",
  );
  const treeMode = (revision: string, path: string) =>
    git(
      fixture.local,
      "--literal-pathspecs",
      "ls-tree",
      revision,
      "--",
      path,
    ).split(/\s/u, 1)[0];

  assert.equal(treeMode(recoveryOid, "mode-tool.sh"), "100755");
  assert.equal(treeMode(recoveryOid, "staged-mode.sh"), "100644");
  assert.equal(treeMode(`${recoveryOid}^2`, "staged-mode.sh"), "100755");
  assert.equal(treeMode(recoveryOid, "tracked-link"), "120000");
  assert.equal(
    treeMode(`${recoveryOid}^3`, "nested-mode/untracked-tool.sh"),
    "100755",
  );
  assert.equal(treeMode(`${recoveryOid}^3`, "nested-mode/link"), "120000");
  assert.equal(treeMode(`${recoveryOid}^3`, ":(glob)*"), "100755");

  git(fixture.local, "stash", "apply", "--index", recoveryOid);
  assert.deepEqual(state(), before);
  await assert.rejects(
    () => tx.rollback(),
    /untracked recovery ownership changed: :\(glob\)\*/u,
  );
  assert.deepEqual(state(), before);
  assert.notEqual(
    git(
      fixture.local,
      "for-each-ref",
      "--format=%(refname)",
      "refs/iva/update-recovery",
    ),
    "",
  );

  await tx.commit();
  assert.equal(
    git(fixture.local, "stash", "list", "--format=%H"),
    olderStashOid,
  );
  assert.notEqual(
    git(
      fixture.local,
      "for-each-ref",
      "--format=%(refname)",
      "refs/iva/update-recovery",
    ),
    "",
  );
});

test("assume-unchanged cannot hide tracked bytes from the durable snapshot", async (t) => {
  const fixture = updateFixture();
  t.after(() => rmSync(fixture.temp, { recursive: true, force: true }));
  git(fixture.local, "update-index", "--assume-unchanged", "tracked.txt");
  writeFileSync(join(fixture.local, "tracked.txt"), "hidden local bytes\n");
  assert.equal(git(fixture.local, "status", "--porcelain=v1"), "");
  const before = readFileSync(join(fixture.local, "tracked.txt")).toString(
    "hex",
  );
  const tx = createUpdateTransaction({
    root: fixture.local,
    dataDir: fixture.data,
    envPath: join(fixture.local, ".env"),
  });

  await tx.protect();
  await tx.rollback();

  assert.equal(
    readFileSync(join(fixture.local, "tracked.txt")).toString("hex"),
    before,
  );
});

test("core.fileMode false cannot hide a mode-only executable change", async (t) => {
  const fixture = updateFixture();
  t.after(() => rmSync(fixture.temp, { recursive: true, force: true }));
  writeFileSync(join(fixture.local, "mode-only.sh"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(fixture.local, "mode-only.sh"), 0o644);
  git(fixture.local, "add", "mode-only.sh");
  git(fixture.local, "commit", "-m", "add hidden mode fixture");
  git(fixture.local, "config", "core.fileMode", "false");
  chmodSync(join(fixture.local, "mode-only.sh"), 0o755);
  assert.equal(git(fixture.local, "status", "--porcelain=v1"), "");
  const tx = createUpdateTransaction({
    root: fixture.local,
    dataDir: fixture.data,
    envPath: join(fixture.local, ".env"),
  });

  await tx.protect();
  const recoveryOid = git(
    fixture.local,
    "for-each-ref",
    "--format=%(objectname)",
    "refs/iva/update-recovery",
  );
  assert.equal(
    git(fixture.local, "ls-tree", recoveryOid, "--", "mode-only.sh").split(
      /\s/u,
      1,
    )[0],
    "100755",
  );

  await tx.rollback();
  assert.equal(
    statSync(join(fixture.local, "mode-only.sh")).mode & 0o777,
    0o755,
  );
});

test("an only-untracked snapshot preserves modes, nested bytes and a literal pathspec", async (t) => {
  const fixture = updateFixture();
  t.after(() => rmSync(fixture.temp, { recursive: true, force: true }));
  mkdirSync(join(fixture.local, "only/deep"), { recursive: true });
  writeFileSync(
    join(fixture.local, "only/deep/data.bin"),
    Buffer.from([0, 9, 10, 255]),
  );
  writeFileSync(join(fixture.local, "only.sh"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(fixture.local, "only.sh"), 0o755);
  writeFileSync(join(fixture.local, ":(glob)*"), Buffer.from([255, 0, 4]));
  const collatingPath = "locale";
  const collatingPathWithZeroWidthSpace = "locale\u200b";
  assert.equal(collatingPath.localeCompare(collatingPathWithZeroWidthSpace), 0);
  writeFileSync(join(fixture.local, collatingPath), Buffer.from([1, 2, 3]));
  writeFileSync(
    join(fixture.local, collatingPathWithZeroWidthSpace),
    Buffer.from([3, 2, 1]),
  );
  chmodSync(join(fixture.local, collatingPathWithZeroWidthSpace), 0o755);
  const state = () => ({
    status: gitHex(
      fixture.local,
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ),
    nested: readFileSync(join(fixture.local, "only/deep/data.bin")).toString(
      "hex",
    ),
    executable: readFileSync(join(fixture.local, "only.sh")).toString("hex"),
    mode: statSync(join(fixture.local, "only.sh")).mode & 0o777,
    literal: readFileSync(join(fixture.local, ":(glob)*")).toString("hex"),
    collating: readFileSync(join(fixture.local, collatingPath)).toString("hex"),
    collatingMode: statSync(join(fixture.local, collatingPath)).mode & 0o777,
    collatingWithZeroWidthSpace: readFileSync(
      join(fixture.local, collatingPathWithZeroWidthSpace),
    ).toString("hex"),
    collatingWithZeroWidthSpaceMode:
      statSync(join(fixture.local, collatingPathWithZeroWidthSpace)).mode &
      0o777,
  });
  const before = state();
  const tx = createUpdateTransaction({
    root: fixture.local,
    dataDir: fixture.data,
    envPath: join(fixture.local, ".env"),
  });

  await tx.protect();
  await tx.rollback();

  assert.deepEqual(state(), before);
});

test("an untracked path ending in a space survives protect and rollback", async (t) => {
  const fixture = updateFixture();
  t.after(() => rmSync(fixture.temp, { recursive: true, force: true }));
  const path = join(fixture.local, "trailing ");
  writeFileSync(path, Buffer.from([0, 32, 10, 255]));
  const before = {
    bytes: readFileSync(path).toString("hex"),
    status: gitHex(
      fixture.local,
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ),
  };
  const tx = createUpdateTransaction({
    root: fixture.local,
    dataDir: fixture.data,
    envPath: join(fixture.local, ".env"),
  });

  await tx.protect();
  await tx.rollback();

  assert.deepEqual(
    {
      bytes: readFileSync(path).toString("hex"),
      status: gitHex(
        fixture.local,
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ),
    },
    before,
  );
});

test("rollback reports reset failure and does not attempt a destructive apply", async (t) => {
  const fixture = updateFixture();
  t.after(() => rmSync(fixture.temp, { recursive: true, force: true }));
  prepareProtectedTree(fixture.local);
  const failRollback = join(fixture.temp, "fail-rollback");
  const { calls, tx } = d10Transaction(
    fixture,
    `if [ -f ${JSON.stringify(failRollback)} ] && [ "$1" = reset ] && [ "$2" = --hard ]; then\n` +
      "  printf '%s\\n' 'injected rollback reset failure' >&2\n" +
      "  exit 91\n" +
      "fi\n",
  );
  await tx.protect();
  const beforeRollbackCalls = readFileSync(calls, "utf8").length;
  writeFileSync(failRollback, "fail\n");

  await assert.rejects(() => tx.rollback(), /injected rollback reset failure/u);

  assert.doesNotMatch(
    readFileSync(calls, "utf8").slice(beforeRollbackCalls),
    /stash apply/u,
  );
});

test("a fault after protect rolls back staged, unstaged, modes and nested untracked bytes", async (t) => {
  const fixture = updateFixture();
  t.after(() => rmSync(fixture.temp, { recursive: true, force: true }));
  const before = prepareProtectedTree(fixture.local);
  const tx = createUpdateTransaction({
    root: fixture.local,
    dataDir: fixture.data,
    envPath: join(fixture.local, ".env"),
  });

  await tx.protect();
  await tx.rollback();

  assert.deepEqual(protectedTreeState(fixture.local), before);
});

test("stash conflict report can still roll back user files byte-for-byte", async () => {
  const { temp, seed, local, data } = updateFixture();
  const logFile = join(temp, "log");
  const originalHead = git(local, "rev-parse", "HEAD");
  writeFileSync(join(local, "tracked.txt"), "user version\n");
  writeFileSync(join(local, "custom.bin"), Buffer.from([0, 1, 2, 255]));
  writeFileSync(join(local, ".env"), "SECRET=before\n", { mode: 0o600 });
  mkdirSync(join(local, ".output"));
  writeFileSync(join(local, ".output", "server"), "old build");

  writeFileSync(join(seed, "tracked.txt"), "upstream version\n");
  git(seed, "add", "tracked.txt");
  git(seed, "commit", "-m", "conflicting upstream");
  git(seed, "push", "origin", "main");

  const tx = createUpdateTransaction({
    root: local,
    dataDir: data,
    envPath: join(local, ".env"),
    logFile,
  });
  await tx.protect();
  await tx.fetchAndIntegrate();
  const restored = await tx.restoreLocalChanges();
  assert.ok(restored.status === "conflicted");
  tx.backupOutput();
  mkdirSync(join(local, ".output"));
  writeFileSync(join(local, ".output", "server"), "bad build");
  tx.adoptOutput();
  await tx.rollback();

  assert.equal(git(local, "rev-parse", "HEAD"), originalHead);
  assert.equal(
    readFileSync(join(local, "tracked.txt"), "utf8"),
    "user version\n",
  );
  assert.deepEqual(
    readFileSync(join(local, "custom.bin")),
    Buffer.from([0, 1, 2, 255]),
  );
  assert.equal(readFileSync(join(local, ".env"), "utf8"), "SECRET=before\n");
  assert.equal(
    readFileSync(join(local, ".output", "server"), "utf8"),
    "old build",
  );
  assert.equal(
    git(local, "stash", "list"),
    "",
    "protective stash is removed after rollback",
  );
  assert.equal(existsSync(join(local, ".output.iva-backup")), false);
  assert.doesNotMatch(
    readFileSync(logFile, "utf8"),
    /No rebase in progress/u,
    "ordinary rollback must not emit a false rebase failure",
  );
});

test("conflicting local commits abort rebase and restore the original branch", async () => {
  const { temp, seed, local, data } = updateFixture();
  writeFileSync(join(local, "tracked.txt"), "local commit\n");
  git(local, "add", "tracked.txt");
  git(local, "commit", "-m", "local");
  const originalHead = git(local, "rev-parse", "HEAD");
  writeFileSync(join(seed, "tracked.txt"), "upstream commit\n");
  git(seed, "add", "tracked.txt");
  git(seed, "commit", "-m", "upstream");
  git(seed, "push", "origin", "main");
  const tx = createUpdateTransaction({
    root: local,
    dataDir: data,
    envPath: join(local, ".env"),
    logFile: join(temp, "log"),
  });
  await tx.protect();
  await assert.rejects(() => tx.fetchAndIntegrate(), /local commits conflict/);
  await tx.rollback();
  assert.equal(git(local, "rev-parse", "HEAD"), originalHead);
  assert.equal(
    readFileSync(join(local, "tracked.txt"), "utf8"),
    "local commit\n",
  );
  assert.equal(git(local, "status", "--porcelain=v1"), "");
});

test("rollback leaves a paused git am session intact", async (t) => {
  const { temp, seed, local, data } = updateFixture();
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  writeFileSync(join(seed, "tracked.txt"), "mail patch\n");
  git(seed, "add", "tracked.txt");
  git(seed, "commit", "-m", "mail patch");
  const patch = execFileSync("git", ["format-patch", "-1", "--stdout"], {
    cwd: seed,
  });
  const patchFile = join(temp, "mail.patch");
  writeFileSync(patchFile, patch);

  writeFileSync(join(local, "tracked.txt"), "local conflict\n");
  git(local, "add", "tracked.txt");
  git(local, "commit", "-m", "local conflict");
  const tx = createUpdateTransaction({
    root: local,
    dataDir: data,
    envPath: join(local, ".env"),
    logFile: join(temp, "log"),
  });
  await tx.protect();
  assert.throws(() =>
    execFileSync("git", ["am", patchFile], {
      cwd: local,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  const gitDir = join(local, git(local, "rev-parse", "--git-dir"));
  const applying = join(gitDir, "rebase-apply", "applying");
  assert.equal(existsSync(applying), true);

  await tx.rollback();

  assert.equal(existsSync(applying), true);
  git(local, "am", "--abort");
});

// --- Worktree-кандидат апдейта (buildCandidate/promoteCandidate) ---------------------------

const FAKE_BUILD =
  "node -e \"const f=require('node:fs');f.mkdirSync('.output/server',{recursive:true});" +
  "f.writeFileSync('.output/server/marker.txt',f.readFileSync('tracked.txt','utf8').trim())\"";

type CandidateFixture = {
  temp: string;
  remote: string;
  seed: string;
  local: string;
  data: string;
};

function candidateFixture({
  buildScript = FAKE_BUILD,
}: { buildScript?: string } = {}): CandidateFixture {
  const temp = mkdtempSync(join(tmpdir(), "iva-update-candidate-"));
  const remote = join(temp, "remote.git");
  const seed = join(temp, "seed");
  const local = join(temp, "local");
  const data = join(temp, "data");
  git(temp, "init", "--bare", remote);
  git(temp, "init", "-b", "main", seed);
  configureGit(seed);
  writeFileSync(
    join(seed, ".gitignore"),
    ".env\n.output\n/.iva-update/\nnode_modules\n",
  );
  writeFileSync(
    join(seed, "package.json"),
    JSON.stringify({
      name: "fixture",
      version: "1.0.0",
      scripts: { build: buildScript, "build:core": buildScript },
    }),
  );
  writeFileSync(join(seed, "tracked.txt"), "base\n");
  git(seed, "add", ".");
  git(seed, "commit", "-m", "base");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-u", "origin", "main");
  git(temp, "clone", "--branch", "main", remote, local);
  configureGit(local);
  mkdirSync(data, { recursive: true });
  mkdirSync(join(local, ".output/server"), { recursive: true });
  writeFileSync(join(local, ".output/server/marker.txt"), "live");
  mkdirSync(join(local, "node_modules"), { recursive: true });
  return { temp, remote, seed, local, data };
}

function pushUpstream(
  seed: string,
  mutate: (seed: string) => void,
  message: string,
): string {
  mutate(seed);
  git(seed, "add", ".");
  git(seed, "commit", "-m", message);
  git(seed, "push", "origin", "main");
  return git(seed, "rev-parse", "HEAD");
}

function candidateTx({ local, temp, data }: CandidateFixture) {
  return createUpdateTransaction({
    root: local,
    dataDir: data,
    envPath: join(local, ".env"),
    logFile: join(temp, "log"),
  });
}

test("update candidate builds in a worktree and is promoted after a clean fast-forward", async () => {
  const fx = candidateFixture();
  const target = pushUpstream(
    fx.seed,
    (seed) => {
      writeFileSync(join(seed, "tracked.txt"), "v2\n");
    },
    "bump",
  );
  const tx = candidateTx(fx);
  await tx.protect();
  const update = await tx.resolveTarget();
  assert.equal(update.plan, "fast-forward");
  const candidate = await tx.buildCandidate({ npm: "npm" });
  assert.ok(candidate, "clean fast-forward must produce a candidate");
  assert.equal(
    readFileSync(join(fx.local, ".output/server/marker.txt"), "utf8"),
    "live",
  );
  await tx.fetchAndIntegrate();
  assert.equal(await tx.promoteCandidate(), true);
  await tx.commit();
  await tx.teardownCandidate();
  assert.equal(git(fx.local, "rev-parse", "HEAD"), target);
  assert.equal(
    readFileSync(join(fx.local, ".output/server/marker.txt"), "utf8"),
    "v2",
  );
  assert.equal(existsSync(join(fx.local, ".iva-update")), false);
  assert.equal(git(fx.local, "stash", "list"), "");
  assert.equal(git(fx.local, "worktree", "list").split("\n").length, 1);
});

test("canonical authored customizations build from data while the live checkout stays clean", async () => {
  const fx = candidateFixture({
    buildScript:
      "node -e \"const f=require('node:fs');f.mkdirSync('.output/server',{recursive:true});" +
      "f.writeFileSync('.output/server/marker.txt',f.readFileSync('agent/instructions.md','utf8').trim())\"",
  });
  mkdirSync(join(fx.seed, "agent/skills/stock"), { recursive: true });
  writeFileSync(join(fx.seed, "agent/instructions.md"), "stock voice\n");
  writeFileSync(join(fx.seed, "agent/skills/stock/SKILL.md"), "stock skill\n");
  git(fx.seed, "add", ".");
  git(fx.seed, "commit", "-m", "add authored core");
  git(fx.seed, "push", "origin", "main");
  git(fx.local, "pull", "--ff-only");

  writeFileSync(join(fx.local, "agent/instructions.md"), "my voice\n");
  // Скилл пользователь пишет прямо в data/custom — оттуда его читает резолвер, и
  // обновление ядра его не касается.
  mkdirSync(join(fx.data, "custom/agent/skills/local"), { recursive: true });
  writeFileSync(
    join(fx.data, "custom/agent/skills/local/SKILL.md"),
    "local skill\n",
  );
  const target = pushUpstream(
    fx.seed,
    (seed) => writeFileSync(join(seed, "new-core.txt"), "new core\n"),
    "update core",
  );

  const tx = candidateTx(fx);
  await tx.protect();
  await tx.resolveTarget();
  const candidate = await tx.buildCandidate({ npm: "npm" });
  assert.ok(candidate);
  assert.equal(candidate.customization, "applied");
  await tx.fetchAndIntegrate();
  const restored = await tx.restoreLocalChanges();
  assert.equal(restored.status, "applied");
  assert.equal(await tx.promoteCandidate(), true);
  await tx.commit();
  await tx.teardownCandidate();

  assert.equal(git(fx.local, "rev-parse", "HEAD"), target);
  assert.equal(
    readFileSync(join(fx.local, "agent/instructions.md"), "utf8"),
    "stock voice\n",
  );
  assert.equal(
    existsSync(join(fx.local, "agent/skills/local/SKILL.md")),
    false,
    "the skill is served from data/custom; the updated tree never gets a copy",
  );
  assert.equal(
    readFileSync(join(fx.data, "custom/agent/instructions.md"), "utf8"),
    "my voice\n",
  );
  assert.equal(
    readFileSync(join(fx.data, "custom/agent/skills/local/SKILL.md"), "utf8"),
    "local skill\n",
    "the user's skill survives the update untouched",
  );
  assert.equal(
    readFileSync(join(fx.local, ".output/server/marker.txt"), "utf8"),
    "my voice",
  );
  assert.equal(git(fx.local, "status", "--porcelain=v1"), "");
  assert.equal(git(fx.local, "stash", "list"), "");
});

test("an authored conflict activates new core and stays recoverable from the canonical layer", async () => {
  const fx = candidateFixture({
    buildScript:
      "node -e \"const f=require('node:fs');f.mkdirSync('.output/server',{recursive:true});" +
      "f.writeFileSync('.output/server/marker.txt',f.readFileSync('agent/instructions.md','utf8').trim())\"",
  });
  mkdirSync(join(fx.seed, "agent"), { recursive: true });
  writeFileSync(join(fx.seed, "agent/instructions.md"), "stock voice\n");
  git(fx.seed, "add", ".");
  git(fx.seed, "commit", "-m", "add authored core");
  git(fx.seed, "push", "origin", "main");
  git(fx.local, "pull", "--ff-only");
  writeFileSync(join(fx.local, "agent/instructions.md"), "my voice\n");
  const target = pushUpstream(
    fx.seed,
    (seed) =>
      writeFileSync(join(seed, "agent/instructions.md"), "upstream voice\n"),
    "update authored core",
  );

  const tx = candidateTx(fx);
  await tx.protect();
  await tx.resolveTarget();
  const candidate = await tx.buildCandidate({ npm: "npm" });
  assert.ok(candidate);
  assert.equal(candidate.customization, "conflicted");
  assert.deepEqual(candidate.conflicts, ["agent/instructions.md"]);
  await tx.fetchAndIntegrate();
  const restored = await tx.restoreLocalChanges();
  assert.equal(restored.status, "conflicted");
  assert.deepEqual(
    restored.conflicts.map(({ path }) => path),
    ["agent/instructions.md"],
  );
  assert.equal(await tx.promoteCandidate(), true);
  await tx.commit();
  await tx.teardownCandidate();

  assert.equal(git(fx.local, "rev-parse", "HEAD"), target);
  assert.equal(
    readFileSync(join(fx.local, "agent/instructions.md"), "utf8"),
    "upstream voice\n",
  );
  assert.equal(
    readFileSync(join(fx.data, "custom/agent/instructions.md"), "utf8"),
    "my voice\n",
  );
  assert.equal(
    readFileSync(join(fx.local, ".output/server/marker.txt"), "utf8"),
    "upstream voice",
  );
  assert.equal(
    JSON.parse(readFileSync(join(restored.recoveryDir, "report.json"), "utf8"))
      .schema,
    "iva-update-conflicts/v1",
  );
  assert.equal(git(fx.local, "status", "--porcelain=v1"), "");
  assert.equal(
    git(fx.local, "stash", "list", "--format=%H"),
    restored.stashOid,
    "the full recovery stash remains available while the conflict is unresolved",
  );
});

test("an invalid custom manifest falls back to new core with a recovery bundle", async () => {
  const fx = candidateFixture();
  mkdirSync(join(fx.data, "custom"), { recursive: true });
  writeFileSync(join(fx.data, "custom/manifest.json"), "{broken json\n");
  const target = pushUpstream(
    fx.seed,
    (seed) => writeFileSync(join(seed, "tracked.txt"), "v2\n"),
    "update core",
  );

  const tx = candidateTx(fx);
  await tx.protect();
  await tx.resolveTarget();
  const candidate = await tx.buildCandidate({ npm: "npm" });
  assert.ok(candidate);
  assert.equal(candidate.customization, "fallback");
  await tx.fetchAndIntegrate();
  const restored = await tx.restoreLocalChanges();
  assert.equal(restored.status, "preserved");
  assert.equal(await tx.promoteCandidate(), true);
  await tx.commit();
  await tx.teardownCandidate();

  assert.equal(git(fx.local, "rev-parse", "HEAD"), target);
  assert.equal(
    readFileSync(join(fx.local, ".output/server/marker.txt"), "utf8"),
    "v2",
  );
  assert.equal(
    JSON.parse(readFileSync(join(restored.recoveryDir, "report.json"), "utf8"))
      .reason,
    "custom-layer-invalid",
  );
  assert.equal(
    readFileSync(join(fx.data, "custom/manifest.json"), "utf8"),
    "{broken json\n",
  );
});

test("a canonical customization that does not build stays inactive and recoverable", async () => {
  const fx = candidateFixture({
    buildScript:
      "node -e \"const f=require('node:fs');const v=f.readFileSync('agent/instructions.md','utf8').trim();" +
      "if(v==='broken local'){process.exit(1)}f.mkdirSync('.output/server',{recursive:true});" +
      "f.writeFileSync('.output/server/marker.txt',v)\"",
  });
  mkdirSync(join(fx.seed, "agent"), { recursive: true });
  writeFileSync(join(fx.seed, "agent/instructions.md"), "stock voice\n");
  git(fx.seed, "add", ".");
  git(fx.seed, "commit", "-m", "add authored core");
  git(fx.seed, "push", "origin", "main");
  git(fx.local, "pull", "--ff-only");
  writeFileSync(join(fx.local, "agent/instructions.md"), "broken local\n");
  pushUpstream(
    fx.seed,
    (seed) => writeFileSync(join(seed, "new-core.txt"), "new core\n"),
    "update core",
  );

  const tx = candidateTx(fx);
  await tx.protect();
  await tx.resolveTarget();
  const candidate = await tx.buildCandidate({ npm: "npm" });
  assert.ok(candidate);
  assert.equal(candidate.customization, "fallback");
  await tx.fetchAndIntegrate();
  const restored = await tx.restoreLocalChanges();
  assert.equal(restored.status, "preserved");
  assert.equal(await tx.promoteCandidate(), true);
  await tx.commit();
  await tx.teardownCandidate();

  assert.equal(
    readFileSync(join(fx.local, ".output/server/marker.txt"), "utf8"),
    "stock voice",
  );
  const manifest = JSON.parse(
    readFileSync(join(fx.data, "custom/manifest.json"), "utf8"),
  );
  assert.ok(manifest.entries["agent/instructions.md"].conflict);
  assert.equal(
    readFileSync(join(fx.data, "custom/agent/instructions.md"), "utf8"),
    "broken local\n",
  );
  assert.equal(git(fx.local, "status", "--porcelain=v1"), "");
  assert.equal(
    readFileSync(join(fx.local, "agent/instructions.md"), "utf8"),
    "stock voice\n",
  );
});

test("dirty update activates the new build and archives conflicting HTML", async () => {
  const fx = candidateFixture({
    buildScript:
      "node -e \"const f=require('node:fs');f.mkdirSync('.output/server',{recursive:true});" +
      "f.writeFileSync('.output/server/marker.txt',f.readFileSync('agent.txt','utf8').trim())\"",
  });
  writeFileSync(join(fx.seed, "agent.txt"), "stock agent\n");
  mkdirSync(join(fx.seed, "docs/ru"), { recursive: true });
  writeFileSync(join(fx.seed, "docs/index.html"), "stock en\n");
  writeFileSync(join(fx.seed, "docs/ru/index.html"), "stock ru\n");
  git(fx.seed, "add", ".");
  git(fx.seed, "commit", "-m", "add authored fixture");
  git(fx.seed, "push", "origin", "main");
  git(fx.local, "pull", "--ff-only");

  writeFileSync(join(fx.local, "agent.txt"), "local agent\n");
  writeFileSync(join(fx.local, "docs/index.html"), "local en\n");
  writeFileSync(join(fx.local, "docs/ru/index.html"), "local ru\n");
  const target = pushUpstream(
    fx.seed,
    (seed) => {
      writeFileSync(join(seed, "docs/index.html"), "upstream en\n");
      writeFileSync(join(seed, "docs/ru/index.html"), "upstream ru\n");
    },
    "update core and docs",
  );

  const tx = candidateTx(fx);
  await tx.protect();
  await tx.resolveTarget();
  const candidate = await tx.buildCandidate({ npm: "npm" });
  assert.ok(candidate, "dirty fast-forward must still produce a candidate");
  await tx.fetchAndIntegrate();
  const restored = await tx.restoreLocalChanges();
  assert.equal(restored.status, "conflicted");
  assert.deepEqual(
    restored.conflicts.map(({ path }) => path),
    ["docs/index.html", "docs/ru/index.html"],
  );
  assert.equal(await tx.promoteCandidate(), true);
  await tx.commit();
  await tx.teardownCandidate();

  assert.equal(git(fx.local, "rev-parse", "HEAD"), target);
  assert.equal(
    readFileSync(join(fx.local, ".output/server/marker.txt"), "utf8"),
    "local agent",
  );
  assert.equal(
    readFileSync(join(fx.local, "docs/index.html"), "utf8"),
    "upstream en\n",
  );
  assert.equal(
    readFileSync(join(fx.local, "docs/ru/index.html"), "utf8"),
    "upstream ru\n",
  );
  assert.equal(
    readFileSync(join(restored.recoveryDir, "base/docs/index.html"), "utf8"),
    "stock en\n",
  );
  assert.equal(
    readFileSync(join(restored.recoveryDir, "local/docs/index.html"), "utf8"),
    "local en\n",
  );
  assert.equal(
    readFileSync(
      join(restored.recoveryDir, "upstream/docs/index.html"),
      "utf8",
    ),
    "upstream en\n",
  );
  assert.equal(existsSync(join(restored.recoveryDir, "changes.patch")), true);
  assert.equal(existsSync(join(restored.recoveryDir, "report.json")), true);
  assert.notEqual(
    git(fx.local, "stash", "list"),
    "",
    "a recovery stash is retained until the user resolves the conflict",
  );
  assert.doesNotMatch(
    git(fx.local, "status", "--porcelain=v1"),
    /^(UU|AA|DD|AU|UA|DU|UD) /m,
  );
});

test("an untracked path claimed upstream preserves the local copy and activates core", async () => {
  const fx = candidateFixture();
  writeFileSync(join(fx.local, "claimed.txt"), "local untracked\n");
  const target = pushUpstream(
    fx.seed,
    (seed) => writeFileSync(join(seed, "claimed.txt"), "upstream tracked\n"),
    "claim local path",
  );

  const tx = candidateTx(fx);
  await tx.protect();
  await tx.resolveTarget();
  const candidate = await tx.buildCandidate({ npm: "npm" });
  assert.ok(candidate);
  assert.equal(candidate.customization, "fallback");
  await tx.fetchAndIntegrate();
  const restored = await tx.restoreLocalChanges();
  assert.ok(restored.status === "preserved");
  assert.equal(await tx.promoteCandidate(), true);
  await tx.commit();
  await tx.teardownCandidate();

  assert.equal(git(fx.local, "rev-parse", "HEAD"), target);
  assert.equal(
    readFileSync(join(fx.local, "claimed.txt"), "utf8"),
    "upstream tracked\n",
  );
  assert.equal(
    JSON.parse(readFileSync(join(restored.recoveryDir, "report.json"), "utf8"))
      .reason,
    "stash-apply-failed",
  );
  assert.notEqual(git(fx.local, "stash", "list"), "");
});

test("conflict resolution treats a pathspec-shaped filename literally", async () => {
  const fx = candidateFixture({
    buildScript:
      "node -e \"const f=require('node:fs');f.mkdirSync('.output/server',{recursive:true});" +
      "f.writeFileSync('.output/server/marker.txt',f.readFileSync('agent.txt','utf8').trim())\"",
  });
  const magicPath = ":(glob)**";
  writeFileSync(join(fx.seed, magicPath), "stock magic\n");
  writeFileSync(join(fx.seed, "agent.txt"), "stock agent\n");
  git(fx.seed, "add", ".");
  git(fx.seed, "commit", "-m", "add literal pathspec fixture");
  git(fx.seed, "push", "origin", "main");
  git(fx.local, "pull", "--ff-only");
  writeFileSync(join(fx.local, magicPath), "local magic\n");
  writeFileSync(join(fx.local, "agent.txt"), "local agent\n");
  pushUpstream(
    fx.seed,
    (seed) => writeFileSync(join(seed, magicPath), "upstream magic\n"),
    "conflict literal pathspec",
  );

  const tx = candidateTx(fx);
  await tx.protect();
  await tx.resolveTarget();
  const candidate = await tx.buildCandidate({ npm: "npm" });
  assert.ok(candidate);
  await tx.fetchAndIntegrate();
  const restored = await tx.restoreLocalChanges();
  assert.ok(restored.status === "conflicted");
  assert.deepEqual(
    restored.conflicts.map(({ path }) => path),
    [magicPath],
  );
  assert.equal(await tx.promoteCandidate(), true);
  await tx.commit();
  await tx.teardownCandidate();

  assert.equal(
    readFileSync(join(fx.local, ".output/server/marker.txt"), "utf8"),
    "local agent",
  );
  assert.equal(
    readFileSync(join(fx.local, "agent.txt"), "utf8"),
    "local agent\n",
  );
});

test("a broken local customization falls back to the verified new core", async () => {
  const fx = candidateFixture({
    buildScript:
      "node -e \"const f=require('node:fs');const v=f.readFileSync('agent.txt','utf8').trim();" +
      "if(v==='broken local'){process.exit(1)}f.mkdirSync('.output/server',{recursive:true});" +
      "f.writeFileSync('.output/server/marker.txt',v)\"",
  });
  writeFileSync(join(fx.seed, "agent.txt"), "stock agent\n");
  git(fx.seed, "add", "agent.txt");
  git(fx.seed, "commit", "-m", "add agent fixture");
  git(fx.seed, "push", "origin", "main");
  git(fx.local, "pull", "--ff-only");
  writeFileSync(join(fx.local, "agent.txt"), "broken local\n");
  const target = pushUpstream(
    fx.seed,
    (seed) => writeFileSync(join(seed, "upstream.txt"), "new core\n"),
    "update core",
  );

  const tx = candidateTx(fx);
  await tx.protect();
  await tx.resolveTarget();
  const candidate = await tx.buildCandidate({ npm: "npm" });
  assert.ok(candidate);
  assert.equal(candidate.customization, "fallback");
  await tx.fetchAndIntegrate();
  const restored = await tx.restoreLocalChanges();
  assert.ok(restored.status === "preserved");
  assert.equal(await tx.promoteCandidate(), true);
  await tx.commit();
  await tx.teardownCandidate();

  assert.equal(git(fx.local, "rev-parse", "HEAD"), target);
  assert.equal(
    readFileSync(join(fx.local, "agent.txt"), "utf8"),
    "stock agent\n",
  );
  assert.equal(
    readFileSync(join(fx.local, ".output/server/marker.txt"), "utf8"),
    "stock agent",
  );
  assert.equal(
    JSON.parse(readFileSync(join(restored.recoveryDir, "report.json"), "utf8"))
      .reason,
    "custom-build-failed",
  );
  assert.notEqual(git(fx.local, "stash", "list"), "");
});

test("a custom build with no output keeps the verified clean candidate", async () => {
  const fx = candidateFixture();
  const pkg = JSON.parse(readFileSync(join(fx.local, "package.json"), "utf8"));
  pkg.scripts["build:core"] = 'node -e "process.exit(0)"';
  writeFileSync(join(fx.local, "package.json"), JSON.stringify(pkg));
  const target = pushUpstream(
    fx.seed,
    (seed) => writeFileSync(join(seed, "core.txt"), "new core\n"),
    "update core",
  );

  const tx = candidateTx(fx);
  await tx.protect();
  await tx.resolveTarget();
  const candidate = await tx.buildCandidate({ npm: "npm" });
  assert.ok(candidate);
  assert.equal(candidate.customization, "fallback");
  await tx.fetchAndIntegrate();
  const restored = await tx.restoreLocalChanges();
  assert.ok(restored.status === "preserved");
  assert.equal(await tx.promoteCandidate(), true);
  await tx.commit();
  await tx.teardownCandidate();

  assert.equal(git(fx.local, "rev-parse", "HEAD"), target);
  assert.equal(
    readFileSync(join(fx.local, ".output/server/marker.txt"), "utf8"),
    "base",
  );
});

test("broken candidate build aborts before the live checkout is touched", async () => {
  const fx = candidateFixture();
  pushUpstream(
    fx.seed,
    (seed) => {
      const pkg = JSON.parse(readFileSync(join(seed, "package.json"), "utf8"));
      pkg.version = "1.1.0";
      pkg.scripts["build:core"] = 'node -e "process.exit(1)"';
      writeFileSync(join(seed, "package.json"), JSON.stringify(pkg));
    },
    "broken build",
  );
  const baseline = git(fx.local, "rev-parse", "HEAD");
  const tx = candidateTx(fx);
  await tx.protect();
  await tx.resolveTarget();
  await assert.rejects(
    () => tx.buildCandidate({ npm: "npm" }),
    /candidate build failed/,
  );
  assert.equal(tx.outputTouched, false);
  await tx.rollback();
  assert.equal(git(fx.local, "rev-parse", "HEAD"), baseline);
  assert.equal(
    readFileSync(join(fx.local, ".output/server/marker.txt"), "utf8"),
    "live",
  );
  assert.equal(existsSync(join(fx.local, ".iva-update")), false);
});

test("changed lockfile installs candidate dependencies and promotes fresh node_modules", async () => {
  const fx = candidateFixture();
  const npmLock = (cwd: string) =>
    execFileSync(
      "npm",
      ["install", "--package-lock-only", "--no-audit", "--no-fund"],
      { cwd, encoding: "utf8" },
    );
  const writeDep = (seed: string, version: string) => {
    mkdirSync(join(seed, "dep"), { recursive: true });
    writeFileSync(
      join(seed, "dep/package.json"),
      JSON.stringify({ name: "dep", version }),
    );
  };
  writeDep(fx.seed, "1.0.0");
  const pkg = JSON.parse(readFileSync(join(fx.seed, "package.json"), "utf8"));
  pkg.dependencies = { dep: "file:dep" };
  writeFileSync(join(fx.seed, "package.json"), JSON.stringify(pkg));
  npmLock(fx.seed);
  git(fx.seed, "add", ".");
  git(fx.seed, "commit", "-m", "lockfile");
  git(fx.seed, "push", "origin", "main");
  git(fx.local, "pull", "--ff-only");
  mkdirSync(join(fx.local, "node_modules"), { recursive: true });
  writeFileSync(join(fx.local, "node_modules/sentinel.txt"), "old-deps");
  pushUpstream(
    fx.seed,
    (seed) => {
      const bumped = JSON.parse(
        readFileSync(join(seed, "package.json"), "utf8"),
      );
      bumped.version = "1.1.0";
      writeFileSync(join(seed, "package.json"), JSON.stringify(bumped));
      writeDep(seed, "1.1.0");
      npmLock(seed);
    },
    "bump deps",
  );
  const tx = candidateTx(fx);
  await tx.protect();
  await tx.resolveTarget();
  const candidate = await tx.buildCandidate({ npm: "npm" });
  assert.ok(candidate);
  assert.equal(candidate.depsChanged, true);
  await tx.fetchAndIntegrate();
  assert.equal(await tx.promoteCandidate(), true);
  assert.equal(existsSync(join(fx.local, "node_modules/sentinel.txt")), false);
  assert.equal(existsSync(join(fx.local, "node_modules/dep")), true);
  await tx.commit();
  await tx.teardownCandidate();
  assert.equal(
    readFileSync(join(fx.local, ".output/server/marker.txt"), "utf8"),
    "base",
  );
  const leftovers = readdirSync(fx.local).filter((name) =>
    name.startsWith("node_modules.iva-backup-"),
  );
  assert.deepEqual(leftovers, []);
});

test("rollback removes promoted dependencies when the old install had none", async () => {
  const fx = candidateFixture();
  const npmLock = (cwd: string) =>
    execFileSync(
      "npm",
      ["install", "--package-lock-only", "--no-audit", "--no-fund"],
      { cwd, encoding: "utf8" },
    );
  const writeDep = (seed: string, version: string) => {
    mkdirSync(join(seed, "dep"), { recursive: true });
    writeFileSync(
      join(seed, "dep/package.json"),
      JSON.stringify({ name: "dep", version }),
    );
  };
  writeDep(fx.seed, "1.0.0");
  const pkg = JSON.parse(readFileSync(join(fx.seed, "package.json"), "utf8"));
  pkg.dependencies = { dep: "file:dep" };
  writeFileSync(join(fx.seed, "package.json"), JSON.stringify(pkg));
  npmLock(fx.seed);
  git(fx.seed, "add", ".");
  git(fx.seed, "commit", "-m", "lockfile");
  git(fx.seed, "push", "origin", "main");
  git(fx.local, "pull", "--ff-only");
  rmSync(join(fx.local, "node_modules"), { recursive: true, force: true });
  writeDep(fx.seed, "1.1.0");
  npmLock(fx.seed);
  git(fx.seed, "add", ".");
  git(fx.seed, "commit", "-m", "bump deps");
  git(fx.seed, "push", "origin", "main");

  const originalHead = git(fx.local, "rev-parse", "HEAD");
  const tx = candidateTx(fx);
  await tx.protect();
  await tx.resolveTarget();
  const candidate = await tx.buildCandidate({ npm: "npm" });
  assert.ok(candidate);
  assert.equal(candidate.depsChanged, true);
  await tx.fetchAndIntegrate();
  assert.equal(await tx.promoteCandidate(), true);
  assert.equal(existsSync(join(fx.local, "node_modules/dep")), true);
  await tx.rollback();
  await tx.teardownCandidate();

  assert.equal(git(fx.local, "rev-parse", "HEAD"), originalHead);
  assert.equal(existsSync(join(fx.local, "node_modules")), false);
  assert.equal(
    readFileSync(join(fx.local, ".output/server/marker.txt"), "utf8"),
    "live",
  );
});

test("local commits skip the candidate and keep the in-place path", async () => {
  const fx = candidateFixture();
  pushUpstream(
    fx.seed,
    (seed) => {
      writeFileSync(join(seed, "upstream.txt"), "upstream\n");
    },
    "upstream",
  );
  writeFileSync(join(fx.local, "local.txt"), "local\n");
  git(fx.local, "add", "local.txt");
  git(fx.local, "commit", "-m", "local commit");
  const tx = candidateTx(fx);
  await tx.protect();
  const update = await tx.resolveTarget();
  assert.equal(update.plan, "rebase");
  assert.equal(await tx.buildCandidate({ npm: "npm" }), null);
  const integrated = await tx.fetchAndIntegrate();
  assert.equal(integrated.changed, true);
  assert.equal(await tx.promoteCandidate(), false);
});

test("a post-commit failure reaches the chat with its secret redacted", async () => {
  const calls: TelegramCall[] = [];
  const fetchImpl: MockFetch = async (url, init) => {
    calls.push({ method: url.split("/").at(-1), body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: {} }),
    };
  };
  const reporter = createTelegramUpdateReporter({
    token: "token",
    job: { chatId: 1, messageId: 100, locale: "en" },
    env: {},
    fetchImpl,
  });
  assert.ok(reporter);
  const planted = `api_key=${"z".repeat(24)}`;

  await reporter.postCommitFailure(`systemctl refused: ${planted}`);
  reporter.dispose();

  const text = calls.at(-1)?.body.text ?? "";
  assert.match(text, /systemctl refused: \[REDACTED\]/);
  assert.doesNotMatch(text, /zzzz/);
});

// The build output an update dumps into the chat carries whatever the build printed -
// including a key in the shape this installation's provider actually issues.
test("a build failure carrying a real key shape is redacted the same way", async () => {
  const calls: TelegramCall[] = [];
  const fetchImpl: MockFetch = async (url, init) => {
    calls.push({ method: url.split("/").at(-1), body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: {} }),
    };
  };
  const reporter = createTelegramUpdateReporter({
    token: "token",
    job: { chatId: 1, messageId: 100, locale: "en" },
    env: {},
    fetchImpl,
  });
  assert.ok(reporter);
  const key = `sk-or-v1-${"4f9c1e77ab3d5602".repeat(4)}`;

  await reporter.postCommitFailure(
    `npm run build\n  provider check failed: ${key}\n  exit 1`,
  );
  reporter.dispose();

  const text = calls.at(-1)?.body.text ?? "";
  assert.match(text, /provider check failed: \[REDACTED\]/);
  assert.doesNotMatch(text, /sk-or-v1|4f9c1e77/);
});

// Реальный репортер, а не заглушка из теста апдейта: текст отказа собирается ЗДЕСЬ и берёт
// язык из job.locale — языка того, кто нажал /update, — а не из AGENT_LANGUAGE процесса CLI.
test("the update reporter refuses a bad provider in the language of the job", async () => {
  for (const [locale, expected] of [
    ["ru", /Сначала почини MODEL_PROVIDER в \.env \(iva config\)/u],
    ["en", /Fix MODEL_PROVIDER in \.env first \(iva config\)/u],
  ] as const) {
    const calls: TelegramCall[] = [];
    const fetchImpl: MockFetch = async (url, init) => {
      calls.push({
        method: url.split("/").at(-1),
        body: JSON.parse(init.body) as TelegramBody,
      });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };
    const reporter = createTelegramUpdateReporter({
      token: "token",
      job: { chatId: 1, messageId: 100, locale },
      env: {},
      fetchImpl,
    });
    assert.ok(reporter);

    await reporter.badProvider("ollmaa", "ollama, opencode, codex, openrouter");

    const text = calls.at(-1)?.body.text ?? "";
    assert.match(text, expected, locale);
    assert.match(text, /"ollmaa"/u, locale);
    assert.match(text, /ollama, opencode, codex, openrouter/u, locale);
    // Это финальный экран: он не должен остаться под лоадером фазы.
    assert.doesNotMatch(text, /Building Iva|Собираю Iva/u, locale);
  }
});

// Терминал причину падения печатал всегда, чат — нет: приходило голое «Couldn't build Iva»
// и «Retry: /update», по которому пользователь жал обновление снова и снова. Хвост причины
// (сообщение ошибки или конец health-лога) теперь едет вместе с отказом.
test("a failed build tells the chat why, redacted and trimmed", async () => {
  const calls: TelegramCall[] = [];
  const fetchImpl: MockFetch = async (url, init) => {
    calls.push({
      method: url.split("/").at(-1),
      body: JSON.parse(init.body) as TelegramBody,
    });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const reporter = createTelegramUpdateReporter({
    token: "token",
    job: { chatId: 1, messageId: 100, locale: "en" },
    env: {},
    fetchImpl,
  });
  assert.ok(reporter);

  await reporter.fail(
    "build",
    "0.3.19",
    'Invalid MODEL_PROVIDER "ollmaa"; expected one of: ollama, opencode, codex, openrouter — run: iva config',
  );

  const text = calls.at(-1)?.body.text ?? "";
  assert.match(text, /Couldn't build Iva/u);
  assert.match(text, /Invalid MODEL_PROVIDER "ollmaa"/u);
  assert.match(text, /iva config/u);
  assert.match(text, /0\.3\.19/u);
});

test("a failure detail is capped and passes the outbound gate", async () => {
  const calls: TelegramCall[] = [];
  const fetchImpl: MockFetch = async (url, init) => {
    calls.push({
      method: url.split("/").at(-1),
      body: JSON.parse(init.body) as TelegramBody,
    });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const reporter = createTelegramUpdateReporter({
    token: "token",
    job: { chatId: 1, messageId: 100, locale: "en" },
    env: {},
    fetchImpl,
  });
  assert.ok(reporter);

  // Хвост лога с ключом внутри: в чат уходит конец, и секрет в нём не переживает гейт.
  const secret = `sk-or-v1-${"a".repeat(48)}`;
  await reporter.fail("build", "0.3.19", `${"x".repeat(2000)}\nkey ${secret}`);

  const text = calls.at(-1)?.body.text ?? "";
  assert.equal(text.includes(secret), false);
  assert.equal(text.length < 900, true, String(text.length));

  // Без причины сообщение остаётся ровно таким, каким было.
  await reporter.fail("build", "0.3.19");
  const plain = calls.at(-1)?.body.text ?? "";
  assert.match(plain, /Couldn't build Iva/u);
  assert.doesNotMatch(plain, /xxxx/u);
});

// Команда репейра — единственное, что пользователю остаётся сделать, поэтому она обязана
// доехать до чата целиком: без обрезки хвостом, без разметки и на языке того, кто нажал.
test("the update reporter hands the repair command to the chat whole", async () => {
  for (const [locale, expected] of [
    ["ru", /Ваша Iva \(0\.3\.20\) слишком старая, чтобы обновиться сама\./u],
    ["en", /Your Iva \(0\.3\.20\) is too old to update itself\./u],
  ] as const) {
    const calls: TelegramCall[] = [];
    const fetchImpl: MockFetch = async (url, init) => {
      calls.push({
        method: url.split("/").at(-1),
        body: JSON.parse(init.body) as TelegramBody,
      });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };
    const reporter = createTelegramUpdateReporter({
      token: "token",
      job: { chatId: 1, messageId: 100, locale },
      env: {},
      fetchImpl,
    });
    assert.ok(reporter);

    await reporter.updaterTooOld("0.3.20");

    const body = calls.at(-1)?.body ?? {};
    const text = body.text ?? "";
    assert.match(text, expected, locale);
    assert.equal(text.includes(REPAIR_COMMAND), true, text);
    // Ни parse_mode, ни entities: любая разметка съела бы часть команды.
    assert.equal("parse_mode" in body, false, locale);
    assert.equal(body.entities, undefined, locale);
    // Это финальный экран, а не фаза под лоадером.
    assert.doesNotMatch(text, /Building Iva|Собираю Iva/u, locale);
    assert.doesNotMatch(text, /Retry: \/update|Повторить: \/update/u, locale);
  }
});
