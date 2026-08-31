import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import type {
  TelegramContext,
  TelegramInboundResultOrPromise,
  TelegramMessage,
} from "eve/channels/telegram";
import type { RouteHandlerArgs } from "eve/channels";
import {
  acquireLock,
  loadJsonStrict,
  releaseLock,
  saveJsonAtomic,
} from "./json-store.ts";
import { dataDir } from "./data-dir.ts";
import { chatKeyOf } from "./run-status.ts";
import { traceInboundOutcome } from "./trace.ts";
import { TELEGRAM_QUEUE_RECEIPT_FIELD } from "./telegram-parts.ts";

export const TELEGRAM_ACCEPTANCE_ROUTE = "/eve/v1/telegram/accepted";
export const TELEGRAM_ACCEPTANCE_KIND_HEADER = "x-iva-telegram-acceptance";
// Ответ на сообщение бота, чья сессия уже закрыта: eve не находит её по continuation-токену
// и падает навсегда. Bridge узнаёт этот класс по заголовку и хоронит апдейт вместо ретрая.
export const TELEGRAM_CLOSED_SESSION_KIND = "closed-session";

type ReceiptContext = { receipt: string | null; handled: boolean };
type CompletedLedger = { botId: string; updates: number[] };
type AcceptedWebhookOptions = { completedUpdatesFile?: string };
type AcceptedWebhookHandler<TState> = (
  request: Request,
  args: RouteHandlerArgs<TState>,
) => Promise<Response>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const receiptContext = new AsyncLocalStorage<ReceiptContext>();
const RECEIPT_PATTERN = /^[a-f0-9]{32}$/u;
const BOT_ID_PATTERN = /^(?<id>[1-9]\d*):/u;
const COMPLETED_UPDATES_LIMIT = 200;
let missingWebhookSecretReported = false;

function validReceipt(value: unknown): value is string {
  return typeof value === "string" && RECEIPT_PATTERN.test(value);
}

// TODO(ticket-04): closed-session detection (`isClosedSessionError` /
// `turnWithoutInputResponses`, formerly used to retry a reply-to-closed-session as
// a fresh turn) was removed here — it depended on intercepting `args.send`, which
// eve 0.47 no longer exposes on RouteHandlerArgs. See handleAcceptedTelegramWebhook
// below for the current (degraded) behavior.

function hasValidWebhookSecret(request: Request): boolean {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN;
  if (!expected) {
    if (!missingWebhookSecretReported) {
      console.error(
        "[telegram] TELEGRAM_WEBHOOK_SECRET_TOKEN не задан: durable deduplication отключена",
      );
      missingWebhookSecretReported = true;
    }
    return false;
  }
  const supplied = request.headers.get("x-telegram-bot-api-secret-token");
  if (!supplied) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}

function configuredBotId(): string | null {
  return (
    BOT_ID_PATTERN.exec(process.env.TELEGRAM_BOT_TOKEN ?? "")?.groups?.id ??
    null
  );
}

export function addTelegramQueueReceipt<T extends Record<string, unknown>>(
  update: T,
  receipt = randomBytes(16).toString("hex"),
): T {
  if (
    !isRecord(update) ||
    !isRecord(update.message) ||
    !validReceipt(receipt)
  ) {
    throw new Error(
      "Telegram queue receipt requires a message update and a 128-bit hex id",
    );
  }
  return {
    ...update,
    message: {
      ...update.message,
      [TELEGRAM_QUEUE_RECEIPT_FIELD]: receipt,
    },
  };
}

export function wrapTelegramQueueOnMessage(
  onMessage: (
    context: TelegramContext,
    message: TelegramMessage,
  ) => TelegramInboundResultOrPromise,
): (
  context: TelegramContext,
  message: TelegramMessage,
) => Promise<Awaited<TelegramInboundResultOrPromise>> {
  return async (context, message) => {
    const raw = message?.raw;
    const receipt =
      typeof raw === "object" &&
      raw !== null &&
      !Array.isArray(raw) &&
      validReceipt(raw[TELEGRAM_QUEUE_RECEIPT_FIELD])
        ? raw[TELEGRAM_QUEUE_RECEIPT_FIELD]
        : null;
    if (typeof raw === "object" && raw !== null) {
      Reflect.deleteProperty(raw, TELEGRAM_QUEUE_RECEIPT_FIELD);
    }

    const result = await onMessage(context, message);
    // Trace: чем кончился inbound-пайплайн и каким апдейтом вызван начинающийся ход.
    // Место выбрано снаружи пайплайна: только здесь видны и сообщение, и его результат,
    // а сам пайплайн остаётся с одной точкой журнала (ADR-0010).
    traceInboundOutcome(
      message,
      chatKeyOf(message.chat.id, message.messageThreadId),
      result?.context,
      result !== null && result !== undefined,
    );
    const active = receiptContext.getStore();
    if (result === null && receipt !== null && active?.receipt === receipt) {
      active.handled = true;
    }
    return result;
  };
}

async function metadataFromRequest(
  request: Request,
): Promise<{ receipt: string | null; updateId: number | null }> {
  try {
    const body: unknown = await request.clone().json();
    const receipt =
      isRecord(body) && isRecord(body.message)
        ? body.message[TELEGRAM_QUEUE_RECEIPT_FIELD]
        : undefined;
    return {
      receipt: validReceipt(receipt) ? receipt : null,
      updateId:
        isRecord(body) &&
        typeof body.update_id === "number" &&
        Number.isSafeInteger(body.update_id) &&
        body.update_id >= 0
          ? body.update_id
          : null,
    };
  } catch {
    return { receipt: null, updateId: null };
  }
}

