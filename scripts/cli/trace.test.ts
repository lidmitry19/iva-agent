/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// `iva trace` against a temp installation and a fixture journal written from the contract
// (docs/trace.md), not from the writer: the CLI is the journal's second reader, and a test
// that generated its input with the writer would only prove the two agree with themselves.
//
// The fixture carries one of everything a reader has to survive: a chat turn with a tool
// call and a subagent, a night Rollup with no turn key, an inbound gate that blocked, a
// failed turn, a Bridge callback orphan, a line that is not JSON, and two days.
//
// HOW TO REPLAY A PROPERTY FAILURE: fast-check prints
// `Property failed after N tests { seed: -1234567, path: "3:1", endOnFailure: true }`.
// Pass it as the second argument — fc.assert(prop, { seed: -1234567, path: "3:1" }) — and
// the run repeats byte for byte, shrinking included.
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import fc from "fast-check";
import { pluginRoot, writePluginsState } from "#lib/plugin-store.ts";
import { createCliRuntime } from "./runtime.ts";
import {
  clock,
  createTraceCommands,
  createTraceTail,
  formatEventLine,
  formatTurn,
  formatTurnList,
  parseTraceLine,
  readServicePort,
  selectTurn,
  sshHost,
  stitchTurns,
  turnOutcome,
  type StitchedTurn,
  type TraceLine,
} from "./trace.ts";

const NO_COLOR = { g: "", y: "", r: "", c: "", b: "", d: "", x: "" };
const DAY_ONE = "2026-08-16";
const DAY_TWO = "2026-08-17";

const worlds: string[] = [];
after(() => {
  for (const dir of worlds) rmSync(dir, { recursive: true, force: true });
});

function world(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `iva-cli-trace-${prefix}-`));
  worlds.push(dir);
  return dir;
}

