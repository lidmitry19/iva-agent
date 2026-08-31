import { join } from "node:path";
import {
  clearQueueFileKey,
  loadQueueFile,
  writeQueueFileAtomic,
} from "../lib/telegram-queue.ts";
import type {
  TelegramQueueDocument,
  TelegramQueueMessage,
  TelegramQueueUpdate,
} from "../lib/telegram-queue.ts";
import {
  clearTelegramResetIntent,
  loadTelegramResetIntents,
  persistTelegramResetIntent,
} from "../lib/telegram-reset-intent.ts";
import {
  requestTelegramReset,
  telegramAddressFromChatKey,
  type TelegramResetTarget,
} from "../lib/telegram-reset.ts";
import {
  getChatStatus,
  listChatStatuses,
  RETIRED_SESSION_ROUTING_FIELD,
  RUN_STALE_MS,
  setChatStatus,
  setChatStatusIf,
} from "#lib/run-status.ts";
import { tr } from "#lib/i18n.ts";
import { DATA_DIR, SECRET, RESET_ROUTE, log } from "./config.ts";
import { tg } from "./transport.ts";

type ErrorLike = { message?: unknown; resetPhase?: string };
type RunStatus = Record<string, unknown> & {
  status?: unknown;
  generation?: unknown;
  updatedAt?: unknown;
  sessionId?: unknown;
  ingressId?: unknown;
  ingressAt?: unknown;
  statusMessageId?: unknown;
};
type ResetResult = { status?: unknown; [key: string]: unknown };
type ResetRequest = { chatKey: string; target: TelegramResetTarget };
type ResetRequestImpl = (request: ResetRequest) => Promise<ResetResult>;
type CompleteStateImpl = (
  chatKey: string,
  options: { clearQueue?: boolean },
) => Promise<void>;
type LogImpl = (...args: unknown[]) => void;
type QueueFileOptions = NonNullable<Parameters<typeof writeQueueFileAtomic>[2]>;
type StatusRecord = { chatKey?: unknown; status?: RunStatus | null };
type StatusImpl = (chatKey: string) => RunStatus | null;
type SetStatusIfImpl = (
  chatKey: string,
  expected: Record<string, unknown>,
  patch: Record<string, unknown>,
) => unknown;
export type QueuePhase =
  | { state: "delivering"; baselineGeneration: number }
  | {
      state: "awaiting-running";
      baselineGeneration: number;
      acceptedAt: number;
    }
  | { state: "running"; baselineGeneration: number; generation: number };

const errorMessage = (error: unknown) => (error as ErrorLike).message;
const withResetPhase = (error: unknown, resetPhase: string) => {
  (error as ErrorLike).resetPhase = resetPhase;
};

// ── Durable busy-time FIFO ──────────────────────────────────────────────────
// Each accepted Telegram update is written as a versioned item (including update_id and
// the untouched raw update) before its Telegram offset advances. The bridge then replays
// one head per idle chat/topic. It removes that head only after Eve accepts the webhook:
// a crash can duplicate the head, but cannot lose it or reorder later items around it.
const QUEUE_FILE = join(DATA_DIR, "telegram-queue.json");
const RESET_INTENT_DIR = join(DATA_DIR, "telegram-reset-intents");
const queueSettleUntil = new Map<string, number>();
const queueInFlight = new Map<string, QueuePhase>();
const queueDrainRotation: { afterKey: string | null } = { afterKey: null };
const undrainableLegacyLogged = new Set<string>();
const QUEUE_DELIVERY_TIMEOUT_MS = 5_000;
const QUEUE_DRAIN_BUDGET_MS = 5_000;

function statusGeneration(status: RunStatus | null | undefined): number {
  const generation = status?.generation;
  return Number.isSafeInteger(generation) && (generation as number) >= 0
    ? (generation as number)
    : 0;
}

export async function loadQueue({ strict = false }: { strict?: boolean } = {}) {
  const loaded = await loadQueueFile(QUEUE_FILE, { strict });
  if (loaded.quarantined) {
    log(
      `damaged Telegram queue moved to ${loaded.quarantined}:`,
      errorMessage(loaded.error),
    );
  }
  return loaded.document;
}

export async function writeQueueAtomic(
  queue: TelegramQueueDocument,
  options: QueueFileOptions = {},
) {
  await writeQueueFileAtomic(QUEUE_FILE, queue, options);
}

