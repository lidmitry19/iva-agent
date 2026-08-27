/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registration promises. */
// eve 0.30.8: result() читает поток с сохранённого streamIndex и останавливается на
// первой границе хода, не сверяя её с только что отправленным сообщением (vercel/eve#2461).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ClientSession } from "eve/client";
import {
  attachRollupNonce,
  drainStreamToTail,
  isOwnTurnResult,
  sentNotBeforeIso,
} from "./rollup-stale-cursor.ts";

function asClientStream(session: {
  stream(options?: {
    follow: false;
    signal?: AbortSignal;
  }): AsyncIterable<unknown>;
}): Pick<ClientSession, "stream"> {
  return session as Pick<ClientSession, "stream">;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const ROLLUP_SRC = readFileSync(join(HERE, "../memory/rollup.ts"), "utf8");

interface StreamEvent {
  readonly type: string;
  readonly data?: { readonly message?: string; readonly finishReason?: string };
  readonly meta?: { readonly at: string };
}

function received(message: string, at: string): StreamEvent {
  return {
    type: "message.received",
    data: { message },
    meta: { at },
  };
}

function completed(message: string, at: string): StreamEvent {
  return {
    type: "message.completed",
    data: { message, finishReason: "stop" },
    meta: { at },
  };
}

function waiting(at: string): StreamEvent {
  return { type: "session.waiting", meta: { at } };
}

function turn(prompt: string, report: string, at: string): StreamEvent[] {
  return [received(prompt, at), completed(report, at), waiting(at)];
}

function isTurnBoundary(event: StreamEvent): boolean {
  return (
    event.type === "session.completed" ||
    event.type === "session.failed" ||
    event.type === "session.waiting"
  );
}

// Модель result() eve 0.30.8: collectTurnEvents с сохранённого курсора до первой границы.
function resultFromCursor(
  stream: readonly StreamEvent[],
  streamIndex: number,
): {
  readonly events: StreamEvent[];
  readonly message: string | undefined;
  readonly status: "completed" | "failed" | "waiting";
} {
  const events: StreamEvent[] = [];
  for (let i = streamIndex; i < stream.length; i++) {
    const event = stream[i];
    if (event === undefined) break;
    events.push(event);
    if (isTurnBoundary(event)) break;
  }
  let message: string | undefined;
  let status: "completed" | "failed" | "waiting" = "completed";
  for (const event of events) {
    if (
      event.type === "message.completed" &&
      event.data?.finishReason !== "tool-calls"
    ) {
      message = event.data?.message;
    }
    if (event.type === "session.waiting") status = "waiting";
    if (event.type === "session.failed") status = "failed";
  }
  return { events, message, status };
}

// origin/main в scripts/memory/rollup.ts: после result() нет сверки с промптом —
// любой waiting-ход с непустым текстом уходит в Telegram.
function mainWouldDeliver(result: {
  readonly status: string;
  readonly message: string | undefined;
}): boolean {
  return result.status !== "failed" && Boolean(result.message);
}

// PR 204: точный текст промпта + meta.at не старше process start минус 60с.
function pr204Owns(
  events: readonly StreamEvent[],
  prompt: string,
  sentNotBefore: string,
): boolean {
  return events.some(
    (event) =>
      event.type === "message.received" &&
      event.data?.message === prompt &&
      (event.meta?.at ?? "") >= sentNotBefore,
  );
}

class FakeSession {
  streamIndex: number;
  readonly events: StreamEvent[];
  constructor(events: StreamEvent[], streamIndex: number) {
    this.events = events;
    this.streamIndex = streamIndex;
  }
  stream(options?: {
    follow: false;
    signal?: AbortSignal;
  }): AsyncIterable<StreamEvent> {
    if ((options ?? { follow: false }).follow !== false)
      throw new Error("expected follow:false");
    const signal = options?.signal;
    return {
      [Symbol.asyncIterator]: () => {
        let closed = false;
        const stop = (): void => {
          closed = true;
        };
        signal?.addEventListener("abort", stop, { once: true });
        if (signal?.aborted) stop();
        return {
          next: async () => {
            await Promise.resolve();
            if (closed || signal?.aborted) {
              return { done: true as const, value: undefined };
            }
            if (this.streamIndex >= this.events.length) {
              return { done: true as const, value: undefined };
            }
            const value = this.events[this.streamIndex];
            this.streamIndex += 1;
            return { done: false as const, value };
          },
          return: () => {
            closed = true;
            return Promise.resolve({ done: true as const, value: undefined });
          },
        };
      },
    };
  }
}

const OLD_PROMPT =
  "You are processing long-term memory. It is now 2026-08-19. Process the completed day 2026-08-18.";
const TONIGHT_PROMPT =
  "You are processing long-term memory. It is now 2026-08-24. Process the completed day 2026-08-23.";
const OLD_REPORT = "Обработан день 2026-08-18";
const TONIGHT_REPORT = "Обработан день 2026-08-23";

test("origin/main delivers a lagged-cursor result from a previous night", () => {
  const stream = [
    ...turn(OLD_PROMPT, OLD_REPORT, "2026-08-19T04:01:00.000Z"),
    ...turn(TONIGHT_PROMPT, TONIGHT_REPORT, "2026-08-24T04:01:00.000Z"),
  ];
  // Курсор отстал на один ход: result() останавливается на первой границе и отдаёт старый отчёт.
  const result = resultFromCursor(stream, 0);
  assert.equal(result.status, "waiting");
  assert.equal(result.message, OLD_REPORT);
  assert.equal(
    mainWouldDeliver(result),
    true,
    "main has no ownership check, so the five-day-old report would be delivered",
  );
});

test("a lagged cursor result is not this Turn's result", () => {
  const stream = [
    ...turn(OLD_PROMPT, OLD_REPORT, "2026-08-19T04:01:00.000Z"),
    ...turn(TONIGHT_PROMPT, TONIGHT_REPORT, "2026-08-24T04:01:00.000Z"),
  ];
  const result = resultFromCursor(stream, 0);
  const tonight = attachRollupNonce(TONIGHT_PROMPT, "tonight");
  assert.equal(
    isOwnTurnResult(result.events, {
      prompt: tonight,
      sentNotBefore: sentNotBeforeIso(Date.parse("2026-08-24T04:00:00.000Z")),
    }),
    false,
  );
});

test("drainStreamToTail advances a lagged cursor to the tail before send", async () => {
  const stream = [
    ...turn(OLD_PROMPT, OLD_REPORT, "2026-08-19T04:01:00.000Z"),
    ...turn(TONIGHT_PROMPT, TONIGHT_REPORT, "2026-08-24T04:01:00.000Z"),
  ];
  const session = new FakeSession(stream, 0);
  await drainStreamToTail(asClientStream(session));
  assert.equal(session.streamIndex, stream.length);
  const tonight = attachRollupNonce(TONIGHT_PROMPT, "tonight");
  const live = [
    ...stream,
    ...turn(tonight, TONIGHT_REPORT, "2026-08-24T04:02:00.000Z"),
  ];
  const result = resultFromCursor(live, session.streamIndex);
  assert.equal(result.message, TONIGHT_REPORT);
  assert.equal(
    isOwnTurnResult(result.events, {
      prompt: tonight,
      sentNotBefore: "2026-08-24T04:00:00.000Z",
    }),
    true,
  );
});

test("drainStreamToTail swallows a stream error so send can still proceed", async () => {
  const session = {
    stream(options?: {
      follow: false;
      signal?: AbortSignal;
    }): AsyncIterable<never> {
      if ((options ?? { follow: false }).follow !== false)
        throw new Error("expected follow:false");
      throw new Error("stream unavailable");
    },
  };
  const errors: string[] = [];
  await drainStreamToTail(session, (error) => errors.push(error.message));
  assert.deepEqual(errors, ["stream unavailable"]);
});

test("drainStreamToTail finishes when both next and return hang past the timeout", async () => {
  const session = {
    stream(options?: {
      follow: false;
      signal?: AbortSignal;
    }): AsyncIterable<never> {
      if ((options ?? { follow: false }).follow !== false)
        throw new Error("expected follow:false");
      return {
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise<IteratorResult<never>>(() => {}),
          return: () => new Promise<IteratorResult<never>>(() => {}),
        }),
      };
    },
  };
  const errors: string[] = [];
  const started = Date.now();
  await drainStreamToTail(session, (error) => errors.push(error.message), 50);
  const elapsed = Date.now() - started;
  assert.ok(
    elapsed < 1000,
    `hung drain must finish within the timeout, took ${elapsed}ms`,
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? "", /timed out/);
});

