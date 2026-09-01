/* eslint-disable @typescript-eslint/no-floating-promises -- Node test owns registrations. */

import assert from "node:assert/strict";
import test from "node:test";

import {
  inputResponseSchema,
  type ClientSession,
  type InputRequest,
  type InputResponse,
  type MessageResult,
  type SendTurnInput,
  type SendTurnOptions,
} from "eve/client";

import {
  BackgroundSessionLimitUpgradeRequiredError,
  BackgroundTokenBudgetExceededError,
  UnexpectedBackgroundInputRequestError,
  createBackgroundSessionBudget,
  isUnconfirmedBackgroundStopError,
} from "./session-budget.ts";

void test("both background Stop errors ban result proof until Stop is confirmed", () => {
  for (const error of [
    new BackgroundSessionLimitUpgradeRequiredError({
      kind: "input",
      limit: 150_000,
      stopConfirmed: false,
      usedTokens: 198_597,
    }),
    new BackgroundTokenBudgetExceededError({
      continuationsGranted: 2,
      kind: "input",
      limit: 300_000,
      maxContinuations: 2,
      stopConfirmed: false,
      usedTokens: 300_001,
    }),
  ]) {
    assert.equal(isUnconfirmedBackgroundStopError(error), true);
  }
  assert.equal(
    isUnconfirmedBackgroundStopError(
      new BackgroundSessionLimitUpgradeRequiredError({
        kind: "input",
        limit: 150_000,
        stopConfirmed: true,
        usedTokens: 198_597,
      }),
    ),
    false,
  );
  assert.equal(isUnconfirmedBackgroundStopError(new Error("other")), false);
});

void test("a stale initial result is rejected before it can dispatch Continue or Stop", async () => {
  const session = new FakeSession([
    messageResult([sessionLimitRequest({ id: "legacy", limit: 150_000 })]),
  ]);
  const mismatch = Object.assign(new Error("stale boundary"), {
    code: "ROLLUP_DISPATCH_PROOF_MISMATCH",
  });

  await assert.rejects(
    createBackgroundSessionBudget().send(session.asClientSession(), "roll up", {
      validateResult: () => {
        throw mismatch;
      },
    }),
    (error: unknown) => error === mismatch,
  );
  assert.equal(session.inputs.length, 1);
});

void test("a stale Stop result remains a proof error instead of becoming an upgrade retry", async () => {
  const session = new FakeSession([
    messageResult([sessionLimitRequest({ id: "legacy", limit: 150_000 })]),
    messageResult([], { status: "waiting" }),
  ]);
  const mismatch = Object.assign(new Error("stale Stop boundary"), {
    code: "ROLLUP_DISPATCH_PROOF_MISMATCH",
  });
  let validations = 0;

  await assert.rejects(
    createBackgroundSessionBudget().send(session.asClientSession(), "roll up", {
      validateResult: () => {
        validations += 1;
        if (validations === 2) throw mismatch;
      },
    }),
    (error: unknown) => error === mismatch,
  );
  assert.equal(session.inputs.length, 2);
});

function messageResult(
  inputRequests: readonly InputRequest[] = [],
  overrides: Partial<MessageResult> = {},
): MessageResult {
  return {
    data: undefined,
    events: [],
    inputRequests,
    message: "ok",
    sessionId: "test-session",
    status: inputRequests.length > 0 ? "waiting" : "completed",
    ...overrides,
  };
}

function turnCancelledEvent(): MessageResult["events"][number] {
  return {
    data: { sequence: 1, turnId: "test-turn" },
    meta: { at: "2026-08-27T00:00:00.000Z", id: "test-event" },
    type: "turn.cancelled",
  };
}

function usageLimitResult(): MessageResult {
  const meta = { at: "2026-08-27T00:00:00.000Z", id: "usage-event" };
  return messageResult([], {
    events: [
      {
        data: {
          code: "usage_limit_reached",
          message: "provider limit",
          sequence: 1,
          stepIndex: 0,
          turnId: "usage-turn",
        },
        meta,
        type: "step.failed",
      },
      {
        data: {
          code: "usage_limit_reached",
          message: "provider limit",
          sequence: 2,
          turnId: "usage-turn",
        },
        meta,
        type: "turn.failed",
      },
      {
        data: {
          continuationToken: "test-continuation",
          wait: "next-user-message",
        },
        meta,
        type: "session.waiting",
      },
    ],
    message: undefined,
    status: "waiting",
  });
}

