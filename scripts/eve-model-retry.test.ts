/* eslint-disable @typescript-eslint/require-await -- Async model doubles implement the SDK Promise interface, including rejected calls. */
// Real Eve boundary: one transport retry owner, before doStream returns only.
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import fc from "fast-check";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { APICallError, type LanguageModel } from "ai";
import { MockLanguageModelV4, convertArrayToReadableStream } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { z } from "zod";
import { createToolLoopHarness } from "../node_modules/eve/dist/src/harness/tool-loop.js";
import type {
  HarnessSession,
  HarnessToolMap,
} from "../node_modules/eve/dist/src/harness/types.js";

const session = (): HarnessSession => ({
  agent: {
    system: "Reply once.",
    tools: [],
    modelReference: { id: "test/model" },
  },
  compaction: { threshold: 100_000, recentWindowSize: 100 },
  continuationToken: "test",
  sessionId: "test",
  history: [],
});
const error = (status = 503, responseHeaders?: Record<string, string>) =>
  new APICallError({
    message: "provider unavailable",
    url: "http://test.invalid",
    requestBodyValues: {},
    statusCode: status,
    responseHeaders,
  });
const success = (): LanguageModelV4StreamPart[] => [
  { type: "text-start", id: "text" },
  { type: "text-delta", id: "text", delta: "ok" },
  { type: "text-end", id: "text" },
  {
    type: "finish",
    finishReason: { unified: "stop", raw: "stop" },
    usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    },
  },
];
function fixture(
  model: LanguageModel,
  signal?: AbortSignal,
  tools: HarnessToolMap = new Map(),
  onEvent?: (event: { type: string; data?: unknown }) => void,
) {
  const events: Array<{ type: string; data?: unknown }> = [];
  const step = createToolLoopHarness({
    mode: "conversation",
    tools,
    resolveModel: () => Promise.resolve(model),
    abortSignal: signal,
    handleEvent: (event) => {
      events.push(event);
      onEvent?.(event);
      return Promise.resolve();
    },
  });
  const initial = session();
  const prepared = {
    ...initial,
    agent: {
      ...initial.agent,
      tools: [...tools.values()].map(({ name, description }) => ({
        name,
        description,
        inputSchema: { type: "object", properties: {} },
      })),
    },
  };
  return { events, run: () => step(prepared, { message: "hello" }), step };
}
function mute(t: TestContext) {
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", () => {});
}
/** Keep the production delay contract visible while advancing waits immediately. */
function fastWaits(t: TestContext) {
  const original = globalThis.setTimeout;
  const waits: number[] = [];
  t.mock.method(
    globalThis,
    "setTimeout",
    (...args: Parameters<typeof setTimeout>) => {
      const [callback, delay, ...rest] = args;
      if (delay !== undefined && delay >= 500 && delay <= 20_000) {
        waits.push(delay);
        return original(callback, 0, ...rest);
      }
      return original(...args);
    },
  );
  return waits;
}
async function wire(t: TestContext, failures: number, disconnect = false) {
  let calls = 0;
  const server = createServer((request, response) => {
    void (async () => {
      let raw = "";
      for await (const chunk of request) raw += String(chunk);
      assert.equal((JSON.parse(raw) as { stream: boolean }).stream, true);
      calls++;
      if (calls <= failures) {
        if (disconnect) {
          request.socket.destroy();
          return;
        }
        response.writeHead(503, { "content-type": "application/json" });
        response.end('{"error":{"message":"provider unavailable"}}');
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "model", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`,
      );
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });
  const provider = createOpenAICompatible({
    name: "test",
    apiKey: "test",
    baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  });
  return { model: provider.chatModel("model"), calls: () => calls };
}

void test("Eve owns all three pre-opening requests instead of AI SDK default retries", async (t) => {
  mute(t);
  const waits = fastWaits(t);
  const provider = await wire(t, 99);
  const fx = fixture(provider.model);
  const result = await fx.run();
  assert.equal(result.settledTurn?.isError, true);
  assert.equal(provider.calls(), 3);
  assert.deepEqual(
    waits.filter((delay) => delay === 5_000 || delay === 15_000),
    [5_000, 15_000],
  );
  assert.equal(
    fx.events.filter((event) => event.type === "step.started").length,
    1,
  );
});

void test("two pre-opening HTTP failures recover on the third call", async (t) => {
  mute(t);
  const waits = fastWaits(t);
  const provider = await wire(t, 2);
  const fx = fixture(provider.model);
  const result = await fx.run();
  assert.equal(result.settledTurn?.output, "ok");
  assert.equal(provider.calls(), 3);
  assert.deepEqual(
    waits.filter((delay) => delay === 5_000 || delay === 15_000),
    [5_000, 15_000],
  );
  assert.equal(
    fx.events.filter((event) => event.type === "step.started").length,
    1,
  );
});

void test("exhausted HTTP retries park one recoverable turn and permit the next user message", async (t) => {
  mute(t);
  fastWaits(t);
  const provider = await wire(t, 3);
  const fx = fixture(provider.model);
  const failed = await fx.run();
  assert.equal(provider.calls(), 3);
  assert.equal(failed.next, null);
  assert.equal(failed.settledTurn?.isError, true);
  assert.equal(
    fx.events.filter((event) => event.type === "turn.failed").length,
    1,
  );
  assert.equal(fx.events.at(-1)?.type, "session.waiting");
  const resumed = await fx.step(failed.session, { message: "try again" });
  assert.equal(resumed.settledTurn?.output, "ok");
  assert.equal(provider.calls(), 4);
});

void test("a reset before the stream opens uses the same bounded owner", async (t) => {
  mute(t);
  fastWaits(t);
  const provider = await wire(t, 2, true);
  assert.equal((await fixture(provider.model).run()).settledTurn?.output, "ok");
  assert.equal(provider.calls(), 3);
});

void test("failure sequences never exceed three requests and permanent errors are not retried", async (t) => {
  mute(t);
  fastWaits(t);
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom(
        400,
        401,
        403,
        404,
        408,
        409,
        422,
        429,
        500,
        502,
        503,
        504,
      ),
      fc.integer({ min: 0, max: 6 }),
      async (status, failures) => {
        let calls = 0;
        const model = new MockLanguageModelV4({
          doStream: async () => {
            if (++calls <= failures) throw error(status);
            return { stream: convertArrayToReadableStream(success()) };
          },
        });
        await fixture(model).run();
        const transient = [408, 409, 429, 500, 502, 503, 504].includes(status);
        assert.equal(
          calls,
          failures === 0 ? 1 : transient ? Math.min(failures + 1, 3) : 1,
        );
      },
    ),
    { numRuns: 100 },
  );
});

void test("an opened stream is never replayed, even before text or after arbitrary partial text", async (t) => {
  mute(t);
  fastWaits(t);
  await fc.assert(
    fc.asyncProperty(fc.option(fc.string(), { nil: null }), async (text) => {
      let calls = 0;
      const model = new MockLanguageModelV4({
        doStream: async () => {
          calls++;
          const parts: LanguageModelV4StreamPart[] =
            text === null
              ? []
              : [
                  { type: "text-start", id: "partial" },
                  { type: "text-delta", id: "partial", delta: text },
                ];
          return {
            stream: convertArrayToReadableStream([
              ...parts,
              { type: "error", error: error() },
            ]),
          };
        },
      });
      const fx = fixture(model);
      const result = await fx.run();
      assert.equal(calls, 1);
      assert.equal(result.next, null);
      assert.equal(result.settledTurn?.isError, true);
      assert.equal(
        fx.events.filter((event) => event.type === "message.appended").length,
        text ? 1 : 0,
      );
    }),
    { numRuns: 100 },
  );
});

void test("a channel failure after a tool side effect never replays its generation", async (t) => {
  mute(t);
  fastWaits(t);
  let effects = 0;
  const tools: HarnessToolMap = new Map([
    [
      "change",
      {
        name: "change",
        description: "Change state once.",
        inputSchema: z.object({}),
        execute: () => {
          effects++;
          return "changed";
        },
      },
    ],
  ]);
  let calls = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      calls++;
      return {
        stream: convertArrayToReadableStream([
          {
            type: "tool-call",
            toolCallId: `call-${calls}`,
            toolName: "change",
            input: "{}",
          },
          {
            type: "finish",
            finishReason: { unified: "tool-calls", raw: "tool-calls" },
            usage: {
              inputTokens: {
                total: 1,
                noCache: 1,
                cacheRead: 0,
                cacheWrite: 0,
              },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
          },
        ]),
      };
    },
  });
  const result = await fixture(model, undefined, tools, (event) => {
    if (event.type === "step.completed" && effects > 0) throw error();
  }).run();
  assert.equal(effects, 1);
  assert.equal(calls, 1);
  assert.equal(result.settledTurn?.isError, true);
});

void test("cancellation during backoff clears its listener and starts no next attempt", async (t) => {
  mute(t);
  const abort = new AbortController();
  let calls = 0;
  let reached!: () => void;
  const waiting = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const original = globalThis.setTimeout;
  t.mock.method(
    globalThis,
    "setTimeout",
    (...args: Parameters<typeof setTimeout>) => {
      const timer = original(...args);
      if (args[1] === 5_000) reached();
      return timer;
    },
  );
  const model = new MockLanguageModelV4({
    doStream: async () => {
      calls++;
      throw error();
    },
  });
  const result = fixture(model, abort.signal).run();
  await waiting;
  abort.abort(new Error("owner stopped"));
  await assert.rejects(result, { name: "TurnCancelledError" });
  assert.equal(calls, 1);
  assert.equal(getEventListeners(abort.signal, "abort").length, 0);
});

void test("cancellation aborts an in-flight pre-opening call without another attempt", async (t) => {
  mute(t);
  const abort = new AbortController();
  let calls = 0;
  let reached!: () => void;
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let providerSignal: AbortSignal | undefined;
  const model = new MockLanguageModelV4({
    doStream: ({ abortSignal }) => {
      calls++;
      providerSignal = abortSignal;
      return new Promise((_, reject) => {
        abortSignal!.addEventListener("abort", () => reject(error()), {
          once: true,
        });
        reached();
      });
    },
  });
  const result = fixture(model, abort.signal).run();
  await started;
  abort.abort();
  await assert.rejects(result, { name: "TurnCancelledError" });
  assert.equal(providerSignal?.aborted, true);
  assert.equal(calls, 1);
});

void test("provider minimum waits consume the same twenty-second total budget", async (t) => {
  mute(t);
  const waits = fastWaits(t);
  let calls = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      if (++calls <= 2)
        throw error(429, calls === 1 ? { "Retry-After": "12" } : {});
      return { stream: convertArrayToReadableStream(success()) };
    },
  });
  assert.equal((await fixture(model).run()).settledTurn?.output, "ok");
  assert.deepEqual(waits, [12_000, 8_000]);
});

void test("HTTP dates and retry-after-ms preserve provider minimums", async (t) => {
  mute(t);
  const waits = fastWaits(t);
  const now = Date.parse("2026-10-02T00:00:00Z");
  t.mock.method(Date, "now", () => now);
  let calls = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      if (++calls <= 2)
        throw error(
          429,
          calls === 1
            ? {
                "rEtRy-AfTeR": new Date(now + 9_000).toUTCString(),
                "Retry-After-MS": "12000",
              }
            : {},
        );
      return { stream: convertArrayToReadableStream(success()) };
    },
  });
  await fixture(model).run();
  assert.deepEqual(waits, [12_000, 8_000]);
});

void test("long Retry-After parks recoverably instead of dispatching early", async (t) => {
  mute(t);
  const waits = fastWaits(t);
  let calls = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      calls++;
      throw error(429, { "RETRY-AFTER": "120" });
    },
  });
  const result = await fixture(model).run();
  assert.equal(calls, 1);
  assert.deepEqual(waits, []);
  assert.equal(result.next, null);
  assert.equal(result.settledTurn?.isError, true);
});

void test("numeric and date Retry-After never dispatch early or exceed the shared wait budget", async (t) => {
  mute(t);
  const waits = fastWaits(t);
  const now = Date.parse("2026-10-02T00:00:00Z");
  t.mock.method(Date, "now", () => now);
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 0, max: 40 }),
      fc.boolean(),
      fc.constantFrom("Retry-After", "RETRY-AFTER", "retry-after"),
      async (seconds, date, key) => {
        waits.length = 0;
        let calls = 0;
        const header = date
          ? new Date(now + seconds * 1000).toUTCString()
          : String(seconds);
        const model = new MockLanguageModelV4({
          doStream: async () => {
            calls++;
            throw error(429, { [key]: header });
          },
        });
        await fixture(model).run();
        assert.equal(calls, seconds > 20 ? 1 : seconds > 10 ? 2 : 3);
        assert.ok(waits.every((wait) => wait >= seconds * 1000));
        assert.ok(waits.reduce((sum, wait) => sum + wait, 0) <= 20_000);
      },
    ),
    { numRuns: 100 },
  );
});

void test("malformed and oversized header values cannot escape retry bounds", async (t) => {
  mute(t);
  const waits = fastWaits(t);
  await fc.assert(
    fc.asyncProperty(fc.string(), async (header) => {
      waits.length = 0;
      let calls = 0;
      const model = new MockLanguageModelV4({
        doStream: async () => {
          calls++;
          throw error(503, { "Retry-After": header });
        },
      });
      await fixture(model).run();
      assert.ok(calls >= 1 && calls <= 3);
      assert.ok(waits.every((wait) => Number.isFinite(wait) && wait >= 0));
      assert.ok(waits.reduce((sum, wait) => sum + wait, 0) <= 20_000);
    }),
    { numRuns: 100 },
  );
  const model = new MockLanguageModelV4({
    doStream: async () => {
      throw error(503, { "Retry-After": "9".repeat(400) });
    },
  });
  waits.length = 0;
  await fixture(model).run();
  assert.deepEqual(waits, []);
});

void test("a turn cancelled before dispatch makes no model request", async (t) => {
  mute(t);
  const abort = new AbortController();
  abort.abort();
  let calls = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      calls++;
      throw error();
    },
  });
  await assert.rejects(fixture(model, abort.signal).run(), {
    name: "TurnCancelledError",
  });
  assert.equal(calls, 0);
});
