// Пробуждение агента после запуска расписания (T20 п.2). Вызывается ребёнком
// scripts/jobs/wake.ts: читает строку факта, собирает текст хода, запускает ход агента и
// возвращает владельцу только непустой ответ. Исход хода (ответил / ответил пустым /
// провалился) приписывается строке запуска — по нему дневной сторож понимает, что агент
// не отвечает.
//
// Никаких политик повторов здесь нет: провал хода — факт, а не повод будить снова.
import {
  recordWake,
  readFacts,
  type JobFact,
  type JobWake,
} from "#lib/job-facts.ts";

export type Translate = (english: string, russian: string) => string;

export type WakeTurnResult = {
  readonly status: "completed" | "failed" | "waiting";
  readonly message?: string;
};

export interface JobWakeDeps {
  readonly factsFile: string;
  readonly tr: Translate;
  readonly runTurn: (prompt: string) => Promise<WakeTurnResult>;
  readonly send: (text: string) => Promise<boolean>;
  /** Test seam for the durable wake record; production uses recordWake. */
  readonly recordWake?: typeof recordWake;
  /** Тихий ли час владельца: ответ хода о провале тогда не шлётся, провал ждёт утреннего Brief. */
  readonly quiet?: (now: number) => boolean;
  readonly now?: () => number;
  readonly log?: (...args: unknown[]) => void;
}

/** `data` кнопки «Починить» — не длиннее 64 байт, лимита Telegram на callback_data. */
export function fixButtonData(name: string, tr: Translate): string {
  const chars = [...tr(`Fix: ${name}`, `Починить: ${name}`)];
  while (Buffer.byteLength(chars.join("")) > 64) chars.pop();
  return chars.join("");
}

/** Текст хода: что случилось, что делать на ok и что на провале, плюс хвост журнала. */
export function jobWakePrompt(fact: JobFact, tr: Translate): string {
  const outcome = fact.ok ? tr("ok", "ок") : tr("failed", "провал");
  const reason = fact.error ?? tr("no reason recorded", "причина не записана");
  const instruction = fact.ok
    ? tr(
        "Nothing is broken: do nothing and answer with an empty message, without thinking.",
        "Всё в порядке: ничего не делай и ответь пустым, без размышлений.",
      )
    : tr(
        "Do not fix or change anything yet — read only: no restarts, no reset-failed, no edits, no trial runs. Find the cause (the log tail below, more with your tools if needed), tell the owner briefly what broke and why, and end with one button (see rich-replies): " +
          `<tg-button-row><tg-button type="callback_data" data="${fixButtonData(fact.name, tr)}">Fix</tg-button></tg-button-row>. ` +
          "Fix it only after the owner taps it.",
        "Пока ничего не чини и не меняй — только чтение: без перезапусков, reset-failed, правок и пробных запусков. Разбери причину (хвост журнала ниже, при нужде — своими инструментами), коротко скажи владельцу, что сломалось и почему, и закончи одной кнопкой (см. rich-replies): " +
          `<tg-button-row><tg-button type="callback_data" data="${fixButtonData(fact.name, tr)}">Починить</tg-button></tg-button-row>. ` +
          "Чини только после тапа владельца.",
      );
  const head = `${tr("Scheduled job", "Расписание")} ${fact.name} ${tr("finished", "завершилось")}: ${outcome}, ${reason} (exit=${fact.exitCode ?? "n/a"}).`;
  const tail = fact.tail
    ? `\n${tr("Log tail", "Хвост журнала")}:\n${fact.tail}`
    : "";
  return `${head}\n${instruction}${tail}`;
}

/** Исход пробуждения для вызывающего: статус строки или «отложен до утреннего Brief». */
export type WakeOutcome = JobWake["status"] | "deferred";

/** Контекст одного пробуждения: куда писать исход и как говорить в журнал. */
type WakeRun = {
  readonly name: string;
  readonly startedAt: number;
  readonly deps: JobWakeDeps;
  readonly now: () => number;
  readonly log: (...args: unknown[]) => void;
};

/** Ответ хода или причина его провала. */
type AgentAnswer = { readonly message: string } | { readonly failure: string };

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function agentAnswer(
  fact: JobFact,
  deps: JobWakeDeps,
): Promise<AgentAnswer> {
  try {
    const turn = await deps.runTurn(jobWakePrompt(fact, deps.tr));
    // Провал — только `failed`. `waiting` — нормальный конец хода: eve не шлёт
    // `session.completed`, после хода сессия остаётся ждать следующего сообщения
    // (прод c1 13.09: каждое пробуждение падало как «turn waiting»).
    // Причина провала хода (в том числе упор в лимит токенов сессии eve) остаётся в строке
    // факта: по ней сторож объясняет владельцу, почему агент не ответил.
    if (turn.status === "failed")
      return {
        failure: turn.message ? `turn failed: ${turn.message}` : "turn failed",
      };
    return { message: (turn.message ?? "").trim() };
  } catch (error) {
    return { failure: reasonOf(error) };
  }
}

