// Якоря контракта журнала хода: схема строки, тумблер содержимого, чистка по имени
// файла, безопасность записи и события швов. Свойства (обрезка, невалидный вход,
// произвольные наборы файлов) живут в trace.property.test.ts.
import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Писатель читает каталог данных на каждой записи, а settings.ts фиксирует свой путь
// на загрузке — окружение выставляем ДО импорта модуля.
const root = mkdtempSync(join(tmpdir(), "iva-trace-"));
process.env.ASSISTANT_DATA_DIR = join(root, "data");
process.env.ASSISTANT_TIMEZONE = "UTC";
process.env.TELEGRAM_ALLOWED_USER_IDS = "42";
mkdirSync(process.env.ASSISTANT_DATA_DIR, { recursive: true });
const trace = await import("./trace.ts");

process.on("exit", () => rmSync(root, { recursive: true, force: true }));

// Свежий каталог данных под тест, которому нужен свой файл журнала.

function last(
  events: Record<string, unknown>[],
  match: (event: Record<string, unknown>) => boolean,
): Record<string, unknown> | undefined {
  return events.filter(match).at(-1);
}

function world(): string {
  const dir = mkdtempSync(join(root, "world-"));
  mkdirSync(join(dir, "data"), { recursive: true });
  return join(dir, "data");
}

const DATA = process.env.ASSISTANT_DATA_DIR;

function lines(dir: string, day: string): Record<string, unknown>[] {
  return readFileSync(trace.traceFilePath(day, dir), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const AT = new Date("2026-08-17T10:20:30.000Z");

void test("путь журнала следует ASSISTANT_DATA_DIR", () => {
  assert.equal(
    trace.traceFilePath("2026-08-17"),
    join(root, "data", "trace", "2026-08-17.jsonl"),
  );
  assert.equal(
    trace.traceFilePath("2026-08-17", "/tmp/iva"),
    "/tmp/iva/trace/2026-08-17.jsonl",
  );
});

void test("событие ложится одной строкой фиксированной схемы", () => {
  const dir = world();
  trace.appendTrace(
    {
      kind: "inbound",
      name: "received",
      turn: "tg:77:5",
      session: "wrun_1",
      source: "telegram",
      data: { chatId: "77" },
      content: { text: "привет" },
    },
    { dir, now: AT, captureContent: true },
  );
  trace.appendTrace(
    { kind: "eve", name: "turn.started", turn: "turn_1" },
    { dir, now: AT, captureContent: true },
  );

  const raw = readFileSync(trace.traceFilePath("2026-08-17", dir), "utf8");
  assert.equal(raw.split("\n").length, 3); // две записи и завершающий перевод строки
  const [first, second] = lines(dir, "2026-08-17");
  assert.deepEqual(Object.keys(first), [
    "ts",
    "turn",
    "session",
    "source",
    "kind",
    "name",
    "data",
  ]);
  assert.deepEqual(first, {
    ts: "2026-08-17T10:20:30.000Z",
    turn: "tg:77:5",
    session: "wrun_1",
    source: "telegram",
    kind: "inbound",
    name: "received",
    data: { chatId: "77", textChars: 6, text: "привет" },
  });
  // Пустые поля заголовка остаются пустыми строками, а не исчезают: схема одна на все события.
  assert.deepEqual(second, {
    ts: "2026-08-17T10:20:30.000Z",
    turn: "turn_1",
    session: "",
    source: "",
    kind: "eve",
    name: "turn.started",
    data: {},
  });
});

void test("captureContent=false оставляет имена, тайминги и размеры", () => {
  const dir = world();
  const input = {
    kind: "outbox",
    name: "delivered",
    turn: "turn_1",
    data: { ok: true, ms: 12 },
    content: { text: "секретный ответ" },
  };
  trace.appendTrace(input, { dir, now: AT, captureContent: false });

  const [event] = lines(dir, "2026-08-17");
  assert.deepEqual(event.data, { ok: true, ms: 12, textChars: 15 });
  assert.equal(JSON.stringify(event).includes("секретный"), false);
});

void test("тумблер captureContent читается из data/settings.json", () => {
  const dir = world();
  // Значение по умолчанию — включено: файла настроек ещё нет.
  assert.equal(trace.captureContentEnabled(), true);

  writeFileSync(
    join(DATA, "settings.json"),
    JSON.stringify({ captureContent: false }),
  );
  assert.equal(trace.captureContentEnabled(), false);
  trace.appendTrace(
    { kind: "eve", name: "message.completed", content: { message: "текст" } },
    { dir, now: AT },
  );
  assert.deepEqual(lines(dir, "2026-08-17")[0].data, { messageChars: 5 });

  writeFileSync(
    join(DATA, "settings.json"),
    JSON.stringify({ captureContent: true }),
  );
  assert.equal(trace.captureContentEnabled(), true);
});

void test("журнал не создаёт каталог данных там, где его нет", () => {
  const absent = join(root, "no-install", "data");
  trace.appendTrace({ kind: "eve", name: "turn.started" }, { dir: absent });
  assert.equal(existsSync(absent), false);
});

void test("ошибка записи не выходит наружу", (t) => {
  const dir = world();
  // Каталог журнала занят файлом: mkdir и append обязаны провалиться.
  writeFileSync(trace.traceDir(dir), "not a directory");
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map((part) => String(part)).join(" "));
  };
  t.after(() => {
    console.error = original;
  });

  assert.doesNotThrow(() =>
    trace.appendTrace({ kind: "eve", name: "turn.started" }, { dir, now: AT }),
  );
  assert.equal(errors.length, 1);
  assert.ok(errors[0].startsWith("[trace] событие не записано:"));
});

