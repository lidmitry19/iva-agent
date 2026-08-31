/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node's test runner owns registrations and test doubles return promises. */
// Отмена хода целиком: клиент моста → аутентифицированный роут канала → публичный
// cancel eve. У прежнего пути (рантайм-import node_modules/eve/dist/src/internal/…)
// тестов не было вовсе, поэтому здесь проверяется вся цепочка, включая сам факт того,
// что до cancel доезжают ровно те аргументы, которые лежали в run-status.
import test from "node:test";
import assert from "node:assert/strict";
import { requestTelegramCancel } from "#lib/telegram-cancel-client.ts";
import { handleTelegramCancelRequest } from "#lib/telegram-cancel-route.ts";
import { cancelEveTurn } from "#lib/eve-cancel.ts";

type FetchCall = { url: string; init: RequestInit };
type CancelInput = { continuationToken: string; turnId?: string };

const accepted = async (input: CancelInput, calls: CancelInput[]) => {
  calls.push(input);
  return { sessionId: "test-session", status: "accepted" as const };
};

test("cancel client sends the token, the turn guard and the webhook secret", async () => {
  const calls: FetchCall[] = [];
  const result = await requestTelegramCancel({
    url: "http://127.0.0.1/eve/v1/telegram/cancel",
    secret: "secret",
    continuationToken: "-1001:7:55",
    turnId: "turn-9",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return Response.json({ ok: true, status: "accepted" });
    },
  });

  assert.equal(result.status, "accepted");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "http://127.0.0.1/eve/v1/telegram/cancel");
  assert.equal(
    (calls[0]?.init.headers as Record<string, string>)[
      "X-Telegram-Bot-Api-Secret-Token"
    ],
    "secret",
  );
  const requestBody = calls[0]?.init.body;
  if (typeof requestBody !== "string")
    throw new Error("expected string request body");
  assert.deepEqual(JSON.parse(requestBody), {
    continuationToken: "-1001:7:55",
    turnId: "turn-9",
  });
});

test("cancel client omits an absent turn guard and accepts no_active_turn", async () => {
  const calls: FetchCall[] = [];
  const result = await requestTelegramCancel({
    url: "http://local/cancel",
    secret: "secret",
    continuationToken: "1::",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return Response.json({ ok: true, status: "no_active_turn" });
    },
  });

  assert.equal(result.status, "no_active_turn");
  const requestBody = calls[0]?.init.body;
  if (typeof requestBody !== "string")
    throw new Error("expected string request body");
  assert.deepEqual(JSON.parse(requestBody), { continuationToken: "1::" });
});

test("cancel client rejects HTTP and malformed success responses", async () => {
  await assert.rejects(
    requestTelegramCancel({
      url: "http://local/cancel",
      secret: "secret",
      continuationToken: "1::",
      fetchImpl: async () => new Response("failed", { status: 500 }),
    }),
    /HTTP 500/u,
  );
  await assert.rejects(
    requestTelegramCancel({
      url: "http://local/cancel",
      secret: "secret",
      continuationToken: "1::",
      // Статус reset-роута на cancel-роуте — тоже мусор: молча принимать нельзя.
      fetchImpl: async () => Response.json({ ok: true, status: "reset" }),
    }),
    /invalid response/u,
  );
});

test("cancel route authenticates and forwards the exact token and turn guard", async () => {
  const calls: CancelInput[] = [];
  const response = await handleTelegramCancelRequest(
    new Request("http://local/eve/v1/telegram/cancel", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "secret" },
      body: JSON.stringify({
        continuationToken: "-1001:7:55",
        turnId: "turn-9",
      }),
    }),
    (input) => accepted(input, calls),
    "secret",
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    sessionId: "test-session",
    status: "accepted",
  });
  assert.deepEqual(calls, [
    { continuationToken: "-1001:7:55", turnId: "turn-9" },
  ]);
});

test("cancel route rejects bad auth and bad input before cancelling", async () => {
  let called = false;
  const cancel = async () => {
    called = true;
    return { sessionId: "test-session", status: "accepted" as const };
  };

  const unauthorized = await handleTelegramCancelRequest(
    new Request("http://local/cancel", {
      method: "POST",
      body: JSON.stringify({ continuationToken: "1::" }),
    }),
    cancel,
    "secret",
  );
  assert.equal(unauthorized.status, 401);

  const brokenJson = await handleTelegramCancelRequest(
    new Request("http://local/cancel", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "secret" },
      body: "{ not json",
    }),
    cancel,
    "secret",
  );
  assert.equal(brokenJson.status, 400);

  const noToken = await handleTelegramCancelRequest(
    new Request("http://local/cancel", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "secret" },
      body: "{}",
    }),
    cancel,
    "secret",
  );
  assert.equal(noToken.status, 400);

  const emptyTurnId = await handleTelegramCancelRequest(
    new Request("http://local/cancel", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "secret" },
      body: JSON.stringify({ continuationToken: "1::", turnId: "" }),
    }),
    cancel,
    "secret",
  );
  assert.equal(emptyTurnId.status, 400);

  assert.equal(called, false);
});

test("the whole ⏹ Stop path reaches eve cancel with the run-status arguments", async () => {
  const calls: CancelInput[] = [];
  // Мост шлёт настоящий HTTP-запрос — здесь его принимает сам роут канала.
  const result = await requestTelegramCancel({
    url: "http://127.0.0.1:8723/eve/v1/telegram/cancel",
    secret: "webhook-secret",
    continuationToken: "7091451031::",
    turnId: "turn-1",
    fetchImpl: (url, init) =>
      handleTelegramCancelRequest(
        new Request(url, init),
        (input) => accepted(input, calls),
        "webhook-secret",
      ),
  });

  assert.equal(result.status, "accepted");
  assert.deepEqual(calls, [
    { continuationToken: "7091451031::", turnId: "turn-1" },
  ]);
});

test("the cancel adapter is the only shape eve sees", async () => {
  const calls: CancelInput[] = [];
  await cancelEveTurn((input) => accepted(input, calls), {
    continuationToken: "1::",
  });
  await cancelEveTurn((input) => accepted(input, calls), {
    continuationToken: "1::",
    turnId: "turn-2",
  });

  // Пустой turnId в объект не попадает: eve отличает «любой ход» от гарда по наличию поля.
  assert.deepEqual(calls, [
    { continuationToken: "1::" },
    { continuationToken: "1::", turnId: "turn-2" },
  ]);
  assert.equal("turnId" in calls[0], false);
});
