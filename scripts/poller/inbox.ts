import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  acknowledgeQueueHead,
  enqueueQueueFile,
  isTelegramQueueUpdate,
  loadQueueFile,
  queueCount,
  queueKeys,
  shouldQueueBusyUpdate,
  type TelegramQueueItem,
  type TelegramQueueUpdate,
} from "../lib/telegram-queue.ts";
import {
  collectorKeyFor,
  collectorOffer,
  collectorTakeExpired,
  createCollector,
} from "../lib/telegram-collect.ts";
import { traceBridgeAdmission } from "#lib/trace.ts";
import { ALLOWED, BOT_USERNAME, DATA_DIR, log } from "./config.ts";
import { chatKey } from "./offset.ts";
import { routeMessageUpdate, type RouteMessageResult } from "./routing.ts";

export const TELEGRAM_INBOX_FILE = join(DATA_DIR, "telegram-inbox.json");

export type InboxCollectorOptions = {
  quietMs?: unknown;
  mediaQuietMs?: unknown;
  maxParts?: unknown;
  maxChars?: unknown;
  maxAgeMs?: unknown;
};

export type ReadyInboxBatch = {
  update: TelegramQueueUpdate;
  updateIds: number[];
};

export type InboxAdmissionResult =
  "owned" | "terminal-drop" | "unownable" | "write-failed";

type InboxSender = { id?: string | number; is_bot?: boolean };

export function inboxKeyFor(
  update: TelegramQueueUpdate | null | undefined,
): string | null {
  const hasMessage = update?.message !== undefined;
  const hasCallback = update?.callback_query !== undefined;
  if (hasMessage === hasCallback) return null;
  if (hasMessage) return collectorKeyFor(update);
  const callback = update?.callback_query;
  const key = chatKey(update ?? {});
  if (key !== null) return `callback:${key}`;
  if (
    callback?.message !== undefined ||
    typeof callback?.inline_message_id !== "string" ||
    callback.inline_message_id.length === 0 ||
    callback.from?.id === undefined
  ) {
    return null;
  }
  const sender = createHash("sha256")
    .update("iva-telegram-inline-callback/v1\0")
    .update(String(callback.from.id))
    .digest("hex");
  return `callback:inline:${sender}`;
}

function senderPolicy(
  sender: InboxSender | undefined,
  allowedUserIds: ReadonlySet<string>,
): "allowed" | "terminal-drop" | "unownable" {
  if (sender?.id === undefined) return "unownable";
  if (allowedUserIds.size === 0 || sender.is_bot === true) {
    return "terminal-drop";
  }
  return allowedUserIds.has(String(sender.id)) ? "allowed" : "terminal-drop";
}

function admissionPolicy(
  update: TelegramQueueUpdate,
  allowedUserIds: ReadonlySet<string>,
  botUsername: unknown,
): { action: "own"; key: string } | { action: "terminal-drop" | "unownable" } {
  const hasMessage = update.message !== undefined;
  const hasCallback = update.callback_query !== undefined;
  if (hasMessage === hasCallback) return { action: "unownable" };
  if (
    hasCallback &&
    (typeof update.callback_query?.id !== "string" ||
      update.callback_query.id.length === 0)
  ) {
    return { action: "unownable" };
  }

  const sender = hasMessage
    ? update.message?.from
    : update.callback_query?.from;
  const senderDecision = senderPolicy(sender, allowedUserIds);
  if (senderDecision !== "allowed") return { action: senderDecision };

  const key = inboxKeyFor(update);
  if (key === null) return { action: "unownable" };
  if (
    hasMessage &&
    !shouldQueueBusyUpdate(update, { allowedUserIds, botUsername })
  ) {
    return { action: "terminal-drop" };
  }
  return { action: "own", key };
}

