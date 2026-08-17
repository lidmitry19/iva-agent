// Хук журнала (agent/hooks/trace.ts) на фейковых событиях eve: что попадает в строку, что
// отбрасывается и как выглядит ход субагента. Проверка идёт по РЕАЛЬНЫМ формам событий из
// node_modules/eve/dist/src/protocol/message.d.ts.
//
// Тест лежит в agent/lib, а не рядом с хуком: eve считает хуком КАЖДЫЙ файл в agent/hooks,
// и «trace.test» — нелегальное имя хука, из-за которого падает вся discovery (`eve build`:
// «Hook path segment "trace.test" is not a legal hook name»). Поэтому во всех слотах
// authored-дерева (hooks, channels, instructions, schedules, tools) тестов нет вовсе.
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

const root = mkdtempSync(join(tmpdir(), "iva-trace-hook-"));
process.env.ASSISTANT_DATA_DIR = join(root, "data");
process.env.ASSISTANT_TIMEZONE = "UTC";
mkdirSync(process.env.ASSISTANT_DATA_DIR, { recursive: true });
const DATA = process.env.ASSISTANT_DATA_DIR;
// Хук импортирует "../lib/trace.js" (в проде специфкатор переписывает eve build) —
// голому node это переписывает тот же резолвер, что и другим тестам authored-дерева.
await import("../../scripts/lib/ts-esm-hooks.ts");
const { traceDay, traceFilePath } = await import("./trace.ts");
const hook = (await import("../hooks/trace.ts")).default;

process.on("exit", () => rmSync(root, { recursive: true, force: true }));

type Handler = (event: unknown, ctx: unknown) => unknown;
const handle = hook.events?.["*"] as unknown as Handler;

const ctx = {
  session: { id: "wrun_7", turn: { id: "turn_3", sequence: 3 }, auth: {} },
  channel: { kind: "telegram" },
};

function feed(event: unknown, context: unknown = ctx): void {
  handle(event, context);
}

