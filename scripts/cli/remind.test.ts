import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { dispatchCli } from "./main.ts";
import {
  createRemindCommand,
  type RemindDependencies,
  type ReminderTurn,
} from "./remind.ts";
import { createCliRuntime } from "./runtime.ts";

// REPRODUCING A FAILURE: fast-check prints
// `Property failed after N tests { seed: -1234567, path: "12:3:0", endOnFailure: true }`.
// Pass seed and path to fc.assert to replay the same generated case and shrink path.
const RUNS = { numRuns: 500 };
const ROOT = "/tmp/iva-cli-remind-test";

type AgentOutcome = "ok" | "empty" | "failed" | "throw" | "timeout";
type SendResult = { ok: boolean; fellBack: boolean; error: string };
type SendCall = readonly [
  bot: string,
  chat: string,
  text: unknown,
  options: { readonly retryTransient?: boolean } | undefined,
];

function remindCommand(
  agentOutcome: AgentOutcome,
  sendResult: SendResult = { ok: true, fellBack: false, error: "" },
  env: NodeJS.ProcessEnv = {
    TELEGRAM_BOT_TOKEN: "bot-token",
    TELEGRAM_DIGEST_CHAT_ID: "555",
  },
) {
  const sent: SendCall[] = [];
  const prompts: string[] = [];
  const feedback: string[] = [];
  const closed: string[] = [];
  const read: string[] = [];
  const messages: string[] = [];
  let feedbackError: Error | undefined;
  let closeError: Error | undefined;
  const base = createCliRuntime(ROOT);
  const dependencies: RemindDependencies = {
    readEnv: (path) => {
      read.push(path);
      return Promise.resolve(env);
    },
    send: (bot, chat, md, options) => {
      sent.push([bot, chat, md, options]);
      return Promise.resolve(sendResult);
    },
    runAgentTurn: async (prompt): Promise<ReminderTurn> => {
      prompts.push(prompt);
      if (agentOutcome === "throw")
        return Promise.reject(new Error("eve unavailable"));
      try {
        if (agentOutcome === "timeout") await new Promise(() => {});
        if (agentOutcome === "failed")
          return { status: "failed", message: "ignore me" };
        if (agentOutcome === "empty") return { status: "waiting", message: "" };
        return {
          status: "waiting",
          message: "Короткое напоминание",
          feedback: (message) => {
            if (feedbackError) return Promise.reject(feedbackError);
            feedback.push(message);
            return Promise.resolve();
          },
        };
      } finally {
        closed.push("closed");
        if (closeError) {
          // Mirrors production cleanup: a failed reset never changes the turn.
        }
      }
    },
    timeoutMs: 1,
  };
  const cmdRemind = createRemindCommand(
    {
      ...base,
      ok: (message) => {
        messages.push(message);
      },
    },
    dependencies,
  );
  return {
    cmdRemind,
    closed,
    envPath: base.ENV_PATH,
    failFeedback: (error: Error) => {
      feedbackError = error;
    },
    failClose: (error: Error) => {
      closeError = error;
    },
    feedback,
    messages,
    prompts,
    read,
    sent,
  };
}

void test("a failed agent turn sends the raw Reminder once", async () => {
  const remind = remindCommand("failed");

  await remind.cmdRemind(["Позвонить", "врачу"]);

  assert.deepEqual(remind.read, [remind.envPath]);
  assert.equal(remind.prompts.length, 1);
  assert.deepEqual(remind.sent, [
    ["bot-token", "555", "⏰ Позвонить врачу", { retryTransient: true }],
  ]);
  assert.deepEqual(remind.messages, ["Reminder sent to Telegram"]);
});

void test("a plain fallback reports formatting feedback to the same turn", async () => {
  const remind = remindCommand("ok", {
    ok: true,
    fellBack: true,
    error: "400: bad entities",
  });

  await remind.cmdRemind(["Проверить", "задачу"]);

  assert.equal(remind.sent[0][2], "Короткое напоминание");
  assert.deepEqual(remind.feedback, [
    "The last reminder failed Telegram parse_mode=HTML (400: bad entities) and was sent as plain text — " +
      "format more simply next time: **bold**, `code`, lists, no raw HTML.",
  ]);
});

void test("a lost feedback turn does not fail a delivered Reminder", async () => {
  const remind = remindCommand("ok", {
    ok: true,
    fellBack: true,
    error: "400: bad entities",
  });
  remind.failFeedback(new Error("eve went away"));

  await remind.cmdRemind(["Проверить", "задачу"]);

  assert.equal(remind.sent.length, 1);
  assert.deepEqual(remind.messages, ["Reminder sent to Telegram"]);
});