void test("чистка удаляет файлы старше 14 дней ПО ИМЕНИ и не трогает чужие", () => {
  const dir = world();
  mkdirSync(trace.traceDir(dir), { recursive: true });
  const names = [
    "2026-08-17.jsonl", // сегодня
    "2026-08-04.jsonl", // граница окна: 14-й день
    "2026-08-03.jsonl", // на день старше окна
    "2026-07-01.jsonl",
    "notes.md",
    "2026-08-05.jsonl.bak",
    "old.jsonl",
  ];
  for (const name of names) writeFileSync(join(trace.traceDir(dir), name), "");

  const removed = trace.pruneTrace(dir, "2026-08-17");

  assert.deepEqual(removed.sort(), ["2026-07-01.jsonl", "2026-08-03.jsonl"]);
  assert.deepEqual(
    readdirSync(trace.traceDir(dir)).sort(),
    [
      "2026-08-04.jsonl",
      "2026-08-17.jsonl",
      "2026-08-05.jsonl.bak",
      "notes.md",
      "old.jsonl",
    ].sort(),
  );
});

void test("новый день чистит журнал сам, один раз", () => {
  const dir = world();
  mkdirSync(trace.traceDir(dir), { recursive: true });
  writeFileSync(join(trace.traceDir(dir), "2026-07-01.jsonl"), "");

  trace.appendTrace({ kind: "eve", name: "turn.started" }, { dir, now: AT });

  assert.deepEqual(readdirSync(trace.traceDir(dir)).sort(), [
    "2026-08-17.jsonl",
  ]);
});

void test("ход связывается с апдейтом через ключ чата", () => {
  const message = {
    chat: { id: "77", type: "private" },
    from: { id: "42" },
    messageId: "5",
    text: "привет",
    caption: "",
  };

  trace.traceInboundReceived(message);
  trace.traceInboundOutcome(message, "77", ["[reply]"], true);
  trace.traceTurnBound("77", "wrun_1", "turn_3");

  const events = lines(DATA, trace.traceDay());
  const received = events.find((event) => event.name === "received");
  const accepted = events.find((event) => event.name === "accepted");
  const bound = events.find((event) => event.name === "bound");
  assert.deepEqual(received?.data, {
    chatId: "77",
    chatType: "private",
    messageId: "5",
    userId: "42",
    allowlisted: true,
    textChars: 6,
    text: "привет",
  });
  assert.equal(received?.turn, "tg:77:5");
  assert.equal(accepted?.turn, "tg:77:5");
  assert.deepEqual(bound, {
    ts: bound?.ts,
    turn: "turn_3",
    session: "wrun_1",
    source: "telegram",
    kind: "turn",
    name: "bound",
    data: { chatKey: "77", updateKey: "tg:77:5" },
  });
});