// A scoped reset intentionally discards only messages queued for this chat/topic.
// Other conversations keep both their queues and their Eve histories.
async function clearChatQueue(chatKey: string) {
  // Reset cleanup must fail loudly: completeScopedResetState keeps the old
  // running status until this atomic rewrite succeeds.
  await clearQueueFileKey(QUEUE_FILE, chatKey);
}

export async function completeScopedResetState(
  chatKey: string,
  {
    clearQueue = false,
    clearQueueImpl = clearChatQueue,
    setStatusImpl = setChatStatus,
  }: {
    clearQueue?: boolean;
    clearQueueImpl?: (chatKey: string) => Promise<void>;
    setStatusImpl?: (
      chatKey: string,
      patch: Record<string, unknown>,
    ) => unknown;
  } = {},
) {
  // For private chats the queue belongs to the reset session, so clear it
  // before exposing an idle tombstone. A failed cleanup leaves the old running
  // status in place and lets a repeated /new retry safely.
  if (clearQueue) await clearQueueImpl(chatKey);

  setStatusImpl(chatKey, {
    status: "idle",
    [RETIRED_SESSION_ROUTING_FIELD]: null,
    sessionId: null,
    turnId: null,
    statusMessageId: null,
    ingressId: null,
    ingressAt: null,
    statusAt: null,
    turnAt: null,
    firstOutputAt: null,
    latencyLogged: null,
    wasCancelled: null,
    resetAt: Date.now(),
  });
}

export async function persistPrivateResetIntent(
  chatKey: string,
) {
  return persistTelegramResetIntent(RESET_INTENT_DIR, chatKey);
}

export async function loadPrivateResetIntents() {
  return loadTelegramResetIntents(RESET_INTENT_DIR);
}

export async function clearPrivateResetIntent(chatKey: string) {
  return clearTelegramResetIntent(RESET_INTENT_DIR, chatKey);
}

const requestResetFromIntent: ResetRequestImpl = ({ target }) =>
  requestTelegramReset({
    url: RESET_ROUTE,
    secret: SECRET as string,
    target,
  });

export async function releaseScopedSession(
  chatKey: string,
  target: TelegramResetTarget,
  {
    requestResetImpl = requestResetFromIntent,
    logImpl = log,
  }: {
    requestResetImpl?: ResetRequestImpl;
    logImpl?: LogImpl;
  } = {},
) {
  let result;
  try {
    result = await requestResetImpl({ chatKey, target });
  } catch (error) {
    withResetPhase(error, "remote");
    throw error;
  }
  logResetOutcome(logImpl, chatKey, target, result);
  return result;
}

function logResetOutcome(
  logImpl: LogImpl,
  chatKey: string,
  target: TelegramResetTarget,
  result: ResetResult,
) {
  try {
    logImpl(
      `reset for chat ${chatKey} -> ${(result?.status as string | undefined) ?? "unknown"} (${"sessionId" in target ? target.sessionId : "address"})`,
    );
  } catch {
    // Журналирование не должно ронять сброс.
  }
}

export async function performScopedReset(
  chatKey: string,
  target: TelegramResetTarget,
  {
    clearQueue = false,
    persistIntentImpl = persistPrivateResetIntent,
    requestResetImpl = requestResetFromIntent,
    completeStateImpl = completeScopedResetState,
    clearIntentImpl = clearPrivateResetIntent,
    logImpl = log,
  }: {
    clearQueue?: boolean;
    persistIntentImpl?: (chatKey: string) => Promise<unknown>;
    requestResetImpl?: ResetRequestImpl;
    completeStateImpl?: CompleteStateImpl;
    clearIntentImpl?: (chatKey: string) => Promise<unknown>;
    logImpl?: LogImpl;
  } = {},
) {
  if (clearQueue) {
    try {
      await persistIntentImpl(chatKey);
    } catch (error) {
      withResetPhase(error, "intent");
      throw error;
    }
  }
  await releaseScopedSession(chatKey, target, {
    requestResetImpl,
    logImpl,
  });
  try {
    await completeStateImpl(chatKey, { clearQueue });
  } catch (error) {
    withResetPhase(error, "cleanup");
    throw error;
  }
  if (clearQueue) {
    try {
      await clearIntentImpl(chatKey);
    } catch (error) {
      withResetPhase(error, "intent-cleanup");
      throw error;
    }
  }
}

