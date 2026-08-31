/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node's test runner owns registrations and reset test doubles intentionally preserve asynchronous production boundaries. */
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

type ChatStatus = {
  status: string;
  sessionId?: string;
  turnId?: string;
  [key: string]: unknown;
};
type RunStatusModule = {
  setChatStatus: (chatKey: string, status: ChatStatus) => void;
  getChatStatus: (chatKey: string) => ChatStatus;
};
type QueueUpdate = {
  update_id: number;
  message?: Record<string, unknown>;
};
type QueueItem = {
  version: number;
  updateId: number;
  enqueuedAt?: number;
  update?: QueueUpdate;
  legacyText?: string;
};
type QueueDocument = {
  version: number;
  queues: Record<string, QueueItem[]>;
};
type ResetIntent = {
  chatKey: string;
  target:
    | { sessionId: string }
    | { address: { chatId: string; messageThreadId?: number } };
};
type CompleteResetOptions = {
  clearQueue?: boolean;
  clearQueueImpl?: () => Promise<unknown>;
};
type PerformResetOptions = {
  clearQueue?: boolean;
  persistIntentImpl?: () => Promise<unknown>;
  requestResetImpl?: (intent: ResetIntent) => Promise<unknown>;
  completeStateImpl?: () => Promise<unknown>;
  clearIntentImpl?: () => Promise<unknown>;
  logImpl?: (line: string) => void;
};
type ReconcileResetOptions = {
  requestResetImpl?: (intent: ResetIntent) => Promise<unknown>;
  logImpl?: (line: string) => void;
};
type DrainOptions = {
  deliverImpl: (update: QueueUpdate) => Promise<boolean>;
  settleUntil: Map<string, number>;
  inFlight: Map<string, unknown>;
};
type WriteQueueOptions = {
  nonce?: string;
  renameImpl?: () => Promise<unknown>;
};
type PollModule = {
  clearPrivateResetIntent: (chatKey: string) => Promise<void>;
  completeScopedResetState: (
    chatKey: string,
    options: CompleteResetOptions,
  ) => Promise<void>;
  drainReadyQueueHeads: (options: DrainOptions) => Promise<number>;
  loadPrivateResetIntents: () => Promise<ResetIntent[]>;
  loadQueue: () => Promise<QueueDocument>;
  performScopedReset: (
    chatKey: string,
    target: ResetIntent["target"],
    options?: PerformResetOptions,
  ) => Promise<void>;
  persistPrivateResetIntent: (chatKey: string) => Promise<void>;
  reconcileScopedResetIntents: (
    options?: ReconcileResetOptions,
  ) => Promise<number>;
  writeQueueAtomic: (
    queue: QueueDocument | Record<string, string[]>,
    options?: WriteQueueOptions,
  ) => Promise<void>;
};

const dataDir = mkdtempSync(join(tmpdir(), "iva-scoped-reset-"));
process.env.ASSISTANT_DATA_DIR = dataDir;
process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN = "test-secret";

const [pollModule, runStatusModule] = (await Promise.all([
  import(`./telegram-poll.mjs?reset-test=${Date.now()}`),
  import(`#lib/run-status.ts?reset-test=${Date.now()}`),
])) as [unknown, unknown];
const {
  clearPrivateResetIntent,
  completeScopedResetState,
  drainReadyQueueHeads,
  loadPrivateResetIntents,
  loadQueue,
  performScopedReset,
  persistPrivateResetIntent,
  reconcileScopedResetIntents,
  writeQueueAtomic,
} = pollModule as PollModule;
const status = runStatusModule as RunStatusModule;

test("private reset clears only the target chat status and queue", async () => {
  status.setChatStatus("chat-a:", {
    status: "running",
    sessionId: "session-a",
    turnId: "turn-a",
  });
  status.setChatStatus("chat-b:7", {
    status: "running",
    sessionId: "session-b",
    turnId: "turn-b",
  });
  writeFileSync(
    join(dataDir, "telegram-queue.json"),
    JSON.stringify({
      "chat-a:": ["discard me"],
      "chat-b:7": ["keep me"],
    }),
  );

  await completeScopedResetState("chat-a:", { clearQueue: true });

  const reset = status.getChatStatus("chat-a:");
  assert.equal(reset.status, "idle");
  assert.equal(reset.sessionId, undefined);
  assert.equal(reset.turnId, undefined);

  const untouched = status.getChatStatus("chat-b:7");
  assert.equal(untouched.status, "running");
  assert.equal(untouched.sessionId, "session-b");

  const queue = JSON.parse(
    readFileSync(join(dataDir, "telegram-queue.json"), "utf8"),
  ) as unknown as QueueDocument;
  assert.equal(queue.version, 1);
  assert.deepEqual(Object.keys(queue.queues), ["chat-b:7"]);
  assert.equal(queue.queues["chat-b:7"][0].legacyText, "keep me");
});

