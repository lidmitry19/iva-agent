// Остановка хода по кнопке ⏹ Стоп: общий текст исходов и обработчик нажатия для
// webhook-режима.
//
// Дверей две, и обе кончаются одним cancel-роутом канала:
//  - long-poll (штатный режим): нажатие ловит МОСТ (scripts/poller/control.ts) и зовёт
//    роут сам — так «Стоп» доходит даже до занятого агента;
//  - webhook-режим: моста нет вовсе, апдейт идёт прямо в eve, и нажатие ловит
//    onCallbackQuery канала — этот модуль.
// В long-poll мост съедает колбэк раньше (scripts/poller/main.ts зовёт handleControl
// до любой доставки), поэтому здешний путь там не срабатывает. Двойное срабатывание
// безопасно и так: cancel идемпотентен, `no_active_turn` — тоже успех.

import { requestTelegramCancel } from "./telegram-cancel-client.ts";
import { localCancelUrl } from "./telegram-cancel-route.ts";
import { allowedTelegramUsers } from "./telegram-allowlist.ts";
import { chatKeyOf, getChatStatus, isRunning } from "./run-status.ts";
import { toChannelLocalToken } from "./telegram-continuation-token.ts";
import { tr } from "./i18n.ts";
import { isPrivateTelegramChat } from "./telegram-private-chat.ts";
import { traceStop } from "./trace.ts";

export type StopOutcome = "requested" | "idle" | "failed";
export type StopCancelRequest = {
  url: string;
  secret: string;
  continuationToken: string;
  turnId?: string;
};
export type StopCallbackQuery = {
  readonly id: string;
  readonly data?: string;
  readonly from?: { readonly id?: number | string };
  readonly message?: {
    readonly chat: { readonly id: number | string; readonly type?: string };
    readonly messageThreadId?: number;
  };
};

// Функция, а не const: перевод выбирается в момент вызова (правило репо).
export function stopOutcomeText(outcome: StopOutcome): string {
  if (outcome === "requested") return tr("Stopping…", "Останавливаю…");
  if (outcome === "idle")
    return tr("Nothing is running right now.", "Сейчас ничего не выполняется.");
  return tr(
    "Didn't work — the turn may have already finished.",
    "Не вышло — возможно, ход уже завершился.",
  );
}

/**
 * ЕДИНАЯ политика остановки для обеих дверей: и мост, и канал ходят сюда, поэтому
 * «что считается живым ходом» не может разъехаться между режимами.
 *
 * Живой ход определяет `isRunning`, а не голое `status === "running"`: запись
 * переживает краш процесса, и в webhook-режиме её некому подчистить (жнец живёт в
 * мосте). Без учёта протухания кнопка после краша вечно отвечала бы «Останавливаю…».
 */
export async function requestTurnCancel(
  chatKey: string | null,
  {
    url,
    secret,
    cancelImpl = requestTelegramCancel,
    getStatusImpl = getChatStatus,
    runningImpl = isRunning,
    logImpl = console.error,
  }: {
    url: string;
    secret?: string;
    cancelImpl?: (input: StopCancelRequest) => Promise<unknown>;
    getStatusImpl?: (chatKey: string) => Record<string, unknown> | null;
    runningImpl?: (chatKey: string) => boolean;
    logImpl?: (...parts: unknown[]) => void;
  },
): Promise<StopOutcome> {
  // Trace: одна точка исхода на обе двери «Стопа» — журнал не может разойтись с политикой
  // остановки, потому что смотрит на её же результат (ADR-0010).
  const finish = (outcome: StopOutcome, turnId?: unknown): StopOutcome => {
    traceStop(chatKey ?? "", turnId, outcome);
    return outcome;
  };
  if (chatKey === null || chatKey.length === 0 || !runningImpl(chatKey))
    return finish("idle");
  const status = getStatusImpl(chatKey);
  const storedToken = status?.continuationToken;
  if (
    status?.status !== "running" ||
    typeof storedToken !== "string" ||
    storedToken.length === 0
  ) {
    return finish("idle");
  }
  // Без секрета вебхука роут ответит 401 — молчать об этом хуже, чем сказать «не вышло».
  if (secret === undefined || secret.length === 0) {
    logImpl("turn cancel failed: no TELEGRAM_WEBHOOK_SECRET_TOKEN");
    return finish("failed", status.turnId);
  }
  const turnId = status.turnId;
  try {
    await cancelImpl({
      url,
      secret,
      // Статусы, записанные до фикса #110, хранят токен с именем канала впереди.
      continuationToken: toChannelLocalToken(storedToken),
      // Гард от запоздалого нажатия: несовпавший turnId eve глотает как no-op.
      ...(typeof turnId === "string" && turnId.length > 0 ? { turnId } : {}),
    });
    return finish("requested", turnId);
  } catch (error) {
    logImpl("turn cancel failed:", error);
    return finish("failed", turnId);
  }
}

/**
 * Нажатие ⏹ Стоп, пришедшее прямо в канал (webhook-режим). Возвращает "ignored",
 * когда нажал не тот, кому можно, или у колбэка нет сообщения-якоря: состояние не
 * трогается, а спиннер кнопки всё равно гасится без текста.
 */
export async function handleTelegramStopCallback(
  query: StopCallbackQuery,
  {
    ackImpl,
    allowedImpl = allowedTelegramUsers,
    urlImpl = localCancelUrl,
    secret = process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN,
    ...cancelDeps
  }: {
    ackImpl: (text?: string) => Promise<unknown>;
    allowedImpl?: () => ReadonlySet<string>;
    urlImpl?: () => string;
    secret?: string;
    cancelImpl?: (input: StopCancelRequest) => Promise<unknown>;
    getStatusImpl?: (chatKey: string) => Record<string, unknown> | null;
    runningImpl?: (chatKey: string) => boolean;
    logImpl?: (...parts: unknown[]) => void;
  },
): Promise<StopOutcome | "ignored"> {
  const from = query.from?.id;
  const allowed = allowedImpl();
  const reference = query.message;
  if (
    allowed.size === 0 ||
    from === undefined ||
    !allowed.has(String(from)) ||
    !reference
  ) {
    await ackImpl();
    return "ignored";
  }
  if (!isPrivateTelegramChat(reference.chat)) {
    await ackImpl(
      tr(
        "Open a private chat with me to use this control.",
        "Открой личный чат со мной, чтобы использовать это управление.",
      ),
    );
    return "ignored";
  }

  const outcome = await requestTurnCancel(
    chatKeyOf(reference.chat.id, reference.messageThreadId),
    { url: urlImpl(), secret, ...cancelDeps },
  );
  await ackImpl(stopOutcomeText(outcome));
  return outcome;
}
