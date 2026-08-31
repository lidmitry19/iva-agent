/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node's test runner owns registrations and test doubles return promises. */
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import type { RouteHandlerArgs, Session } from "eve/channels";
import {
  requestTelegramReset,
  resetTargetForControl,
  telegramAddressFromChatKey,
} from "./telegram-reset.ts";
import { handleTelegramResetRequest } from "#lib/telegram-reset-route.ts";

type FetchCall = { url: string; init: RequestInit };
type ResetOperations = Pick<RouteHandlerArgs, "attachSession" | "resolveSession">;

function session(id: string, reasons: unknown[]): Session {
  return {
    id,
    reset: async (options?: { reason?: string }) => {
      reasons.push(options?.reason);
      return { status: "reset" as const, previousSessionId: id };
    },
  } as Session;
}

test("stored session wins for groups and forum topics", () => {
  const update = {
    message: {
      chat: { id: -1001, type: "supergroup" },
      message_thread_id: 77,
      message_id: 91,
    },
  };
  assert.deepEqual(resetTargetForControl(update, { sessionId: "session-42" }, "777"), {
    sessionId: "session-42",
  });
});

test("private-chat upgrade fallback builds a channel address", () => {
  const update = {
    message: { chat: { id: 123, type: "private" }, message_id: 10 },
  };
  assert.deepEqual(resetTargetForControl(update, null), {
    address: { chatId: "123" },
  });
});

test("group fallback requires an explicit reply to Iva", () => {
  const base = {
    chat: { id: -1001, type: "supergroup" },
    message_thread_id: 7,
    message_id: 10,
  };
  assert.equal(resetTargetForControl({ message: base }, null, "777"), null);
  assert.deepEqual(
    resetTargetForControl(
      {
        message: {
          ...base,
          reply_to_message: {
            message_id: 55,
            from: { id: 777, is_bot: true },
          },
        },
      },
      null,
      "777",
    ),
    {
      address: { chatId: "-1001", messageThreadId: 7, conversationId: "55" },
    },
  );
});

test("explicit Iva reply wins, but another bot cannot select stored state", () => {
  const message = {
    chat: { id: -1001, type: "supergroup" },
    message_thread_id: 7,
    message_id: 91,
    reply_to_message: {
      message_id: 55,
      from: { id: 777, is_bot: true },
    },
  };
  assert.deepEqual(
    resetTargetForControl({ message }, { sessionId: "session-old" }, "777"),
    {
      address: { chatId: "-1001", messageThreadId: 7, conversationId: "55" },
    },
  );
  assert.equal(
    resetTargetForControl(
      {
        message: {
          ...message,
          reply_to_message: {
            message_id: 55,
            from: { id: 888, is_bot: true },
          },
        },
      },
      { sessionId: "session-old" },
      "777",
    ),
    null,
  );
});

test("chat-key address resolver roundtrips private and topic keys", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: -9_007_199_254_740_991, max: 9_007_199_254_740_991 }).filter((id) => id !== 0),
      fc.option(fc.integer({ min: 1, max: 2_147_483_647 }), { nil: undefined }),
      (chatId, threadId) => {
        const key = `${chatId}:${threadId ?? ""}`;
        assert.deepEqual(telegramAddressFromChatKey(key), {
          chatId: String(chatId),
          ...(threadId === undefined ? {} : { messageThreadId: threadId }),
        });
      },
    ),
    { seed: 47_003, numRuns: 1_000 },
  );
});

test("chat-key address resolver rejects junk without throwing", () => {
  for (const key of ["", ":", "abc:", "1:0", "1:-1", "1:1.5", "1:2:3"]) {
    assert.equal(telegramAddressFromChatKey(key), null, key);
  }
});

