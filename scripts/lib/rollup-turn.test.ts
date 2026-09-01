import test from "node:test";
import assert from "node:assert/strict";
import { ClientError } from "eve/client";
import {
  cancelTurnAndConfirmQuietly,
  canRetryFresh,
  cancelTurnQuietly,
  DEFAULT_TURN_TIMEOUT_MS,
  isSessionNotActiveError,
  RollupTurnTimeoutError,
  resolveTurnTimeoutMs,
  withTurnTimeout,
} from "./rollup-turn.ts";

interface TestTurnResult {
  readonly events?: readonly { readonly type?: string }[];
}

interface TestResponse {
  result(): Promise<TestTurnResult>;
}

interface RetryPolicyOptions {
  readonly firstSend: (recordSend: () => void) => Promise<TestResponse>;
  readonly cancel: () => Promise<{ status?: string }>;
}

void test("fresh retry requires session_not_active or confirmed cancellation", () => {
  assert.equal(
    canRetryFresh({
      cancelConfirmed: false,
      sessionNotActive: false,
    }),
    false,
  );
  assert.equal(
    canRetryFresh({
      cancelConfirmed: true,
      sessionNotActive: false,
    }),
    true,
  );
  assert.equal(
    canRetryFresh({
      cancelConfirmed: false,
      sessionNotActive: true,
    }),
    true,
  );
});

void test("only a structured 409 session_not_active proves send rejection", () => {
  assert.equal(
    isSessionNotActiveError({ status: 409, code: "session_not_active" }),
    true,
  );
  assert.equal(
    isSessionNotActiveError({ status: 500, code: "session_not_active" }),
    false,
  );
  assert.equal(isSessionNotActiveError({ status: 409, code: "other" }), false);
  assert.equal(isSessionNotActiveError(new Error("session_not_active")), false);
});

async function countSendsThroughRetryPolicy({
  firstSend,
  cancel,
}: RetryPolicyOptions): Promise<number> {
  let sends = 0;
  let sessionNotActive = false;
  let acceptedTurnResult: Promise<TestTurnResult> | undefined;
  try {
    await withTurnTimeout(
      async () => {
        let response;
        try {
          response = await firstSend(() => {
            sends += 1;
          });
        } catch (error) {
          sessionNotActive = isSessionNotActiveError(error);
          throw error;
        }
        acceptedTurnResult = response.result();
        return await acceptedTurnResult;
      },
      { timeoutMs: 20, label: "main-turn" },
    );
  } catch {
    // Это точная модель catch-флоу rollup.ts, а не выполнение самого rollup.ts.
    const cancelConfirmed = !sessionNotActive
      ? await cancelTurnAndConfirmQuietly({ cancel }, acceptedTurnResult, {
          timeoutMs: 20,
        })
      : false;
    if (canRetryFresh({ sessionNotActive, cancelConfirmed })) sends += 1;
  }
  return sends;
}

void test("an accepted hung turn with refused cancellation never sends a fresh retry", async () => {
  const sends = await countSendsThroughRetryPolicy({
    firstSend: (recordSend) => {
      recordSend();
      return Promise.resolve({
        result: () => new Promise<TestTurnResult>(() => {}),
      });
    },
    cancel: () => Promise.reject(new Error("cancel refused")),
  });
  assert.equal(sends, 1);
});

void test("an accepted cancel response without a terminal cancelled event blocks fresh retry", async () => {
  const sends = await countSendsThroughRetryPolicy({
    firstSend: (recordSend) => {
      recordSend();
      return Promise.resolve({
        result: () => new Promise<TestTurnResult>(() => {}),
      });
    },
    cancel: () => Promise.resolve({ status: "accepted" }),
  });
  assert.equal(sends, 1);
});

void test("an accepted hung turn retries after the stream confirms turn.cancelled", async () => {
  let finishTurn: (value: TestTurnResult) => void;
  const sends = await countSendsThroughRetryPolicy({
    firstSend: (recordSend) => {
      recordSend();
      return Promise.resolve({
        result: () =>
          new Promise<TestTurnResult>((resolve) => {
            finishTurn = resolve;
          }),
      });
    },
    cancel: () => {
      finishTurn!({
        events: [{ type: "turn.cancelled" }, { type: "session.waiting" }],
      });
      return Promise.resolve({ status: "accepted" });
    },
  });
  assert.equal(sends, 2);
});

void test("a hung send with refused cancellation never sends a fresh retry", async () => {
  let cancels = 0;
  const sends = await countSendsThroughRetryPolicy({
    firstSend: async (recordSend) => {
      recordSend();
      return await new Promise<TestResponse>(() => {});
    },
    cancel: () => {
      cancels += 1;
      return Promise.resolve({ status: "accepted" });
    },
  });
  assert.equal(sends, 1);
  assert.equal(cancels, 1);
});

