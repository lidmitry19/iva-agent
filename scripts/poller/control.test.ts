/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node owns test registration; async doubles preserve the I/O boundary. */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

type Event = string | [string, string, number | undefined, string | undefined];
type CaptureMessage = { message_id?: number };
type CaptureState = { flow: unknown; awaitText?: unknown };
type CancelCall = {
  url: string;
  secret: string;
  sessionId: string;
  turnId?: string;
};
type ControlUpdate = Record<string, unknown>;
type ControlModule = {
  handleAwaitNonText: (
    message: CaptureMessage & Record<string, unknown>,
    pending: CaptureState,
    io: Record<string, unknown>,
  ) => Promise<boolean>;
  handleControl: (
    update: ControlUpdate,
    deps?: {
      replyImpl?: (
        chatId: number | undefined,
        text: string,
      ) => Promise<{ message_id: number } | null>;
      ackImpl?: (id: string, text?: string) => Promise<unknown>;
      cancelImpl?: (input: CancelCall) => Promise<unknown>;
    },
  ) => Promise<boolean>;
  OUT_OF_BAND_COMMANDS: string[];
};
type RunStatusModule = {
  setChatStatus: (chatKey: string, patch: Record<string, unknown>) => void;
};
type FlowState = Record<string, unknown>;
type WizardsModule = {
  flows: {
    start: (
      chatId: number,
      userId: string,
      flow: string,
      extra: Record<string, unknown>,
    ) => FlowState;
    get: (chatId: number, userId: string) => FlowState | null;
  };
};

// Мост читает run-status с диска и берёт allowlist из окружения на импорте, поэтому
// и то и другое ставим ДО загрузки модуля, в свежей data-директории.
const dataDir = mkdtempSync(join(tmpdir(), "iva-control-"));
process.env.ASSISTANT_DATA_DIR = dataDir;
process.env.TELEGRAM_BOT_TOKEN = "424242:test-token";
process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN = "test-secret";
process.env.TELEGRAM_ALLOWED_USER_IDS = "42";
process.env.IVA_PORT = "8723";
delete process.env.ASSISTANT_HOST;
delete process.env.AGENT_LANGUAGE; // без настроек язык моста — ru

const [controlModule, runStatusModule, wizardsModule] = (await Promise.all([
  import(`./control.ts?control-test=${Date.now()}`),
  import(`#lib/run-status.ts?control-test=${Date.now()}`),
  import("./wizards.ts"),
])) as [unknown, unknown, unknown];
const { handleAwaitNonText, handleControl, OUT_OF_BAND_COMMANDS } =
  controlModule as ControlModule;
const status = runStatusModule as RunStatusModule;
const { flows } = wizardsModule as WizardsModule;

const CANCEL_ROUTE = "http://127.0.0.1:8723/eve/v1/telegram/cancel";
const trustedFrom = { id: 42, is_bot: false };
const chat = { id: 7, type: "private" };

function runningTurn(overrides: Record<string, unknown> = {}) {
  status.setChatStatus("7:", {
    status: "running",
    sessionId: "session-1",
    turnId: "turn-1",
    ...overrides,
  });
}

function stopButton(): ControlUpdate {
  return {
    update_id: 5,
    callback_query: {
      id: "cq-5",
      from: trustedFrom,
      message: { message_id: 4, date: 1, chat },
      data: "iva_cancel",
    },
  };
}

function stopCommand(): ControlUpdate {
  return {
    update_id: 6,
    message: {
      message_id: 6,
      date: 1,
      chat,
      from: trustedFrom,
      text: "/stop",
    },
  };
}

function recordingDeps() {
  const cancels: CancelCall[] = [];
  const acks: Array<[string, string | undefined]> = [];
  const replies: Array<[number | undefined, string]> = [];
  return {
    cancels,
    acks,
    replies,
    deps: {
      cancelImpl: async (input: CancelCall) => {
        cancels.push(input);
        return { ok: true, status: "accepted" };
      },
      ackImpl: async (id: string, text?: string) => {
        acks.push([id, text]);
        return { ok: true, result: true };
      },
      replyImpl: async (chatId: number | undefined, text: string) => {
        replies.push([chatId, text]);
        return { message_id: replies.length };
      },
    },
  };
}

