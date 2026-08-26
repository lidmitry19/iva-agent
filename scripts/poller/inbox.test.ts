import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import fc from "fast-check";
import {
  createQueueItem,
  enqueueItem,
  removeQueueHead,
  type TelegramQueueDocument,
  type TelegramQueueUpdate,
} from "../lib/telegram-queue.ts";
import {
  admitTelegramUpdate,
  inboxKeyFor,
  promoteReadyInbox,
  selectReadyInboxBatch,
  terminalDropLine,
} from "./inbox.ts";

const SEED = 18_702;

// Мост пишет журнал хода (ADR-0010) из СВОЕГО процесса, в тот же дневной файл, что и
// агент. Каталог данных — временный: писатель резолвит его на каждой записи.
const traceRoot = mkdtempSync(join(tmpdir(), "iva-bridge-trace-"));
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

function update(updateId: number, text: string): TelegramQueueUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1,
      chat: { id: 1, type: "private" },
      from: { id: 42, is_bot: false },
      text,
    },
  };
}

function inboxDocument(
  ...updates: TelegramQueueUpdate[]
): TelegramQueueDocument {
  return updates.reduce<TelegramQueueDocument>(
    (document, candidate, index) => {
      const key = inboxKeyFor(candidate);
      assert.ok(key);
      return enqueueItem(document, key, createQueueItem(candidate, index * 100))
        .document;
    },
    { version: 1, queues: {} },
  );
}

function callback(updateId: number, fromId = 42): TelegramQueueUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: `callback-${updateId}`,
      from: { id: fromId, is_bot: false },
      message: {
        message_id: updateId - 1,
        chat: { id: 1, type: "private" },
      },
      data: "foreign_callback",
    },
  };
}

function inlineCallback(updateId: number, fromId = 42): TelegramQueueUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: `inline-callback-${updateId}`,
      from: { id: fromId, is_bot: false },
      inline_message_id: "inline-message-1",
      data: "foreign_inline_callback",
    },
  };
}

void test("durable inbox waits for quiet and then merges the owned burst", () => {
  const document = inboxDocument(update(101, "first"), update(102, "second"));
  assert.equal(
    selectReadyInboxBatch("1::42", document.queues["1::42"], 899, {
      quietMs: 800,
    }),
    null,
  );
  const batch = selectReadyInboxBatch("1::42", document.queues["1::42"], 900, {
    quietMs: 800,
  });
  assert.ok(batch?.update.message?.iva_parts);
  assert.equal(batch.update.update_id, 102);
  assert.deepEqual(batch.updateIds, [101, 102]);
  assert.deepEqual(
    batch.update.message.iva_parts.map((part) => part.text),
    ["first", "second"],
  );
});

void test("property: durable reconstruction returns the exact ready prefix", () => {
  fc.assert(
    fc.property(
      fc
        .uniqueArray(fc.integer({ min: 1, max: 1_000_000 }), {
          minLength: 1,
          maxLength: 10,
        })
        .map((ids) => ids.sort((left, right) => left - right)),
      fc.integer({ min: 0, max: 500 }),
      (updateIds, quietMs) => {
        const document = inboxDocument(
          ...updateIds.map((updateId) => update(updateId, `part-${updateId}`)),
        );
        const batch = selectReadyInboxBatch(
          "1::42",
          document.queues["1::42"],
          (updateIds.length - 1) * 100 + quietMs,
          { quietMs },
        );
        assert.ok(batch);
        const expectedIds = quietMs === 0 ? updateIds.slice(0, 1) : updateIds;
        assert.deepEqual(batch.updateIds, expectedIds);
        assert.equal(batch.update.update_id, Math.max(...expectedIds));
      },
    ),
    { seed: SEED, numRuns: 1_000 },
  );
});

void test("callback inbox keys are stable passthrough keys and cannot collide with message collectors", () => {
  const message = update(101, "message");
  const callbackUpdate = callback(102);
  assert.equal(inboxKeyFor(message), "1::42");
  assert.equal(inboxKeyFor(callbackUpdate), "callback:1:");
  assert.notEqual(inboxKeyFor(message), inboxKeyFor(callbackUpdate));

  const document = inboxDocument(callbackUpdate);
  const batch = selectReadyInboxBatch(
    "callback:1:",
    document.queues["callback:1:"],
    0,
    { quietMs: 800 },
  );
  assert.deepEqual(batch, { update: callbackUpdate, updateIds: [102] });
});