void test("отброшенный апдейт ход не помечает", () => {
  const message = {
    chat: { id: "78", type: "group" },
    from: { id: "9" },
    messageId: "6",
    text: "чужое",
    caption: "",
  };
  trace.traceInboundOutcome(message, "78", undefined, false);
  trace.traceTurnBound("78", "wrun_2", "turn_4");

  const events = lines(DATA, trace.traceDay());
  const dropped = events.find((event) => event.name === "dropped");
  const bound = last(events, (event) => event.name === "bound");
  assert.equal(dropped?.turn, "tg:78:6");
  assert.deepEqual(dropped?.data, {
    chatId: "78",
    chatKey: "78",
    parts: 0,
    partChars: [],
    context: [],
  });
  assert.deepEqual(bound?.data, { chatKey: "78", updateKey: "" });
});

void test("мост пишет свои события тем же ключом апдейта", () => {
  const update = {
    update_id: 900,
    message: { message_id: 5, chat: { id: 77 } },
  };
  trace.traceBridgeAdmission(update, "own");
  trace.traceBridgeDelivery(update, true, 42);
  trace.traceBridgeAdmission(
    {
      update_id: 901,
      callback_query: { id: "cb1", message: { chat: { id: 77 } } },
    },
    "terminal-drop",
  );

  const events = lines(DATA, trace.traceDay());
  const admitted = events.find(
    (event) => event.kind === "bridge" && event.name === "admitted",
  );
  const delivered = events.find((event) => event.name === "delivered");
  const callback = last(
    events,
    (event) => event.kind === "bridge" && event.name === "admitted",
  );
  assert.equal(admitted?.turn, "tg:77:5");
  assert.equal(admitted?.source, "bridge");
  assert.deepEqual(admitted?.data, {
    updateId: 900,
    chatId: 77,
    messageId: "5",
    kind: "message",
    decision: "own",
  });
  assert.deepEqual(delivered?.data, {
    updateId: 900,
    chatId: 77,
    messageId: "5",
    kind: "message",
    accepted: true,
    ms: 42,
  });
  assert.equal(callback?.turn, "tg:77:cb:cb1");
});

void test("вердикты гейтов и Стоп пишутся своими событиями", () => {
  trace.traceInboundGate(
    "telegram",
    {
      blocked: true,
      reason: "Prompt injection",
      flags: ["overrides=3"],
      truncatedChars: 4,
    },
    120,
  );
  trace.traceOutboundGate(
    "turn_3",
    "wrun_1",
    false,
    [{ type: "api_key", name: "openai" }],
    55,
  );
  trace.traceOutboxResult(
    "turn_3",
    "wrun_1",
    "ответ",
    { ok: true, delivered: 1, fellBack: false, error: "" },
    17,
  );
  trace.traceStop("77", "turn_3", "requested");

  const events = lines(DATA, trace.traceDay());
  const inbound = last(
    events,
    (event) => event.kind === "gate" && event.name === "inbound",
  );
  const outbound = last(
    events,
    (event) => event.kind === "gate" && event.name === "outbound",
  );
  const outbox = last(events, (event) => event.kind === "outbox");
  const stop = last(events, (event) => event.kind === "stop");
  assert.deepEqual(inbound?.data, {
    surface: "telegram",
    blocked: true,
    reason: "Prompt injection",
    flags: ["overrides=3"],
    truncatedChars: 4,
    chars: 120,
  });
  assert.deepEqual(outbound?.data, {
    clean: false,
    findings: ["api_key:openai"],
    chars: 55,
  });
  assert.equal(outbox?.name, "delivered");
  assert.deepEqual(outbox?.data, {
    ok: true,
    delivered: 1,
    fellBack: false,
    error: "",
    ms: 17,
    textChars: 5,
    text: "ответ",
  });
  assert.equal(stop?.turn, "turn_3");
  assert.deepEqual(stop?.data, { chatKey: "77", outcome: "requested" });
});