function write(root: string, path: string, contents: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

type Event = {
  readonly ts: string;
  readonly turn?: string;
  readonly session?: string;
  readonly source: string;
  readonly kind: string;
  readonly name: string;
  readonly data: Record<string, unknown>;
};

/** One line of the journal, in the field order the contract fixes. */
function line(event: Event): string {
  return JSON.stringify({
    ts: event.ts,
    turn: event.turn ?? "",
    session: event.session ?? "",
    source: event.source,
    kind: event.kind,
    name: event.name,
    data: event.data,
  });
}

// --- The fixture journal ---

/** A chat turn: Bridge → inbound pipeline → Gate → context → model, a tool, a subagent,
 *  the outbound Gate and the Outbox. Timestamps are distinct so order is never ambiguous. */
const CHAT_TURN: readonly Event[] = [
  {
    ts: "2026-08-17T09:32:05.100Z",
    turn: "tg:100:9241",
    source: "bridge",
    kind: "bridge",
    name: "admitted",
    data: {
      updateId: 7,
      chatId: "100",
      messageId: "9241",
      kind: "message",
      decision: "owned",
    },
  },
  {
    ts: "2026-08-17T09:32:05.200Z",
    turn: "tg:100:9241",
    source: "telegram",
    kind: "inbound",
    name: "received",
    data: {
      chatId: "100",
      chatType: "private",
      messageId: "9241",
      userId: "55",
      allowlisted: true,
      textChars: 29,
      text: "что там по погоде\nв Ташкенте?",
    },
  },
  {
    ts: "2026-08-17T09:32:05.260Z",
    turn: "tg:100:9241",
    source: "telegram",
    kind: "gate",
    name: "inbound",
    data: {
      surface: "telegram",
      blocked: false,
      reason: "",
      flags: [],
      truncatedChars: 0,
      chars: 29,
    },
  },
  {
    ts: "2026-08-17T09:32:05.300Z",
    turn: "tg:100:9241",
    source: "telegram",
    kind: "inbound",
    name: "accepted",
    data: {
      chatId: "100",
      chatKey: "tg:100",
      parts: 1,
      partChars: [15],
      context: ["reply to: привет"],
    },
  },
  {
    ts: "2026-08-17T09:32:05.400Z",
    turn: "turn_12",
    session: "sess-a",
    source: "telegram",
    kind: "turn",
    name: "bound",
    data: { chatKey: "tg:100", updateKey: "tg:100:9241" },
  },
  {
    ts: "2026-08-17T09:32:05.420Z",
    turn: "turn_12",
    session: "sess-a",
    source: "telegram",
    kind: "context",
    name: "parts",
    data: {
      core: 1180,
      persona: 740,
      moc: 9021,
      daily: 4021,
      unit: "bytes",
      approximate: true,
    },
  },
  {
    ts: "2026-08-17T09:32:05.500Z",
    turn: "turn_12",
    session: "sess-a",
    source: "telegram",
    kind: "eve",
    name: "turn.started",
    data: { sequence: 1, sessionId: "sess-a" },
  },
  {
    ts: "2026-08-17T09:32:05.600Z",
    turn: "turn_12",
    session: "sess-a",
    source: "telegram",
    kind: "eve",
    name: "step.started",
    data: { sequence: 1, stepIndex: 0 },
  },
  {
    ts: "2026-08-17T09:32:07.900Z",
    turn: "turn_12",
    session: "sess-a",
    source: "telegram",
    kind: "eve",
    name: "actions.requested",
    data: {
      sequence: 1,
      stepIndex: 0,
      actions: [{ kind: "tool", callId: "c1", toolName: "memory_search" }],
      args: [{ query: "погода Ташкент" }],
    },
  },
  {
    ts: "2026-08-17T09:32:08.400Z",
    turn: "turn_12",
    session: "sess-a",
    source: "telegram",
    kind: "eve",
    name: "action.result",
    data: {
      sequence: 1,
      stepIndex: 0,
      status: "ok",
      callId: "c1",
      toolName: "memory_search",
      isError: false,
      resultChars: 51,
      result: "cards/weather.md — прогноз на неделю",
    },
  },
  {
    ts: "2026-08-17T09:32:08.500Z",
    turn: "turn_12",
    session: "sess-a",
    source: "telegram",
    kind: "eve",
    name: "step.completed",
    data: {
      sequence: 1,
      stepIndex: 0,
      finishReason: "tool-calls",
      usage: { in: 12040, out: 320, cacheRead: 9000, cacheWrite: 0 },
    },
  },
  {
    ts: "2026-08-17T09:32:08.600Z",
    turn: "turn_12",
    session: "sess-a",
    source: "telegram",
    kind: "eve",
    name: "subagent.started",
    data: { callId: "c2", subagentName: "planner", childSessionId: "sess-p" },
  },
  {
    ts: "2026-08-17T09:32:08.700Z",
    turn: "turn_12#planner",
    session: "sess-a",
    source: "telegram",
    kind: "eve",
    name: "step.started",
    data: {
      sequence: 1,
      stepIndex: 0,
      subagent: "planner",
      parentCallId: "c2",
    },
  },
  {
    ts: "2026-08-17T09:32:11.200Z",
    turn: "turn_12#planner",
    session: "sess-a",
    source: "telegram",
    kind: "eve",
    name: "step.completed",
    data: {
      sequence: 1,
      stepIndex: 0,
      finishReason: "stop",
      usage: { in: 3000, out: 210, cacheRead: 0, cacheWrite: 0 },
      subagent: "planner",
      parentCallId: "c2",
    },
  },
  {
    ts: "2026-08-17T09:32:11.400Z",
    turn: "turn_12",
    session: "sess-a",
    source: "telegram",
    kind: "eve",
    name: "subagent.completed",
    data: {
      callId: "c2",
      subagentName: "planner",
      outputChars: 41,
      output: "1. прочитать карточку\n2. ответить коротко",
    },
  },
  {
    ts: "2026-08-17T09:32:18.100Z",
    turn: "turn_12",
    session: "sess-a",
    source: "telegram",
    kind: "eve",
    name: "message.completed",
    data: {
      sequence: 1,
      stepIndex: 1,
      finishReason: "stop",
      messageChars: 36,
      message: "В Ташкенте +34, ясно. Вечером ветер.",
    },
  },
  {
    ts: "2026-08-17T09:32:18.300Z",
    turn: "turn_12",
    session: "sess-a",
    source: "telegram",
    kind: "eve",
    name: "turn.completed",
    data: { sequence: 1 },
  },
  {
    ts: "2026-08-17T09:32:18.600Z",
    turn: "turn_12",
    session: "sess-a",
    source: "telegram",
    kind: "gate",
    name: "outbound",
    data: {
      clean: true,
      findings: [],
      chars: 36,
      textChars: 36,
      text: "В Ташкенте +34, ясно. Вечером ветер.",
    },
  },
  {
    ts: "2026-08-17T09:32:19.100Z",
    turn: "turn_12",
    session: "sess-a",
    source: "telegram",
    kind: "outbox",
    name: "delivered",
    data: {
      ok: true,
      delivered: 1,
      fellBack: false,
      error: "",
      chars: 36,
      ms: 480,
    },
  },
];

/** A night turn: no turn key on the seams, a session that stitches it together. */
const NIGHT_TURN: readonly Event[] = [
  {
    ts: "2026-08-17T03:00:00.100Z",
    turn: "turn_1",
    session: "sess-night",
    source: "unknown",
    kind: "eve",
    name: "turn.started",
    data: { sequence: 1, sessionId: "sess-night" },
  },
  {
    ts: "2026-08-17T03:00:01.000Z",
    session: "sess-night",
    source: "rollup",
    kind: "gate",
    name: "outbound",
    data: {
      clean: true,
      findings: [],
      chars: 900,
      textChars: 900,
      text: "Ночная сводка: 4 карточки",
    },
  },
  {
    ts: "2026-08-17T03:00:01.400Z",
    session: "sess-night",
    source: "rollup",
    kind: "outbox",
    name: "delivered",
    data: {
      ok: true,
      delivered: 1,
      fellBack: false,
      error: "",
      chars: 900,
      ms: 320,
    },
  },
];

/** Yesterday: a gate that blocked, a turn that failed, and a callback orphan. */
const DAY_BEFORE: readonly Event[] = [
  {
    ts: "2026-08-16T18:10:00.000Z",
    turn: "tg:100:8000",
    source: "bridge",
    kind: "bridge",
    name: "admitted",
    data: {
      updateId: 3,
      chatId: "100",
      messageId: "8000",
      kind: "message",
      decision: "owned",
    },
  },
  {
    ts: "2026-08-16T18:10:00.100Z",
    turn: "tg:100:8000",
    source: "telegram",
    kind: "gate",
    name: "inbound",
    data: {
      surface: "telegram",
      blocked: true,
      reason: "prompt-injection",
      flags: ["ignore-instructions"],
      truncatedChars: 0,
      chars: 900,
    },
  },
  {
    ts: "2026-08-16T18:10:00.200Z",
    turn: "tg:100:8000",
    source: "telegram",
    kind: "inbound",
    name: "dropped",
    data: { chatId: "100", chatKey: "tg:100", parts: 0, partChars: [] },
  },
  {
    ts: "2026-08-16T20:00:00.000Z",
    turn: "turn_9",
    session: "sess-z",
    source: "telegram",
    kind: "turn",
    name: "bound",
    data: { chatKey: "tg:100", updateKey: "tg:100:8100" },
  },
  {
    ts: "2026-08-16T20:00:01.000Z",
    turn: "turn_9",
    session: "sess-z",
    source: "telegram",
    kind: "eve",
    name: "turn.failed",
    data: {
      sequence: 1,
      stepIndex: 0,
      code: "model_error",
      messageChars: 35,
      message: "429 Too Many Requests from provider",
    },
  },
  {
    ts: "2026-08-16T21:00:00.000Z",
    turn: "tg:100:cb:77",
    source: "bridge",
    kind: "bridge",
    name: "admitted",
    data: { updateId: 4, chatId: "100", kind: "callback", decision: "owned" },
  },
];

/** An installation home with the fixture journal and a predictable timezone. */
function home(prefix = "home"): string {
  const root = world(prefix);
  write(
    root,
    ".env",
    "ASSISTANT_DATA_DIR=data\nASSISTANT_TIMEZONE=UTC\nASSISTANT_HOST=http://127.0.0.1:8723\n",
  );
  // Write order is what a file records, so the night turn sits where it was written —
  // out of `ts` order, exactly like two processes appending to one file.
  const today = [
    ...CHAT_TURN.slice(0, 4),
    ...NIGHT_TURN,
    ...CHAT_TURN.slice(4),
  ].map(line);
  write(
    root,
    `data/trace/${DAY_TWO}.jsonl`,
    // The malformed line sits in the middle: a broken line must not spoil its neighbours.
    `${today.slice(0, 6).join("\n")}\nnot json at all\n{"ts": broken\n${today.slice(6).join("\n")}\n`,
  );
  write(
    root,
    `data/trace/${DAY_ONE}.jsonl`,
    `${DAY_BEFORE.map(line).join("\n")}\n`,
  );
  // A file whose name is not a day is not ours to read (retention leaves it alone too).
  write(root, "data/trace/README.txt", "not a journal\n");
  return root;
}

type Events = Array<[string, string]>;

function commands(
  root: string,
  extra: Parameters<typeof createTraceCommands>[1] = {},
) {
  const events: Events = [];
  const printed: string[] = [];
  const base = createCliRuntime(root);
  const { cmdTrace } = createTraceCommands(
    {
      ...base,
      C: NO_COLOR,
      ok: (m) => events.push(["ok", m]),
      warn: (m) => events.push(["warn", m]),
      bad: (m) => events.push(["bad", m]),
      step: (m) => events.push(["step", m]),
    },
    {
      translate: (en) => en,
      log: (...args: unknown[]) => printed.push(args.map(String).join(" ")),
      hostName: () => "c1",
      userName: () => "shima",
      follow: () => Promise.resolve(),
      ...extra,
    },
  );
  return { cmdTrace, events, printed, out: () => printed.join("\n") };
}

function messages(events: Events, kind?: string): string {
  return events
    .filter(([type]) => !kind || type === kind)
    .map(([, message]) => message)
    .join("\n");
}

function fixtureLines(root: string): TraceLine[] {
  const text = readFileSync(join(root, `data/trace/${DAY_TWO}.jsonl`), "utf8");
  return text
    .split("\n")
    .map((raw, index) => parseTraceLine(raw, index))
    .filter((parsed): parsed is TraceLine => parsed !== null);
}

// --- show ---

test("show lists the last turns with source, steps, tools, duration and outcome", async () => {
  const { cmdTrace, printed } = commands(home());

  await cmdTrace(["show"]);

  const rows = printed.slice(1);
  assert.equal(rows.length, 5, printed.join("\n"));
  // Newest last: the owner reads a terminal from the bottom. The day is on every row —
  // fourteen days of nightly Rollups would otherwise all read `03:00:00`.
  assert.match(
    rows[0],
    /^08-16 18:10:00 {2}telegram {3}tg:100:8000 .*0 steps.*blocked$/u,
  );
  assert.match(rows[1], /^08-16 20:00:00 {2}telegram {3}turn_9 .*failed$/u);
  assert.match(rows[2], /^08-16 21:00:00 {2}bridge {5}tg:100:cb:77 .*open$/u);
  assert.match(rows[3], /^08-17 03:00:00 {2}rollup {5}turn_1 .*delivered$/u);
  assert.equal(
    rows[4],
    "08-17 09:32:05  telegram   turn_12               1 step    memory_search             14.0s    delivered",
  );
  assert.match(printed[0], /iva trace show <turn\|last>/u);
});

test("show stitches a chat turn from the update key, the turnId and the subagent suffix", async () => {
  const { cmdTrace, printed } = commands(home());

  await cmdTrace(["show", "turn_12"]);

  assert.equal(printed[0], "turn_12 · tg:100:9241 · telegram · session sess-a");
  assert.equal(
    printed[1],
    "09:32:05 → 09:32:19 · 14.0s · 1 step · tools memory_search · delivered",
  );
  const body = printed.slice(3);
  // Every event of the turn, in `ts` order, whatever order the file recorded them in.
  assert.deepEqual(
    body
      .filter((row) => /^ {2}\d\d:/u.test(row))
      .map((row) => row.slice(20).trim().split(/ {2,}/u)[0]),
    [
      "bridge.admitted",
      "inbound.received",
      "gate.inbound",
      "inbound.accepted",
      "turn.bound",
      "context.parts",
      "eve.turn.started",
      "eve.step.started",
      "eve.actions.requested",
      "eve.action.result",
      "eve.step.completed",
      "eve.subagent.started",
      "eve.step.started",
      "eve.step.completed",
      "eve.subagent.completed",
      "eve.message.completed",
      "eve.turn.completed",
      "gate.outbound",
      "outbox.delivered",
    ],
  );
  // The subagent's own steps are indented; the parent's are not.
  const nested = body.filter((row) =>
    /^ {2}\d\d:\S+ +\+?\S* {3}eve\.step\./u.test(row),
  );
  assert.equal(nested.length, 2, nested.join("\n"));
  // Gaps between steps, the tool it called, its arguments and its result, all capped.
  assert.match(
    body.join("\n"),
    /\+2\.3s +eve\.actions\.requested +actions=memory_search/u,
  );
  assert.match(
    body.join("\n"),
    /eve\.action\.result +toolName=memory_search status=ok/u,
  );
  assert.match(body.join("\n"), /args: \[\{"query":"погода Ташкент"\}\]/u);
  assert.match(
    body.join("\n"),
    /result: cards\/weather\.md — прогноз на неделю/u,
  );
  // Content is one line by default: a newline inside a message must not redraw the output.
  assert.match(body.join("\n"), /text: что там по погоде в Ташкенте\?/u);
});

test("show accepts an update key, a session id and last, and refuses an unknown turn", async () => {
  const root = home();
  const byUpdateKey = commands(root);
  await byUpdateKey.cmdTrace(["show", "tg:100:9241"]);
  assert.match(byUpdateKey.printed[0], /^turn_12 · tg:100:9241/u);

  const byLast = commands(root);
  await byLast.cmdTrace(["show", "last"]);
  assert.match(byLast.printed[0], /^turn_12 · tg:100:9241/u);

  const bySession = commands(root);
  await bySession.cmdTrace(["show", "sess-night"]);
  assert.equal(
    bySession.printed[0],
    "turn_1 · - · rollup · session sess-night",
  );
  assert.match(
    bySession.printed[1],
    /1\.3s · 0 steps · no tools · delivered$/u,
  );

  const missing = commands(root);
  await assert.rejects(
    () => missing.cmdTrace(["show", "turn_404"]),
    /no turn turn_404 in the journal — list them: iva trace show/u,
  );
});

test("show --full prints content uncut and --json prints the stored lines", async () => {
  const root = home();
  const full = commands(root);
  await full.cmdTrace(["show", "turn_12", "--full"]);
  assert.match(
    full.out(),
    /output: 1\. прочитать карточку\n +2\. ответить коротко/u,
  );

  const raw = commands(root);
  await raw.cmdTrace(["show", "turn_9", "--json"]);
  assert.deepEqual(raw.printed, [line(DAY_BEFORE[3]), line(DAY_BEFORE[4])]);
});

test("show reports an empty journal instead of failing", async () => {
  const root = world("empty");
  write(root, ".env", "ASSISTANT_DATA_DIR=data\nASSISTANT_TIMEZONE=UTC\n");
  const { cmdTrace, out } = commands(root);

  await cmdTrace(["show"]);

  assert.match(out(), /the journal is empty: .*data\/trace$/u);
});

test("a day file that cannot be read costs that day, not the command", async () => {
  const root = home("unreadable-day");
  // A directory where a day file belongs: the read fails, the other days still answer.
  mkdirSync(join(root, "data/trace/2026-08-15.jsonl"), { recursive: true });
  const { cmdTrace, printed } = commands(root);

  await cmdTrace(["show"]);

  assert.equal(printed.slice(1).length, 5);
});

test("help prints in both languages and an unknown subcommand names the three", async () => {
  const root = home();
  for (const args of [[], ["help"], ["--help"], ["-h"]]) {
    const { cmdTrace, out } = commands(root);
    await cmdTrace(args);
    assert.match(out(), /iva trace tail \[--since N\]/u, args.join(" "));
    assert.match(out(), /read the turn journal/u);
  }

  const russian = commands(root, { translate: (_en, ru) => ru });
  await russian.cmdTrace(["help"]);
  assert.match(russian.out(), /читать журнал хода/u);
  assert.match(russian.out(), /сначала N последних строк/u);

  const wrong = commands(root);
  await assert.rejects(
    () => wrong.cmdTrace(["taill"]),
    /unknown: iva trace taill — tail, show, open/u,
  );
});

test("tail and show say what to run when the agent tree is missing", async () => {
  const root = home();
  for (const args of [["tail"], ["show"]]) {
    const { cmdTrace } = commands(root, {
      loadTrace: () => Promise.reject(new Error("no such module")),
    });
    await assert.rejects(
      () => cmdTrace(args),
      /the journal cannot be read: the agent tree is missing — run: iva update/u,
      args.join(" "),
    );
  }
});

// --- tail ---

test("tail --since prints the last lines in write order, then only what arrives", async () => {
  const root = home();
  const path = join(root, `data/trace/${DAY_TWO}.jsonl`);
  const later = line({
    ts: "2026-08-17T09:40:00.000Z",
    turn: "turn_13",
    session: "sess-a",
    source: "telegram",
    kind: "eve",
    name: "step.completed",
    data: {
      sequence: 1,
      stepIndex: 0,
      finishReason: "stop",
      usage: { in: 900, out: 40 },
    },
  });
  const { cmdTrace, printed } = commands(root, {
    now: () => new Date("2026-08-17T12:00:00.000Z"),
    follow: (flush) => {
      writeFileSync(path, `${readFileSync(path, "utf8")}${later}\n`);
      flush();
      // A second poll with nothing new must print nothing at all.
      flush();
      return Promise.resolve();
    },
  });

  await cmdTrace(["tail", "--since", "2"]);

  assert.deepEqual(printed, [
    "09:32:18  turn_12         gate.outbound             clean=true chars=36  text: В Ташкенте +34, ясно. Вечером ветер.",
    "09:32:19  turn_12         outbox.delivered          ok=true chars=36 480ms",
    "09:40:00  turn_13         eve.step.completed        tok=900/40 finishReason=stop",
  ]);
});

test("tail without --since starts at the end of the file", async () => {
  const { cmdTrace, printed } = commands(home(), {
    now: () => new Date("2026-08-17T12:00:00.000Z"),
  });

  await cmdTrace(["tail"]);

  assert.deepEqual(printed, []);
});

test("tail waits on a journal that does not exist yet and says so", async () => {
  const root = world("no-journal");
  write(root, ".env", "ASSISTANT_DATA_DIR=data\nASSISTANT_TIMEZONE=UTC\n");
  const { cmdTrace, events, printed } = commands(root, {
    now: () => new Date("2026-08-17T12:00:00.000Z"),
  });

  await cmdTrace(["tail", "--since=5"]);

  assert.match(
    messages(events, "warn"),
    /no journal yet: .*data\/trace — it appears with the first turn/u,
  );
  assert.deepEqual(printed, []);
});

test("Ctrl-C ends the default tail loop and takes its handler with it", async () => {
  const root = home("interrupt");
  const path = join(root, `data/trace/${DAY_TWO}.jsonl`);
  const before = process.listenerCount("SIGINT");
  const { cmdTrace, printed } = commands(root, {
    now: () => new Date("2026-08-17T12:00:00.000Z"),
    follow: undefined,
  });

  const running = cmdTrace(["tail"]);
  // The stream has to reach the end of the file first: `tail` shows what arrives after it.
  await new Promise((resolve) => setTimeout(resolve, 100));
  writeFileSync(
    path,
    `${readFileSync(path, "utf8")}${line({
      ts: "2026-08-17T09:45:00.000Z",
      turn: "turn_14",
      source: "telegram",
      kind: "eve",
      name: "turn.completed",
      data: { sequence: 1 },
    })}\n`,
  );
  // One poll interval, so the live line arrives before the interrupt does.
  await new Promise((resolve) => setTimeout(resolve, 700));
  process.emit("SIGINT");
  await running;

  assert.deepEqual(
    printed.map((row) => row.slice(0, 8)),
    ["09:45:00"],
  );
  assert.equal(process.listenerCount("SIGINT"), before);
});

test("tail rolls over to the new day file at midnight", () => {
  const root = home();
  let clock = new Date("2026-08-17T23:59:59.000Z");
  const tail = createTraceTail({
    filePath: (day) => join(root, `data/trace/${day}.jsonl`),
    day: (at) => at.toISOString().slice(0, 10),
    now: () => clock,
    since: 1,
  });

  assert.equal(tail.day(), DAY_TWO);
  assert.deepEqual(
    tail.drain().map((event) => event.turn),
    ["turn_12"],
  );

  // Midnight: the writer opens tomorrow's file and the follower has to move with it.
  clock = new Date("2026-08-18T00:00:01.000Z");
  write(
    root,
    "data/trace/2026-08-18.jsonl",
    `${line({
      ts: "2026-08-18T00:00:00.500Z",
      turn: "turn_20",
      session: "sess-b",
      source: "telegram",
      kind: "eve",
      name: "turn.started",
      data: { sequence: 1 },
    })}\n`,
  );

  assert.equal(tail.day(), DAY_TWO);
  assert.deepEqual(
    tail.drain().map((event) => event.turn),
    ["turn_20"],
  );
  assert.equal(tail.day(), "2026-08-18");
  // Yesterday's file is not read again, even when something lands in it late.
  writeFileSync(
    join(root, `data/trace/${DAY_TWO}.jsonl`),
    `${readFileSync(join(root, `data/trace/${DAY_TWO}.jsonl`), "utf8")}${line({
      ts: "2026-08-17T23:59:59.900Z",
      turn: "turn_19",
      source: "telegram",
      kind: "eve",
      name: "turn.completed",
      data: {},
    })}\n`,
  );
  assert.deepEqual(tail.drain(), []);
});

test("tail rereads a day file that was truncated under it", () => {
  const root = world("truncated");
  const path = join(root, `data/trace/${DAY_TWO}.jsonl`);
  const first = line({
    ts: "2026-08-17T10:00:00.000Z",
    turn: "turn_1",
    source: "telegram",
    kind: "eve",
    name: "turn.started",
    data: {},
  });
  write(root, `data/trace/${DAY_TWO}.jsonl`, `${first}\n`);
  const tail = createTraceTail({
    filePath: () => path,
    day: () => DAY_TWO,
    now: () => new Date("2026-08-17T12:00:00.000Z"),
  });
  assert.deepEqual(tail.drain(), []);

  writeFileSync(path, `${first}\n`.slice(0, 20));
  assert.deepEqual(tail.drain(), []);
  writeFileSync(path, `${first}\n`);

  assert.deepEqual(
    tail.drain().map((event) => event.name),
    ["turn.started"],
  );
});

test("tail keeps a half-written line until its newline arrives", () => {
  const root = world("partial");
  const path = join(root, `data/trace/${DAY_TWO}.jsonl`);
  const whole = line({
    ts: "2026-08-17T10:00:00.000Z",
    turn: "turn_1",
    source: "telegram",
    kind: "eve",
    name: "message.completed",
    data: { message: "привет" },
  });
  write(root, `data/trace/${DAY_TWO}.jsonl`, "");
  const tail = createTraceTail({
    filePath: () => path,
    day: () => DAY_TWO,
    now: () => new Date("2026-08-17T12:00:00.000Z"),
  });
  tail.drain();

  // Split inside a multi-byte character: the tail is bytes, so nothing may be damaged.
  const bytes = Buffer.from(`${whole}\n`, "utf8");
  writeFileSync(path, bytes.subarray(0, bytes.length - 4));
  assert.deepEqual(tail.drain(), []);
  writeFileSync(path, bytes);

  const [event] = tail.drain();
  assert.equal(event.data.message, "привет");
});

// --- open ---

test("open prints the tunnel on the default port and points at the plugin when it is absent", async () => {
  const { cmdTrace, events, printed } = commands(home());

  await cmdTrace(["open"]);

  assert.match(
    messages(events, "warn"),
    /not installed — install it: iva plugin add trace/u,
  );
  assert.deepEqual(printed, [
    "1. Run this on your computer: ssh -N -L 8726:127.0.0.1:8726 shima@c1",
    "2. Then open in the browser: http://127.0.0.1:8726",
  ]);
});

test("open takes the port from the installed plugin's service declaration", async () => {
  const root = home("with-plugin");
  const data = join(root, "data");
  await writePluginsState(data, {
    marketplaces: [],
    plugins: [
      {
        name: "trace",
        source: "smixs/iva-plugins/trace",
        ref: "HEAD",
        sha: "a".repeat(40),
        digest: "b".repeat(64),
        enabled: true,
        trusted: true,
        installedAt: "2026-08-17T00:00:00.000Z",
      },
    ],
  });
  write(
    pluginRoot(data, "trace"),
    "sh.iva/services/viewer/service.json",
    JSON.stringify({ command: "node", args: ["server.mjs"], port: 9100 }),
  );
  const { cmdTrace, events, printed } = commands(root);

  await cmdTrace(["open"]);

  assert.equal(messages(events, "warn"), "");
  assert.deepEqual(printed, [
    "1. Run this on your computer: ssh -N -L 9100:127.0.0.1:9100 shima@c1",
    "2. Then open in the browser: http://127.0.0.1:9100",
  ]);
});

test("open still prints the command when the agent tree is missing", async () => {
  const { cmdTrace, events, printed } = commands(home(), {
    loadPlugins: () => Promise.resolve(null),
  });

  await cmdTrace(["open"]);

  assert.match(
    messages(events, "warn"),
    /the agent tree is missing — run: iva update/u,
  );
  assert.match(printed[0], /ssh -N -L 8726:127\.0\.0\.1:8726 shima@c1$/u);
});

test("open warns about a disabled plugin and still prints the tunnel", async () => {
  const root = home("disabled-plugin");
  const data = join(root, "data");
  await writePluginsState(data, {
    marketplaces: [],
    plugins: [
      {
        name: "trace",
        source: "smixs/iva-plugins/trace",
        ref: "HEAD",
        sha: "",
        digest: "",
        enabled: false,
        trusted: false,
        installedAt: "2026-08-17T00:00:00.000Z",
      },
    ],
  });
  const { cmdTrace, events, printed } = commands(root);

  await cmdTrace(["open"]);

  assert.match(
    messages(events, "warn"),
    /the trace plugin is off — turn it on: iva plugin enable trace/u,
  );
  // No service declaration on disk, so the default port stands.
  assert.match(printed[0], /ssh -N -L 8726:127\.0\.0\.1:8726 shima@c1$/u);
});

test("open names this host and this user when nothing is injected", async () => {
  const { cmdTrace, printed } = commands(home("real-host"), {
    hostName: undefined,
    userName: undefined,
  });

  await cmdTrace(["open"]);

  assert.match(
    printed[0],
    /^1\. Run this on your computer: ssh -N -L 8726:127\.0\.0\.1:8726 \S+@\S+$/u,
  );
});

test("an unusable timezone prints an empty clock instead of throwing", () => {
  assert.equal(
    clock(Date.parse("2026-08-17T09:00:00.000Z"), "UTC"),
    "09:00:00",
  );
  assert.equal(clock(0, "UTC"), "--:--:--");
  assert.equal(clock(Date.now(), "Mars/Olympus"), "--:--:--");
});

test("the ssh host is a real host, never the loopback address ASSISTANT_HOST carries", () => {
  assert.equal(
    sshHost("http://127.0.0.1:8723", () => "c1"),
    "c1",
  );
  // A URL that does not parse names no host at all.
  assert.equal(
    sshHost("http://[nope", () => "c1"),
    "c1",
  );
  assert.equal(
    sshHost("http://localhost:8723/", () => "c1"),
    "c1",
  );
  assert.equal(
    sshHost(undefined, () => "c1"),
    "c1",
  );
  assert.equal(
    sshHost("", () => "c1"),
    "c1",
  );
  assert.equal(
    sshHost("http://iva.example.net:8723", () => "c1"),
    "iva.example.net",
  );
  assert.equal(
    sshHost("iva.example.net:8723", () => "c1"),
    "iva.example.net",
  );
});

test("a service port is read when it is a usable port and defaulted when it is not", () => {
  const root = world("ports");
  write(root, "good.json", JSON.stringify({ port: 9100 }));
  write(root, "zero.json", JSON.stringify({ port: 0 }));
  write(root, "huge.json", JSON.stringify({ port: 70000 }));
  write(root, "text.json", JSON.stringify({ port: "9100" }));
  write(root, "broken.json", "{ not json");
  write(root, "list.json", "[1,2,3]");

  assert.equal(readServicePort(join(root, "good.json")), 9100);
  for (const name of ["zero", "huge", "text", "broken", "list", "absent"])
    assert.equal(readServicePort(join(root, `${name}.json`)), 8726);
});

// --- the journal as a whole ---

test("a line that is not JSON is skipped and its neighbours survive", async () => {
  const root = home();
  const text = readFileSync(join(root, `data/trace/${DAY_TWO}.jsonl`), "utf8");
  assert.match(text, /^not json at all$/mu, "the fixture carries broken lines");

  const parsed = fixtureLines(root);
  assert.equal(parsed.length, CHAT_TURN.length + NIGHT_TURN.length);

  const { cmdTrace, printed } = commands(root);
  await cmdTrace(["show", "turn_12"]);
  assert.equal(printed.filter((row) => /^ {2}\d\d:/u.test(row)).length, 19);
});

test("the outcome of a turn is the worst thing that happened to it", () => {
  const turns = stitchTurns([
    ...fixtureLines(home()),
    ...DAY_BEFORE.map(line)
      .map((raw, index) => parseTraceLine(raw, 100 + index))
      .filter((parsed): parsed is TraceLine => parsed !== null),
  ]);
  const outcomes = new Map(
    turns.map((turn) => [turn.turnId || turn.key, turnOutcome(turn)]),
  );
  assert.deepEqual(Object.fromEntries(outcomes), {
    turn_12: "delivered",
    turn_1: "delivered",
    "tg:100:8000": "blocked",
    turn_9: "failed",
    "tg:100:cb:77": "open",
  });
});

test("a Bridge callback stays an orphan: no turn.bound, no inbound, its own group", () => {
  const lines = DAY_BEFORE.map(line)
    .map((raw, index) => parseTraceLine(raw, index))
    .filter((parsed): parsed is TraceLine => parsed !== null);
  const orphan = selectTurn(stitchTurns(lines), "tg:100:cb:77");

  assert.ok(orphan);
  assert.equal(orphan.turnId, "");
  assert.equal(orphan.session, "");
  assert.deepEqual(orphan.sources, ["bridge"]);
  assert.equal(orphan.events.length, 1);
});

// --- properties ---

/** What a caller of `stitchTurns` can see; `index` is an implementation detail. */
function shape(turns: readonly StitchedTurn[]): unknown {
  return turns.map((turn) => ({
    key: turn.key,
    turnId: turn.turnId,
    updateKey: turn.updateKey,
    session: turn.session,
    sources: turn.sources,
    events: turn.events.map((event) => event.raw),
  }));
}

function parseAll(raws: readonly string[]): TraceLine[] {
  return raws
    .map((raw, index) => parseTraceLine(raw, index))
    .filter((parsed): parsed is TraceLine => parsed !== null);
}

const eventShape = fc.record({
  turn: fc.constantFrom(
    "tg:1:2",
    "tg:1:3",
    "turn_5",
    "turn_5#planner",
    "turn_6",
    "tg:1:cb:9",
    "",
  ),
  session: fc.constantFrom("", "sess-a", "sess-night"),
  source: fc.constantFrom("telegram", "bridge", "rollup", "unknown", ""),
  kind: fc.constantFrom(
    "bridge",
    "inbound",
    "gate",
    "turn",
    "eve",
    "outbox",
    "stop",
  ),
  name: fc.constantFrom(
    "admitted",
    "received",
    "inbound",
    "bound",
    "step.started",
    "delivered",
  ),
});

// Distinct timestamps, one second apart: then `ts` alone fixes the order and a permutation
// of the input has nothing left to change.
const journal = fc
  .array(eventShape, { minLength: 1, maxLength: 14 })
  .map((events) =>
    events.map((event, at) =>
      line({
        ...event,
        ts: new Date(Date.UTC(2026, 7, 17, 0, 0, at)).toISOString(),
        data:
          event.kind === "turn" && event.name === "bound"
            ? { chatKey: "tg:1", updateKey: "tg:1:2" }
            : { note: at },
      }),
    ),
  );

test("stitching a journal does not depend on the order its lines were written in", () => {
  fc.assert(
    fc.property(
      journal.chain((raws) =>
        fc.tuple(
          fc.constant(raws),
          fc.shuffledSubarray(raws, {
            minLength: raws.length,
            maxLength: raws.length,
          }),
        ),
      ),
      ([written, shuffled]) => {
        assert.deepEqual(
          shape(stitchTurns(parseAll(shuffled))),
          shape(stitchTurns(parseAll(written))),
        );
      },
    ),
    { numRuns: 300 },
  );
});

const wildText = fc.oneof(
  fc.string({ unit: "binary", maxLength: 120 }),
  fc.string({ unit: "grapheme", maxLength: 120 }),
  fc.constantFrom(
    "\ud800",
    "a\ud800b",
    "\u0000\u001b[31mred",
    "line\nbreak\ttab\r\n",
    "🙂".repeat(60),
    "x".repeat(2500),
  ),
);

const wildLine = fc
  .record({
    ts: fc.oneof(
      fc.constant("2026-08-17T09:00:00.000Z"),
      fc.constant(""),
      wildText,
    ),
    turn: wildText,
    session: wildText,
    source: wildText,
    kind: fc.oneof(
      fc.constantFrom("eve", "gate", "bridge", "outbox"),
      wildText,
    ),
    name: fc.oneof(
      fc.constantFrom("action.result", "bound", "inbound", "delivered"),
      wildText,
    ),
    data: fc.oneof(
      fc.dictionary(
        fc.oneof(
          fc.constantFrom(
            "toolName",
            "text",
            "result",
            "args",
            "actions",
            "usage",
            "ms",
            "chars",
            "traceTrimmed",
          ),
          wildText,
        ),
        fc.oneof(
          wildText,
          fc.integer(),
          fc.boolean(),
          fc.jsonValue({ maxDepth: 3 }),
        ),
        { maxKeys: 8 },
      ),
      fc.jsonValue({ maxDepth: 3 }),
    ),
  })
  .map((event) => JSON.stringify(event));

test("the text renderer survives any JSON line and never breaks one event into two", () => {
  fc.assert(
    fc.property(fc.array(wildLine, { minLength: 1, maxLength: 8 }), (raws) => {
      const lines = parseAll(raws);
      for (const event of lines) {
        const rendered = formatEventLine(event, { timeZone: "UTC" });
        assert.doesNotMatch(rendered, /[\n\r]/u, "one event is one line");
      }
      const turns = stitchTurns(lines);
      for (const turn of turns) {
        for (const rendered of formatTurn(turn, { timeZone: "UTC" }))
          assert.doesNotMatch(rendered, /[\n\r]/u, "one event is one line");
        // `--full` gives up the one-line rule on purpose; it must still not throw.
        formatTurn(turn, { timeZone: "UTC", full: true });
      }
      for (const rendered of formatTurnList(turns, { timeZone: "UTC" }))
        assert.doesNotMatch(rendered, /[\n\r]/u, "one turn is one row");
    }),
    { numRuns: 300 },
  );
});

test("a line that is not an object, or carries neither kind nor name, is not an event", () => {
  fc.assert(
    fc.property(
      fc.oneof(
        fc.constantFrom("42", '"text"', "[1,2]", "null", "{}", "", "   ", "{"),
        fc.jsonValue({ maxDepth: 2 }).map((value) => JSON.stringify(value)),
      ),
      (raw) => {
        const parsed = parseTraceLine(raw);
        if (parsed === null) return;
        assert.ok(
          parsed.kind !== "" || parsed.name !== "",
          "an event has at least a kind or a name",
        );
      },
    ),
    { numRuns: 300 },
  );
});

// --- Round 2: many turns in one session ---

/** The digest shape: one Eve session, two `session.send()` calls, so two turns. */
const DIGEST_SESSION: readonly Event[] = [
  {
    ts: "2026-08-17T06:00:00.000Z",
    turn: "turn_0",
    session: "sess-digest",
    source: "unknown",
    kind: "eve",
    name: "turn.started",
    data: { sequence: 1, sessionId: "sess-digest" },
  },
  {
    ts: "2026-08-17T06:00:02.000Z",
    session: "sess-digest",
    source: "digest",
    kind: "gate",
    name: "outbound",
    data: { clean: true, findings: [], chars: 120, text: "утренний дайджест" },
  },
  {
    ts: "2026-08-17T06:00:02.500Z",
    session: "sess-digest",
    source: "digest",
    kind: "outbox",
    name: "delivered",
    data: {
      ok: true,
      delivered: 1,
      fellBack: false,
      error: "",
      chars: 120,
      ms: 210,
    },
  },
  {
    ts: "2026-08-17T06:00:10.000Z",
    turn: "turn_1",
    session: "sess-digest",
    source: "unknown",
    kind: "eve",
    name: "turn.started",
    data: { sequence: 2, sessionId: "sess-digest" },
  },
  {
    ts: "2026-08-17T06:00:12.000Z",
    session: "sess-digest",
    source: "digest",
    kind: "gate",
    name: "outbound",
    data: { clean: true, findings: [], chars: 80, text: "и второе сообщение" },
  },
  {
    ts: "2026-08-17T06:00:12.500Z",
    session: "sess-digest",
    source: "digest",
    kind: "outbox",
    name: "failed",
    data: {
      ok: false,
      delivered: 0,
      fellBack: false,
      error: "429",
      chars: 80,
      ms: 40,
    },
  },
];

test("two sends in one session are two turns, and each keyless line lands on its own", () => {
  const turns = stitchTurns(parseAll(DIGEST_SESSION.map(line)));

  assert.deepEqual(
    turns.map((turn) => [turn.turnId, turn.session, turn.events.length]),
    [
      ["turn_0", "sess-digest", 3],
      ["turn_1", "sess-digest", 3],
    ],
  );
  // Each turn keeps the send seam of ITS OWN send.
  assert.deepEqual(
    turns.map((turn) => turnOutcome(turn)),
    ["delivered", "failed"],
  );
  assert.deepEqual(
    turns[0].events.map((event) => event.data.chars ?? null),
    [null, 120, 120],
  );
  // Both turns answer to their name, and the session names the newest of them.
  assert.equal(selectTurn(turns, "turn_0")?.key, "sess-digest|turn_0");
  assert.equal(selectTurn(turns, "turn_1")?.key, "sess-digest|turn_1");
  assert.equal(selectTurn(turns, "sess-digest")?.turnId, "turn_1");
  assert.equal(selectTurn(turns, "last")?.turnId, "turn_1");
});

test("a Rollup session that spans two nights stays two turns, not one", async () => {
  const root = world("two-nights");
  write(root, ".env", "ASSISTANT_DATA_DIR=data\nASSISTANT_TIMEZONE=UTC\n");
  const night = (day: string, turn: string, text: string): string[] => [
    line({
      ts: `${day}T03:00:00.000Z`,
      turn,
      session: "sess-rollup",
      source: "unknown",
      kind: "eve",
      name: "turn.started",
      data: { sequence: 1, sessionId: "sess-rollup" },
    }),
    line({
      ts: `${day}T03:00:20.000Z`,
      session: "sess-rollup",
      source: "rollup",
      kind: "outbox",
      name: "delivered",
      data: {
        ok: true,
        delivered: 1,
        fellBack: false,
        error: "",
        chars: 400,
        ms: 90,
        text,
      },
    }),
  ];
  write(
    root,
    `data/trace/${DAY_ONE}.jsonl`,
    `${night(DAY_ONE, "turn_4", "ночь одна").join("\n")}\n`,
  );
  write(
    root,
    `data/trace/${DAY_TWO}.jsonl`,
    `${night(DAY_TWO, "turn_5", "ночь два").join("\n")}\n`,
  );

  const listed = commands(root);
  await listed.cmdTrace(["show"]);
  assert.equal(listed.printed.slice(1).length, 2, listed.out());

  for (const turn of ["turn_4", "turn_5"]) {
    const one = commands(root);
    await one.cmdTrace(["show", turn]);
    assert.equal(one.printed[0], `${turn} · - · rollup · session sess-rollup`);
    assert.equal(
      one.printed[1],
      "03:00:00 → 03:00:20 · 20.0s · 0 steps · no tools · delivered",
    );
  }
});

test("a keyless line ahead of every turn of its session joins the first one", () => {
  const turns = stitchTurns(
    parseAll([
      line({
        ts: "2026-08-17T03:00:00.000Z",
        session: "sess-early",
        source: "rollup",
        kind: "gate",
        name: "outbound",
        data: { clean: true, findings: [], chars: 10 },
      }),
      line({
        ts: "2026-08-17T03:00:01.000Z",
        turn: "turn_2",
        session: "sess-early",
        source: "unknown",
        kind: "eve",
        name: "turn.started",
        data: { sequence: 1 },
      }),
    ]),
  );

  assert.equal(turns.length, 1);
  assert.equal(turns[0].turnId, "turn_2");
  assert.equal(turns[0].events.length, 2);
});

test("the earliest turn.bound owns an update key that two of them claim", () => {
  const claim = (ts: string, turn: string): string =>
    line({
      ts,
      turn,
      session: "sess-a",
      source: "telegram",
      kind: "turn",
      name: "bound",
      data: { chatKey: "tg:100", updateKey: "tg:100:9241" },
    });
  const inbound = line({
    ts: "2026-08-17T09:00:00.000Z",
    turn: "tg:100:9241",
    source: "telegram",
    kind: "inbound",
    name: "received",
    data: { chatId: "100", allowlisted: true },
  });
  const early = claim("2026-08-17T09:00:01.000Z", "turn_20");
  const late = claim("2026-08-17T09:00:02.000Z", "turn_21");

  for (const raws of [
    [inbound, early, late],
    [late, early, inbound],
    [early, late, inbound],
  ]) {
    const turns = stitchTurns(parseAll(raws));
    const owner = turns.find((turn) => turn.updateKey === "tg:100:9241");
    assert.equal(owner?.turnId, "turn_20", raws.join("\n"));
    // The inbound line goes to whoever claimed it first, whatever the write order was.
    assert.ok(owner?.events.some((event) => event.kind === "inbound"));
  }
});

// --- Round 2: invisible characters ---

// The repo's threat class (INVISIBLE_RE in agent/lib/security-gate.ts). Built by code
// point on purpose: a source file that carries a live escape sequence is its own problem.
const ESCAPE = String.fromCharCode(0x1b);
const BELL = String.fromCharCode(0x07);
const SOFT_HYPHEN = String.fromCharCode(0xad);

test("--full keeps the line breaks of content and drops everything else invisible", async () => {
  const root = world("invisible");
  write(root, ".env", "ASSISTANT_DATA_DIR=data\nASSISTANT_TIMEZONE=UTC\n");
  write(
    root,
    `data/trace/${DAY_TWO}.jsonl`,
    `${[
      line({
        ts: "2026-08-17T10:00:00.000Z",
        turn: "turn_3",
        session: "sess-e",
        source: "telegram",
        kind: "turn",
        name: "bound",
        data: { chatKey: "tg:1", updateKey: "tg:1:1" },
      }),
      line({
        ts: "2026-08-17T10:00:01.000Z",
        turn: "turn_3",
        session: "sess-e",
        source: "telegram",
        kind: "eve",
        name: "action.result",
        data: {
          toolName: "bash",
          status: "ok",
          // What a shell command really returns: a colour code, a bell, a soft hyphen.
          result: `first${ESCAPE}[31m red${BELL}\nsecond${SOFT_HYPHEN}line\r\nthird`,
        },
      }),
    ].join("\n")}\n`,
  );

  const full = commands(root);
  await full.cmdTrace(["show", "turn_3", "--full"]);
  const capped = commands(root);
  await capped.cmdTrace(["show", "turn_3"]);

  for (const out of [full.out(), capped.out()])
    for (const invisible of [ESCAPE, BELL, SOFT_HYPHEN])
      assert.equal(
        out.includes(invisible),
        false,
        "nothing invisible reaches stdout",
      );
  // `--full` keeps the shape of the result: three lines where the tool wrote three.
  assert.match(
    full.out(),
    /result: first \[31m red\n {14}second line\n {14}third/u,
  );
  // Capped, the same result is one line.
  assert.match(capped.out(), /result: first \[31m red second line third$/mu);
});

// --- Round 2: tail and the timezone ---

test("tail with no history reads no bytes of the day file", () => {
  const root = home("no-read");
  const path = join(root, `data/trace/${DAY_TWO}.jsonl`);
  let lookups = 0;
  const tail = createTraceTail({
    filePath: () => {
      lookups += 1;
      return path;
    },
    day: () => DAY_TWO,
    now: () => new Date("2026-08-17T12:00:00.000Z"),
  });

  assert.deepEqual(tail.drain(), []);
  // One lookup, for the size that becomes the offset. No read, no parse.
  assert.equal(lookups, 1);
  const size = statSync(path).size;
  writeFileSync(
    path,
    `${readFileSync(path, "utf8")}${line({
      ts: "2026-08-17T11:00:00.000Z",
      turn: "turn_30",
      source: "telegram",
      kind: "eve",
      name: "turn.started",
      data: {},
    })}\n`,
  );
  assert.ok(statSync(path).size > size);

  assert.deepEqual(
    tail.drain().map((event) => event.turn),
    ["turn_30"],
  );
});

test("the day file and the clock both follow ASSISTANT_TIMEZONE out of .env", async () => {
  const root = world("tashkent");
  // 20:30 UTC is 01:30 the next day in Tashkent, so the journal is already on 18 August.
  write(
    root,
    ".env",
    "ASSISTANT_DATA_DIR=data\nASSISTANT_TIMEZONE=Asia/Tashkent\n",
  );
  write(
    root,
    "data/trace/2026-08-18.jsonl",
    `${line({
      ts: "2026-08-17T20:30:00.000Z",
      turn: "turn_40",
      session: "sess-t",
      source: "telegram",
      kind: "eve",
      name: "turn.started",
      data: { sequence: 1 },
    })}\n`,
  );
  const { cmdTrace, printed } = commands(root, {
    now: () => new Date("2026-08-17T20:30:00.000Z"),
  });

  await cmdTrace(["tail", "--since", "1"]);

  assert.equal(printed.length, 1, printed.join("\n"));
  assert.match(printed[0], /^01:30:00 {2}turn_40 {9}eve\.turn\.started/u);
});

test("--json needs one turn and says so instead of printing the list", async () => {
  const { cmdTrace, printed } = commands(home());

  await assert.rejects(
    () => cmdTrace(["show", "--json"]),
    /--json shows one turn: iva trace show --json <turn\|last>/u,
  );
  assert.deepEqual(printed, []);
});