function sessionLimitRequest(options: {
  id: string;
  kind?: "input" | "output";
  limit?: number;
  usedTokens?: number;
  overrides?: Record<string, unknown>;
}): InputRequest {
  const kind = options.kind ?? "input";
  const limit = options.limit ?? (kind === "input" ? 300_000 : 20_000);
  return {
    action: {
      callId: options.id,
      input: {
        kind,
        limit,
        usedTokens: options.usedTokens ?? limit,
      },
      kind: "tool-call",
      toolName: "session_limit_continuation",
    },
    allowFreeform: false,
    display: "confirmation",
    kind: "session-limit",
    options: [
      {
        description: "Grant a fresh token budget",
        id: "continue",
        label: "Approve",
        style: "primary",
      },
      {
        description: "Stop now",
        id: "stop",
        label: "Stop",
        style: "danger",
      },
    ],
    prompt: "Continue with a fresh budget?",
    requestId: options.id,
    ...options.overrides,
  };
}

function sessionLimitRequestWithRawLimit(
  id: string,
  limit: unknown,
): InputRequest {
  const request = sessionLimitRequest({ id });
  return {
    ...request,
    action: {
      ...request.action,
      input: { ...request.action.input, limit },
    },
  } as unknown as InputRequest;
}

function approvalRequest(id = "approval-1"): InputRequest {
  return {
    action: {
      callId: id,
      input: {},
      kind: "tool-call",
      toolName: "dangerous_tool",
    },
    allowFreeform: false,
    display: "confirmation",
    kind: "tool-approval",
    options: [
      { id: "approve", label: "Approve", style: "primary" },
      { id: "deny", label: "Deny", style: "danger" },
    ],
    prompt: "Approve this action?",
    requestId: id,
  };
}

type RecordedInput =
  | SendTurnInput["message"]
  | (SendTurnInput & { readonly inputResponses?: never })
  | {
      readonly inputResponses: readonly InputResponse[];
      readonly signal?: AbortSignal;
    };

class FakeSession {
  readonly inputs: RecordedInput[] = [];
  resultCalls = 0;
  private readonly results: Array<
    MessageResult | Error | Promise<MessageResult>
  >;

  constructor(results: Array<MessageResult | Error | Promise<MessageResult>>) {
    this.results = results;
  }

  asClientSession(): Pick<ClientSession, "send" | "respond"> {
    return this as unknown as Pick<ClientSession, "send" | "respond">;
  }

  send(message: SendTurnInput["message"], options: SendTurnOptions = {}) {
    this.inputs.push(
      Object.keys(options).length > 0 ? { message, ...options } : message,
    );
    return this.nextResponse();
  }

  respond(
    inputResponses: readonly InputResponse[],
    options: SendTurnOptions = {},
  ) {
    this.inputs.push({ inputResponses, ...options });
    return this.nextResponse();
  }

  private nextResponse() {
    assert.ok(this.results.length > 0, "fake session has a queued result");
    const next = this.results.shift();
    return Promise.resolve({
      result: () => {
        this.resultCalls += 1;
        if (next instanceof Error) return Promise.reject(next);
        assert.ok(next);
        return Promise.resolve(next);
      },
    });
  }
}

function assertInputResponse(
  input: RecordedInput,
  requestId: string,
  optionId: string,
): void {
  assert.equal(typeof input, "object");
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    !("inputResponses" in input)
  ) {
    return;
  }
  assert.equal(Array.isArray(input.inputResponses), true);
  assert.equal(input.inputResponses?.length, 1);
  assert.equal(
    inputResponseSchema.safeParse(input.inputResponses?.[0]).success,
    true,
  );
  assert.deepEqual(input.inputResponses?.[0], { requestId, optionId });
}

test("normal results return without additional sends", async () => {
  const expected = messageResult();
  const session = new FakeSession([expected]);
  const budget = createBackgroundSessionBudget();

  assert.equal(await budget.send(session.asClientSession(), "hello"), expected);
  assert.deepEqual(session.inputs, ["hello"]);
  assert.equal(session.resultCalls, 1);
  assert.equal(budget.continuationsGranted, 0);
});