function validCompletedLedger(value: unknown): CompletedLedger {
  if (
    !isRecord(value) ||
    typeof value.botId !== "string" ||
    !Array.isArray(value.updates) ||
    !value.updates.every((id) => Number.isSafeInteger(id) && id >= 0)
  ) {
    throw new Error("completed Telegram update ledger has invalid schema");
  }
  return value as CompletedLedger;
}

async function loadCompletedLedger(
  file: string,
  botId: string,
): Promise<{ ledger: CompletedLedger; recovered: boolean }> {
  try {
    return {
      ledger: validCompletedLedger(
        await loadJsonStrict(file, { botId, updates: [] }),
      ),
      recovered: false,
    };
  } catch (error) {
    const message =
      error !== null && typeof error === "object" && "message" in error
        ? String(error.message)
        : String(error);
    if (
      !message.includes("damaged (invalid JSON)") &&
      !message.includes("ledger has invalid schema")
    ) {
      throw error;
    }
    console.error(
      `[telegram] ledger завершённых update пересоздан: ${message}`,
    );
    return { ledger: { botId, updates: [] }, recovered: true };
  }
}

async function withCompletedLedger<T>(
  file: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lock = `${file}.lock`;
  const token = await acquireLock(lock);
  try {
    return await fn();
  } finally {
    releaseLock(lock, token);
  }
}

async function hasCompletedUpdate(
  file: string,
  botId: string,
  updateId: number,
): Promise<boolean> {
  return withCompletedLedger(file, async () => {
    const { ledger, recovered } = await loadCompletedLedger(file, botId);
    if (recovered) await saveJsonAtomic(file, ledger);
    return ledger.botId === botId && ledger.updates.includes(updateId);
  });
}

async function recordCompletedUpdate(
  file: string,
  botId: string,
  updateId: number,
): Promise<void> {
  return withCompletedLedger(file, async () => {
    const { ledger, recovered } = await loadCompletedLedger(file, botId);
    const current = ledger.botId === botId ? ledger.updates : [];
    const updates = current.includes(updateId)
      ? current
      : [...current, updateId].slice(-COMPLETED_UPDATES_LIMIT);
    if (recovered || ledger.botId !== botId || updates !== current) {
      await saveJsonAtomic(file, { botId, updates });
    }
  });
}

// telegramChannel acknowledges webhooks before its waitUntil dispatch has called
// send(). The polling bridge needs a stronger receipt for durable FIFO replay:
// this wrapper runs the authored channel handler unchanged, but waits until its
// real Eve send has resolved before returning success.
export async function handleAcceptedTelegramWebhook<TState>(
  handler: AcceptedWebhookHandler<TState>,
  request: Request,
  args: RouteHandlerArgs<TState>,
  options: AcceptedWebhookOptions = {},
): Promise<Response> {
  const { receipt, updateId } = await metadataFromRequest(request);
  const authenticated = hasValidWebhookSecret(request);
  const botId = configuredBotId();
  const completedFile =
    options.completedUpdatesFile ?? join(dataDir(), "completed-updates.json");
  // Старые/нестандартные payload без update_id сохраняют прежний путь обработки.
  if (
    updateId !== null &&
    authenticated &&
    botId !== null &&
    (await hasCompletedUpdate(completedFile, botId, updateId))
  ) {
    return new Response(null, {
      status: 204,
      headers: { [TELEGRAM_ACCEPTANCE_KIND_HEADER]: "handled" },
    });
  }
  return receiptContext.run({ receipt, handled: false }, async () => {
    const background: Promise<unknown>[] = [];
    // TODO(ticket-04): eve 0.47 removed `send` from RouteHandlerArgs (dispatch now
    // goes through `from(address).send()`, which this route no longer receives
    // baked into `args`). The FIFO acceptance guarantee below used to intercept
    // `args.send` to confirm a real Eve send before acking the bridge, and to
    // detect a closed-session reply and retry it as a fresh turn. Neither hook
    // exists on this API anymore, so both are gone here: this now only reports
    // the receiptContext `handled` signal (untouched, unrelated to send). Ticket 04
    // rebuilds send-confirmation and closed-session detection on the new surface.
    // Until then this never claims `accepted`, so a real accepted send now falls
    // through to the transient 503 path below (safe: the bridge retries, ADR-0002)
    // instead of a false-positive 204.
    const wrappedArgs: RouteHandlerArgs<TState> = {
      ...args,
      waitUntil: (task: Promise<unknown>) => {
        background.push(Promise.resolve(task));
      },
    };
    const response = await handler(request, wrappedArgs);

    if (!response.ok) return response;
    await Promise.allSettled(background);
    const handled = receiptContext.getStore()?.handled === true;
    if (handled) {
      if (updateId !== null && authenticated && botId !== null) {
        try {
          await recordCompletedUpdate(completedFile, botId, updateId);
        } catch (error) {
          // Ход уже принят: ошибка ledger не должна вернуть 5xx и запустить тот же ход снова.
          console.error(
            "[telegram] не смог записать завершённый update:",
            error,
          );
        }
      }
      return new Response(null, {
        status: 204,
        headers: { [TELEGRAM_ACCEPTANCE_KIND_HEADER]: "handled" },
      });
    }
    return new Response("Telegram update was not accepted by Eve", {
      status: 503,
    });
  });
}