void test("an allowed inline callback has a bounded sender key and remains passthrough", async () => {
  const candidate = inlineCallback(103);
  const key = inboxKeyFor(candidate);
  assert.match(key ?? "", /^callback:inline:[0-9a-f]{64}$/u);
  const owned: string[] = [];
  assert.equal(
    await admitTelegramUpdate(candidate, {
      allowedUserIds: new Set(["42"]),
      enqueueImpl: (candidateKey) => {
        owned.push(candidateKey);
        return Promise.resolve();
      },
    }),
    "owned",
  );
  assert.deepEqual(owned, [key]);
  const document = inboxDocument(candidate);
  assert.deepEqual(
    selectReadyInboxBatch(key as string, document.queues[key as string], 0, {
      quietMs: 800,
    }),
    { update: candidate, updateIds: [103] },
  );
});

void test("property: callback and message inbox key spaces never collide", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: -1_000_000, max: 1_000_000 }),
      fc.integer({ min: 1, max: 1_000_000 }),
      fc.option(fc.integer({ min: 1, max: 1_000_000 }), { nil: undefined }),
      (chatId, fromId, threadId) => {
        const message = update(101, "message");
        assert.ok(message.message);
        message.message.chat = { id: chatId, type: "private" };
        message.message.from = { id: fromId, is_bot: false };
        if (threadId !== undefined)
          message.message.message_thread_id = threadId;
        const callbackUpdate = callback(102, fromId);
        assert.ok(callbackUpdate.callback_query?.message);
        callbackUpdate.callback_query.message.chat = {
          id: chatId,
          type: "private",
        };
        if (threadId !== undefined) {
          callbackUpdate.callback_query.message.message_thread_id = threadId;
        }
        const messageKey = inboxKeyFor(message);
        const callbackKey = inboxKeyFor(callbackUpdate);
        assert.ok(messageKey);
        assert.ok(callbackKey);
        assert.match(callbackKey, /^callback:/u);
        assert.notEqual(messageKey, callbackKey);
      },
    ),
    { seed: SEED, numRuns: 1_000 },
  );
});

void test("promotion publishes the delivery item before removing raw ownership", async () => {
  let document = inboxDocument(update(101, "first"), update(102, "second"));
  const events: string[] = [];
  const remaining = await promoteReadyInbox({
    now: () => 1_000,
    collectorOptions: { quietMs: 800 },
    loadImpl: () => Promise.resolve(document),
    routeImpl: (candidate) => {
      events.push(`route:${candidate.update_id}`);
      return Promise.resolve("queued");
    },
    acknowledgeImpl: (key, updateId) => {
      events.push(`ack:${updateId}`);
      document = removeQueueHead(document, key, updateId);
      return Promise.resolve();
    },
  });

  assert.equal(remaining, 0);
  assert.deepEqual(events, ["route:102", "ack:101", "ack:102"]);
});

void test("failed promotion keeps every raw part for retry", async () => {
  const document = inboxDocument(update(101, "first"), update(102, "second"));
  let acknowledgements = 0;
  assert.equal(
    await promoteReadyInbox({
      now: () => 1_000,
      collectorOptions: { quietMs: 800 },
      loadImpl: () => Promise.resolve(document),
      routeImpl: () => Promise.resolve("enqueue-failed"),
      acknowledgeImpl: () => {
        acknowledgements++;
        return Promise.resolve();
      },
    }),
    2,
  );
  assert.equal(acknowledgements, 0);
});

void test("callback rejection, downstream drop, and enqueue failure all retain inbox ownership", async () => {
  for (const result of ["rejected", "dropped", "enqueue-failed"] as const) {
    const document = inboxDocument(callback(101));
    let acknowledgements = 0;
    assert.equal(
      await promoteReadyInbox({
        now: () => 0,
        loadImpl: () => Promise.resolve(document),
        routeImpl: () => Promise.resolve(result),
        acknowledgeImpl: () => {
          acknowledgements++;
          return Promise.resolve();
        },
      }),
      1,
    );
    assert.equal(acknowledgements, 0, result);
  }
});