test("secret document capture deletes before download and never reaches Eve", async () => {
  const events: Event[] = [];
  const io = {
    deleteSecret: async () => {
      events.push("delete");
      return true;
    },
    download: async () => {
      events.push("download");
      return "client secret";
    },
    deliver: async (
      text: string,
      message: CaptureMessage,
      state: CaptureState,
    ) => {
      events.push([
        "deliver",
        text,
        message.message_id,
        (state.awaitText as { kind?: string } | undefined)?.kind,
      ]);
    },
    reply: async () => assert.fail("must not reply after a successful capture"),
  };

  const consumed = await handleAwaitNonText(
    {
      message_id: 7,
      chat: { id: 42 },
      document: { file_id: "file", file_size: 100 },
    },
    { flow: "menu", awaitText: { kind: "gws_client_secret", file: true } },
    io,
  );

  assert.equal(consumed, true);
  assert.deepEqual(events, [
    "delete",
    "download",
    ["deliver", "client secret", 7, "gws_client_secret"],
  ]);
});

test("failed deletion consumes a secret document without downloading it", async () => {
  const events: Event[] = [];
  const consumed = await handleAwaitNonText(
    {
      message_id: 8,
      chat: { id: 42 },
      document: { file_id: "file", file_size: 100 },
    },
    { flow: "menu", awaitText: { kind: "gws_client_secret", file: true } },
    {
      deleteSecret: async () => {
        events.push("delete");
        return false;
      },
      download: async () => assert.fail("must not download a visible secret"),
      deliver: async () => assert.fail("must not deliver a visible secret"),
      reply: async () => assert.fail("deleteSecret owns the failure warning"),
    },
  );

  assert.equal(consumed, true);
  assert.deepEqual(events, ["delete"]);
});

test("the ⏹ Stop button cancels through the channel route, never through Eve", async () => {
  runningTurn();
  const { cancels, acks, replies, deps } = recordingDeps();

  const consumed = await handleControl(stopButton(), deps);

  assert.equal(consumed, true); // тап съеден мостом и в eve не уходит
  assert.deepEqual(cancels, [
    {
      url: CANCEL_ROUTE,
      secret: "test-secret",
      sessionId: "session-1",
      turnId: "turn-1",
    },
  ]);
  assert.deepEqual(acks, [["cq-5", "Останавливаю…"]]);
  assert.deepEqual(replies, []);
});

test("/stop takes the same door and stays silent while the status message speaks", async () => {
  runningTurn({ sessionId: "session-2", turnId: "turn-2" });
  const { cancels, replies, deps } = recordingDeps();

  const consumed = await handleControl(stopCommand(), deps);

  assert.equal(consumed, true);
  assert.deepEqual(cancels, [
    {
      url: CANCEL_ROUTE,
      secret: "test-secret",
      sessionId: "session-2",
      turnId: "turn-2",
    },
  ]);
  // Подтверждение — переписанное «Работаю…», а не второе сообщение в чате.
  assert.deepEqual(replies, []);
});

test("Stop on an idle chat explains itself and never calls cancel", async () => {
  status.setChatStatus("7:", {
    status: "idle",
    sessionId: null,
    turnId: null,
  });
  const { cancels, acks, replies, deps } = recordingDeps();

  assert.equal(await handleControl(stopButton(), deps), true);
  assert.equal(await handleControl(stopCommand(), deps), true);

  assert.deepEqual(cancels, []);
  assert.deepEqual(acks, [["cq-5", "Сейчас ничего не выполняется."]]);
  assert.deepEqual(replies, [[7, "Сейчас ничего не выполняется."]]);
});

test("an early running status without a session is not cancellable", async () => {
  status.setChatStatus("7:", {
    status: "running",
    sessionId: null,
    turnId: null,
    ingressId: "ingress-1",
  });
  const { cancels, acks, deps } = recordingDeps();

  assert.equal(await handleControl(stopButton(), deps), true);

  assert.deepEqual(cancels, []);
  assert.deepEqual(acks, [["cq-5", "Сейчас ничего не выполняется."]]);
});

test("an untrusted tap on someone else's Stop button is swallowed", async () => {
  runningTurn();
  const { cancels, acks, deps } = recordingDeps();
  const update = stopButton();
  (update.callback_query as Record<string, unknown>).from = {
    id: 999,
    is_bot: false,
  };

  assert.equal(await handleControl(update, deps), true);
  assert.deepEqual(cancels, []);
  // Спиннер кнопки гасим, но ход чужого пользователя не трогаем и ничего не объясняем.
  assert.deepEqual(acks, [["cq-5", undefined]]);
});

test("a failed cancel request is explained instead of pretending it stopped", async () => {
  runningTurn();
  const acks: Array<[string, string | undefined]> = [];
  const consumed = await handleControl(stopButton(), {
    cancelImpl: async () => {
      throw new Error("connect ECONNREFUSED");
    },
    ackImpl: async (id: string, text?: string) => {
      acks.push([id, text]);
      return { ok: true, result: true };
    },
  });

  assert.equal(consumed, true);
  assert.deepEqual(acks, [
    ["cq-5", "Не вышло — возможно, ход уже завершился."],
  ]);
});

