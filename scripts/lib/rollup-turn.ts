// Таймаут одного хода ночного роллапа.
//
// Зачем: на eve 0.27.13 резюм припаркованной сессии ПОСЛЕ рестарта сервера виснет молча
// (vercel/eve#1450) — `session.send()` отвечает 200, а `await response.result()` не резолвится никогда.
// Обычный try/catch такое не ловит: ошибки нет, ход просто не заканчивается, и ночной
// юнит висит до утра, не написав ни строчки в журнал. Гонка с таймером превращает молчание
// в честную ошибку, по которой вызывающий может уйти на свежую сессию.
//
// Таймер обязательно гасится в finally: живой setTimeout держит event loop и не даёт
// процессу (и тесту) завершиться после успешного хода.

export const DEFAULT_TURN_TIMEOUT_MS = 10 * 60_000;

// Node держит таймер в 32-битном знаковом диапазоне: всё сверх этого молча схлопывается в 1 мс.
const MAX_TIMER_MS = 2 ** 31 - 1;

// Разбор ROLLUP_TURN_TIMEOUT_MS. Пустая строка (частый случай — `ROLLUP_TURN_TIMEOUT_MS=` в .env)
// и мусор дают Number() → 0/NaN, а это таймер на 1 мс: каждый ход «зависал» бы мгновенно и ночь
// уходила бы в фолбэк. Мусор не роняет ночь — падаем на дефолт и громко пишем в stderr.
interface TimeoutOptions {
  readonly timeoutMs?: number;
}

interface TurnTimeoutOptions extends TimeoutOptions {
  readonly label?: string;
}

interface RetryState {
  readonly cancelConfirmed: boolean;
  readonly sessionNotActive: boolean;
}

interface CancelSession<T = unknown> {
  cancel(options?: { turnId?: string }): Promise<T>;
}

interface CancelResult {
  readonly status?: string;
}

interface TurnResult {
  readonly events?: readonly { readonly type?: string }[];
}

export function resolveTurnTimeoutMs(
  raw: string | undefined | null,
  {
    warn = (): void => {},
  }: {
    warn?: (message: string) => void;
  } = {},
): number {
  if (raw === undefined || raw === null || String(raw).trim() === "")
    return DEFAULT_TURN_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > MAX_TIMER_MS) {
    warn(
      `ROLLUP_TURN_TIMEOUT_MS=${String(raw)} is not a positive integer of milliseconds (max ${MAX_TIMER_MS}) — ` +
        `falling back to ${DEFAULT_TURN_TIMEOUT_MS}`,
    );
    return DEFAULT_TURN_TIMEOUT_MS;
  }
  return n;
}

export class RollupTurnTimeoutError extends Error {
  declare readonly code: "ROLLUP_TURN_TIMEOUT";
  declare readonly label: string;

  constructor(label: string, timeoutMs: number) {
    super(
      `rollup turn "${label}" timed out after ${Math.round(timeoutMs / 1000)}s`,
    );
    this.name = "RollupTurnTimeoutError";
    this.code = "ROLLUP_TURN_TIMEOUT";
    this.label = label;
  }
}

export const DEFAULT_CANCEL_TIMEOUT_MS = 30_000;

// Любой сетевой отказ send двусмысленен: сервер мог принять ход до обрыва ответа.
// Без отмены retry безопасен только для штатного 409 session_not_active от eve.
export function isSessionNotActiveError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as {
    readonly code?: unknown;
    readonly status?: unknown;
  };
  return candidate.status === 409 && candidate.code === "session_not_active";
}

export function canRetryFresh({
  cancelConfirmed,
  sessionNotActive,
}: RetryState): boolean {
  return sessionNotActive === true || cancelConfirmed === true;
}

// Отмена проигравшего гонку хода. Таймаут не останавливает ход на сервере — тот продолжает
// писать в vault, — поэтому перед retry в свежей сессии старый ход надо погасить, иначе два
// писателя правят одни и те же карточки и CORE.md под одним флоком.
// Best-effort по определению: у заклинившей сессии cancel сам может висеть или ответить 500,
// а у не начатой — бросить. Любой исход проглатывается, наверх идёт только признак успеха.
export async function cancelTurnQuietly(
  session: CancelSession,
  { timeoutMs = DEFAULT_CANCEL_TIMEOUT_MS }: TimeoutOptions = {},
): Promise<boolean> {
  try {
    await withTurnTimeout(() => session.cancel(), {
      timeoutMs,
      label: "cancel",
    });
    return true;
  } catch {
    return false;
  }
}

// Успешный HTTP-ответ cancel ещё не означает, что ход перестал писать. `accepted` только
// принимает сигнал отмены; безопасную границу подтверждает `turn.cancelled` в дочитанном
// результате. `no_active_turn` сам является серверным подтверждением, что писателя уже нет.
export async function cancelTurnAndConfirmQuietly(
  session: CancelSession<CancelResult>,
  turnResult: Promise<TurnResult> | undefined,
  { timeoutMs = DEFAULT_CANCEL_TIMEOUT_MS }: TimeoutOptions = {},
): Promise<boolean> {
  try {
    const cancellation = await withTurnTimeout(() => session.cancel(), {
      timeoutMs,
      label: "cancel",
    });
    if (cancellation?.status === "no_active_turn") return true;
    if (cancellation?.status !== "accepted" || !turnResult) return false;
    const result = await withTurnTimeout(() => turnResult, {
      timeoutMs,
      label: "cancel-terminal",
    });
    return (
      result?.events?.some((event) => event?.type === "turn.cancelled") === true
    );
  } catch {
    return false;
  }
}

// Выполняет fn() и отклоняется RollupTurnTimeoutError, если тот не уложился в timeoutMs.
// Проигравшая сторона гонки не отменяется (у eve-хода нет abort) — она просто повисает
// в фоне; вызывающий должен считать сессию непригодной и завести новую.
export async function withTurnTimeout<T>(
  fn: () => Promise<T>,
  {
    timeoutMs = DEFAULT_TURN_TIMEOUT_MS,
    label = "turn",
  }: TurnTimeoutOptions = {},
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new RollupTurnTimeoutError(label, timeoutMs)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
