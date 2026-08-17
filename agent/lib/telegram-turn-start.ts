import { randomUUID } from "node:crypto";
import { toChannelLocalToken } from "./telegram-continuation-token.ts";
import { traceTurnBound } from "./trace.ts";

type ChatStatus = Record<string, unknown> | null;
type GetStatus = (chatKey: string) => ChatStatus;
type SetStatusIf = (
  chatKey: string,
  expected: Record<string, unknown>,
  patch: Record<string, unknown>,
) => unknown;

export interface PublishTelegramEarlyStatusOptions {
  chatKey: string;
  ingressId?: string;
  now?: () => number;
  staleMs?: number;
  getStatusImpl: GetStatus;
  setStatusIfImpl: SetStatusIf;
  sendWorkingStatusImpl: (options: {
    canStop: false;
  }) => Promise<number | null | undefined>;
  removeWorkingStatusImpl?: (messageId: number) => Promise<unknown>;
  onWorkingStatusError?: (error: unknown) => void;
}

export interface PublishTelegramTurnStartedOptions {
  chatKey: string;
  continuationToken: string;
  sessionId: string;
  turnId: string;
  now?: () => number;
  getStatusImpl: GetStatus;
  setStatusIfImpl: SetStatusIf;
  sendWorkingStatusImpl?: (options: {
    canStop: true;
  }) => Promise<number | null | undefined>;
  enableWorkingStatusStopImpl?: (messageId: number) => Promise<unknown>;
  removeWorkingStatusImpl?: (messageId: number) => Promise<unknown>;
  onWorkingStatusError?: (error: unknown) => void;
}

export interface AbandonTelegramEarlyStatusOptions {
  chatKey: string;
  ingressId: string;
  getStatusImpl: GetStatus;
  setStatusIfImpl: SetStatusIf;
  removeWorkingStatusImpl?: (messageId: number) => Promise<unknown>;
  onWorkingStatusError?: (error: unknown) => void;
}

export interface EmitTelegramTurnLatencyOptions {
  chatKey: string;
  sessionId: string;
  deliveryAt: number;
  delivered: boolean;
  getStatusImpl: GetStatus;
  setStatusIfImpl: SetStatusIf;
  logImpl?: (line: string) => void;
}

export interface MarkTelegramFirstOutputOptions {
  chatKey: string;
  sessionId: string;
  now?: () => number;
  getStatusImpl: GetStatus;
  setStatusIfImpl: SetStatusIf;
}

export interface MarkTelegramTurnAliveOptions {
  chatKey: string;
  sessionId: string;
  now?: () => number;
  minIntervalMs?: number;
  beats?: Map<string, TurnHeartbeat>;
  getStatusImpl: GetStatus;
  setStatusIfImpl: SetStatusIf;
}

export type TurnHeartbeat = { sessionId: string; at: number };

// Пульс живого хода. Жнец моста (scripts/poller/queue.ts) считает ход мёртвым по
// возрасту updatedAt, а тот двигался только на старте хода, первом выводе и финале:
// молчаливый ход на сорок минут (глубокий ресёрч) получал насильный idle, реальный
// сброс континуации и ложь «ход оборвался» — при живом ходе. Теперь ход сам
// подтверждает, что жив, из своих же событий.
//
// Дёшево: события идут пачками, поэтому запись в run-status дросселируется одной на
// интервал и делается CAS-ом по sessionId — опоздавший пульс не воскресит уже
// завершённый или сброшенный ход. Карта пульсов ключуется чатом, не сессией, поэтому
// не растёт с числом ходов.
export const TURN_HEARTBEAT_MIN_INTERVAL_MS = 60_000;
const turnHeartbeats = new Map<string, TurnHeartbeat>();

const durationFromIngress = (ingressAt: unknown, at: unknown): number | null =>
  typeof ingressAt === "number" &&
  Number.isFinite(ingressAt) &&
  typeof at === "number" &&
  Number.isFinite(at) &&
  at >= ingressAt
    ? at - ingressAt
    : null;