test("legacy durable session limits receive confirmed Stop before rotation", async () => {
  const session = new FakeSession([
    messageResult([
      sessionLimitRequest({
        id: "legacy-input-limit",
        limit: 150_000,
        usedTokens: 451_234,
      }),
    ]),
    messageResult([], {
      events: [turnCancelledEvent()],
      message: undefined,
      status: "waiting",
    }),
  ]);
  const budget = createBackgroundSessionBudget();

  await assert.rejects(
    budget.send(session.asClientSession(), "work"),
    (error: unknown) => {
      assert.equal(
        error instanceof BackgroundSessionLimitUpgradeRequiredError,
        true,
      );
      if (!(error instanceof BackgroundSessionLimitUpgradeRequiredError))
        return false;
      assert.equal(error.code, "BACKGROUND_SESSION_LIMIT_UPGRADE_REQUIRED");
      assert.equal(error.kind, "input");
      assert.equal(error.limit, 150_000);
      assert.equal(error.usedTokens, 451_234);
      assert.equal(error.stopConfirmed, true);
      assert.equal("prompt" in error, false);
      return true;
    },
  );

  assert.equal(session.inputs.length, 2);
  assertInputResponse(session.inputs[1], "legacy-input-limit", "stop");
  assert.equal(session.resultCalls, 2, "Stop response must be fully consumed");
  assert.equal(budget.continuationsGranted, 0);
});

test("an unconfirmed legacy Stop cannot authorize a fresh-session rotation", async () => {
  const stopFailure = new Error("stop response failed");
  const session = new FakeSession([
    messageResult([
      sessionLimitRequest({
        id: "legacy-unconfirmed",
        limit: 150_000,
      }),
    ]),
    stopFailure,
  ]);
  const budget = createBackgroundSessionBudget();

  await assert.rejects(
    budget.send(session.asClientSession(), "work"),
    (error: unknown) => {
      assert.equal(
        error instanceof BackgroundSessionLimitUpgradeRequiredError,
        true,
      );
      if (!(error instanceof BackgroundSessionLimitUpgradeRequiredError))
        return false;
      assert.equal(error.limit, 150_000);
      assert.equal(error.stopConfirmed, false);
      return true;
    },
  );

  assert.equal(session.inputs.length, 2);
  assertInputResponse(session.inputs[1], "legacy-unconfirmed", "stop");
  assert.equal(budget.continuationsGranted, 0);
});

test("a stale waiting boundary without turn.cancelled cannot confirm legacy Stop", async () => {
  const session = new FakeSession([
    messageResult([
      sessionLimitRequest({
        id: "legacy-stale-boundary",
        limit: 150_000,
      }),
    ]),
    messageResult([], { message: undefined, status: "waiting" }),
  ]);
  const budget = createBackgroundSessionBudget();

  await assert.rejects(
    budget.send(session.asClientSession(), "work"),
    (error: unknown) => {
      assert.equal(
        error instanceof BackgroundSessionLimitUpgradeRequiredError,
        true,
      );
      if (!(error instanceof BackgroundSessionLimitUpgradeRequiredError))
        return false;
      assert.equal(error.stopConfirmed, false);
      return true;
    },
  );

  assert.equal(session.inputs.length, 2);
  assertInputResponse(session.inputs[1], "legacy-stale-boundary", "stop");
  assert.equal(session.resultCalls, 2, "Stop response must be fully consumed");
});

test("a completed boundary cannot confirm a session-limit Stop", async () => {
  const session = new FakeSession([
    messageResult([
      sessionLimitRequest({
        id: "legacy-completed-boundary",
        limit: 150_000,
      }),
    ]),
    messageResult([], {
      events: [turnCancelledEvent()],
      message: undefined,
      status: "completed",
    }),
  ]);
  const budget = createBackgroundSessionBudget();

  await assert.rejects(
    budget.send(session.asClientSession(), "work"),
    (error: unknown) =>
      error instanceof BackgroundSessionLimitUpgradeRequiredError &&
      error.stopConfirmed === false,
  );
});