test("repeated taps after the turn is gone stay harmless", async () => {
  runningTurn();
  const { cancels, acks, deps } = recordingDeps();

  await handleControl(stopButton(), deps);
  status.setChatStatus("7:", { status: "idle", sessionId: null, turnId: null });
  await handleControl(stopButton(), deps);
  await handleControl(stopButton(), deps);

  assert.equal(cancels.length, 1);
  assert.deepEqual(acks.slice(1), [
    ["cq-5", "Сейчас ничего не выполняется."],
    ["cq-5", "Сейчас ничего не выполняется."],
  ]);
});

test("/start is answered by the bridge and never becomes a model turn", async () => {
  const { replies, deps } = recordingDeps();
  const consumed = await handleControl(
    {
      update_id: 7,
      message: {
        message_id: 7,
        date: 1,
        chat,
        from: trustedFrom,
        text: "/start",
      },
    },
    deps,
  );

  assert.equal(consumed, true);
  assert.equal(replies.length, 1);
  assert.equal(replies[0][0], 7);
  assert.match(replies[0][1], /Iva/u);
  assert.match(replies[0][1], /\/help/u);
  assert.match(replies[0][1], /\/menu/u);
  assert.ok(OUT_OF_BAND_COMMANDS.includes("/start"));
});

test("/start from an untrusted user is not answered by the bridge", async () => {
  const { replies, deps } = recordingDeps();
  const consumed = await handleControl(
    {
      update_id: 8,
      message: {
        message_id: 8,
        date: 1,
        chat,
        from: { id: 999, is_bot: false },
        text: "/start",
      },
    },
    deps,
  );

  assert.equal(consumed, false); // дальше его молча уронит allowlist входного пайплайна
  assert.deepEqual(replies, []);
});

test("non-private group-safe commands leave stale pending flows unchanged", async () => {
  const previousFetch = globalThis.fetch;
  const botApiMethods: string[] = [];
  globalThis.fetch = async (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    botApiMethods.push(url.split("/").at(-1) ?? "");
    return Response.json({ ok: true, result: { message_id: 99 } });
  };
  try {
    for (const chatType of ["group", "supergroup", "channel", undefined]) {
      const state = flows.start(7, "42", "menu", {
        screen: "srch",
        msgId: 701,
        awaitText: {
          kind: "apikey",
          secret: true,
          data: { provider: "synthetic" },
        },
      });
      const before = structuredClone(state);
      const { replies, deps } = recordingDeps();

      const consumed = await handleControl(
        {
          update_id: 701,
          message: {
            message_id: 701,
            date: 1,
            chat: { id: 7, type: chatType },
            from: trustedFrom,
            text: "/help",
          },
        },
        deps,
      );

      assert.equal(consumed, true, String(chatType));
      assert.deepEqual(flows.get(7, "42"), before, String(chatType));
      assert.equal(replies.length, 1, String(chatType));
    }
    assert.deepEqual(botApiMethods, []);
  } finally {
    const stale = flows.get(7, "42");
    if (stale) {
      stale.createdAt = 0;
      flows.get(7, "42");
    }
    globalThis.fetch = previousFetch;
  }
});