export async function publishTelegramEarlyStatus({
  chatKey,
  ingressId = randomUUID(),
  now = Date.now,
  staleMs = 30 * 60_000,
  getStatusImpl,
  setStatusIfImpl,
  sendWorkingStatusImpl,
  removeWorkingStatusImpl = async () => {},
  onWorkingStatusError = () => {},
}: PublishTelegramEarlyStatusOptions): Promise<string | null> {
  const ingressAt = now();
  // Мост пропускает реплаи на сообщения бота мимо busy-очереди, поэтому сюда можно
  // попасть, пока предыдущий ход ещё бежит. Безусловный overwrite крал у него
  // sessionId+statusMessageId: терминальная уборка проходила мимо CAS и «Работаю…/Стоп»
  // оставался в чате навсегда. Живой ход не трогаем — его индикатор уже на экране,
  // а свой этот ход получит в turn.started. Клейм — CAS по generation, чтобы
  // конкурирующий ingress не украл состояние между read и write.
  let claimed = null;
  let orphanMessageId: number | undefined;
  try {
    for (let attempt = 0; attempt < 3 && !claimed; attempt++) {
      const current = getStatusImpl(chatKey);
      if (
        current?.status === "running" &&
        typeof current.updatedAt === "number" &&
        ingressAt - current.updatedAt < staleMs
      ) {
        return null;
      }
      // Протухший running: после overwrite его индикатор больше никто не найдёт —
      // прибираем сами (best-effort, как в reaper).
      orphanMessageId =
        current?.status === "running" &&
        typeof current.statusMessageId === "number"
          ? current.statusMessageId
          : undefined;
      claimed = setStatusIfImpl(
        chatKey,
        { generation: current?.generation },
        {
          status: "running",
          ingressId,
          ingressAt,
          statusAt: null,
          turnAt: null,
          firstOutputAt: null,
          sessionId: null,
          turnId: null,
          statusMessageId: null,
          latencyLogged: null,
          resetAt: null,
        },
      );
    }
  } catch (error) {
    onWorkingStatusError(error);
    return null;
  }
  if (!claimed) return null;
  if (orphanMessageId !== undefined) {
    try {
      await removeWorkingStatusImpl(orphanMessageId);
    } catch (error) {
      onWorkingStatusError(error);
    }
  }

  let statusMessageId;
  try {
    statusMessageId = await sendWorkingStatusImpl({ canStop: false });
  } catch (error) {
    onWorkingStatusError(error);
    return ingressId;
  }
  if (statusMessageId === null || statusMessageId === undefined)
    return ingressId;

  const attached = setStatusIfImpl(
    chatKey,
    { status: "running", ingressId },
    { statusMessageId, statusAt: now() },
  );
  if (!attached) {
    try {
      await removeWorkingStatusImpl(statusMessageId);
    } catch (error) {
      onWorkingStatusError(error);
    }
  }
  return ingressId;
}

export async function publishTelegramTurnStarted({
  chatKey,
  continuationToken: rawContinuationToken,
  sessionId,
  turnId,
  now = Date.now,
  getStatusImpl,
  setStatusIfImpl,
  sendWorkingStatusImpl,
  enableWorkingStatusStopImpl = async () => {},
  removeWorkingStatusImpl = async () => {},
  onWorkingStatusError = () => {},
}: PublishTelegramTurnStartedOptions): Promise<boolean> {
  // Trace: ключ апдейта ↔ ход. Единственное место, где события «до хода» (Bridge,
  // Inbound pipeline, Gate) сшиваются с событиями eve — раньше turnId не существует.
  traceTurnBound(chatKey, sessionId, turnId);
  // Обработчики событий eve отдают токен с именем канала впереди. В статусе он должен
  // лежать только channel-local: reset-роут клеит имя канала сам (#110).
  const continuationToken = toChannelLocalToken(rawContinuationToken);
  const current = getStatusImpl(chatKey);
  if (
    current?.status !== "running" ||
    typeof current.ingressId !== "string" ||
    current.ingressId.length === 0 ||
    current.sessionId !== undefined
  ) {
    // Callback/HITL and proactive turns do not pass through onMessage. Preserve
    // their existing status behavior with a generation CAS, while a reset
    // tombstone always wins over a late old turn.
    if (current?.resetAt !== undefined) return false;
    let claimed;
    try {
      claimed = setStatusIfImpl(
        chatKey,
        { generation: current?.generation },
        {
          status: "running",
          continuationToken,
          sessionId,
          turnId,
          statusMessageId: null,
          turnAt: now(),
          latencyLogged: null,
        },
      );
    } catch (error) {
      onWorkingStatusError(error);
      return false;
    }
    if (!claimed || sendWorkingStatusImpl === undefined)
      return Boolean(claimed);
    let statusMessageId;
    try {
      statusMessageId = await sendWorkingStatusImpl({ canStop: true });
    } catch (error) {
      onWorkingStatusError(error);
      return true;
    }
    if (statusMessageId === null || statusMessageId === undefined) return true;
    const attached = setStatusIfImpl(
      chatKey,
      { status: "running", sessionId, turnId },
      { statusMessageId },
    );
    if (!attached) {
      try {
        await removeWorkingStatusImpl(statusMessageId);
      } catch (error) {
        onWorkingStatusError(error);
      }
    }
    return true;
  }
  try {
    const adopted = setStatusIfImpl(
      chatKey,
      {
        status: "running",
        ingressId: current.ingressId,
        sessionId: undefined,
      },
      {
        continuationToken,
        sessionId,
        turnId,
        turnAt: now(),
      },
    );
    if (!adopted) return false;
    if (current.statusMessageId !== undefined) {
      try {
        await enableWorkingStatusStopImpl(current.statusMessageId as number);
      } catch (error) {
        onWorkingStatusError(error);
      }
    }
    return true;
  } catch (error) {
    onWorkingStatusError(error);
    return false;
  }
}