void test("a terminally dropped update leaves the inbox instead of looping forever", async () => {
  let document = inboxDocument(update(101, "reply to a closed session"));
  const routed: number[] = [];
  const remaining = await promoteReadyInbox({
    now: () => 1_000,
    collectorOptions: { quietMs: 800 },
    loadImpl: () => Promise.resolve(document),
    routeImpl: (candidate) => {
      routed.push(candidate.update_id);
      return Promise.resolve("terminal-drop");
    },
    acknowledgeImpl: (key, updateId) => {
      document = removeQueueHead(document, key, updateId);
      return Promise.resolve();
    },
  });

  assert.equal(remaining, 0);
  assert.deepEqual(routed, [101]);
  assert.deepEqual(document.queues, {});
});

void test("property: terminal results never loop while transient results never lose an update", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.constantFrom("terminal-drop", "rejected", "delivered"), {
        minLength: 1,
        maxLength: 8,
      }),
      fc.integer({ min: 1, max: 6 }),
      async (outcomes, passes) => {
        // Свой чат на каждый апдейт: иначе коллектор склеит их в одну голову.
        let document = outcomes.reduce<TelegramQueueDocument>(
          (accumulator, _outcome, index) => {
            const candidate = update(200 + index, `part-${index}`);
            assert.ok(candidate.message);
            candidate.message.chat = { id: 200 + index, type: "private" };
            const key = inboxKeyFor(candidate);
            assert.ok(key);
            return enqueueItem(accumulator, key, createQueueItem(candidate, 0))
              .document;
          },
          { version: 1, queues: {} },
        );
        const verdicts = new Map(
          outcomes.map((outcome, index) => [200 + index, outcome]),
        );
        const deliveries: number[] = [];
        const attempts = new Map<number, number>();

        for (let pass = 0; pass < passes; pass++) {
          await promoteReadyInbox({
            now: () => 1_000,
            collectorOptions: { quietMs: 0 },
            loadImpl: () => Promise.resolve(document),
            routeImpl: (candidate) => {
              const verdict = verdicts.get(candidate.update_id);
              assert.ok(verdict);
              attempts.set(
                candidate.update_id,
                (attempts.get(candidate.update_id) ?? 0) + 1,
              );
              if (verdict === "delivered") deliveries.push(candidate.update_id);
              return Promise.resolve(verdict);
            },
            acknowledgeImpl: (key, updateId) => {
              document = removeQueueHead(document, key, updateId);
              return Promise.resolve();
            },
          });
        }

        // Терминальный апдейт живёт ровно один проход, доставленный уходит в агента
        // ровно один раз, транзиентный ретраится каждый проход и остаётся на месте.
        for (const [updateId, verdict] of verdicts) {
          const seen = attempts.get(updateId) ?? 0;
          assert.equal(
            seen,
            verdict === "rejected" ? passes : 1,
            `${verdict} ${String(updateId)}`,
          );
        }
        assert.equal(new Set(deliveries).size, deliveries.length);
        assert.equal(
          Object.values(document.queues).flat().length,
          outcomes.filter((outcome) => outcome === "rejected").length,
        );
        return true;
      },
    ),
    { seed: SEED, numRuns: 300 },
  );
});

void test("admission owns trusted input and drops group noise before any offset may move", async () => {
  const owned: Array<[string, number]> = [];
  assert.equal(
    await admitTelegramUpdate(update(101, "private"), {
      allowedUserIds: new Set(["42"]),
      botUsername: "iva_bot",
      enqueueImpl: (key, candidate) => {
        owned.push([key, candidate.update_id]);
        return Promise.resolve();
      },
    }),
    "owned",
  );
  const noise = update(102, "group noise");
  assert.ok(noise.message);
  noise.message.chat = { id: -100, type: "supergroup" };
  assert.equal(
    await admitTelegramUpdate(noise, {
      allowedUserIds: new Set(["42"]),
      botUsername: "iva_bot",
      enqueueImpl: () => assert.fail("noise must not be persisted"),
    }),
    "terminal-drop",
  );
  assert.deepEqual(owned, [["1::42", 101]]);
});

