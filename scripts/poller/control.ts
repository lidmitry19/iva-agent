import { botCommands, helpText, startText, tr } from "#lib/i18n.ts";
import { resetTargetForControl } from "../lib/telegram-reset.ts";
import { TELEGRAM_STOP_CALLBACK } from "#lib/telegram-status-message.ts";
import {
  requestTurnCancel,
  stopOutcomeText,
  type StopOutcome,
} from "#lib/telegram-stop.ts";
import type {
  TelegramCallbackQuery,
  TelegramQueueMessage as TelegramMessage,
  TelegramQueueUpdate as TelegramUpdate,
} from "../lib/telegram-queue.ts";
import type { TelegramFlowState } from "../lib/tg-flow.ts";
import { getChatStatus } from "#lib/run-status.ts";
import { readEnvFresh } from "../lib/env-file.ts";
import {
  formatUsageReport,
  parseWindow,
  readEntries,
  summarize,
} from "../lib/usage.ts";
import {
  ALLOWED,
  BOT_USER_ID,
  CANCEL_ROUTE,
  DATA_DIR,
  ENV_PATH,
  ROOT,
  SECRET,
  log,
} from "./config.ts";
import { downloadTelegramFile, edit, reply, sc, tg } from "./transport.ts";
import { chatKey } from "./offset.ts";
import { performScopedReset } from "./queue.ts";
import { deliverDirectUpdate } from "./routing.ts";
import { parseUpdateCallbackData } from "./update-callback.ts";
import { handleUpdateCallback, handleUpdateCheck } from "./update-flow.ts";
import {
  endWizard,
  flows,
  getWizard,
  handleKeyMessage,
  handleModelCmd,
  handleThinkCmd,
  handleWizardCallback,
  resetMessageCopy,
} from "./wizards.ts";
import { createMenu } from "../lib/menu/index.ts";
import { admitTelegramUpdate } from "./inbox.ts";
import { isPrivateTelegramChat } from "#lib/telegram-private-chat.ts";

type ControlCallbackQuery = TelegramCallbackQuery & { data: string };
type PendingFlow = {
  flow: unknown;
  awaitText?: unknown;
  [key: string]: unknown;
};
type AwaitText = { file?: boolean; kind?: string; secret?: boolean };
type TelegramResult = { ok?: boolean; result?: unknown };
type SentMessage = { message_id: number };
type ErrorDetails = { message?: unknown; resetPhase?: unknown };
type NonTextIo = {
  deleteSecret: (
    chatId: number | undefined,
    messageId: number | undefined,
  ) => Promise<boolean>;
  reply: (chatId: number | undefined, text: string) => Promise<unknown>;
  download: (fileId: string, maxBytes: number) => Promise<string | null>;
  deliver: (
    text: string,
    message: TelegramMessage,
    state: PendingFlow,
  ) => Promise<unknown>;
};
type ControlTransport = (
  method: string,
  body: Record<string, unknown>,
) => Promise<TelegramResult>;
type StatusImpl = (chatKey: string) => Record<string, unknown> | null;
type CancelImpl = (input: {
  url: string;
  secret: string;
  sessionId: string;
  turnId?: string;
}) => Promise<unknown>;
// Точки ввода-вывода handleControl, которые подменяются в тестах: ответ в чат,
// подтверждение нажатия и вызов cancel-роута. Всё остальное остаётся дефолтным.
export type ControlDeps = {
  replyImpl?: (
    chatId: number | undefined,
    text: string,
  ) => Promise<SentMessage | null>;
  ackImpl?: (callbackQueryId: string, text?: string) => Promise<unknown>;
  cancelImpl?: CancelImpl;
};

const controlTg = tg as unknown as ControlTransport;

function errorDetails(error: unknown): ErrorDetails {
  return typeof error === "object" && error !== null ? error : {};
}

function errorMessage(error: unknown): string {
  const message = errorDetails(error).message;
  if (typeof message === "string") return message;
  if (message === undefined) return "undefined";
  if (message === null) return "null";
  if (
    typeof message === "number" ||
    typeof message === "boolean" ||
    typeof message === "bigint"
  )
    return `${message}`;
  return Object.prototype.toString.call(message);
}