test("upstream usage-limit errors propagate before and after a continuation", async (t) => {
  await t.test("before continuation", async () => {
    const upstream = Object.assign(new Error("usage limit reached"), {
      code: "usage_limit_reached",
    });
    const session = new FakeSession([upstream]);
    const budget = createBackgroundSessionBudget();

    await assert.rejects(
      budget.send(session.asClientSession(), "work"),
      (error: unknown) => error === upstream,
    );
    assert.deepEqual(session.inputs, ["work"]);
  });

  await t.test("after continuation", async () => {
    const upstream = Object.assign(new Error("usage limit reached"), {
      code: "usage_limit_reached",
    });
    const session = new FakeSession([
      messageResult([sessionLimitRequest({ id: "current-then-usage" })]),
      upstream,
    ]);
    const budget = createBackgroundSessionBudget();

    await assert.rejects(
      budget.send(session.asClientSession(), "work"),
      (error: unknown) => error === upstream,
    );
    assert.equal(session.inputs.length, 2);
    assertInputResponse(session.inputs[1], "current-then-usage", "continue");
  });
});

test("a resolved Eve usage-limit boundary is returned unchanged", async () => {
  const expected = usageLimitResult();
  const session = new FakeSession([expected]);
  const budget = createBackgroundSessionBudget();

  assert.equal(await budget.send(session.asClientSession(), "work"), expected);
  assert.deepEqual(session.inputs, ["work"]);
  assert.equal(session.resultCalls, 1);
  assert.equal(budget.continuationsGranted, 0);
});

test("two limit requests receive exact Continue responses", async () => {
  const session = new FakeSession([
    messageResult([sessionLimitRequest({ id: "limit-1" })]),
    messageResult([
      sessionLimitRequest({ id: "limit-2", usedTokens: 316_000 }),
    ]),
    messageResult(),
  ]);
  const seen: Array<{ kind: string; continuationsGranted: number }> = [];
  const budget = createBackgroundSessionBudget({
    onContinuation: ({ kind, continuationsGranted }) => {
      seen.push({ kind, continuationsGranted });
    },
  });

  await budget.send(session.asClientSession(), "work");

  assert.equal(session.inputs.length, 3);
  assertInputResponse(session.inputs[1], "limit-1", "continue");
  assertInputResponse(session.inputs[2], "limit-2", "continue");
  assert.equal(budget.continuationsGranted, 2);
  assert.deepEqual(seen, [
    { kind: "input", continuationsGranted: 1 },
    { kind: "input", continuationsGranted: 2 },
  ]);
});

test("the third request receives Stop, is consumed, and throws a safe typed error", async () => {
  const session = new FakeSession([
    messageResult([sessionLimitRequest({ id: "limit-1" })]),
    messageResult([sessionLimitRequest({ id: "limit-2" })]),
    messageResult([
      sessionLimitRequest({ id: "limit-3", usedTokens: 301_234 }),
    ]),
    messageResult([], {
      events: [turnCancelledEvent()],
      message: undefined,
      status: "waiting",
    }),
  ]);
  const budget = createBackgroundSessionBudget();

  await assert.rejects(
    budget.send(session.asClientSession(), "work"),
    (error: unknown) => {
      assert.equal(error instanceof BackgroundTokenBudgetExceededError, true);
      if (!(error instanceof BackgroundTokenBudgetExceededError)) return false;
      assert.equal(error.code, "BACKGROUND_TOKEN_BUDGET_EXCEEDED");
      assert.equal(error.kind, "input");
      assert.equal(error.limit, 300_000);
      assert.equal(error.usedTokens, 301_234);
      assert.equal(error.continuationsGranted, 2);
      assert.equal(error.stopConfirmed, true);
      assert.equal("prompt" in error, false);
      return true;
    },
  );

  assert.equal(session.inputs.length, 4);
  assertInputResponse(session.inputs[3], "limit-3", "stop");
  assert.equal(session.resultCalls, 4, "Stop response must be fully consumed");
});

test("continuation count is shared across separate sends", async () => {
  const session = new FakeSession([
    messageResult([sessionLimitRequest({ id: "first-1" })]),
    messageResult(),
    messageResult([sessionLimitRequest({ id: "second-1" })]),
    messageResult([sessionLimitRequest({ id: "second-2" })]),
    messageResult([], { message: undefined, status: "waiting" }),
  ]);
  const budget = createBackgroundSessionBudget();

  await budget.send(session.asClientSession(), "first turn");
  await assert.rejects(
    budget.send(session.asClientSession(), "second turn"),
    BackgroundTokenBudgetExceededError,
  );

  assertInputResponse(session.inputs[1], "first-1", "continue");
  assertInputResponse(session.inputs[3], "second-1", "continue");
  assertInputResponse(session.inputs[4], "second-2", "stop");
  assert.equal(budget.continuationsGranted, 2);
});