void test("a refused Reminder send reports the Telegram error and exits one", async () => {
  const remind = remindCommand("ok", {
    ok: false,
    fellBack: false,
    error: "503: unavailable",
  });
  const events: string[] = [];

  await assert.rejects(
    dispatchCli(
      ["remind", "текст"],
      { remind: remind.cmdRemind },
      {
        bad: (message) => events.push(`bad:${message}`),
        help: assert.fail,
        exit: (code): never => {
          events.push(`exit:${code}`);
          throw new Error(`exit ${code}`);
        },
      },
    ),
    { message: "exit 1" },
  );

  assert.deepEqual(events, [
    "bad:Reminder Telegram send failed: 503: unavailable",
    "exit:1",
  ]);
  assert.equal(remind.sent.length, 1);
  assert.deepEqual(remind.closed, ["closed"]);
});

void test("a session reset failure does not fail a delivered Reminder", async () => {
  const remind = remindCommand("ok");
  remind.failClose(new Error("reset unavailable"));

  await remind.cmdRemind(["Проверить", "задачу"]);

  assert.equal(remind.sent[0][2], "Короткое напоминание");
  assert.deepEqual(remind.closed, ["closed"]);
  assert.deepEqual(remind.messages, ["Reminder sent to Telegram"]);
});

void test("a missing token or chat fails before the agent turn", async () => {
  for (const { env, expected } of [
    {
      env: { TELEGRAM_DIGEST_CHAT_ID: "555" },
      expected: "TELEGRAM_BOT_TOKEN is missing — run: iva config",
    },
    {
      env: {
        TELEGRAM_BOT_TOKEN: "bot-token",
        TELEGRAM_ALLOWED_USER_IDS: " , ",
      },
      expected:
        "No target chat — set TELEGRAM_DIGEST_CHAT_ID or TELEGRAM_ALLOWED_USER_IDS in .env",
    },
  ]) {
    const remind = remindCommand(
      "ok",
      { ok: true, fellBack: false, error: "" },
      env,
    );

    await assert.rejects(remind.cmdRemind(["текст"]), { message: expected });
    assert.deepEqual(remind.read, [remind.envPath]);
    assert.deepEqual(remind.prompts, []);
    assert.deepEqual(remind.sent, []);
  }
});

const reminderText = fc
  .string({ minLength: 1, maxLength: 60, unit: "grapheme" })
  .filter((value) => value.trim().length > 0);
const agentOutcome = fc.constantFrom<AgentOutcome>(
  "ok",
  "empty",
  "failed",
  "throw",
  "timeout",
);

void test("property: one content send chooses agent text or the raw fallback", async () => {
  await fc.assert(
    fc.asyncProperty(
      reminderText,
      agentOutcome,
      fc.boolean(),
      async (generatedText, outcome, sendOk) => {
        const remind = remindCommand(outcome, {
          ok: sendOk,
          fellBack: false,
          error: sendOk ? "" : "429: retry limit reached",
        });
        let thrown: unknown;

        try {
          await remind.cmdRemind([generatedText]);
        } catch (error) {
          thrown = error;
        }

        assert.equal(remind.sent.length, 1);
        assert.equal(remind.sent[0][3]?.retryTransient, true);
        const expectedText =
          outcome === "ok"
            ? "Короткое напоминание"
            : `⏰ ${generatedText.trim()}`;
        assert.equal(remind.sent[0][2], expectedText);
        assert.equal(
          String(remind.sent[0][2]).startsWith("⏰ "),
          outcome !== "ok",
        );
        assert.equal(thrown === undefined, sendOk);
      },
    ),
    RUNS,
  );
});

const whitespaceText = fc
  .array(fc.constantFrom(" ", "\t", "\n", "\r", "\u00a0", "\u2003"), {
    maxLength: 30,
  })
  .map((parts) => parts.join(""));

void test("property: empty Unicode whitespace fails before env, eve and Telegram", async () => {
  await fc.assert(
    fc.asyncProperty(whitespaceText, async (text) => {
      const remind = remindCommand("ok");

      await assert.rejects(remind.cmdRemind([text]), {
        message: "Nothing to send — usage: iva remind <text>",
      });
      assert.deepEqual(remind.read, []);
      assert.deepEqual(remind.prompts, []);
      assert.deepEqual(remind.sent, []);
    }),
    RUNS,
  );
});