function isAwaitText(value: unknown): value is AwaitText {
  return typeof value === "object" && value !== null;
}

function hasCallbackData(
  callback: TelegramCallbackQuery,
): callback is ControlCallbackQuery {
  return typeof callback.data === "string";
}

function telegramCallSucceeded(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as TelegramResult).ok === true &&
    (value as TelegramResult).result === true
  );
}

function replySucceeded(value: SentMessage | null | undefined): boolean {
  return typeof value?.message_id === "number";
}

function isTelegramFlowState(value: PendingFlow): value is TelegramFlowState {
  return (
    typeof value.flow === "string" &&
    (typeof value.chatId === "string" || typeof value.chatId === "number") &&
    (typeof value.userId === "string" || typeof value.userId === "number") &&
    typeof value.createdAt === "number" &&
    (value.msgId === null || typeof value.msgId === "number") &&
    typeof value.page === "number" &&
    typeof value.data === "object" &&
    value.data !== null
  );
}

const replyTo = (chatId: number | undefined, text: string) =>
  reply(chatId as number, text) as Promise<SentMessage | null>;

const editMessage = (
  chatId: number | undefined,
  messageId: number,
  text: string,
) => edit(chatId as number, messageId, text);

// Команды, которые исполняет САМ мост: они обязаны работать, даже когда агент занят
// или завис, поэтому в eve не уходят. Порядок здесь ни на что не влияет — /help и синее
// меню Telegram кормит таблица COMMANDS (agent/lib/i18n.ts).
export const OUT_OF_BAND_COMMANDS = [
  "/menu",
  "/help",
  "/start",
  "/stop",
  "/usage",
  "/restart",
  "/new",
  "/update",
  "/model",
  "/think",
];

// Подтверждение нажатия: гасит спиннер кнопки и показывает всплывающую подсказку.
// Ошибки глотаем — сама отмена уже отправлена, а протухший callback_query_id Telegram
// отвергает штатно.
const answerCallback = (callbackQueryId: string, text?: string) =>
  controlTg("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text === undefined ? {} : { text }),
  }).catch((e: unknown) => {
    log("answerCallbackQuery failed:", errorMessage(e));
    return { ok: false };
  });

const privateChatOnlyText = () =>
  tr(
    "Open a private chat with me to use this control.",
    "Открой личный чат со мной, чтобы использовать это управление.",
  );

const PRIVATE_ONLY_COMMANDS = new Set(["/menu", "/model", "/think"]);

// ⏹ Стоп: кнопка статус-сообщения и /stop. В long-poll обе двери ведут сюда, в мост:
// он перехватывает апдейт раньше любой доставки, поэтому «Стоп» доходит и до занятого
// агента. Решение «есть ли что останавливать» и сам POST на cancel-роут живут в
// agent/lib/telegram-stop.ts — там же, где второй вход (onCallbackQuery канала для
// webhook-режима), чтобы политика не разъехалась между режимами.
async function requestTurnStop(
  update: TelegramUpdate,
  {
    keyImpl = chatKey,
    cancelImpl,
    ...cancelDeps
  }: {
    keyImpl?: (update: TelegramUpdate) => string | null;
    cancelImpl?: CancelImpl;
    getStatusImpl?: StatusImpl;
    runningImpl?: (chatKey: string) => boolean;
    logImpl?: (...parts: unknown[]) => void;
  } = {},
): Promise<StopOutcome> {
  return requestTurnCancel(keyImpl(update), {
    url: CANCEL_ROUTE,
    secret: SECRET,
    logImpl: log,
    ...(cancelImpl === undefined ? {} : { cancelImpl }),
    ...cancelDeps,
  });
}