function journal(): Record<string, unknown>[] {
  return readFileSync(traceFilePath(traceDay(), DATA), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function only(name: string): Record<string, unknown>[] {
  return journal().filter((event) => event.name === name);
}

void test("шаг модели, вызов тула и ответ ложатся отдельными событиями", () => {
  feed({ type: "turn.started", data: { sequence: 1, turnId: "turn_3" } });
  feed({
    type: "step.started",
    data: { sequence: 2, stepIndex: 0, turnId: "turn_3" },
  });
  feed({
    type: "actions.requested",
    data: {
      sequence: 3,
      stepIndex: 0,
      turnId: "turn_3",
      actions: [
        {
          kind: "tool-call",
          callId: "call_1",
          toolName: "memory_search",
          input: { query: "что я говорил про отпуск" },
        },
      ],
    },
  });
  feed({
    type: "action.result",
    data: {
      sequence: 4,
      stepIndex: 0,
      turnId: "turn_3",
      status: "completed",
      result: {
        callId: "call_1",
        kind: "tool-result",
        toolName: "memory_search",
        output: "3 карточки",
      },
    },
  });
  feed({
    type: "step.completed",
    data: {
      sequence: 5,
      stepIndex: 1,
      turnId: "turn_3",
      finishReason: "stop",
      usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 10 },
    },
  });
  feed({
    type: "message.completed",
    data: {
      sequence: 6,
      stepIndex: 1,
      turnId: "turn_3",
      finishReason: "stop",
      message: "в июле",
    },
  });
  feed({ type: "turn.completed", data: { sequence: 7, turnId: "turn_3" } });

  const events = journal();
  assert.deepEqual(
    events.map((event) => event.name),
    [
      "turn.started",
      "step.started",
      "actions.requested",
      "action.result",
      "step.completed",
      "message.completed",
      "turn.completed",
    ],
  );
  for (const event of events) {
    assert.equal(event.kind, "eve");
    assert.equal(event.turn, "turn_3");
    assert.equal(event.session, "wrun_7");
    assert.equal(event.source, "telegram");
  }

  const [requested] = only("actions.requested");
  assert.deepEqual(requested.data, {
    sequence: 3,
    stepIndex: 0,
    actions: [
      { kind: "tool-call", callId: "call_1", toolName: "memory_search" },
    ],
    args: [{ query: "что я говорил про отпуск" }],
  });
});

void test("расход и содержимое шага пишутся с потолком", () => {
  const [step] = only("step.completed");
  assert.deepEqual(step.data, {
    sequence: 5,
    stepIndex: 1,
    finishReason: "stop",
    usage: { in: 120, out: 30, cacheRead: 10, cacheWrite: 0 },
  });
  const [message] = only("message.completed");
  assert.deepEqual(message.data, {
    sequence: 6,
    stepIndex: 1,
    finishReason: "stop",
    messageChars: 6,
    message: "в июле",
  });
  const [result] = only("action.result");
  assert.equal(
    (result.data as Record<string, unknown>).toolName,
    "memory_search",
  );
  assert.equal((result.data as Record<string, unknown>).status, "completed");
});

void test("дельта-события в журнал не попадают", () => {
  const before = journal().length;
  feed({
    type: "message.appended",
    data: { messageDelta: "в", messageSoFar: "в", turnId: "turn_3" },
  });
  feed({
    type: "reasoning.appended",
    data: { reasoningDelta: "…", reasoningSoFar: "…", turnId: "turn_3" },
  });
  feed({
    type: "action.partial",
    data: { result: { output: "частично" }, turnId: "turn_3" },
  });
  assert.equal(journal().length, before);
});

void test("шаги субагента пишутся ключом хода родителя с суффиксом", () => {
  feed({
    type: "subagent.event",
    data: {
      callId: "call_9",
      subagentName: "planner",
      event: {
        type: "step.completed",
        data: {
          sequence: 1,
          stepIndex: 0,
          turnId: "turn_0",
          finishReason: "stop",
          usage: { inputTokens: 40, outputTokens: 5 },
        },
      },
    },
  });

  const nested = journal().at(-1);
  assert.equal(nested?.name, "step.completed");
  assert.equal(nested?.turn, "turn_3#planner");
  assert.equal(nested?.session, "wrun_7");
  assert.deepEqual(nested?.data, {
    sequence: 1,
    stepIndex: 0,
    finishReason: "stop",
    usage: { in: 40, out: 5, cacheRead: 0, cacheWrite: 0 },
    subagent: "planner",
    parentCallId: "call_9",
  });
});

void test("ход без turnId в событии берёт ход из сессии", () => {
  feed({ type: "session.waiting", data: { sessionId: "wrun_7" } });
  const waiting = journal().at(-1);
  assert.equal(waiting?.turn, "turn_3");

  feed(
    { type: "session.started", data: {} },
    {
      session: { id: "wrun_8", turn: { id: "", sequence: 0 }, auth: {} },
      channel: {},
    },
  );
  const started = journal().at(-1);
  assert.equal(started?.turn, "turn_0");
  assert.equal(started?.source, "unknown");
});

void test("сбой хода пишется кодом в data и текстом в содержимом", () => {
  feed({
    type: "turn.failed",
    data: {
      sequence: 9,
      turnId: "turn_3",
      code: "MODEL_ERROR",
      message: "provider refused",
      details: { status: 503 },
    },
  });
  const failed = journal().at(-1);
  assert.deepEqual(failed?.data, {
    sequence: 9,
    code: "MODEL_ERROR",
    messageChars: 16,
    message: "provider refused",
    details: { status: 503 },
  });
});

void test("captureContent=false оставляет от события имена и размеры", (t) => {
  const settings = join(DATA, "settings.json");
  writeFileSync(settings, JSON.stringify({ captureContent: false }));
  t.after(() => rmSync(settings, { force: true }));

  feed({
    type: "action.result",
    data: {
      sequence: 10,
      stepIndex: 2,
      turnId: "turn_3",
      status: "completed",
      result: {
        callId: "call_2",
        kind: "tool-result",
        toolName: "bash",
        output: "секрет в выводе",
      },
    },
  });

  const event = journal().at(-1);
  assert.deepEqual(event?.data, {
    sequence: 10,
    stepIndex: 2,
    status: "completed",
    callId: "call_2",
    toolName: "bash",
  });
  assert.equal(JSON.stringify(event).includes("секрет"), false);
});

void test("хук не роняет ход ни на каком событии", (t) => {
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => errors.push(args);
  t.after(() => {
    console.error = original;
  });
  const before = journal().length;

  const hostile: [string, unknown, unknown][] = [
    // Чужой геттер в payload.
    [
      "throwing getter",
      {
        type: "action.result",
        data: {
          get result(): unknown {
            throw new Error("getter");
          },
        },
      },
      ctx,
    ],
    // subagent.event без вложенного события.
    [
      "subagent without event",
      { type: "subagent.event", data: { callId: "c", subagentName: "p" } },
      ctx,
    ],
    ["subagent without data", { type: "subagent.event" }, ctx],
    // Контекст без канала и без сессии.
    [
      "context without channel",
      { type: "turn.started", data: { turnId: "turn_1" } },
      { session: { id: "wrun_1", turn: { id: "turn_1" } } },
    ],
    ["empty context", { type: "turn.started", data: { turnId: "turn_1" } }, {}],
    // Событие без данных вовсе.
    ["event without data", { type: "turn.completed" }, ctx],
    ["no event at all", null, ctx],
  ];

  for (const [label, event, context] of hostile) {
    assert.doesNotThrow(() => feed(event, context), label);
  }
  // Что смогло — записано, что не смогло — объяснено в логе службы, ход жив.
  assert.ok(journal().length >= before);
  for (const line of journal()) assert.equal(typeof line.kind, "string");
});
