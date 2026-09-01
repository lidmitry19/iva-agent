// One Reminder, judged by an eve turn and delivered by the CLI. The command keeps every
// authored-tree import lazy so repair and doctor still load on a partial installation.
import { readEnvFresh } from "../lib/env-file.ts";
import { notificationChat } from "../lib/notification-chat.ts";
import { writtenInLanguage } from "../lib/notice-policy.ts";
import type { createCliRuntime } from "./runtime.ts";

type CliRuntime = ReturnType<typeof createCliRuntime>;
type SendTelegramHtml =
  typeof import("../lib/telegram-send.ts").sendTelegramHtml;

export type ReminderTurn = {
  readonly status: string;
  readonly message?: string;
  readonly feedback?: (message: string) => Promise<unknown>;
};

type RunAgentTurn = (prompt: string) => Promise<ReminderTurn>;
type Timeout = <T>(work: Promise<T>, timeoutMs: number) => Promise<T>;

export type RemindDependencies = {
  readonly readEnv?: typeof readEnvFresh;
  readonly send?: SendTelegramHtml;
  readonly runAgentTurn?: RunAgentTurn;
  readonly timeout?: Timeout;
  readonly timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

const deadline: Timeout = (work, timeoutMs) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Reminder turn timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    void work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });

async function runAgentTurn(prompt: string): Promise<ReminderTurn> {
  const { Client } = await import("eve/client");
  const port = process.env.IVA_PORT ?? "8723";
  const host = process.env.ASSISTANT_HOST ?? `http://127.0.0.1:${port}`;
  const bearer = process.env.ASSISTANT_BEARER;
  const client = new Client({
    host,
    ...(bearer ? { auth: { bearer: () => Promise.resolve(bearer) } } : {}),
  });
  const { response, session } = await client.sessions.create({
    message: prompt,
  });
  const result = await response.result();
  return {
    status: result.status,
    ...(typeof result.message === "string" ? { message: result.message } : {}),
    feedback: async (message) => session.send(message),
  };
}

/** Create the remind command without reading .env or touching eve at import time. */
export function createRemindCommand(
  runtime: CliRuntime,
  dependencies: RemindDependencies = {},
) {
  const { ENV_PATH, ok } = runtime;
  const readEnv = dependencies.readEnv ?? readEnvFresh;

  return async function cmdRemind(args: readonly string[] = []): Promise<void> {
    const text = args.join(" ").trim();
    if (!text) throw new Error("Nothing to send — usage: iva remind <text>");
    const env = await readEnv(ENV_PATH);
    const token = String(env.TELEGRAM_BOT_TOKEN ?? "").trim();
    if (!token)
      throw new Error("TELEGRAM_BOT_TOKEN is missing — run: iva config");
    const chat = notificationChat(env);
    if (!chat)
      throw new Error(
        "No target chat — set TELEGRAM_DIGEST_CHAT_ID or TELEGRAM_ALLOWED_USER_IDS in .env",
      );

    let turn: ReminderTurn | undefined;
    try {
      const { tr } = await import("#lib/i18n.ts");
      const prompt =
        `A one-time reminder fired: ${JSON.stringify(text)}. ` +
        "Check whether it is still relevant; the task may already be closed, so inspect tasks. " +
        "Formulate a short reminder message for the user and return it as the final text of this turn. " +
        `Return the text ${writtenInLanguage(tr)}. ` +
        "Do not send anything yourself: no rich messages and no Telegram tools. " +
        "Only the finished reminder text, no preamble.";
      const runner = dependencies.runAgentTurn ?? runAgentTurn;
      turn = await (dependencies.timeout ?? deadline)(
        runner(prompt),
        dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
    } catch {
      turn = undefined;
    }

    const agentMessage =
      turn?.status !== "failed" && turn?.message ? turn.message : undefined;
    const message = agentMessage ?? `⏰ ${text}`;
    const send =
      dependencies.send ??
      (await import("../lib/telegram-send.ts")).sendTelegramHtml;
    const result = await send(token, chat, message, { retryTransient: true });
    if (!result.ok)
      throw new Error(`Reminder Telegram send failed: ${result.error}`);
    if (agentMessage && result.fellBack && turn?.feedback) {
      // The Reminder is already delivered: a lost feedback turn must not fail the unit,
      // or the journal would claim a delivered Reminder was lost.
      try {
        await turn.feedback(
          `The last reminder failed Telegram parse_mode=HTML (${result.error}) and was sent as plain text — ` +
            "format more simply next time: **bold**, `code`, lists, no raw HTML.",
        );
      } catch {
        // Delivery succeeded; the formatting hint just will not reach this turn.
      }
    }
    ok("Reminder sent to Telegram");
  };
}