test("input and output budget requests share the same bounded allowance", async () => {
  const session = new FakeSession([
    messageResult([sessionLimitRequest({ id: "input-limit", kind: "input" })]),
    messageResult([
      sessionLimitRequest({
        id: "output-limit",
        kind: "output",
        usedTokens: 21_000,
      }),
    ]),
    messageResult(),
  ]);
  const seenKinds: string[] = [];
  const budget = createBackgroundSessionBudget({
    onContinuation: ({ kind }) => {
      seenKinds.push(kind);
    },
  });

  await budget.send(session.asClientSession(), "work");

  assert.deepEqual(seenKinds, ["input", "output"]);
  assertInputResponse(session.inputs[1], "input-limit", "continue");
  assertInputResponse(session.inputs[2], "output-limit", "continue");
});

test("unknown, multiple, malformed, and freeform requests fail closed", async (t) => {
  const cases: Array<{
    name: string;
    requests: InputRequest[];
    reason: string;
  }> = [
    {
      name: "unknown approval",
      requests: [approvalRequest()],
      reason: "malformed_session_limit_request",
    },
    {
      name: "multiple requests",
      requests: [
        sessionLimitRequest({ id: "limit-a" }),
        sessionLimitRequest({ id: "limit-b" }),
      ],
      reason: "invalid_request_count",
    },
    {
      name: "malformed request kind",
      requests: [
        sessionLimitRequest({
          id: "wrong-kind",
          overrides: { kind: "question" },
        }),
      ],
      reason: "malformed_session_limit_request",
    },
    {
      name: "malformed options",
      requests: [
        sessionLimitRequest({
          id: "bad-options",
          overrides: {
            options: [
              { id: "continue", label: "Continue" },
              { id: "approve", label: "Approve" },
            ],
          },
        }),
      ],
      reason: "malformed_session_limit_request",
    },
    {
      name: "freeform continuation",
      requests: [
        sessionLimitRequest({
          id: "freeform",
          overrides: { allowFreeform: true },
        }),
      ],
      reason: "malformed_session_limit_request",
    },
    {
      name: "zero session limit",
      requests: [sessionLimitRequest({ id: "zero-limit", limit: 0 })],
      reason: "malformed_session_limit_request",
    },
    {
      name: "negative session limit",
      requests: [sessionLimitRequest({ id: "negative-limit", limit: -1 })],
      reason: "malformed_session_limit_request",
    },
    {
      name: "fractional session limit",
      requests: [sessionLimitRequest({ id: "fractional-limit", limit: 1.5 })],
      reason: "malformed_session_limit_request",
    },
    {
      name: "unsafe session limit",
      requests: [
        sessionLimitRequest({
          id: "unsafe-limit",
          limit: Number.MAX_SAFE_INTEGER + 1,
        }),
      ],
      reason: "malformed_session_limit_request",
    },
    {
      name: "string session limit",
      requests: [sessionLimitRequestWithRawLimit("string-limit", "150000")],
      reason: "malformed_session_limit_request",
    },
    {
      name: "usage below requested limit",
      requests: [
        sessionLimitRequest({
          id: "below-limit",
          limit: 150_000,
          usedTokens: 149_999,
        }),
      ],
      reason: "malformed_session_limit_request",
    },
    {
      name: "unexpected configured limit",
      requests: [sessionLimitRequest({ id: "wrong-limit", limit: 999_999 })],
      reason: "malformed_session_limit_request",
    },
    {
      name: "input limit used for output kind",
      requests: [
        sessionLimitRequest({
          id: "cross-kind-limit",
          kind: "output",
          limit: 150_000,
        }),
      ],
      reason: "malformed_session_limit_request",
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const session = new FakeSession([messageResult(fixture.requests)]);
      const budget = createBackgroundSessionBudget();

      await assert.rejects(
        budget.send(session.asClientSession(), "work"),
        (error: unknown) => {
          assert.equal(
            error instanceof UnexpectedBackgroundInputRequestError,
            true,
          );
          if (!(error instanceof UnexpectedBackgroundInputRequestError))
            return false;
          assert.equal(error.reason, fixture.reason);
          return true;
        },
      );
      assert.deepEqual(
        session.inputs,
        ["work"],
        "no input request may be auto-answered",
      );
    });
  }
});