void test("trusted local synthetic input uses the canonical inbox despite group ingress policy", async () => {
  const synthetic = update(-401, "[Core memory setup]");
  assert.ok(synthetic.message);
  synthetic.message.message_id = 401;
  synthetic.message.chat = { id: -100, type: "supergroup" };
  const owned: Array<[string, number]> = [];

  assert.equal(
    await admitTelegramUpdate(synthetic, {
      trustedLocal: true,
      allowedUserIds: new Set(),
      enqueueImpl: (key, candidate) => {
        owned.push([key, candidate.update_id]);
        return Promise.resolve();
      },
    }),
    "owned",
  );
  assert.deepEqual(owned, [["-100::42", -401]]);
});

void test("trusted local duplicate retry stays one canonical inbox item", async () => {
  const synthetic = update(-402, "[Core memory setup]");
  assert.ok(synthetic.message);
  synthetic.message.message_id = 402;
  let document: TelegramQueueDocument = { version: 1, queues: {} };
  const added: boolean[] = [];
  const enqueueImpl = (key: string, candidate: TelegramQueueUpdate) => {
    const result = enqueueItem(document, key, createQueueItem(candidate, 1));
    document = result.document;
    added.push(result.added);
    return Promise.resolve();
  };

  assert.equal(
    await admitTelegramUpdate(synthetic, { trustedLocal: true, enqueueImpl }),
    "owned",
  );
  assert.equal(
    await admitTelegramUpdate(synthetic, { trustedLocal: true, enqueueImpl }),
    "owned",
  );
  assert.deepEqual(added, [true, false]);
  assert.equal(document.queues["1::42"].length, 1);
});

void test("trusted local inbox write fault fails ownership proof", async () => {
  const synthetic = update(-403, "[Core memory setup]");
  assert.equal(
    await admitTelegramUpdate(synthetic, {
      trustedLocal: true,
      enqueueImpl: () => Promise.reject(new Error("injected write fault")),
      logImpl: () => {},
    }),
    "write-failed",
  );
});

void test("callback admission owns allowed users, terminally drops known unauthorised users, and fails closed without a key", async () => {
  const owned: Array<[string, number]> = [];
  assert.equal(
    await admitTelegramUpdate(callback(101), {
      allowedUserIds: new Set(["42"]),
      enqueueImpl: (key, candidate) => {
        owned.push([key, candidate.update_id]);
        return Promise.resolve();
      },
    }),
    "owned",
  );
  assert.equal(
    await admitTelegramUpdate(callback(102, 99), {
      allowedUserIds: new Set(["42"]),
      enqueueImpl: () => assert.fail("unauthorised callback must not persist"),
    }),
    "terminal-drop",
  );
  const unownable = callback(103);
  assert.ok(unownable.callback_query);
  delete unownable.callback_query.message;
  assert.equal(
    await admitTelegramUpdate(unownable, {
      allowedUserIds: new Set(["42"]),
      enqueueImpl: () => assert.fail("callback without a key must fail closed"),
    }),
    "unownable",
  );
  const missingSender = inlineCallback(104);
  assert.ok(missingSender.callback_query);
  delete missingSender.callback_query.from;
  assert.equal(
    await admitTelegramUpdate(missingSender, {
      allowedUserIds: new Set(["42"]),
      enqueueImpl: () =>
        assert.fail("callback without a sender must fail closed"),
    }),
    "unownable",
  );
  const missingId = callback(105);
  assert.ok(missingId.callback_query);
  missingId.callback_query.id = "";
  assert.equal(
    await admitTelegramUpdate(missingId, {
      allowedUserIds: new Set(["42"]),
      enqueueImpl: () => assert.fail("callback without an id must fail closed"),
    }),
    "unownable",
  );
  assert.deepEqual(owned, [["callback:1:", 101]]);
});

