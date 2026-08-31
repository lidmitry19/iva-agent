/* eslint-disable @typescript-eslint/require-await -- Async fetch double preserves the production boundary. */
import assert from "node:assert/strict";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import test from "node:test";

process.env.TELEGRAM_BOT_TOKEN = "73002:test-token";
process.env.TELEGRAM_ALLOWED_USER_IDS = "42";
process.env.TELEGRAM_POLL_SETTLE_MS = "0";

const { deliver } = await import("./deliver.ts");

void test("direct acceptance 503 exhausts three attempts and notifies retained once", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "log", () => undefined);
  const originalFetch = globalThis.fetch;
  let deliveryAttempts = 0;
  let retainedNotifications = 0;
  globalThis.fetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith("/sendMessage")) {
      retainedNotifications++;
      return Response.json({ ok: true });
    }
    assert.match(url, /\/eve\/v1\/telegram\/accepted$/u);
    deliveryAttempts++;
    return new Response(null, { status: 503 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const pending = deliver(
    {
      update_id: 212,
      message: {
        message_id: 212,
        date: 1,
        chat: { id: 1, type: "private" },
        from: { id: 42, is_bot: false },
        text: "hello",
      },
    },
    {
      timeoutMs: 90_000,
      retryAcceptanceTimeout: false,
      boundedAttempts: 3,
    },
  );

  await waitForImmediate();
  t.mock.timers.tick(1_000);
  await waitForImmediate();
  t.mock.timers.tick(2_000);

  assert.equal(await pending, false);
  assert.equal(deliveryAttempts, 3);
  assert.equal(retainedNotifications, 1);
});