export async function reconcileScopedResetIntents({
  loadIntentsImpl = loadPrivateResetIntents,
  requestResetImpl = requestResetFromIntent,
  completeStateImpl = completeScopedResetState,
  clearIntentImpl = clearPrivateResetIntent,
  logImpl = log,
}: {
  loadIntentsImpl?: typeof loadPrivateResetIntents;
  requestResetImpl?: ResetRequestImpl;
  completeStateImpl?: CompleteStateImpl;
  clearIntentImpl?: (chatKey: string) => Promise<unknown>;
  logImpl?: LogImpl;
} = {}) {
  const intents = await loadIntentsImpl();
  for (const intent of intents) {
    const address = telegramAddressFromChatKey(intent.chatKey);
    if (address === null) {
      throw new Error(`invalid Telegram reset intent chat key: ${intent.chatKey}`);
    }
    const target = { address } as const;
    const result = await requestResetImpl({ chatKey: intent.chatKey, target });
    logResetOutcome(logImpl, intent.chatKey, target, result);
    await completeStateImpl(intent.chatKey, {
      clearQueue: true,
    });
    await clearIntentImpl(intent.chatKey);
  }
  return intents.length;
}

function telegramTargetOf(
  chatKey: string,
): { chat_id: string; message_thread_id?: number } | null {
  const separator = chatKey.indexOf(":");
  if (separator <= 0) return null;
  const chatId = chatKey.slice(0, separator);
  if (!/^-?\d+$/.test(chatId)) return null;
  const thread = chatKey.slice(separator + 1);
  if (thread === "") return { chat_id: chatId };
  if (!/^\d+$/.test(thread)) return null;
  const messageThreadId = Number(thread);
  if (!Number.isSafeInteger(messageThreadId) || messageThreadId <= 0)
    return null;
  return { chat_id: chatId, message_thread_id: messageThreadId };
}

async function sendStaleRunNotice(chatKey: string, text: string) {
  const target = telegramTargetOf(chatKey);
  if (!target) throw new Error(`invalid Telegram chat key: ${chatKey}`);
  const data = await tg("sendMessage", { ...target, text });
  const response = data as { ok?: unknown; description?: unknown } | null;
  if (!response?.ok)
    throw new Error(
      String(
        (response?.description as string | undefined) || "sendMessage failed",
      ),
    );
}

async function deleteStaleWorkingMessage(
  chatKey: string,
  messageId: string | number,
) {
  const target = telegramTargetOf(chatKey);
  if (!target) return;
  await tg("deleteMessage", {
    chat_id: target.chat_id,
    message_id: messageId,
  });
}

async function clearFailedDirectIngress(
  chatKey: string,
  {
    baselineGeneration,
    startedAt,
    statusImpl = getChatStatus,
    setStatusIfImpl = setChatStatusIf,
    deleteMessageImpl = deleteStaleWorkingMessage,
    now = Date.now,
  }: {
    baselineGeneration: number;
    startedAt: number;
    statusImpl?: StatusImpl;
    setStatusIfImpl?: SetStatusIfImpl;
    deleteMessageImpl?: (
      chatKey: string,
      messageId: string | number,
    ) => unknown;
    now?: () => number;
  },
) {
  const current = statusImpl(chatKey);
  const observedAt = now();
  if (
    current?.status !== "running" ||
    current.sessionId !== undefined ||
    typeof current.ingressId !== "string" ||
    typeof current.ingressAt !== "number" ||
    !Number.isFinite(current.ingressAt) ||
    current.ingressAt < startedAt ||
    current.ingressAt > observedAt ||
    statusGeneration(current) <= baselineGeneration
  ) {
    return false;
  }

  const cleared = setStatusIfImpl(
    chatKey,
    {
      status: "running",
      generation: current.generation,
      updatedAt: current.updatedAt,
      ingressId: current.ingressId,
      sessionId: undefined,
    },
    {
      status: "idle",
      sessionId: null,
      turnId: null,
      statusMessageId: null,
      ingressId: null,
      ingressAt: null,
      statusAt: null,
      turnAt: null,
      firstOutputAt: null,
      latencyLogged: null,
      wasCancelled: null,
      resetAt: observedAt,
    },
  );
  if (!cleared) return false;

  if (
    current.statusMessageId !== undefined &&
    current.statusMessageId !== null
  ) {
    try {
      await deleteMessageImpl(
        chatKey,
        current.statusMessageId as string | number,
      );
    } catch {
      // Failed-attempt working messages are removed best-effort, like stale ones.
    }
  }
  return true;
}