/** Исход «пусто»; не записался — ход для сторожа не состоялся (T30 №10). */
async function settleEmpty(
  run: WakeRun,
  line: string,
): Promise<JobWake["status"]> {
  const recorded = await recordOutcome(run.deps, run.name, run.startedAt, {
    at: run.now(),
    status: "empty",
    error: null,
  });
  run.log(line);
  return recorded ? "empty" : "failed";
}

async function sendAnswer(
  send: JobWakeDeps["send"],
  message: string,
): Promise<string | null> {
  try {
    return (await send(message)) ? null : "telegram send was refused";
  } catch (error) {
    return reasonOf(error);
  }
}

async function deliverAnswer(
  run: WakeRun,
  message: string,
): Promise<JobWake["status"]> {
  const sendError = await sendAnswer(run.deps.send, message);
  // Ответ, который не доехал, — провал хода, а не состоявшийся ответ: владелец не получил
  // ничего, и страховка обязана считать такой ход не бывшим (слепая приёмка T20 по v6).
  const recorded = await recordOutcome(run.deps, run.name, run.startedAt, {
    at: run.now(),
    status: sendError === null ? "answered" : "failed",
    error: sendError,
  });
  run.log(
    sendError
      ? `wake: ${run.name} answered, but the owner did not get it: ${sendError}`
      : `wake: ${run.name} answered the owner`,
  );
  // Несданный исход = ход не состоялся для сторожа (T30 №10).
  if (!recorded) return "failed";
  return sendError === null ? "answered" : "failed";
}

/** Ход по провалу запуска: ответ уходит владельцу, провал и пустота — в строку факта. */
async function wakeOnFailure(
  run: WakeRun,
  fact: JobFact,
): Promise<WakeOutcome> {
  // Ход идёт и в тихие часы: только он показывает сторожу, жив ли агент. Упал — исход failed,
  // и сторож jobs-watchdog скажет владельцу утром, как раньше.
  const answer = await agentAnswer(fact, run.deps);
  if ("failure" in answer) {
    await recordOutcome(run.deps, run.name, run.startedAt, {
      at: run.now(),
      status: "failed",
      error: answer.failure,
    });
    run.log(`wake: ${run.name} turn failed: ${answer.failure}`);
    return "failed";
  }
  // Тихие часы: ответ ночью не шлём; провал открыт и встанет первым в утреннем Brief. На диске —
  // `empty` и признак deferred: ход был, агент жив (сторож), а 0.4.11 строку читает.
  if (run.deps.quiet?.(run.now()) === true) {
    const recorded = await recordOutcome(run.deps, run.name, run.startedAt, {
      at: run.now(),
      status: "empty",
      error: null,
      deferred: true,
    });
    run.log(
      `wake: ${run.name} failed in the quiet hours, deferred to the morning brief`,
    );
    return recorded ? "deferred" : "failed";
  }
  if (answer.message.length === 0)
    return settleEmpty(run, `wake: ${run.name} answered with an empty message`);
  return deliverAnswer(run, answer.message);
}

/**
 * Один ход по факту. Возвращает исход хода; строка факта всегда получает его (кроме
 * случая, когда строки уже нет, — тогда пробуждение не к чему приписать).
 */
export async function runJobWake(
  name: string,
  startedAt: number,
  deps: JobWakeDeps,
): Promise<WakeOutcome> {
  const run: WakeRun = {
    name,
    startedAt,
    deps,
    now: deps.now ?? Date.now,
    log:
      deps.log ??
      ((...args: unknown[]) => console.log(new Date().toISOString(), ...args)),
  };
  const facts = await readFacts(deps.factsFile);
  const fact = facts.find(
    (row) => row.name === name && row.startedAt === startedAt,
  );
  if (!fact) {
    run.log(`wake: ${name}@${startedAt} is not in the facts table`);
    return "failed";
  }
  if (fact.ok)
    return settleEmpty(run, `wake: ${name} succeeded; no agent turn needed`);
  return wakeOnFailure(run, fact);
}

/** Persists a wake outcome and makes failed persistence visible to the caller. */
async function recordOutcome(
  deps: JobWakeDeps,
  name: string,
  startedAt: number,
  wake: JobWake,
): Promise<boolean> {
  try {
    await (deps.recordWake ?? recordWake)(
      deps.factsFile,
      name,
      startedAt,
      wake,
    );
    return true;
  } catch (error) {
    // Запись исхода не сдалась: для сторожа хода не было, поэтому вызывающий обязан
    // вернуть failed, а не выдать отправку за состоявшийся ход (T30 №10).
    const log = deps.log ?? console.error;
    log(
      `wake: could not record the outcome of ${name}@${startedAt}:`,
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}
