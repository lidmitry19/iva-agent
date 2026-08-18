import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Статус живёт в run-status, а язык — в settings: оба читают ASSISTANT_DATA_DIR
// на загрузке модуля, поэтому окружение выставляем до импорта.
const dataDir = mkdtempSync(join(tmpdir(), "iva-telegram-status-"));
process.env.ASSISTANT_DATA_DIR = dataDir;
process.env.AGENT_LANGUAGE = "en";
const load = <T>(name: string): Promise<T> =>
  import(
    pathToFileURL(fileURLToPath(new URL(name, import.meta.url))).href
  ) as Promise<T>;
const status = await load<typeof import("./telegram-status-message.ts")>(
  "./telegram-status-message.ts",
);
const runStatus =
  await load<typeof import("./run-status.ts")>("./run-status.ts");

type Call = { method: string; body: Record<string, unknown> };

function handle(
  reply: (
    call: Call,
    index: number,
  ) => { ok: boolean; body: unknown } = () => ({
    ok: true,
    body: { result: { message_id: 500 } },
  }),
) {
  const calls: Call[] = [];
  return {
    calls,
    tg: {
      chatId: "77",
      request: (method: string, body?: Record<string, unknown>) => {
        const call = { method, body: body ?? {} };
        calls.push(call);
        return Promise.resolve(reply(call, calls.length - 1));
      },
    },
  };
}

await test("статус уходит анимированным эмодзи и несёт кнопку «Стоп»", async () => {
  const { calls, tg } = handle();

  assert.equal(await status.sendWorkingStatus(tg), 500);
  assert.equal(calls.length, 1);
  assert.ok(Array.isArray(calls[0].body.entities));
  assert.deepEqual(calls[0].body.reply_markup, status.stopReplyMarkup());
});

await test("отказ Telegram на custom_emoji роняет лоадер на ⏳ навсегда", async () => {
  const rejectCustom = handle((call, index) =>
    index === 0 && call.body.entities
      ? { ok: false, body: { description: "Bad Request: custom emoji" } }
      : { ok: true, body: { result: { message_id: 501 } } },
  );

  assert.equal(await status.sendWorkingStatus(rejectCustom.tg), 501);
  assert.equal(rejectCustom.calls.length, 2);
  assert.match(String(rejectCustom.calls[1].body.text), /^⏳ /u);

  const next = handle();
  assert.equal(
    await status.sendWorkingStatus(next.tg, { canStop: false }),
    500,
  );
  assert.equal(next.calls.length, 1);
  assert.equal(next.calls[0].body.entities, undefined);
  assert.equal(next.calls[0].body.reply_markup, undefined);
});

await test("вне лички кнопку «Стоп» не показываем и не дорисовываем", async () => {
  // Колбэк кнопки принимают только в личке, поэтому в группе её быть не должно:
  // нажатие всё равно вернуло бы «откройте личный чат».
  const supergroup = handle();
  const groupTg = { ...supergroup.tg, chatId: "-1001", chatType: "supergroup" };

  assert.equal(await status.sendWorkingStatus(groupTg), 500);
  assert.equal(supergroup.calls.length, 1);
  assert.equal(supergroup.calls[0].body.reply_markup, undefined);

  await status.enableWorkingStatusStop(groupTg, 500);
  assert.equal(supergroup.calls.length, 1);

  // Проактивный ход приходит без типа чата — тогда решает знак chat_id.
  const proactive = handle();
  await status.sendWorkingStatus({ ...proactive.tg, chatId: "-1001" });
  await status.enableWorkingStatusStop(
    { ...proactive.tg, chatId: "-1001" },
    500,
  );
  assert.equal(proactive.calls.length, 1);
  assert.equal(proactive.calls[0].body.reply_markup, undefined);

  // В личке правило прежнее: кнопка и в статусе, и в дорисовке.
  const direct = handle();
  assert.equal(await status.sendWorkingStatus(direct.tg), 500);
  assert.deepEqual(direct.calls[0].body.reply_markup, status.stopReplyMarkup());
  await status.enableWorkingStatusStop(direct.tg, 500);
  assert.equal(direct.calls[1].method, "editMessageReplyMarkup");
  assert.deepEqual(direct.calls[1].body.reply_markup, status.stopReplyMarkup());
});

await test("обычный финал гасит статус и убирает сообщение, повтор — no-op", async () => {
  const key = runStatus.chatKeyOf("77", undefined);
  runStatus.setChatStatus(key, {
    status: "running",
    sessionId: "s-1",
    statusMessageId: 500,
  });
  const { calls, tg } = handle();
  const channel = { continuationToken: "telegram:77", telegram: tg };

  assert.equal(
    await status.finishTelegramStatus(channel, "s-1", "completed"),
    true,
  );
  assert.deepEqual(
    calls.map((call) => call.method),
    ["deleteMessage"],
  );
  assert.equal(runStatus.getChatStatus(key)?.status, "idle");

  // Позднее терминальное событие того же хода не должно трогать чужой статус.
  assert.equal(
    await status.finishTelegramStatus(channel, "s-1", "completed"),
    false,
  );
  assert.equal(calls.length, 1);
});

await test("отмена переписывает статус и оставляет пометку прерванного хода", async () => {
  const key = runStatus.chatKeyOf("77", undefined);
  runStatus.setChatStatus(key, {
    status: "running",
    sessionId: "s-2",
    statusMessageId: 501,
  });
  const { calls, tg } = handle();

  assert.equal(
    await status.finishTelegramStatus(
      { continuationToken: "telegram:77", telegram: tg },
      "s-2",
      "cancelled",
    ),
    true,
  );
  assert.equal(calls[0].method, "editMessageText");
  assert.match(String(calls[0].body.text), /^⏹ Stopped/u);
  assert.equal(runStatus.getChatStatus(key)?.wasCancelled, true);
});

await test("сбой Bot API на уборке не рушит терминал хода", async () => {
  const key = runStatus.chatKeyOf("77", undefined);
  runStatus.setChatStatus(key, {
    status: "running",
    sessionId: "s-3",
    statusMessageId: 502,
  });
  const failing = {
    chatId: "77",
    request: () => Promise.reject(new Error("Telegram 502")),
  };

  assert.equal(
    await status.finishTelegramStatus(
      { continuationToken: "telegram:77", telegram: failing },
      "s-3",
      "failed",
    ),
    true,
  );
  assert.equal(runStatus.getChatStatus(key)?.status, "idle");
});
