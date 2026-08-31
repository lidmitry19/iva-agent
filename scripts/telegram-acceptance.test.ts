/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node's test runner owns registration promises and the harness preserves production async seams. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { telegramChannel } from "eve/channels/telegram";
import type {
  TelegramChannelState,
  TelegramContext,
  TelegramMessage,
} from "eve/channels/telegram";
import type { RouteHandlerArgs, Session } from "eve/channels";
import {
  createQueueItem,
  enqueueItem,
  queueHead,
  removeQueueHead,
} from "./lib/telegram-queue.ts";
import {
  addTelegramQueueReceipt,
  handleAcceptedTelegramWebhook,
  TELEGRAM_CLOSED_SESSION_KIND,
  wrapTelegramQueueOnMessage,
} from "#lib/telegram-acceptance.ts";
import { TELEGRAM_QUEUE_RECEIPT_FIELD } from "#lib/telegram-parts.ts";

const WEBHOOK_SECRET = "test-secret";

// Журнал хода (ADR-0010): обёртка onMessage — единственное место, где видны и апдейт, и
// результат inbound-пайплайна, поэтому состав контекста и связка «апдейт ↔ ход» пишутся
// здесь, а не внутри самого пайплайна.
const traceRoot = mkdtempSync(join(tmpdir(), "iva-acceptance-trace-"));
process.env.ASSISTANT_DATA_DIR = join(traceRoot, "data");
mkdirSync(process.env.ASSISTANT_DATA_DIR, { recursive: true });
const trace = await import("#lib/trace.ts");
process.on("exit", () => rmSync(traceRoot, { recursive: true, force: true }));

function traceEvents(): Record<string, unknown>[] {
  try {
    return readFileSync(
      trace.traceFilePath(trace.traceDay(), process.env.ASSISTANT_DATA_DIR),
      "utf8",
    )
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return []; // журнала ещё нет — событий тоже
  }
}

function inboundMessage(chatId: number, messageId: number): TelegramMessage {
  return {
    attachments: [],
    caption: "",
    chat: { id: String(chatId), type: "private" },
    from: { id: "42", isBot: false },
    messageId: String(messageId),
    raw: {},
    text: "привет",
  } as unknown as TelegramMessage;
}
type TestUpdate = {
  update_id: number;
  message: {
    message_id: number;
    date: number;
    chat: { id: number; type: string };
    from: { id: number; is_bot: boolean; first_name: string };
    text?: string;
    [key: string]: unknown;
  };
};
type DeliveryResult = true | false | "handled" | "closed-session";
type SendImpl = (
  update: TestUpdate,
  input: unknown,
  options: unknown,
) => Promise<unknown>;
type DeliveryOptions = {
  webhookVerifier?: (
    request: Request,
    rawBody: string,
  ) => Promise<string | boolean>;
  onMessage?: (context: TelegramContext, message: TelegramMessage) => unknown;
  marked?: boolean;
  webhookSecretHeader?: string;
  completedUpdatesFile?: string;
};
type DrainReadyQueueHeads = (
  options: Record<string, unknown>,
) => Promise<number>;

const isCompletedLedger = (
  value: unknown,
): value is { botId: string; updates: number[] } =>
  value !== null &&
  typeof value === "object" &&
  "botId" in value &&
  typeof value.botId === "string" &&
  "updates" in value &&
  Array.isArray(value.updates) &&
  value.updates.every((id) => typeof id === "number");

const fakeBotToken = (id: number, label: string): string =>
  `${id}:${Buffer.from(label).toString("base64url")}`;
// TODO(ticket-04): eve 0.47 grew `Session` (send/respond/compact/clear/reset are
// now required); this mock never implemented those and the whole acceptance harness
// predates the new `from(address)` dispatch surface. Cast, don't redesign, here.
const fakeSession = (id: string): Session =>
  ({
    id,
    continuationToken: id,
    cancel: () => {
      throw new Error("not used");
    },
    getEventStream: () => {
      throw new Error("not used");
    },
    getStreamTailIndex: () => {
      throw new Error("not used");
    },
  }) as unknown as Session;