test("drainStreamToTail passes abort signal so a late next does not advance the cursor", async () => {
  let hasSignal = false;
  let streamIndex = 0;
  let closed = false;
  let pendingResolve: ((result: IteratorResult<unknown>) => void) | undefined;
  const session = {
    stream(options?: {
      follow: false;
      signal?: AbortSignal;
    }): AsyncIterable<unknown> {
      hasSignal = options?.signal !== undefined;
      const signal = options?.signal;
      signal?.addEventListener(
        "abort",
        () => {
          closed = true;
        },
        { once: true },
      );
      return {
        [Symbol.asyncIterator]: () => ({
          next: () =>
            new Promise<IteratorResult<unknown>>((resolve) => {
              pendingResolve = (result) => {
                if (closed || signal?.aborted) {
                  resolve({ done: true, value: undefined });
                  return;
                }
                streamIndex += 1;
                resolve(result);
              };
            }),
          return: () => {
            closed = true;
            return Promise.resolve({ done: true as const, value: undefined });
          },
        }),
      };
    },
  };
  const errors: string[] = [];
  await drainStreamToTail(
    asClientStream(session),
    (error) => errors.push(error.message),
    50,
  );
  assert.equal(hasSignal, true);
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? "", /timed out/);
  pendingResolve?.({ done: false, value: { type: "late" } });
  assert.equal(streamIndex, 0);
});