export function selectReadyInboxBatch(
  key: string,
  items: readonly TelegramQueueItem[],
  now: number,
  collectorOptions: InboxCollectorOptions = {},
): ReadyInboxBatch | null {
  const collector = createCollector(collectorOptions);
  const updateIds: number[] = [];
  for (const item of items) {
    const update = item.update;
    if (
      !isTelegramQueueUpdate(update) ||
      inboxKeyFor(update) !== key ||
      typeof item.enqueuedAt !== "number" ||
      !Number.isFinite(item.enqueuedAt) ||
      item.enqueuedAt < 0
    ) {
      throw new Error(`invalid durable Telegram inbox item ${item.updateId}`);
    }
    updateIds.push(item.updateId);
    const offered = collectorOffer(collector, update, item.enqueuedAt);
    if (offered.status === "passthrough" || offered.status === "ready") {
      return { update: offered.update, updateIds: [...updateIds] };
    }
  }
  const [expired] = collectorTakeExpired(collector, now);
  return expired ? { update: expired, updateIds } : null;
}

export async function admitTelegramUpdate(
  update: TelegramQueueUpdate,
  {
    allowedUserIds = ALLOWED,
    botUsername = BOT_USERNAME,
    trustedLocal = false,
    enqueueImpl = (key: string, candidate: TelegramQueueUpdate) =>
      enqueueQueueFile(TELEGRAM_INBOX_FILE, key, candidate, { strict: true }),
    logImpl = log,
  }: {
    allowedUserIds?: ReadonlySet<string>;
    botUsername?: unknown;
    /** Already-authorized local payload; bypasses external sender/group policy, never key validation. */
    trustedLocal?: boolean;
    enqueueImpl?: (
      key: string,
      candidate: TelegramQueueUpdate,
    ) => Promise<unknown>;
    logImpl?: (...parts: unknown[]) => void;
  } = {},
): Promise<InboxAdmissionResult> {
  const trustedKey = trustedLocal ? inboxKeyFor(update) : null;
  const decision = trustedLocal
    ? trustedKey === null
      ? { action: "unownable" as const }
      : { action: "own" as const, key: trustedKey }
    : admissionPolicy(update, allowedUserIds, botUsername);
  // Trace: мост принял апдейт или отбросил его своей политикой — первое звено цепочки
  // хода, и пишется оно из ПРОЦЕССА МОСТА в тот же дневной файл (ADR-0010).
  if (decision.action !== "own") {
    traceBridgeAdmission(update, decision.action);
    return decision.action;
  }
  try {
    await enqueueImpl(decision.key, update);
    traceBridgeAdmission(update, "owned");
    return "owned";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logImpl(`inbox write failed for update ${update.update_id}:`, message);
    traceBridgeAdmission(update, "write-failed");
    return "write-failed";
  }
}

export async function promoteReadyInbox({
  now = Date.now,
  collectorOptions = {},
  loadImpl = async () =>
    (await loadQueueFile(TELEGRAM_INBOX_FILE, { strict: true })).document,
  routeImpl = routeMessageUpdate,
  acknowledgeImpl = (key: string, updateId: number) =>
    acknowledgeQueueHead(TELEGRAM_INBOX_FILE, key, updateId, { strict: true }),
}: {
  now?: () => number;
  collectorOptions?: InboxCollectorOptions;
  loadImpl?: () => Promise<
    Awaited<ReturnType<typeof loadQueueFile>>["document"]
  >;
  routeImpl?: (update: TelegramQueueUpdate) => Promise<RouteMessageResult>;
  acknowledgeImpl?: (key: string, updateId: number) => Promise<unknown>;
} = {}): Promise<number> {
  const snapshot = await loadImpl();
  for (const key of queueKeys(snapshot)) {
    const batch = selectReadyInboxBatch(
      key,
      snapshot.queues[key],
      now(),
      collectorOptions,
    );
    if (!batch) continue;
    const routed = await routeImpl(batch.update);
    if (routed !== "queued" && routed !== "delivered") continue;
    for (const updateId of batch.updateIds) {
      await acknowledgeImpl(key, updateId);
    }
  }
  return queueCount(await loadImpl());
}