test("settings commands reject every non-private chat before state or Bot API effects", async () => {
  const previousFetch = globalThis.fetch;
  const botApiMethods: string[] = [];
  globalThis.fetch = async (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    botApiMethods.push(url.split("/").at(-1) ?? "");
    return new Response(
      JSON.stringify({ ok: true, result: { message_id: 99 } }),
      { headers: { "content-type": "application/json" } },
    );
  };
  try {
    for (const command of ["/menu", "/model", "/think"]) {
      for (const chatType of ["group", "supergroup", "channel", undefined]) {
        const { replies, deps } = recordingDeps();
        const consumed = await handleControl(
          {
            update_id: 800,
            message: {
              message_id: 800,
              date: 1,
              chat: { id: -800, type: chatType },
              from: trustedFrom,
              text: command,
            },
          },
          deps,
        );

        assert.equal(consumed, true, `${command}:${String(chatType)}`);
        assert.equal(replies.length, 1, `${command}:${String(chatType)}`);
        assert.match(
          replies[0][1],
          /private|личн/u,
          `${command}:${String(chatType)}`,
        );
      }
    }
    assert.deepEqual(botApiMethods, []);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("local callbacks reject non-private chats before cancellation or dispatch", async () => {
  for (const data of [
    "iva_cancel",
    "iva_update:do",
    "iva_model:keep",
    "iva_think:keep",
    "iva_menu:r:o",
  ]) {
    for (const chatType of ["group", "supergroup", "channel", undefined]) {
      runningTurn();
      const { cancels, acks, deps } = recordingDeps();
      const update = stopButton();
      const callback = update.callback_query as Record<string, unknown>;
      callback.data = data;
      callback.message = {
        message_id: 4,
        date: 1,
        chat: { id: 7, type: chatType },
      };

      const label = `${data}:${String(chatType)}`;
      assert.equal(await handleControl(update, deps), true, label);
      assert.deepEqual(cancels, [], label);
      assert.equal(acks.length, 1, label);
      assert.match(acks[0][1] ?? "", /private|личн/u, label);
    }
  }
});

test("a non-private rejection does not reveal controls to an untrusted user", async () => {
  runningTurn();
  const { cancels, acks, deps } = recordingDeps();
  const update = stopButton();
  const callback = update.callback_query as Record<string, unknown>;
  callback.from = { id: 999, is_bot: false };
  callback.message = {
    message_id: 4,
    date: 1,
    chat: { id: 7, type: "group" },
  };

  assert.equal(await handleControl(update, deps), true);
  assert.deepEqual(cancels, []);
  assert.deepEqual(acks, [["cq-5", undefined]]);
});

test("malformed update callback is not claimed as a local control", async () => {
  const methods: string[] = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    methods.push(url.split("/").at(-1) ?? "");
    return new Response(JSON.stringify({ ok: true, result: {} }), {
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const consumed = await handleControl({
      update_id: 9,
      callback_query: {
        id: "cq-invalid-update",
        from: trustedFrom,
        message: { message_id: 9, date: 1, chat },
        data: "iva_update:do-now",
      },
    });

    assert.equal(consumed, false);
    assert.deepEqual(methods, []);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("a falsey local reply does not authorize offset acknowledgement", async () => {
  const consumed = await handleControl(
    {
      update_id: 10,
      message: {
        message_id: 10,
        date: 1,
        chat,
        from: trustedFrom,
        text: "/help",
      },
    },
    { replyImpl: async () => null },
  );

  assert.equal(consumed, false);
});

test("a falsey callback ack does not claim a local control", async () => {
  status.setChatStatus("7:", {
    status: "idle",
    sessionId: null,
    turnId: null,
  });

  const consumed = await handleControl(stopButton(), {
    ackImpl: async () => null,
  });

  assert.equal(consumed, false);
});

test("a false callback ack result does not claim a local control", async () => {
  status.setChatStatus("7:", {
    status: "idle",
    sessionId: null,
    turnId: null,
  });

  const consumed = await handleControl(stopButton(), {
    ackImpl: async () => ({ ok: true, result: false }),
  });

  assert.equal(consumed, false);
});

for (const [command, updateId] of [
  ["/model", 21],
  ["/think", 22],
] as const) {
  test(`${command} is retained when its initial Bot API screen fails`, async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ ok: false, result: false }), {
        headers: { "content-type": "application/json" },
      });
    try {
      const consumed = await handleControl({
        update_id: updateId,
        message: {
          message_id: updateId,
          date: 1,
          chat,
          from: trustedFrom,
          text: command,
        },
      });

      assert.equal(consumed, false);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
}

test("model keep callback is retained when only spinner ack succeeds", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ok: true, result: { message_id: 71 } }), {
      headers: { "content-type": "application/json" },
    });
  try {
    assert.equal(
      await handleControl({
        update_id: 11,
        message: {
          message_id: 11,
          date: 1,
          chat: { id: 71, type: "private" },
          from: trustedFrom,
          text: "/model",
        },
      }),
      true,
    );

    const methods: string[] = [];
    globalThis.fetch = async (input) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      methods.push(url.split("/").at(-1) ?? "");
      return new Response(
        JSON.stringify(
          url.endsWith("/answerCallbackQuery")
            ? { ok: true, result: true }
            : { ok: false, result: false },
        ),
        { headers: { "content-type": "application/json" } },
      );
    };

    const callback = {
      update_id: 12,
      callback_query: {
        id: "cq-model-keep",
        from: trustedFrom,
        message: {
          message_id: 71,
          date: 1,
          chat: { id: 71, type: "private" },
        },
        data: "iva_model:keep",
      },
    };
    const consumed = await handleControl(callback);

    assert.equal(consumed, false);
    assert.deepEqual(methods, [
      "answerCallbackQuery",
      "editMessageText",
      "sendMessage",
    ]);

    globalThis.fetch = async (input) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      methods.push(url.split("/").at(-1) ?? "");
      return new Response(
        JSON.stringify(
          url.endsWith("/answerCallbackQuery")
            ? { ok: true, result: true }
            : { ok: true, result: { message_id: 71 } },
        ),
        { headers: { "content-type": "application/json" } },
      );
    };

    assert.equal(await handleControl(callback), true);
    assert.deepEqual(methods.slice(3), [
      "answerCallbackQuery",
      "editMessageText",
    ]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