test("reset client sends the exact target and accepts duplicate reset", async () => {
  const calls: FetchCall[] = [];
  const result = await requestTelegramReset({
    url: "http://127.0.0.1/eve/v1/telegram/reset",
    secret: "secret",
    target: { sessionId: "session-55" },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return Response.json({ ok: true, status: "no_active_session" });
    },
  });
  assert.equal(result.status, "no_active_session");
  assert.equal(
    (calls[0]?.init.headers as Record<string, string>)[
      "X-Telegram-Bot-Api-Secret-Token"
    ],
    "secret",
  );
  const requestBody = calls[0]?.init.body;
  if (typeof requestBody !== "string")
    throw new Error("expected string request body");
  assert.deepEqual(JSON.parse(requestBody), { sessionId: "session-55" });
});

test("reset client rejects HTTP and malformed success responses", async () => {
  await assert.rejects(
    requestTelegramReset({
      url: "http://local/reset",
      secret: "secret",
      target: { address: { chatId: "1" } },
      fetchImpl: async () => new Response("failed", { status: 500 }),
    }),
    /HTTP 500/u,
  );
  await assert.rejects(
    requestTelegramReset({
      url: "http://local/reset",
      secret: "secret",
      target: { address: { chatId: "1" } },
      fetchImpl: async () => Response.json({ ok: true, status: "surprise" }),
    }),
    /invalid response/u,
  );
});

test("reset route attaches an exact session", async () => {
  const attached: string[] = [];
  const reasons: unknown[] = [];
  const operations: ResetOperations = {
    attachSession: (sessionId) => {
      attached.push(sessionId);
      return session(sessionId, reasons);
    },
    resolveSession: async () => undefined,
  };
  const response = await handleTelegramResetRequest(
    new Request("http://local/eve/v1/telegram/reset", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "secret" },
      body: JSON.stringify({ sessionId: "session-55" }),
    }),
    operations,
    "secret",
  );

  assert.deepEqual(await response.json(), {
    ok: true,
    status: "reset",
    previousSessionId: "session-55",
  });
  assert.deepEqual(attached, ["session-55"]);
  assert.deepEqual(reasons, ["Telegram recovery command"]);
});

test("reset route resolves the exact Telegram address", async () => {
  const resolved: string[] = [];
  const reasons: unknown[] = [];
  const operations: ResetOperations = {
    attachSession: () => {
      throw new Error("unexpected attach");
    },
    resolveSession: async (address) => {
      resolved.push(address);
      return session("session-55", reasons);
    },
  };
  const response = await handleTelegramResetRequest(
    new Request("http://local/eve/v1/telegram/reset", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "secret" },
      body: JSON.stringify({
        address: { chatId: -1001, messageThreadId: 7, conversationId: 55 },
      }),
    }),
    operations,
    "secret",
  );

  assert.equal(response.status, 200);
  assert.deepEqual(resolved, ["-1001:7:55"]);
  assert.deepEqual(reasons, ["Telegram recovery command"]);
});

test("reset route returns no_active_session for an unowned address", async () => {
  const operations: ResetOperations = {
    attachSession: () => {
      throw new Error("unexpected attach");
    },
    resolveSession: async () => undefined,
  };
  const response = await handleTelegramResetRequest(
    new Request("http://local/reset", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "secret" },
      body: JSON.stringify({ address: { chatId: "1" } }),
    }),
    operations,
    "secret",
  );
  assert.deepEqual(await response.json(), { ok: true, status: "no_active_session" });
});

test("reset route rejects auth, malformed targets and conflicting targets", async () => {
  let called = false;
  const operations: ResetOperations = {
    attachSession: () => {
      called = true;
      return session("unexpected", []);
    },
    resolveSession: async () => {
      called = true;
      return undefined;
    },
  };
  const request = (body: string, secret = "secret") =>
    new Request("http://local/reset", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": secret },
      body,
    });
  const cases = [
    request('{"sessionId":"s"}', "bad"),
    request("{ not json"),
    request("{}"),
    request('{"sessionId":""}'),
    request('{"address":{"chatId":"junk"}}'),
    request('{"sessionId":"s","address":{"chatId":"1"}}'),
    request('{"sessionId":"","address":{"chatId":"1"}}'),
  ];

  for (const [index, req] of cases.entries()) {
    const response = await handleTelegramResetRequest(req, operations, "secret");
    assert.equal(response.status, index === 0 ? 401 : 400);
  }
  assert.equal(called, false);
});