// Движок /menu: делит session-store (flows) с визардами /model//think. deps — мост отдаёт
// экранам всё нужное (пути, systemctl, доставку в eve, allowlist, хендофф в визарды).
const menu = createMenu({
  flows,
  tg,
  deps: {
    envPath: ENV_PATH,
    dataDir: DATA_DIR,
    root: ROOT,
    sc,
    reply,
    // Синтетическая дистилляция делит acceptance, пейсинг и уборку failed-ingress
    // с обычной прямой доставкой, но намеренно не проходит busy-time FIFO.
    deliver: (update) =>
      deliverDirectUpdate(update).then((result) => result === "delivered"),
    admitSynthetic: (update) =>
      admitTelegramUpdate(update, { trustedLocal: true }).then(
        (result) => result === "owned",
      ),
    log,
    allowed: ALLOWED,
    handleModelCmd,
    handleThinkCmd,
    handleUpdateCheck,
  },
});

// setMyCommands: синее командное меню Telegram из общей таблицы COMMANDS (default=en +
// language_code:"ru"). Идемпотентно, зовётся на каждом старте моста; ошибки нефатальны.
async function registerBotCommands() {
  try {
    await tg("setMyCommands", { commands: botCommands("en") });
    await tg("setMyCommands", {
      commands: botCommands("ru"),
      language_code: "ru",
    });
  } catch (e: unknown) {
    log("setMyCommands failed:", errorDetails(e).message);
  }
}

// Delete a message carrying a secret, warning the user if Telegram won't let us — a rejected secret
// must never silently linger in the chat (mirrors the delete-first path in menu.onText).
async function deleteSecretMessage(
  chatId: number | undefined,
  messageId: number | undefined,
) {
  const del = await controlTg("deleteMessage", {
    chat_id: chatId,
    message_id: messageId,
  }).catch(() => ({ ok: false }));
  if (!del?.ok) {
    await replyTo(
      chatId,
      tr(
        "Couldn't delete your message — please delete it manually.",
        "Не смог удалить сообщение — удали его вручную.",
      ),
    ).catch(() => {});
  }
  return del?.ok === true;
}

// Default I/O for handleAwaitNonText — injectable so the delete→download ordering and the
// "never reaches eve" contract can be unit-tested with mocks.
const nonTextIo: NonTextIo = {
  deleteSecret: (chatId: number | undefined, id: number | undefined) =>
    deleteSecretMessage(chatId, id),
  reply: (chatId: number | undefined, text: string) => replyTo(chatId, text),
  download: (fileId: string, max: number) => downloadTelegramFile(fileId, max),
  // Run the screen's own text handler on downloaded content WITHOUT re-deleting (already deleted).
  deliver: async (text: string, msg: TelegramMessage, st: PendingFlow) => {
    if (!isTelegramFlowState(st)) return true;
    return menu.onText({ ...msg, text }, st, { skipDelete: true });
  },
};

// A non-text message arrived while a menu/wizard awaits a SECRET (the caller gates this to
// secret/file-capable states — a non-secret interview attachment falls through to eve untouched).
// It must never reach eve. For a file-capable prompt (gws client_secret) a document is captured;
// crucially the message is DELETED FIRST, before the download, so the secret doesn't linger in the
// chat for the download's duration. Anything else is deleted with a clear ack telling the user how
// to send it. Always returns true (the update is consumed, not delivered).
export async function handleAwaitNonText(
  msg: TelegramMessage,
  pending: PendingFlow,
  io: NonTextIo = nonTextIo,
) {
  const chatId = msg.chat?.id;
  const a = isAwaitText(pending.awaitText) ? pending.awaitText : null;
  const MAX_BYTES = 256 * 1024;
  if (a?.file && msg.document && pending.flow === "menu") {
    if ((msg.document.file_size ?? 0) > MAX_BYTES) {
      await io.deleteSecret(chatId, msg.message_id);
      await io.reply(
        chatId,
        tr(
          "That file is too large — paste the contents as text instead.",
          "Файл слишком большой — вставь содержимое текстом.",
        ),
      );
      return true;
    }
    // Delete FIRST, and only proceed once the secret has actually left the chat. If Telegram
    // refused the deletion, deleteSecret already told the user to remove it manually — we must NOT
    // download or deliver a secret that is still visible in the conversation. Consume it either way
    // so it never reaches eve.
    const deleted = await io.deleteSecret(chatId, msg.message_id);
    if (!deleted) return true;
    const content = await io.download(msg.document.file_id, MAX_BYTES);
    if (content == null) {
      await io.reply(
        chatId,
        tr(
          "Couldn't read that file — paste the contents as text instead.",
          "Не смог прочитать файл — вставь содержимое текстом.",
        ),
      );
      return true;
    }
    await io.deliver(content, msg, pending); // skipDelete is safe now — the message is confirmed gone
    return true;
  }
  // Secret prompt, but not a capturable file (a photo, or a text-only secret) — delete it so it can't
  // reach eve, and tell the user how to send it instead of dropping it silently.
  await io.deleteSecret(chatId, msg.message_id);
  await io.reply(
    chatId,
    a?.file
      ? tr(
          "Send client_secret.json as text or attach the .json file — not a photo.",
          "Пришли client_secret.json текстом или прикрепи .json-файл — не фото.",
        )
      : tr("Send it as text, please.", "Пришли это, пожалуйста, текстом."),
  );
  return true;
}