test("group reset preserves the shared topic queue", async () => {
  status.setChatStatus("group:7", {
    status: "running",
    sessionId: "session-a",
  });
  writeFileSync(
    join(dataDir, "telegram-queue.json"),
    JSON.stringify({
      "group:7": ["future standalone conversation"],
      "other:9": ["keep me too"],
    }),
  );

  await completeScopedResetState("group:7", {
    clearQueue: false,
  });

  assert.equal(status.getChatStatus("group:7").status, "idle");
  assert.deepEqual(
    JSON.parse(
      readFileSync(join(dataDir, "telegram-queue.json"), "utf8"),
    ) as unknown,
    {
      "group:7": ["future standalone conversation"],
      "other:9": ["keep me too"],
    },
  );
});

test("failed private queue cleanup does not expose an idle tombstone", async () => {
  status.setChatStatus("chat-c:", {
    status: "running",
    sessionId: "session-c",
  });

  await assert.rejects(
    completeScopedResetState("chat-c:", {
      clearQueue: true,
      clearQueueImpl: async () => {
        throw new Error("disk full");
      },
    }),
    /disk full/,
  );
  assert.equal(status.getChatStatus("chat-c:").status, "running");
  assert.equal(status.getChatStatus("chat-c:").sessionId, "session-c");
});

test("private reset intent is durable before remote reset and clears after local cleanup", async () => {
  const events: string[] = [];
  await performScopedReset(
    "chat-intent:",
    { sessionId: "session-105" },
    {
      clearQueue: true,
      persistIntentImpl: async () => events.push("intent"),
      requestResetImpl: async () => events.push("remote"),
      completeStateImpl: async () => events.push("cleanup"),
      clearIntentImpl: async () => events.push("clear-intent"),
    },
  );

  assert.deepEqual(events, ["intent", "remote", "cleanup", "clear-intent"]);
});

test("startup reconciliation prevents a remotely reset private queue from draining after a crash", async () => {
  const key = "106:";
  status.setChatStatus(key, {
    status: "running",
    sessionId: "old-session",
    turnId: "old-turn",
  });
  await writeQueueAtomic({
    version: 1,
    queues: {
      [key]: [
        {
          version: 1,
          updateId: 901,
          enqueuedAt: 1,
          update: {
            update_id: 901,
            message: {
              message_id: 901,
              date: 1,
              chat: { id: 901, type: "private" },
              from: { id: 42, is_bot: false, first_name: "Owner" },
              text: "must be discarded after reset",
            },
          },
        },
      ],
    },
  });
  await persistPrivateResetIntent(key);

  const remoteRetries: ResetIntent[] = [];
  await reconcileScopedResetIntents({
    requestResetImpl: async (intent) => {
      remoteRetries.push(intent);
    },
  });

  assert.deepEqual(remoteRetries, [
    { chatKey: key, target: { address: { chatId: "106" } } },
  ]);
  assert.deepEqual(await loadPrivateResetIntents(), []);
  assert.equal(status.getChatStatus(key).status, "idle");
  assert.equal(status.getChatStatus(key).sessionId, undefined);
  assert.equal((await loadQueue()).queues[key], undefined);

  const delivered: number[] = [];
  assert.equal(
    await drainReadyQueueHeads({
      deliverImpl: async (update) => {
        delivered.push(update.update_id);
        return true;
      },
      settleUntil: new Map(),
      inFlight: new Map(),
    }),
    0,
  );
  assert.deepEqual(
    delivered,
    [],
    "startup must reconcile reset intent before any old head can drain",
  );
});

test("failed reset reconciliation keeps its durable intent for the next startup", async () => {
  const key = "107:";
  await persistPrivateResetIntent(key);

  await assert.rejects(
    reconcileScopedResetIntents({
      requestResetImpl: async () => {
        throw new Error("eve unavailable");
      },
    }),
    /eve unavailable/,
  );

  assert.deepEqual(
    (await loadPrivateResetIntents()).map(({ chatKey }) => chatKey),
    [key],
  );
  await clearPrivateResetIntent(key);
});

test("a corrupt reset intent does not block a valid chat", async (t) => {
  const key = "108:";
  await persistPrivateResetIntent(key);
  const intentDirectory = join(dataDir, "telegram-reset-intents");
  const corruptFile = join(intentDirectory, "corrupt.json");
  writeFileSync(corruptFile, "{broken", "utf8");
  t.after(() => rmSync(corruptFile, { force: true }));
  t.mock.method(console, "error", () => {});

  const requested: ResetIntent[] = [];
  await reconcileScopedResetIntents({
    requestResetImpl: async (intent) => {
      requested.push(intent);
    },
  });

  assert.deepEqual(requested, [
    { chatKey: key, target: { address: { chatId: "108" } } },
  ]);
  assert.equal(readdirSync(intentDirectory).includes("corrupt.json"), true);
  assert.deepEqual(await loadPrivateResetIntents(), []);
});