export async function abandonTelegramEarlyStatus({
  chatKey,
  ingressId,
  getStatusImpl,
  setStatusIfImpl,
  removeWorkingStatusImpl = async () => {},
  onWorkingStatusError = () => {},
}: AbandonTelegramEarlyStatusOptions): Promise<boolean> {
  const current = getStatusImpl(chatKey);
  if (
    current?.status !== "running" ||
    current.ingressId !== ingressId ||
    current.sessionId !== undefined
  ) {
    return false;
  }
  const cleared = setStatusIfImpl(
    chatKey,
    { status: "running", ingressId, sessionId: undefined },
    {
      status: "idle",
      ingressId: null,
      ingressAt: null,
      statusAt: null,
      turnAt: null,
      firstOutputAt: null,
      statusMessageId: null,
      latencyLogged: null,
    },
  );
  if (!cleared) return false;
  if (current.statusMessageId !== undefined) {
    try {
      await removeWorkingStatusImpl(current.statusMessageId as number);
    } catch (error) {
      onWorkingStatusError(error);
    }
  }
  return true;
}

export function markTelegramFirstOutput({
  chatKey,
  sessionId,
  now = Date.now,
  getStatusImpl,
  setStatusIfImpl,
}: MarkTelegramFirstOutputOptions): boolean {
  const current = getStatusImpl(chatKey);
  if (
    current?.status !== "running" ||
    current.sessionId !== sessionId ||
    current.firstOutputAt !== undefined
  ) {
    return false;
  }
  return Boolean(
    setStatusIfImpl(
      chatKey,
      { status: "running", sessionId, firstOutputAt: undefined },
      { firstOutputAt: now() },
    ),
  );
}

export function markTelegramTurnAlive({
  chatKey,
  sessionId,
  now = Date.now,
  minIntervalMs = TURN_HEARTBEAT_MIN_INTERVAL_MS,
  beats = turnHeartbeats,
  getStatusImpl,
  setStatusIfImpl,
}: MarkTelegramTurnAliveOptions): boolean {
  const at = now();
  const previous = beats.get(chatKey);
  if (previous?.sessionId === sessionId && at - previous.at < minIntervalMs)
    return false;
  const current = getStatusImpl(chatKey);
  if (current?.status !== "running" || current.sessionId !== sessionId) {
    // Ход этого чата уже не наш: пульс не пишем и забываем его отметку.
    if (previous !== undefined) beats.delete(chatKey);
    return false;
  }
  // Отметку ставим до записи: сбойный CAS не должен превращать поток событий в
  // поток попыток записи. Следующая попытка всё равно придёт через интервал.
  beats.set(chatKey, { sessionId, at });
  // Патч пустой намеренно: пульсу нечего сообщать, кроме «я жив», а любая успешная
  // запись run-status двигает updatedAt (agent/lib/run-status.ts). Отдельное поле
  // дублировало бы updatedAt и требовало уборки в каждом терминальном патче.
  return Boolean(
    setStatusIfImpl(chatKey, { status: "running", sessionId }, {}),
  );
}

export function emitTelegramTurnLatency({
  chatKey,
  sessionId,
  deliveryAt,
  delivered,
  getStatusImpl,
  setStatusIfImpl,
  logImpl = console.log,
}: EmitTelegramTurnLatencyOptions): boolean {
  if (delivered !== true) return false;
  const current = getStatusImpl(chatKey);
  if (
    current?.status !== "running" ||
    current.sessionId !== sessionId ||
    current.latencyLogged !== undefined
  ) {
    return false;
  }
  const marked = setStatusIfImpl(
    chatKey,
    { status: "running", sessionId, latencyLogged: undefined },
    { latencyLogged: true },
  );
  if (!marked) return false;

  const record = {
    event: "telegram_turn_latency",
    ingressToStatusMs: durationFromIngress(current.ingressAt, current.statusAt),
    ingressToTurnMs: durationFromIngress(current.ingressAt, current.turnAt),
    ingressToFirstOutputMs: durationFromIngress(
      current.ingressAt,
      current.firstOutputAt,
    ),
    ingressToDeliveryMs: durationFromIngress(current.ingressAt, deliveryAt),
  };
  logImpl(JSON.stringify(record));
  return true;
}