// Control commands are handled by the BRIDGE (out-of-band) — they work even if the agent is stuck.
// Trusted IDs only. Returns true if the command was handled (we do NOT deliver it to eve).
async function handleControl(
  update: TelegramUpdate,
  {
    replyImpl = replyTo,
    ackImpl = answerCallback,
    cancelImpl,
  }: ControlDeps = {},
) {
  // Bridge-owned inline-button taps (/update, /model, /think) — not eve HITL callbacks.
  const cq = update.callback_query;
  if (cq && hasCallbackData(cq)) {
    const callback = cq;
    const updateCallback = parseUpdateCallbackData(callback.data);
    const isLocalCallback =
      callback.data === TELEGRAM_STOP_CALLBACK ||
      updateCallback !== null ||
      callback.data.startsWith("iva_model:") ||
      callback.data.startsWith("iva_think:") ||
      callback.data.startsWith("iva_menu:");
    const callbackFrom = String(callback.from?.id ?? "");
    const callbackAllowed = ALLOWED.size > 0 && ALLOWED.has(callbackFrom);
    if (
      isLocalCallback &&
      callbackAllowed &&
      !isPrivateTelegramChat(callback.message?.chat)
    ) {
      await ackImpl(callback.id, privateChatOnlyText()).catch(() => {});
      return true;
    }
    // ⏹ Стоп у статус-сообщения. Тап никогда не уходит в eve: колбэк наш, а отмену
    // мост делает сам через cancel-роут канала. У канала есть свой обработчик той же
    // кнопки (agent/lib/telegram-stop.ts), но он для webhook-режима, где моста нет:
    // здесь апдейт перехватывается раньше любой доставки.
    // NB: колбэк с ЧУЖИМИ данными уходит в eve и там попадает в тот же
    // onCallbackQuery канала — дефолтная ветка eve «Unsupported action.» из-за него
    // отключена, поэтому спиннер гасит сам канал пустым answerCallbackQuery.
    if (callback.data === TELEGRAM_STOP_CALLBACK) {
      const from = String(callback.from?.id ?? "");
      // Чужой тап в группе: гасим спиннер молча и ничего не отменяем.
      if (ALLOWED.size === 0 || !ALLOWED.has(from)) {
        return telegramCallSucceeded(await ackImpl(callback.id));
      }
      const outcome = await requestTurnStop(update, { cancelImpl });
      const acknowledged = telegramCallSucceeded(
        await ackImpl(callback.id, stopOutcomeText(outcome)),
      );
      return outcome === "requested" || acknowledged;
    }
    if (updateCallback !== null) return handleUpdateCallback(callback);
    // Wizard errors must not escape and crash the bridge. A failed handler returns
    // false so the callback enters durable inbox ownership before offset advances.
    if (
      callback.data.startsWith("iva_model:") ||
      callback.data.startsWith("iva_think:")
    ) {
      return handleWizardCallback(callback).catch((e: unknown) => {
        log("wizard callback error:", errorDetails(e).message);
        return false;
      });
    }
    // /menu: тот же принцип consume-on-error — тап меню всегда проглатывается (в eve не уходит).
    if (callback.data.startsWith("iva_menu:")) {
      return menu.onCallback(callback, update.update_id).catch((e: unknown) => {
        log("menu callback error:", errorDetails(e).message);
        return true;
      });
    }
  }
  const msg = update.message;
  const text = (msg?.text || "").trim();
  // A pending flow (menu screen or /model wizard) awaiting input claims this user's next message
  // (a key must never reach eve); a command aborts the wait — a silently still-visible prompt would
  // invite pasting the key later, when nothing intercepts it. This runs BEFORE the busy-buffer gate
  // (below), so a capture works even mid-turn. Non-text is intercepted only while awaiting a SECRET
  // (or a file-capable secret): a document/photo could be the secret itself and must not reach eve.
  // A non-secret await (e.g. the memory interview) lets a non-text message fall through unchanged.
  if (msg?.from && isPrivateTelegramChat(msg.chat)) {
    const pending = getWizard(msg.chat?.id, String(msg.from.id));
    const a = isAwaitText(pending?.awaitText) ? pending.awaitText : null;
    if (pending && a) {
      if (text.startsWith("/")) {
        await endWizard(
          pending,
          tr(
            "Cancelled — no longer waiting for input.",
            "Отменено — ожидание ввода снято.",
          ),
        ).catch(() => {});
      } else if (text) {
        if (pending.flow === "menu") {
          // Menu screens own their capture (interview / key intake / gws JSON / ubcred).
          return menu.onText(msg, pending).catch((e: unknown) => {
            log("menu capture error:", errorDetails(e).message); // e.message never contains a secret value
            return true;
          });
        }
        // /model wizard key intake — consume the update even on failure (the key must never
        // be re-polled into eve). handleKeyMessage stays the wizard's own handler.
        return handleKeyMessage(
          msg as { chat: { id: number }; message_id: number; text: string },
          pending,
        ).catch((e: unknown) => {
          log("wizard key error:", errorDetails(e).message); // e.message never contains the key value
          return true;
        });
      } else if (a.secret || a.file) {
        // Non-text while awaiting a secret — never let it reach eve (delete-first inside).
        return handleAwaitNonText(msg, pending).catch((e: unknown) => {
          log("menu attachment capture error:", errorDetails(e).message); // never contains the secret value
          return true;
        });
      }
      // else: non-secret await + non-text → fall through so eve handles it normally.
    }
  }
  if (!text.startsWith("/")) return false;
  const cmd = text.split(/\s+/)[0].replace(/@\w+$/, "").toLowerCase();
  if (!OUT_OF_BAND_COMMANDS.includes(cmd)) return false;
  const from = String(msg?.from?.id ?? "");
  if (ALLOWED.size === 0 || !ALLOWED.has(from)) return false; // untrusted — let eve drop it
  const chatId = msg?.chat?.id;
  if (chatId === undefined) return false;
  if (PRIVATE_ONLY_COMMANDS.has(cmd) && !isPrivateTelegramChat(msg?.chat)) {
    await replyImpl(chatId, privateChatOnlyText()).catch((e: unknown) =>
      log("private-chat rejection failed:", errorMessage(e)),
    );
    return true;
  }
  // /menu — open the nested settings menu (out-of-band; errors consumed, never reach eve).
  if (cmd === "/menu") {
    await menu
      .open(chatId, from)
      .catch((e: unknown) => log("menu error:", errorDetails(e).message));
    return true;
  }
  if (cmd === "/help") {
    return replySucceeded(await replyImpl(chatId, helpText()));
  }
  // /start — кнопка Start у нового пользователя. Без этой ветки приветствие уходило
  // обычным ходом в модель: платный запрос ради «привет». Отвечает мост, out-of-band.
  if (cmd === "/start") {
    return replySucceeded(await replyImpl(chatId, startText()));
  }
  // /stop — interrupt the current turn, the same door as the ⏹ Stop button.
  // Out-of-band so it reaches a busy agent (an ordinary message would be queued by
  // the gate below and never processed).
  if (cmd === "/stop") {
    const outcome = await requestTurnStop(update, { cancelImpl });
    // Успех виден по статус-сообщению: turn.cancelled перепишет его на «Остановлено».
    if (outcome === "requested") return true;
    return replySucceeded(await replyImpl(chatId, stopOutcomeText(outcome)));
  }
  // /usage — token spend from data/usage.jsonl. Out-of-band and FREE (we don't call the model).
  if (cmd === "/usage") {
    const arg = text.split(/\s+/).slice(1).join(" ");
    try {
      const agg = summarize(readEntries(), {
        window: parseWindow(arg),
        now: Date.now(),
        tz: process.env.ASSISTANT_TIMEZONE,
      });
      return replySucceeded(await replyTo(chatId, formatUsageReport(agg)));
    } catch (e: unknown) {
      return replySucceeded(
        await replyTo(
          chatId,
          "Couldn't read the usage log: " + errorMessage(e),
        ),
      );
    }
  }
  // /update — check upstream; if newer, offer inline Update/Skip buttons. Out-of-band.
  if (cmd === "/update") {
    return handleUpdateCheck(chatId);
  }
  // /model, /think — provider/model/effort wizard (writes .env; applied on restart).
  if (cmd === "/model") {
    return handleModelCmd(chatId, from).catch((e: unknown) => {
      log("wizard /model error:", errorDetails(e).message);
      return false;
    });
  }
  if (cmd === "/think") {
    return handleThinkCmd(chatId, from).catch((e: unknown) => {
      log("wizard /think error:", errorDetails(e).message);
      return false;
    });
  }
  // /new retires only this exact Telegram session. /restart does the same first,
  // then restarts the agent process; histories and queues of other chats survive.
  const key = chatKey(update);
  const resetTarget = key
    ? resetTargetForControl(
        update,
        getChatStatus(key),
        BOT_USER_ID ?? undefined,
      )
    : null;
  const resetCopy = resetMessageCopy(cmd, await readEnvFresh(ENV_PATH));
  const status = await replyTo(chatId, resetCopy.pending);
  if (!resetTarget || !key) {
    if (status) {
      await editMessage(
        chatId,
        status.message_id,
        tr(
          "⚠️ I couldn't identify this conversation. In a group, reply /new to Iva's latest message.",
          "⚠️ Не удалось определить этот диалог. В группе ответьте /new на последнее сообщение Iva.",
        ),
      );
    }
    return replySucceeded(status);
  }

  const clearsPrivateQueue = msg?.chat?.type === "private";
  try {
    await performScopedReset(key, resetTarget, {
      // Group/forum queues are keyed only by chat/topic while Eve sessions also
      // include conversationId. Clearing the shared queue here would lose
      // messages belonging to other group conversation anchors.
      clearQueue: clearsPrivateQueue,
    });
  } catch (e: unknown) {
    const error = errorDetails(e);
    const resetPhase =
      typeof error.resetPhase === "string" ? error.resetPhase : "unknown";
    log(`scoped reset ${resetPhase} failed for ${key}:`, error.message);
    if (status) {
      await editMessage(
        chatId,
        status.message_id,
        error.resetPhase === "remote"
          ? tr(
              "⚠️ Couldn't confirm this conversation reset. Recovery will retry automatically.",
              "⚠️ Не удалось подтвердить сброс диалога. Восстановление повторит его автоматически.",
            )
          : tr(
              "⚠️ Conversation reset recovery is incomplete. Iva will retry it before accepting queued work.",
              "⚠️ Восстановление после сброса не завершено. Iva повторит его до приёма задач из очереди.",
            ),
      );
    }
    // A private reset request is ambiguous after any I/O failure: Eve may have
    // committed it even when the response was lost. Stop this polling process so
    // startup reconciliation consumes the durable intent before any old head.
    if (clearsPrivateQueue) throw e;
    return true;
  }

  if (cmd === "/restart" && !(await sc("restart", "iva.service"))) {
    if (status) {
      await editMessage(
        chatId,
        status.message_id,
        tr(
          "⚠️ Conversation reset, but Iva couldn't restart.",
          "⚠️ Диалог сброшен, но перезапустить Iva не удалось.",
        ),
      );
    }
    return true;
  }
  if (status) await editMessage(chatId, status.message_id, resetCopy.complete);
  return true;
}

export { registerBotCommands, handleControl };