test("queue rename failure keeps the previous whole queue byte-for-byte", async () => {
  const queueFile = join(dataDir, "telegram-queue.json");
  const original = JSON.stringify({
    "chat-d:": ["keep this"],
    "chat-e:": ["keep this too"],
  });
  writeFileSync(queueFile, original);

  await assert.rejects(
    writeQueueAtomic(
      { "chat-d:": ["replacement"] },
      {
        nonce: "fault-injection",
        renameImpl: async () => {
          throw new Error("injected rename failure");
        },
      },
    ),
    /injected rename failure/,
  );

  assert.equal(readFileSync(queueFile, "utf8"), original);
  assert.equal(
    readdirSync(dataDir).some((name) =>
      name.startsWith("telegram-queue.json.tmp-"),
    ),
    false,
  );
});

test("corrupt queue is not treated as empty during reset", async () => {
  const queueFile = join(dataDir, "telegram-queue.json");
  const corrupt = '{"chat-f:": ["unfinished"';
  writeFileSync(queueFile, corrupt);
  status.setChatStatus("chat-f:", {
    status: "running",
    sessionId: "session-f",
  });

  await assert.rejects(
    completeScopedResetState("chat-f:", { clearQueue: true }),
    SyntaxError,
  );

  assert.equal(readFileSync(queueFile, "utf8"), corrupt);
  assert.equal(status.getChatStatus("chat-f:").status, "running");
});

test("ordinary queue load quarantines corrupt bytes and continues", async () => {
  const queueFile = join(dataDir, "telegram-queue.json");
  const corrupt = '{"chat-g:": ["unfinished"';
  writeFileSync(queueFile, corrupt);

  assert.deepEqual(await loadQueue(), { version: 1, queues: {} });

  const backups = readdirSync(dataDir).filter((name) =>
    name.startsWith("telegram-queue.json.corrupt-"),
  );
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(dataDir, backups[0]), "utf8"), corrupt);
});

test("reset tombstone retires the legacy routing field", async () => {
  const legacyField = "continuationToken";
  status.setChatStatus("7091451031:", {
    status: "running",
    sessionId: "session-old",
    [legacyField]: "legacy-value",
  });
  await completeScopedResetState("7091451031:", {
    clearQueue: true,
  });

  const tombstone = status.getChatStatus("7091451031:");
  assert.equal(tombstone.status, "idle");
  assert.equal(Object.hasOwn(tombstone, legacyField), false);
});

test("a durable reset intent reconstructs its Telegram address", async () => {
  const key = "429888768:";
  await persistPrivateResetIntent(key);

  const requested: ResetIntent[] = [];
  await reconcileScopedResetIntents({
    requestResetImpl: async (request) => {
      requested.push(request);
    },
  });

  assert.deepEqual(requested, [
    { chatKey: key, target: { address: { chatId: "429888768" } } },
  ]);
  assert.equal(status.getChatStatus(key).status, "idle");
});

test("/new sends the exact stored session target", async () => {
  const requested: ResetIntent[] = [];
  await performScopedReset(
    "7091451031:",
    { sessionId: "session-1" },
    {
      clearQueue: true,
      persistIntentImpl: async () => {},
      requestResetImpl: async (request) => requested.push(request),
      completeStateImpl: async () => {},
      clearIntentImpl: async () => {},
    },
  );

  assert.deepEqual(requested, [
    {
      chatKey: "7091451031:",
      target: { sessionId: "session-1" },
    },
  ]);
});

test("reset outcome is logged for session and address targets", async () => {
  const lines: string[] = [];
  await performScopedReset(
    "7091451031:",
    { sessionId: "session-1" },
    {
      clearQueue: true,
      persistIntentImpl: async () => {},
      requestResetImpl: async () => ({ ok: true, status: "no_active_session" }),
      completeStateImpl: async () => {},
      clearIntentImpl: async () => {},
      logImpl: (line) => lines.push(line),
    },
  );

  assert.deepEqual(lines, [
    "reset for chat 7091451031: -> no_active_session (session-1)",
  ]);

  const successes: string[] = [];
  await performScopedReset(
    "7091451031:",
    { address: { chatId: "7091451031" } },
    {
      persistIntentImpl: async () => {},
      requestResetImpl: async () => ({
        ok: true,
        status: "reset",
        previousSessionId: "wrun_1",
      }),
      completeStateImpl: async () => {},
      clearIntentImpl: async () => {},
      logImpl: (line) => successes.push(line),
    },
  );
  assert.deepEqual(successes, [
    "reset for chat 7091451031: -> reset (address)",
  ]);
});

test("intent reconciliation logs its reset outcome too", async () => {
  await persistPrivateResetIntent("429888768:");
  const lines: string[] = [];
  await reconcileScopedResetIntents({
    requestResetImpl: async () => ({ ok: true, status: "reset" }),
    logImpl: (line) => lines.push(line),
  });

  assert.deepEqual(lines, ["reset for chat 429888768: -> reset (address)"]);
});