test("PR 204 still accepts a delayed previous Turn event; a per-Turn nonce does not", () => {
  const processStart = Date.parse("2026-08-24T04:00:00.000Z");
  const delayedAt = "2026-08-24T04:00:05.000Z";
  const previous = attachRollupNonce(TONIGHT_PROMPT, "previous");
  const tonight = attachRollupNonce(TONIGHT_PROMPT, "tonight");
  const delayedPrevious = received(previous, delayedAt);
  const delayedSameText = received(TONIGHT_PROMPT, delayedAt);

  assert.equal(
    pr204Owns(
      [delayedSameText],
      TONIGHT_PROMPT,
      new Date(processStart - 60_000).toISOString(),
    ),
    true,
    "PR 204: same-date prompt + 60s slack accepts a delayed previous Turn event",
  );
  assert.equal(
    isOwnTurnResult([delayedSameText], {
      prompt: TONIGHT_PROMPT,
      sentNotBefore: sentNotBeforeIso(processStart),
    }),
    true,
    "time check without a nonce still accepts an event stamped after process start",
  );
  assert.equal(
    isOwnTurnResult([delayedPrevious], {
      prompt: tonight,
      sentNotBefore: sentNotBeforeIso(processStart),
    }),
    false,
  );
  assert.equal(
    isOwnTurnResult([received(tonight, delayedAt)], {
      prompt: tonight,
      sentNotBefore: sentNotBeforeIso(processStart),
    }),
    true,
  );
});

test("sentNotBefore is the send instant, without a 60s slack window", () => {
  const processStart = Date.parse("2026-08-24T04:00:00.000Z");
  const tonight = attachRollupNonce(TONIGHT_PROMPT, "tonight");
  const earlierSameNight = received(tonight, "2026-08-24T03:59:50.000Z");
  assert.equal(
    isOwnTurnResult([earlierSameNight], {
      prompt: tonight,
      sentNotBefore: sentNotBeforeIso(processStart),
    }),
    false,
  );
  assert.equal(
    pr204Owns(
      [received(TONIGHT_PROMPT, "2026-08-24T03:59:50.000Z")],
      TONIGHT_PROMPT,
      new Date(processStart - 60_000).toISOString(),
    ),
    true,
  );
});

test("rollup.ts drains before every send, stamps send time, and refuses a foreign result", () => {
  assert.match(ROLLUP_SRC, /vercel\/eve#2461/);
  assert.match(ROLLUP_SRC, /drainStreamToTail\(/);
  assert.match(ROLLUP_SRC, /isOwnTurnResult\(/);
  assert.match(ROLLUP_SRC, /attachRollupNonce\(/);
  assert.match(ROLLUP_SRC, /sentNotBeforeIso\(/);
  assert.doesNotMatch(ROLLUP_SRC, /Date\.now\(\) - 60_000/);
  assert.match(ROLLUP_SRC, /if \(saved\) await drainBeforeSend\("main-turn"\)/);
  assert.match(ROLLUP_SRC, /await drainBeforeSend\("core-correction"\)/);
  assert.match(ROLLUP_SRC, /await drainBeforeSend\("format-feedback"\)/);
  assert.equal(
    [...ROLLUP_SRC.matchAll(/drainBeforeSend\("/g)].length,
    3,
    "main, core-correction, format-feedback",
  );
  assert.ok(
    ROLLUP_SRC.indexOf('await drainBeforeSend("core-correction")') <
      ROLLUP_SRC.indexOf('"core-correction",'),
  );
  assert.ok(
    ROLLUP_SRC.indexOf('await drainBeforeSend("format-feedback")') <
      ROLLUP_SRC.indexOf('"format-feedback",'),
  );
  const ownAt = ROLLUP_SRC.indexOf("isOwnTurnResult(");
  const saveAt = ROLLUP_SRC.indexOf(
    "saveSession(session.state, sessionCreatedAt);",
  );
  assert.ok(
    ownAt > 0 && ownAt < saveAt,
    "refuse stale before saving the cursor",
  );
});