process.env.TELEGRAM_BOT_TOKEN = fakeBotToken(999, "acceptance-default");
process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN = WEBHOOK_SECRET;
process.env.TELEGRAM_ALLOWED_USER_IDS = "42";
process.env.TELEGRAM_POLL_SETTLE_MS = "0";
const pollModulePath = "./telegram-poll.mjs";
const { drainReadyQueueHeads } = (await import(pollModulePath)) as {
  drainReadyQueueHeads: DrainReadyQueueHeads;
};

const privateUpdate = (updateId: number, text?: string): TestUpdate => ({
  update_id: updateId,
  message: {
    message_id: updateId,
    date: 1,
    chat: { id: 1, type: "private" },
    from: { id: 42, is_bot: false, first_name: "Owner" },
    text,
  },
});

function deferred(): {
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve: (value: unknown) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<unknown>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${label}`);
}

function productionTelegramDelivery(
  sendImpl: SendImpl,
  {
    webhookVerifier,
    onMessage = () => ({ auth: null }),
    marked = true,
    webhookSecretHeader = WEBHOOK_SECRET,
    completedUpdatesFile = join(
      mkdtempSync(join(tmpdir(), "iva-completed-updates-test-")),
      "completed-updates.json",
    ),
  }: DeliveryOptions = {},
): (update: TestUpdate) => Promise<DeliveryResult> {
  const channel = telegramChannel({
    credentials: {
      webhookVerifier:
        webhookVerifier ?? (async (_request, rawBody) => rawBody),
    },
    onMessage: wrapTelegramQueueOnMessage(
      onMessage as Parameters<typeof wrapTelegramQueueOnMessage>[0],
    ),
  });
  const route = channel.routes.find(
    (candidate) =>
      candidate.transport !== "websocket" &&
      candidate.method === "POST" &&
      candidate.path === "/eve/v1/telegram",
  );
  assert.ok(route && route.transport !== "websocket");

  return async (update: TestUpdate) => {
    // TODO(ticket-04): eve 0.47 removed `send`/`resolveActiveSession` from
    // RouteHandlerArgs (dispatch moved to `from(address)`/`attachSession`); this
    // harness mocks the pre-migration shape so the real telegramChannel route
    // handler no longer finds the dispatch surface it expects. Cast keeps this
    // compiling; ticket 04 rebuilds the harness on the new surface.
    const routeArgs = {
      send: async (input: unknown, options: unknown) => {
        await sendImpl(update, input, options);
        return fakeSession(`test-session-${update.update_id}`);
      },
      resolveActiveSession: () => {
        throw new Error("not used");
      },
      cancel: () => {
        throw new Error("not used");
      },
      clear: () => {
        throw new Error("not used");
      },
      compact: () => {
        throw new Error("not used");
      },
      reset: () => {
        throw new Error("not used");
      },
      getSession: () => {
        throw new Error("not used");
      },
      receive: () => {
        throw new Error("not used");
      },
      params: {},
      waitUntil: () => {},
      requestIp: "127.0.0.1",
    } as unknown as RouteHandlerArgs<TelegramChannelState>;
    const response = await handleAcceptedTelegramWebhook(
      route.handler,
      new Request("http://iva.test/eve/v1/telegram/accepted", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": webhookSecretHeader,
        },
        body: JSON.stringify(marked ? addTelegramQueueReceipt(update) : update),
      }),
      routeArgs,
      { completedUpdatesFile },
    );
    if (!response.ok) {
      return response.headers.get("x-iva-telegram-acceptance") ===
        TELEGRAM_CLOSED_SESSION_KIND
        ? TELEGRAM_CLOSED_SESSION_KIND
        : false;
    }
    return response.headers.get("x-iva-telegram-acceptance") === "handled"
      ? "handled"
      : true;
  };
}

test("intentional authored no-send accepts queued contact, then the later text keeps FIFO order", async () => {
  const contact = {
    ...privateUpdate(101, undefined),
    message: {
      ...privateUpdate(101, undefined).message,
      contact: { first_name: "Ada", phone_number: "+99800" },
    },
  };
  let document = enqueueItem(
    enqueueItem({ version: 1, queues: {} }, "1:", createQueueItem(contact, 1))
      .document,
    "1:",
    createQueueItem(privateUpdate(102, "after contact"), 2),
  ).document;
  const sent: number[] = [];
  const deliverImpl = productionTelegramDelivery(
    async (update) => {
      sent.push(update.update_id);
      return { id: `session-${update.update_id}` };
    },
    {
      onMessage: (_ctx, message) => {
        assert.equal(
          Object.hasOwn(message.raw, TELEGRAM_QUEUE_RECEIPT_FIELD),
          false,
        );
        return message.raw.contact ? null : { auth: null };
      },
    },
  );
  const acknowledgeImpl = async (key: string, updateId: number) => {
    document = removeQueueHead(document, key, updateId);
  };
  const inFlight = new Map();

  assert.equal(
    await drainReadyQueueHeads({
      loadImpl: async () => document,
      runningImpl: () => false,
      deliverImpl,
      acknowledgeImpl,
      settleUntil: new Map(),
      inFlight,
    }),
    1,
  );
  assert.equal(queueHead(document, "1:")?.updateId, 102);
  assert.deepEqual(sent, []);

  assert.equal(
    await drainReadyQueueHeads({
      loadImpl: async () => document,
      runningImpl: () => false,
      deliverImpl,
      acknowledgeImpl,
      settleUntil: new Map(),
      inFlight,
    }),
    0,
  );
  assert.deepEqual(sent, [102]);
});

test("intentional silent sticker no-send is accepted, while throw and unmarked null are rejected", async () => {
  const sticker = {
    ...privateUpdate(201, undefined),
    message: {
      ...privateUpdate(201, undefined).message,
      sticker: { file_id: "silent-sticker" },
    },
  };
  let sendCalls = 0;
  const silent = productionTelegramDelivery(
    async () => {
      sendCalls++;
      return { id: "must-not-send" };
    },
    { onMessage: () => null },
  );
  assert.equal(await silent(sticker), "handled");
  assert.equal(sendCalls, 0);

  const thrown = productionTelegramDelivery(
    async () => {
      sendCalls++;
      return { id: "must-not-send" };
    },
    {
      onMessage: () => {
        throw new Error("injected authored handler failure");
      },
    },
  );
  assert.equal(await thrown(sticker), false);
  assert.equal(sendCalls, 0);

  const unmarked = productionTelegramDelivery(
    async () => {
      sendCalls++;
      return { id: "must-not-send" };
    },
    { onMessage: () => null, marked: false },
  );
  assert.equal(await unmarked(sticker), false);
  assert.equal(sendCalls, 0);
});

test("acceptance route preserves Telegram auth failure and rejects malformed no-send updates", async () => {
  let sendCalls = 0;
  const rejectedByVerifier = productionTelegramDelivery(
    async () => {
      sendCalls++;
      return { id: "must-not-run" };
    },
    { webhookVerifier: async () => false },
  );
  assert.equal(
    await rejectedByVerifier(privateUpdate(1, "unauthorized")),
    false,
  );
  assert.equal(sendCalls, 0);

  const channel = telegramChannel({
    credentials: { webhookVerifier: async (_request, rawBody) => rawBody },
    onMessage: () => ({ auth: null }),
  });
  const route = channel.routes.find(
    (candidate) =>
      candidate.transport !== "websocket" &&
      candidate.method === "POST" &&
      candidate.path === "/eve/v1/telegram",
  );
  assert.ok(route && route.transport !== "websocket");
  const malformed = await handleAcceptedTelegramWebhook(
    route.handler,
    new Request("http://iva.test/eve/v1/telegram/accepted", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{broken",
    }),
    // TODO(ticket-04): same pre-migration RouteHandlerArgs mock as
    // productionTelegramDelivery above (see its cast comment).
    {
      send: () => {
        sendCalls++;
        throw new Error("must not run");
      },
      resolveActiveSession: () => {
        throw new Error("must not run");
      },
      cancel: () => {
        throw new Error("must not run");
      },
      clear: () => {
        throw new Error("must not run");
      },
      compact: () => {
        throw new Error("must not run");
      },
      reset: () => {
        throw new Error("must not run");
      },
      getSession: () => {
        throw new Error("must not run");
      },
      receive: () => {
        throw new Error("must not run");
      },
      params: {},
      waitUntil: () => {},
      requestIp: "127.0.0.1",
    } as unknown as RouteHandlerArgs<TelegramChannelState>,
  );
  assert.equal(malformed.ok, false);
  assert.equal(malformed.status, 503);
  assert.equal(sendCalls, 0);
});

test("production Telegram deferred failure retains the head and cannot start the next head", async () => {
  let document = enqueueItem(
    enqueueItem(
      { version: 1, queues: {} },
      "1:",
      createQueueItem(privateUpdate(101, "first"), 1),
    ).document,
    "1:",
    createQueueItem(privateUpdate(102, "second"), 2),
  ).document;
  const attempts: number[] = [];

  const remaining = await drainReadyQueueHeads({
    loadImpl: async () => document,
    runningImpl: () => false,
    deliverImpl: productionTelegramDelivery(async (update) => {
      attempts.push(update.update_id);
      throw new Error("injected Eve acceptance failure");
    }),
    acknowledgeImpl: async (key: string, updateId: number) => {
      document = removeQueueHead(document, key, updateId);
    },
    settleUntil: new Map(),
    inFlight: new Map(),
  });

  assert.equal(remaining, 2);
  assert.equal(queueHead(document, "1:")?.updateId, 101);
  assert.deepEqual(attempts, [101]);
});

test("production Telegram receipt removes exactly one head only after Eve send resolves", async () => {
  let document = enqueueItem(
    enqueueItem(
      { version: 1, queues: {} },
      "1:",
      createQueueItem(privateUpdate(101, "first"), 1),
    ).document,
    "1:",
    createQueueItem(privateUpdate(102, "second"), 2),
  ).document;
  const acceptance = deferred();
  const attempts: number[] = [];

  const drain = drainReadyQueueHeads({
    loadImpl: async () => document,
    runningImpl: () => false,
    deliverImpl: productionTelegramDelivery(async (update) => {
      attempts.push(update.update_id);
      return acceptance.promise;
    }),
    acknowledgeImpl: async (key: string, updateId: number) => {
      document = removeQueueHead(document, key, updateId);
    },
    settleUntil: new Map(),
    inFlight: new Map(),
  });

  await waitFor(() => attempts.length === 1, "the first delivery attempt");
  assert.equal(queueHead(document, "1:")?.updateId, 101);
  assert.deepEqual(attempts, [101]);

  acceptance.resolve({ id: "accepted-session" });
  assert.equal(await drain, 1);
  assert.equal(queueHead(document, "1:")?.updateId, 102);
  assert.deepEqual(
    attempts,
    [101],
    "one drain pass must keep one in-flight head per chat",
  );
});

test("a completed update is handled from disk without invoking the authored handler", async () => {
  const root = mkdtempSync(join(tmpdir(), "iva-completed-ledger-test-"));
  const completedUpdatesFile = join(root, "completed-updates.json");
  let handlerCalls = 0;
  const first = productionTelegramDelivery(
    async () => ({ id: "accepted-session" }),
    {
      completedUpdatesFile,
      onMessage: () => {
        handlerCalls++;
        return { auth: null };
      },
    },
  );
  assert.equal(await first(privateUpdate(501, "first")), true);

  handlerCalls = 0;
  const afterReload = productionTelegramDelivery(
    async () => {
      throw new Error("duplicate must not send");
    },
    {
      completedUpdatesFile,
      onMessage: () => {
        handlerCalls++;
        return { auth: null };
      },
    },
  );
  assert.equal(await afterReload(privateUpdate(501, "duplicate")), "handled");
  assert.equal(handlerCalls, 0);
  assert.deepEqual(JSON.parse(readFileSync(completedUpdatesFile, "utf8")), {
    botId: "999",
    updates: [501],
  });

  const unauthorized = productionTelegramDelivery(
    async () => {
      throw new Error("unauthorized duplicate must not send");
    },
    {
      completedUpdatesFile,
      webhookSecretHeader: "wrong-secret",
      webhookVerifier: async (request): Promise<boolean> =>
        request.headers.get("x-telegram-bot-api-secret-token") ===
        WEBHOOK_SECRET,
      onMessage: () => {
        handlerCalls++;
        return { auth: null };
      },
    },
  );
  assert.equal(
    await unauthorized(privateUpdate(501, "unauthorized duplicate")),
    false,
  );
  assert.equal(handlerCalls, 0);
});

test("an update is recorded only after successful acceptance", async () => {
  const root = mkdtempSync(join(tmpdir(), "iva-completed-ledger-reject-test-"));
  const completedUpdatesFile = join(root, "completed-updates.json");
  let handlerCalls = 0;
  const rejected = productionTelegramDelivery(
    async () => {
      throw new Error("injected rejection");
    },
    {
      completedUpdatesFile,
      onMessage: () => {
        handlerCalls++;
        return { auth: null };
      },
    },
  );
  assert.equal(await rejected(privateUpdate(601, "retry me")), false);

  const accepted = productionTelegramDelivery(
    async () => ({ id: "accepted-session" }),
    {
      completedUpdatesFile,
      onMessage: () => {
        handlerCalls++;
        return { auth: null };
      },
    },
  );
  assert.equal(await accepted(privateUpdate(601, "retry me")), true);
  assert.equal(handlerCalls, 2);
  assert.deepEqual(JSON.parse(readFileSync(completedUpdatesFile, "utf8")), {
    botId: "999",
    updates: [601],
  });
});

test("the completed-update ledger keeps the latest 200 ids", async () => {
  const root = mkdtempSync(join(tmpdir(), "iva-completed-ledger-bound-test-"));
  const completedUpdatesFile = join(root, "completed-updates.json");
  writeFileSync(
    completedUpdatesFile,
    JSON.stringify({
      botId: "999",
      updates: Array.from({ length: 200 }, (_, id) => id),
    }),
  );
  const delivery = productionTelegramDelivery(
    async () => ({ id: "accepted-session" }),
    { completedUpdatesFile },
  );

  assert.equal(await delivery(privateUpdate(999, "newest")), true);
  const completed: unknown = JSON.parse(
    readFileSync(completedUpdatesFile, "utf8"),
  );
  assert.ok(isCompletedLedger(completed));
  assert.equal(completed.botId, "999");
  assert.equal(completed.updates.length, 200);
  assert.equal(completed.updates.includes(0), false);
  assert.equal(completed.updates.includes(999), true);
});

test("a completed-update ledger is isolated by Telegram bot id", async () => {
  const root = mkdtempSync(join(tmpdir(), "iva-completed-ledger-bot-test-"));
  const completedUpdatesFile = join(root, "completed-updates.json");
  let sends = 0;
  const delivery = productionTelegramDelivery(
    async () => ({ id: `accepted-${++sends}` }),
    { completedUpdatesFile },
  );
  const priorToken = process.env.TELEGRAM_BOT_TOKEN;
  try {
    process.env.TELEGRAM_BOT_TOKEN = fakeBotToken(111, "first-bot");
    assert.equal(await delivery(privateUpdate(701, "first bot")), true);
    process.env.TELEGRAM_BOT_TOKEN = fakeBotToken(222, "second-bot");
    assert.equal(await delivery(privateUpdate(701, "second bot")), true);
    assert.equal(
      await delivery(privateUpdate(701, "second bot duplicate")),
      "handled",
    );
    assert.equal(sends, 2);
    assert.deepEqual(JSON.parse(readFileSync(completedUpdatesFile, "utf8")), {
      botId: "222",
      updates: [701],
    });
  } finally {
    if (priorToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = priorToken;
  }
});

test("an invalid completed-update schema is recovered after acceptance", async () => {
  const root = mkdtempSync(join(tmpdir(), "iva-completed-ledger-schema-test-"));
  const completedUpdatesFile = join(root, "completed-updates.json");
  writeFileSync(completedUpdatesFile, JSON.stringify({ updates: "broken" }));
  let sends = 0;
  const delivery = productionTelegramDelivery(
    async () => ({ id: `accepted-${++sends}` }),
    { completedUpdatesFile },
  );

  assert.equal(await delivery(privateUpdate(801, "recover")), true);
  assert.equal(await delivery(privateUpdate(801, "duplicate")), "handled");
  assert.equal(sends, 1);
  assert.deepEqual(JSON.parse(readFileSync(completedUpdatesFile, "utf8")), {
    botId: "999",
    updates: [801],
  });
});

test("missing webhook secret disables deduplication and reports it once", async () => {
  const root = mkdtempSync(join(tmpdir(), "iva-completed-ledger-secret-test-"));
  const completedUpdatesFile = join(root, "completed-updates.json");
  const priorSecret = process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN;
  const priorError = console.error;
  const logs: string[] = [];
  let sends = 0;
  delete process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN;
  console.error = (...parts: unknown[]) =>
    logs.push(parts.map(String).join(" "));
  try {
    const delivery = productionTelegramDelivery(
      async () => ({ id: `accepted-${++sends}` }),
      { completedUpdatesFile },
    );
    assert.equal(await delivery(privateUpdate(901, "first")), true);
    assert.equal(await delivery(privateUpdate(901, "repeat")), true);
  } finally {
    console.error = priorError;
    process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN = priorSecret;
  }
  assert.equal(sends, 2);
  assert.equal(
    logs.filter((line) => line.includes("durable deduplication")).length,
    1,
  );
});

test("Trace: обёртка пишет состав контекста и связывает ход с апдейтом", async () => {
  const before = traceEvents().length;
  const accepted = wrapTelegramQueueOnMessage(() => ({
    auth: null,
    context: ["[reply]", "[voice] spoken words"],
  }));
  const dropped = wrapTelegramQueueOnMessage(() => null);

  await accepted({} as TelegramContext, inboundMessage(77, 5));
  await dropped({} as TelegramContext, inboundMessage(78, 6));

  const added = traceEvents()
    .slice(before)
    .filter((event) => event.kind === "inbound");
  assert.deepEqual(
    added.map((event) => event.name),
    ["accepted", "dropped"],
  );
  assert.equal(added[0].turn, "tg:77:5");
  assert.deepEqual(added[0].data, {
    chatId: "77",
    chatKey: "77:",
    parts: 2,
    partChars: [7, 20],
    context: ["[reply]", "[voice] spoken words"],
  });
  // Принятый апдейт помечен для старта хода, отброшенный — нет.
  assert.equal(trace.traceBoundUpdate("77:"), "tg:77:5");
  assert.equal(trace.traceBoundUpdate("78:"), "");
});

// --- Reply на закрытую сессию (issue #203) ---
// eve строит inputResponses из reply на сообщение бота. Сессия под цитатой закрывается
// штатно (ротация, ночной сброс, /new, рестарт при апдейте), и тогда send падает
// навсегда: доставить inputResponses уже некуда.
const CLOSED_SESSION_ERROR =
  "Cannot deliver inputResponses — the target session was not found via continuation token.";

const replyToBotUpdate = (updateId: number, text: string): TestUpdate => ({
  ...privateUpdate(updateId, text),
  message: {
    ...privateUpdate(updateId, text).message,
    reply_to_message: {
      message_id: updateId - 1,
      date: 1,
      chat: { id: 1, type: "private" },
      from: { id: 999, is_bot: true, first_name: "Iva" },
      text: "старый ответ бота",
    },
  },
});

const inputResponsesOf = (input: unknown): unknown[] =>
  typeof input === "object" && input !== null && "inputResponses" in input
    ? ((input as { inputResponses?: unknown[] }).inputResponses ?? [])
    : [];

test("a reply to a closed session is delivered as a new turn exactly once", async () => {
  const attempts: unknown[] = [];
  const priorError = console.error;
  const logs: string[] = [];
  console.error = (...parts: unknown[]) =>
    logs.push(parts.map(String).join(" "));
  try {
    const delivery = productionTelegramDelivery(async (_update, input) => {
      attempts.push(input);
      if (inputResponsesOf(input).length > 0)
        throw new Error(CLOSED_SESSION_ERROR);
      return { id: "new-turn" };
    });
    assert.equal(await delivery(replyToBotUpdate(1101, "и что дальше?")), true);
  } finally {
    console.error = priorError;
  }

  assert.equal(attempts.length, 2, "ровно одна перемаршрутизация");
  assert.equal(inputResponsesOf(attempts[0]).length, 1);
  assert.equal(inputResponsesOf(attempts[1]).length, 0);
  // Текст и контекст хода те же — теряется только привязка к закрытой сессии.
  assert.deepEqual(
    (attempts[1] as { message: unknown }).message,
    (attempts[0] as { message: unknown }).message,
  );
  assert.deepEqual(
    logs.filter((line) => line.includes("closed session")),
    [
      "[telegram] reply to a closed session; delivering as a new message (update 1101)",
    ],
  );
});

test("a new turn refused by an unavailable eve is retained, then delivered on the next healthy cycle", async () => {
  const attempts: unknown[] = [];
  let eveIsDown = true;
  const priorError = console.error;
  console.error = () => {};
  try {
    const delivery = productionTelegramDelivery(async (_update, input) => {
      attempts.push(input);
      if (inputResponsesOf(input).length > 0)
        throw new Error(CLOSED_SESSION_ERROR);
      if (eveIsDown) throw new Error("eve is restarting");
      return { id: "new-turn" };
    });
    const update = replyToBotUpdate(1102, "и что дальше?");
    // Сессия не найдена, но новый ход упал по недоступности eve — сообщение владельца
    // не теряется (ADR-0002): транзиентный отказ, мост сохраняет апдейт.
    assert.equal(await delivery(update), false);
    eveIsDown = false;
    assert.equal(await delivery(update), true);
  } finally {
    console.error = priorError;
  }
  assert.equal(attempts.length, 4, "по две попытки на каждый проход моста");
  assert.equal(inputResponsesOf(attempts[3]).length, 0);
});

test("a new turn that is itself refused as a closed session is terminal, not retried", async () => {
  let attempts = 0;
  const priorError = console.error;
  console.error = () => {};
  try {
    const delivery = productionTelegramDelivery(async () => {
      attempts++;
      throw new Error(CLOSED_SESSION_ERROR);
    });
    assert.equal(
      await delivery(replyToBotUpdate(1104, "и что дальше?")),
      TELEGRAM_CLOSED_SESSION_KIND,
    );
  } finally {
    console.error = priorError;
  }
  assert.equal(attempts, 2, "перемаршрутизация пробуется ровно один раз");
});

test("an ordinary send failure stays transient and never claims the closed-session class", async () => {
  let attempts = 0;
  const priorError = console.error;
  console.error = () => {};
  try {
    const delivery = productionTelegramDelivery(async () => {
      attempts++;
      throw new Error("eve is restarting");
    });
    assert.equal(
      await delivery(replyToBotUpdate(1103, "и что дальше?")),
      false,
    );
  } finally {
    console.error = priorError;
  }
  assert.equal(attempts, 1, "транзиентный сбой не перемаршрутизируется");
});