void test("Trace: мост пишет вердикт приёма своим ключом апдейта", async () => {
  const before = traceEvents().length;

  await admitTelegramUpdate(update(701, "принимай"), {
    allowedUserIds: new Set(["42"]),
    enqueueImpl: () => Promise.resolve(),
  });
  await admitTelegramUpdate(update(702, "чужое"), {
    allowedUserIds: new Set(["7"]),
    enqueueImpl: () => assert.fail("чужой апдейт не ставится в очередь"),
  });

  const added = traceEvents().slice(before);
  // Имя события следует исходу: принятый апдейт и отброшенный — разные строки ленты.
  assert.deepEqual(
    added.map((event) => `${String(event.kind)}.${String(event.name)}`),
    ["bridge.admitted", "bridge.dropped"],
  );
  // Ключ апдейта — тот же, что напишет ядро: чат и сообщение, а не update_id.
  assert.equal(added[0].turn, "tg:1:701");
  assert.equal(added[0].source, "bridge");
  assert.deepEqual(added[0].data, {
    updateId: 701,
    chatId: 1,
    messageId: "701",
    kind: "message",
    decision: "owned",
  });
  assert.equal(
    (added[1].data as Record<string, unknown>).decision,
    "terminal-drop",
  );
});

void test("Trace: сбой записи в inbox виден в журнале отдельным вердиктом", async () => {
  const before = traceEvents().length;

  assert.equal(
    await admitTelegramUpdate(update(703, "не влезло"), {
      allowedUserIds: new Set(["42"]),
      enqueueImpl: () => Promise.reject(new Error("ENOSPC")),
      logImpl: () => {},
    }),
    "write-failed",
  );

  const added = traceEvents().slice(before);
  assert.equal(added.length, 1);
  assert.equal(added[0].name, "dropped");
  assert.equal(
    (added[0].data as Record<string, unknown>).decision,
    "write-failed",
  );
});

// --- Bot API 10.1: rich_message ---------------------------------------------
//
// Мост судит конверт, а не список известных видов содержимого, поэтому сообщение,
// у которого текстовой проекции нет вовсе, доезжает до агента целым (ADR-0002).
const RICH_UPDATE: TelegramQueueUpdate = {
  update_id: 924_151_861,
  message: {
    message_id: 3401,
    from: { id: 42, is_bot: false },
    chat: { id: 42, type: "private" },
    date: 1_780_000_000,
    rich_message: {
      blocks: [
        {
          type: "paragraph",
          text: "Долгий текст, который не влез в 4096 знаков.",
        },
        {
          type: "list",
          items: [
            {
              label: "1.",
              blocks: [
                {
                  type: "paragraph",
                  text: { type: "bold", text: "Первый пункт" },
                },
              ],
            },
          ],
        },
      ],
    },
  },
};

void test("REGRESSION: a rich_message update from an allowed sender is owned, not dropped", async () => {
  const owned: Array<[string, number]> = [];

  assert.equal(
    await admitTelegramUpdate(RICH_UPDATE, {
      allowedUserIds: new Set(["42"]),
      botUsername: "iva_bot",
      enqueueImpl: (key, candidate) => {
        owned.push([key, candidate.update_id]);
        return Promise.resolve();
      },
    }),
    "owned",
  );
  assert.deepEqual(owned, [["42::42", 924_151_861]]);
});

void test("the drop line names the message fields and never their values", () => {
  const dropped: TelegramQueueUpdate = {
    update_id: 924_151_862,
    message: {
      message_id: 3402,
      from: { id: 42, is_bot: false },
      chat: { id: 42, type: "private" },
      date: 1_780_000_000,
      rich_message: { blocks: [{ type: "paragraph", text: "секрет" }] },
      Ключ: "мусор",
      "a b": 1,
    },
  };

  const line = terminalDropLine(dropped);

  assert.equal(
    line,
    'drop update 924151862 — terminal ingress policy; message keys: ["chat","date","from","message_id","rich_message"]',
  );
  assert.equal(line.includes("секрет"), false);
  assert.equal(line.includes("Ключ"), false);
  // Апдейт без message — это колбэк: строка остаётся прежней.
  assert.equal(
    terminalDropLine({ update_id: 5, callback_query: { id: "cb" } }),
    "drop update 5 — terminal ingress policy",
  );
});

void test("the drop line prints at most twelve field names", () => {
  const many = Object.fromEntries(
    Array.from({ length: 20 }, (_, index) => [`f${index}`, index]),
  );
  const line = terminalDropLine({
    update_id: 6,
    message: { ...many, chat: { id: 42, type: "private" } },
  });
  const keys = JSON.parse(line.slice(line.indexOf("["))) as string[];

  assert.equal(keys.length, 12);
  assert.deepEqual(keys, [...keys].sort());
});