test("initial send lifecycle hooks preserve timeout and retry accounting", async () => {
  const session = new FakeSession([messageResult()]);
  const accepted: Array<Promise<MessageResult>> = [];
  let rejected = 0;
  const budget = createBackgroundSessionBudget();

  await budget.send(session.asClientSession(), "work", {
    onAccepted: (result) => accepted.push(result),
    onSendRejected: () => {
      rejected += 1;
    },
  });
  assert.equal(accepted.length, 1);
  assert.equal(rejected, 0);

  const failed = {
    respond: () => Promise.reject(new Error("respond rejected")),
    send: () => Promise.reject(new Error("send rejected")),
  } as unknown as Pick<ClientSession, "send" | "respond">;
  await assert.rejects(
    budget.send(failed, "fail", {
      onSendRejected: () => {
        rejected += 1;
      },
    }),
    /send rejected/u,
  );
  assert.equal(rejected, 1);
});

test("send-start hook runs synchronously before every send and preserves the initial signal", async () => {
  const controller = new AbortController();
  const session = new FakeSession([
    messageResult([sessionLimitRequest({ id: "continue-once" })]),
    messageResult([sessionLimitRequest({ id: "stop-next" })]),
    messageResult([], {
      events: [turnCancelledEvent()],
      message: undefined,
      status: "waiting",
    }),
  ]);
  const startInputCounts: number[] = [];
  const budget = createBackgroundSessionBudget({ maxContinuations: 1 });

  const pending = budget.send(
    session.asClientSession(),
    { message: "work", signal: controller.signal },
    {
      onSendStart: () => startInputCounts.push(session.inputs.length),
    },
  );

  assert.deepEqual(
    startInputCounts,
    [0],
    "the initial hook must run in the budget.send call stack",
  );
  await assert.rejects(pending, BackgroundTokenBudgetExceededError);

  assert.deepEqual(startInputCounts, [0, 1, 2]);
  assert.equal(session.inputs.length, 3);
  for (const followUp of session.inputs.slice(1)) {
    assert.notEqual(typeof followUp, "string");
    if (
      typeof followUp === "object" &&
      followUp !== null &&
      !Array.isArray(followUp) &&
      "signal" in followUp
    ) {
      assert.equal(followUp.signal, controller.signal);
    }
  }
});

test("a closed attempt fence blocks late session-limit follow-ups", async (t) => {
  await t.test("an aborted signal blocks a late Continue", async () => {
    let resolveInitial!: (result: MessageResult) => void;
    const initialResult = new Promise<MessageResult>((resolve) => {
      resolveInitial = resolve;
    });
    const controller = new AbortController();
    const abortReason = new Error("rollup attempt closed");
    const session = new FakeSession([initialResult, messageResult()]);
    const startInputCounts: number[] = [];
    let rejected = 0;
    const budget = createBackgroundSessionBudget();

    const pending = budget.send(
      session.asClientSession(),
      { message: "work", signal: controller.signal },
      {
        onSendStart: () => startInputCounts.push(session.inputs.length),
        onSendRejected: () => {
          rejected += 1;
        },
      },
    );
    assert.deepEqual(startInputCounts, [0]);

    controller.abort(abortReason);
    resolveInitial(
      messageResult([sessionLimitRequest({ id: "late-continuation" })]),
    );

    await assert.rejects(pending, (error: unknown) => error === abortReason);
    assert.deepEqual(startInputCounts, [0]);
    assert.equal(session.inputs.length, 1, "Continue must not be sent");
    assert.equal(rejected, 0, "a local fence is not a send rejection");
  });

  await t.test("a throwing send-start hook blocks a late Stop", async () => {
    let resolveInitial!: (result: MessageResult) => void;
    const initialResult = new Promise<MessageResult>((resolve) => {
      resolveInitial = resolve;
    });
    const fenceError = new Error("rollup attempt closed");
    const session = new FakeSession([initialResult, messageResult()]);
    const startInputCounts: number[] = [];
    let closed = false;
    let rejected = 0;
    const budget = createBackgroundSessionBudget();

    const pending = budget.send(session.asClientSession(), "work", {
      onSendStart: () => {
        startInputCounts.push(session.inputs.length);
        if (closed) throw fenceError;
      },
      onSendRejected: () => {
        rejected += 1;
      },
    });
    assert.deepEqual(startInputCounts, [0]);

    closed = true;
    resolveInitial(
      messageResult([
        sessionLimitRequest({
          id: "late-stop",
          limit: 150_000,
        }),
      ]),
    );

    await assert.rejects(
      pending,
      (error: unknown) =>
        error instanceof BackgroundSessionLimitUpgradeRequiredError &&
        error.stopConfirmed === false,
    );
    assert.deepEqual(startInputCounts, [0, 1]);
    assert.equal(session.inputs.length, 1, "Stop must not be sent");
    assert.equal(rejected, 0, "a local fence is not a send rejection");
  });
});