export async function reapStaleRuns({
  listStatusesImpl = listChatStatuses,
  setStatusIfImpl = setChatStatusIf,
  resetImpl = releaseScopedSession,
  sendImpl = sendStaleRunNotice,
  deleteMessageImpl = deleteStaleWorkingMessage,
  now = Date.now,
  inFlight = queueInFlight,
  staleMs = RUN_STALE_MS,
  trImpl = tr,
  logImpl = log,
}: {
  listStatusesImpl?: () => StatusRecord[] | Promise<StatusRecord[]>;
  setStatusIfImpl?: SetStatusIfImpl;
  resetImpl?: (
    chatKey: string,
    target: TelegramResetTarget,
  ) => Promise<unknown>;
  sendImpl?: (chatKey: string, text: string) => Promise<unknown>;
  deleteMessageImpl?: (
    chatKey: string,
    messageId: string | number,
  ) => Promise<unknown>;
  now?: () => number;
  inFlight?: ReadonlyMap<string, unknown>;
  staleMs?: number;
  trImpl?: (en: string, ru: string) => string;
  logImpl?: LogImpl;
} = {}) {
  const safeLog = (...args: unknown[]) => {
    try {
      logImpl(...args);
    } catch {
      // Обслуживание протухших ходов не должно останавливать polling loop.
    }
  };

  let records;
  try {
    records = await listStatusesImpl();
  } catch (error) {
    safeLog("stale run scan failed:", errorMessage(error));
    return 0;
  }

  let reaped = 0;
  for (const record of records) {
    const key = record?.chatKey;
    const status = record?.status;
    if (
      typeof key !== "string" ||
      status?.status !== "running" ||
      now() - ((status.updatedAt as number | null | undefined) ?? 0) <=
        staleMs ||
      inFlight.has(key)
    ) {
      continue;
    }

    let flipped;
    const reapedAt = now();
    try {
      flipped = setStatusIfImpl(
        key,
        {
          status: "running",
          generation: status.generation,
          updatedAt: status.updatedAt,
        },
        {
          status: "idle",
          sessionId: null,
          turnId: null,
          statusMessageId: null,
          ingressId: null,
          ingressAt: null,
          statusAt: null,
          turnAt: null,
          firstOutputAt: null,
          latencyLogged: null,
          wasCancelled: null,
          resetAt: reapedAt,
        },
      );
    } catch (error) {
      safeLog(`stale run CAS failed for ${key}:`, errorMessage(error));
      continue;
    }
    if (!flipped) continue;
    reaped++;

    if (typeof status.sessionId === "string" && status.sessionId.length > 0) {
      try {
        await resetImpl(key, { sessionId: status.sessionId });
      } catch (error) {
        safeLog(`stale run reset failed for ${key}:`, errorMessage(error));
      }
    } else {
      safeLog(`stale run ${key} has no session id`);
    }

    try {
      await sendImpl(
        key,
        trImpl(
          "The previous turn was interrupted - repeat your request or use /new",
          "Предыдущий ход оборвался - повтори запрос или /new",
        ),
      );
    } catch (error) {
      safeLog(`stale run notification failed for ${key}:`, errorMessage(error));
    }

    if (
      status.statusMessageId !== undefined &&
      status.statusMessageId !== null
    ) {
      try {
        await deleteMessageImpl(key, status.statusMessageId as string | number);
      } catch {
        // Старое статус-сообщение удаляется best-effort.
      }
    }
  }
  return reaped;
}

async function acknowledgeQueued(update: TelegramQueueUpdate, count: number) {
  const message = update.message as TelegramQueueMessage;
  await tg("setMessageReaction", {
    chat_id: message.chat?.id,
    message_id: message.message_id,
    reaction: [{ type: "emoji", emoji: "👀" }],
  }).catch((error: unknown) => log("reaction failed:", errorMessage(error)));
  await tg("sendMessage", {
    chat_id: message.chat?.id,
    text: tr(
      `Queued (${count}). I'll start it automatically when the current task finishes.`,
      `В очереди: ${count}. Начну автоматически, когда текущая задача завершится.`,
    ),
    ...(message.message_thread_id === undefined
      ? {}
      : { message_thread_id: message.message_thread_id }),
  }).catch((error: unknown) =>
    log("queue status failed:", errorMessage(error)),
  );
}

export {
  QUEUE_FILE,
  queueSettleUntil,
  queueInFlight,
  queueDrainRotation,
  undrainableLegacyLogged,
  statusGeneration,
  sendStaleRunNotice,
  deleteStaleWorkingMessage,
  clearFailedDirectIngress,
  acknowledgeQueued,
  QUEUE_DELIVERY_TIMEOUT_MS,
  QUEUE_DRAIN_BUDGET_MS,
};