void test("a hung send gets one fresh retry when cancel reports no active turn", async () => {
  const sends = await countSendsThroughRetryPolicy({
    firstSend: async (recordSend) => {
      recordSend();
      return await new Promise<TestResponse>(() => {});
    },
    cancel: () => Promise.resolve({ status: "no_active_turn" }),
  });
  assert.equal(sends, 2);
});

void test("a disconnected send does not retry without confirmed cancellation", async () => {
  let cancels = 0;
  const sends = await countSendsThroughRetryPolicy({
    firstSend: (recordSend) => {
      recordSend();
      return Promise.reject(new TypeError("fetch failed"));
    },
    cancel: () => {
      cancels += 1;
      return Promise.resolve({ status: "accepted" });
    },
  });
  assert.equal(sends, 1);
  assert.equal(cancels, 1);
});

void test("a structured session_not_active rejection gets one fresh retry", async () => {
  const sends = await countSendsThroughRetryPolicy({
    firstSend: (recordSend) => {
      recordSend();
      return Promise.reject(
        new ClientError(
          409,
          JSON.stringify({ code: "session_not_active", error: "inactive" }),
        ),
      );
    },
    cancel: () =>
      Promise.reject(new Error("inactive sessions do not need cancellation")),
  });
  assert.equal(sends, 2);
});

void test("a turn that finishes in time returns its result", async () => {
  const result = await withTurnTimeout(() => Promise.resolve("report"), {
    timeoutMs: 50,
    label: "main-turn",
  });
  assert.equal(result, "report");
});

void test("a hung turn rejects with a labelled timeout error", async () => {
  await assert.rejects(
    withTurnTimeout(() => new Promise<never>(() => {}), {
      timeoutMs: 20,
      label: "main-turn",
    }),
    (e) => {
      assert.ok(e instanceof RollupTurnTimeoutError);
      assert.equal(e.code, "ROLLUP_TURN_TIMEOUT");
      assert.equal(e.label, "main-turn");
      assert.deepEqual(Object.keys(e), ["name", "code", "label"]);
      return true;
    },
  );
});

void test("the timer is cleared, so the next turn runs right after a win", async () => {
  assert.equal(
    await withTurnTimeout(() => Promise.resolve(1), {
      timeoutMs: DEFAULT_TURN_TIMEOUT_MS,
      label: "first",
    }),
    1,
  );
  assert.equal(
    await withTurnTimeout(() => Promise.resolve(2), {
      timeoutMs: DEFAULT_TURN_TIMEOUT_MS,
      label: "second",
    }),
    2,
  );
  // Файл теста завершается сам: незачищенный 10-минутный таймер держал бы event loop.
});

void test("the configured timeout is taken only when it is a sane millisecond count", () => {
  assert.equal(resolveTurnTimeoutMs("60000"), 60000);
  assert.equal(resolveTurnTimeoutMs(undefined), DEFAULT_TURN_TIMEOUT_MS);
});

void test("a malformed timeout falls back to the default and warns", () => {
  // Пустое значение и мусор дают Number() → 0/NaN: без разбора это был бы таймер на 1 мс,
  // то есть мгновенно «зависший» ход на каждой ночи.
  for (const raw of ["", "  ", "abc", "0", "-1", "1.5", String(2 ** 31)]) {
    const warnings: string[] = [];
    assert.equal(
      resolveTurnTimeoutMs(raw, { warn: (m) => warnings.push(m) }),
      DEFAULT_TURN_TIMEOUT_MS,
    );
    if (raw.trim() !== "")
      assert.equal(
        warnings.length,
        1,
        `expected a warning for ${JSON.stringify(raw)}`,
      );
  }
});

void test("a hung cancel is swallowed instead of blocking the retry", async () => {
  const session = { cancel: () => new Promise(() => {}) };
  assert.equal(await cancelTurnQuietly(session, { timeoutMs: 30 }), false);
});

void test("a refused cancel is swallowed too", async () => {
  // Не начатая сессия бросает синхронно, заклинившая может ответить 500 — оба исхода не наши.
  const throws = {
    cancel: () => {
      throw new Error("session has not started");
    },
  };
  const rejects = {
    cancel: () => Promise.reject(new Error("500 cancel-turn")),
  };
  assert.equal(await cancelTurnQuietly(throws, { timeoutMs: 30 }), false);
  assert.equal(await cancelTurnQuietly(rejects, { timeoutMs: 30 }), false);
});

void test("an accepted cancel reports success", async () => {
  const session = { cancel: () => Promise.resolve({ status: "accepted" }) };
  assert.equal(await cancelTurnQuietly(session, { timeoutMs: 30 }), true);
});