test("an abort while the first continuation is pending blocks the second continuation", async () => {
  let resolveContinuation!: (result: MessageResult) => void;
  const continuationResult = new Promise<MessageResult>((resolve) => {
    resolveContinuation = resolve;
  });
  const controller = new AbortController();
  const abortReason = new Error("rollup attempt closed");
  const session = new FakeSession([
    messageResult([sessionLimitRequest({ id: "first-continuation" })]),
    continuationResult,
    messageResult(),
  ]);
  const budget = createBackgroundSessionBudget();

  const pending = budget.send(session.asClientSession(), {
    message: "work",
    signal: controller.signal,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(session.inputs.length, 2, "the first Continue was accepted");

  controller.abort(abortReason);
  resolveContinuation(
    messageResult([sessionLimitRequest({ id: "second-continuation" })]),
  );

  await assert.rejects(pending, (error: unknown) => error === abortReason);
  assert.equal(
    session.inputs.length,
    2,
    "the second Continue must not be sent",
  );
  const firstFollowUp = session.inputs[1];
  assert.notEqual(typeof firstFollowUp, "string");
  if (
    typeof firstFollowUp === "object" &&
    firstFollowUp !== null &&
    !Array.isArray(firstFollowUp) &&
    "signal" in firstFollowUp
  ) {
    assert.equal(firstFollowUp.signal, controller.signal);
  }
});

test("accepted-result hook tracks every continuation response", async () => {
  const session = new FakeSession([
    messageResult([sessionLimitRequest({ id: "tracked-continuation" })]),
    messageResult(),
  ]);
  const accepted: Array<Promise<MessageResult>> = [];
  const budget = createBackgroundSessionBudget();

  await budget.send(session.asClientSession(), "work", {
    onAccepted: (result) => accepted.push(result),
  });

  assert.equal(accepted.length, 2);
  assert.deepEqual(await Promise.all(accepted), [
    messageResult([sessionLimitRequest({ id: "tracked-continuation" })]),
    messageResult(),
  ]);
});

test("accepted-result hook tracks the Stop response used for rotation", async () => {
  const session = new FakeSession([
    messageResult([
      sessionLimitRequest({ id: "tracked-stop", limit: 150_000 }),
    ]),
    messageResult([], {
      events: [turnCancelledEvent()],
      message: undefined,
      status: "waiting",
    }),
  ]);
  const accepted: Array<Promise<MessageResult>> = [];
  const budget = createBackgroundSessionBudget();

  await assert.rejects(
    budget.send(session.asClientSession(), "work", {
      onAccepted: (result) => accepted.push(result),
    }),
    BackgroundSessionLimitUpgradeRequiredError,
  );

  assert.equal(accepted.length, 2);
  assert.equal((await accepted[1])?.status, "waiting");
});

test("the continuation ceiling cannot be configured above two", () => {
  assert.throws(
    () => createBackgroundSessionBudget({ maxContinuations: 3 }),
    /maxContinuations must be an integer from 0 to 2/u,
  );
  assert.throws(
    () => createBackgroundSessionBudget({ maxContinuations: 1.5 }),
    /maxContinuations must be an integer from 0 to 2/u,
  );
});
