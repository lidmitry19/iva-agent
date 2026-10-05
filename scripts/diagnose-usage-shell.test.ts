/* eslint-disable @typescript-eslint/no-floating-promises -- Node owns test registration */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SCRIPT = join(ROOT, "diagnose-usage.sh");

const CHAT_TEXT = "мой пароль от банка 4242 и адрес Ленина 5";
const TOOL_INPUT = "cat ~/private/diary.md";
const TOOL_OUTPUT = "дорогой дневник, сегодня";
// Fake credentials, built from parts: the shape the redaction must catch, not a real key.
const BOT_TOKEN = ["123456", "AAbbCCddEEffGGhhIIjjKKllMMnnOOppQQ"].join(":");
const API_KEY = ["sk", "live", "0123456789abcdefghijklmnop"].join("-");

/** One stream chunk the way eve's local world writes it: a header, `devl`, a devalue pair. */
function chunk(event: Record<string, unknown>): Buffer {
  const b64 = Buffer.from(JSON.stringify(event)).toString("base64");
  return Buffer.concat([
    Buffer.from([0, 0, 0, 0x6d]),
    Buffer.from("devl" + JSON.stringify([["Uint8Array", 1], b64])),
  ]);
}

function install(t: TestContext): {
  home: string;
  sent: string;
  run: (env?: Record<string, string>) => string;
} {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "iva-diag-usage-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const iva = join(home, "iva");
  const data = join(iva, "data");
  mkdirSync(join(data, "trace"), { recursive: true });
  writeFileSync(
    join(iva, ".env"),
    [
      `TELEGRAM_BOT_TOKEN=${BOT_TOKEN}`,
      "TELEGRAM_ALLOWED_USER_IDS=777,888",
      "MODEL_PROVIDER=ollama",
      "OLLAMA_MODEL=glm-5.3-flash",
      `OLLAMA_API_KEY=${API_KEY}`,
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(iva, "package.json"),
    '{ "name": "iva", "version": "0.4.7" }\n',
  );
  const now = Date.now();
  const at = (s: number) => new Date(now - 3_600_000 + s * 1000).toISOString();
  writeFileSync(
    join(data, "usage.jsonl"),
    [
      JSON.stringify({
        ts: at(1),
        source: "http",
        model: "glm-5.3-flash",
        sessionId: "wrun_01AAA",
        turnId: "turn_0",
        step: 0,
        in: 80_000,
        out: 10,
        cacheRead: 0,
      }),
      "{not json",
      JSON.stringify({
        ts: at(2),
        source: "http",
        model: "glm-5.3-flash",
        sessionId: "wrun_01AAA",
        turnId: "turn_0",
        step: 1,
        in: 81_000,
        out: 5,
        cacheRead: 0,
      }),
      JSON.stringify({
        ts: "2020-01-01T00:00:00Z",
        source: "http",
        model: "old",
        sessionId: "wrun_OLD",
        turnId: "turn_0",
        step: 0,
        in: 1,
        out: 1,
      }),
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(data, "trace", "today.jsonl"),
    '{"kind":"eve","name":"step.started"}\n',
  );

  // A turn: one tool step, then three steps with neither a tool nor text, then an answer.
  const lane = join(
    iva,
    ".eve",
    ".workflow-data",
    "streams",
    "chunks",
    "strm_01AAA_user",
  );
  mkdirSync(lane, { recursive: true });
  const events: Record<string, unknown>[] = [
    { type: "turn.started", data: { sequence: 0, turnId: "turn_0" } },
    {
      type: "message.received",
      data: { turnId: "turn_0", parts: [{ type: "text", text: CHAT_TEXT }] },
    },
    {
      type: "step.started",
      data: {
        turnId: "turn_0",
        stepIndex: 0,
        modelId: "iva-ollama/glm-5.3-flash",
      },
    },
    {
      type: "action.input.appended",
      data: {
        turnId: "turn_0",
        stepIndex: 0,
        toolName: "bash",
        inputTextDelta: TOOL_INPUT,
      },
    },
    {
      type: "actions.requested",
      data: {
        turnId: "turn_0",
        stepIndex: 0,
        actions: [
          {
            callId: "c1",
            kind: "tool-call",
            toolName: "bash",
            input: { command: TOOL_INPUT },
          },
        ],
      },
    },
    {
      type: "action.result",
      data: {
        turnId: "turn_0",
        stepIndex: 0,
        status: "completed",
        result: {
          callId: "c1",
          kind: "tool-result",
          toolName: "bash",
          output: { stdout: TOOL_OUTPUT, exitCode: 1 },
        },
      },
    },
    {
      type: "step.completed",
      data: {
        turnId: "turn_0",
        stepIndex: 0,
        finishReason: "tool-calls",
        usage: { inputTokens: 80_000, outputTokens: 10 },
      },
    },
    ...[1, 2, 3].flatMap((i) => [
      {
        type: "step.started",
        data: {
          turnId: "turn_0",
          stepIndex: i,
          modelId: "iva-ollama/glm-5.3-flash",
        },
      },
      {
        type: "step.completed",
        data: {
          turnId: "turn_0",
          stepIndex: i,
          finishReason: "tool-calls",
          usage: { inputTokens: 81_000, outputTokens: 3 },
        },
      },
    ]),
    {
      type: "step.started",
      data: {
        turnId: "turn_0",
        stepIndex: 4,
        modelId: "iva-ollama/glm-5.3-flash",
      },
    },
    {
      type: "message.appended",
      data: { turnId: "turn_0", stepIndex: 4, messageDelta: CHAT_TEXT },
    },
    {
      type: "message.completed",
      data: {
        turnId: "turn_0",
        stepIndex: 4,
        finishReason: "stop",
        message: CHAT_TEXT,
      },
    },
    {
      type: "step.completed",
      data: {
        turnId: "turn_0",
        stepIndex: 4,
        finishReason: "stop",
        usage: { inputTokens: 82_000, outputTokens: 40 },
      },
    },
    {
      type: "step.failed",
      data: {
        turnId: "turn_0",
        stepIndex: 5,
        code: "MODEL_CALL_FAILED",
        message: `Bad Request key=${API_KEY}`,
      },
    },
    { type: "turn.failed", data: { turnId: "turn_0", message: "Bad Request" } },
  ];
  events.forEach((event, i) =>
    writeFileSync(
      join(lane, `chnk_${String(i).padStart(4, "0")}.bin`),
      chunk({ ...event, meta: { at: at(10 + i) } }),
    ),
  );
  writeFileSync(join(lane, "chnk_9998.bin"), "garbage without a marker");
  writeFileSync(
    join(lane, "chnk_9999.bin"),
    'devl[["Uint8Array",1],"%%%not-base64"]',
  );

  const bin = join(home, "bin");
  mkdirSync(bin);
  const sent = join(home, "sent.txt");
  writeFileSync(
    join(bin, "curl"),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${sent}"\necho '{"ok":true}'\n`,
  );
  writeFileSync(
    join(bin, "journalctl"),
    [
      "#!/usr/bin/env bash",
      `echo "Sep 24 09:08:20 host env[1]: tool-loop stream error: session usage limit reached TELEGRAM_BOT_TOKEN=${BOT_TOKEN}"`,
      `echo "Sep 24 09:08:20 host env[1]:             content: '${CHAT_TEXT} error'"`,
      `echo "Sep 24 09:09:00 host env[1]: schedule-runner: memory-daily tail: ${CHAT_TEXT}"`,
      'echo "Sep 24 09:10:00 host env[1]: [vision] chat model sees images: true"',
      "",
    ].join("\n"),
  );
  writeFileSync(join(bin, "systemctl"), "#!/usr/bin/env bash\nexit 1\n");
  for (const f of ["curl", "journalctl", "systemctl"])
    chmodSync(join(bin, f), 0o755);

  const run = (env: Record<string, string> = {}) =>
    execFileSync("bash", [SCRIPT], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        IVA_INSTALL_DIR: iva,
        ...env,
      },
    });
  return { home, sent, run };
}

/** Unpacks the one archive the script left in data/diagnose and returns its folder. */
function unpack(home: string): string {
  const dir = join(home, "iva", "data", "diagnose");
  const archives = readdirSync(dir).filter((f) => f.endsWith(".tgz"));
  assert.equal(archives.length, 1);
  const out = join(home, "out");
  mkdirSync(out);
  execFileSync("tar", ["-xzf", join(dir, archives[0]), "-C", out]);
  return join(out, readdirSync(out)[0]);
}

function readAll(dir: string): string {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => readFileSync(join(e.parentPath, e.name), "utf8"))
    .join("\n");
}

test("the package names the silent steps, their tokens and tools, and sends one file to the owner", (t) => {
  const { home, sent, run } = install(t);
  assert.match(run(), /Sent to your chat with the bot: iva-usage-.*\.tgz/);
  const args = readFileSync(sent, "utf8");
  assert.match(args, /chat_id=777\n/);
  assert.match(args, /document=@.*iva-usage-.*\.tgz/);
  assert.match(args, new RegExp(`bot${BOT_TOKEN}/sendDocument`));

  const pkg = unpack(home);
  const summary = readFileSync(join(pkg, "summary.txt"), "utf8");
  assert.match(summary, /steps=5 withTool=1 withText=1 silent=3/);
  assert.match(summary, /finish: tool-calls×4, stop×1/);
  assert.match(summary, /tools: bash×1/);
  assert.match(summary, /failed tools: bash×1/);
  assert.match(summary, /end=failed/);
  assert.match(summary, /model=iva-ollama\/glm-5\.3-flash/);
  assert.match(
    summary,
    /glm-5\.3-flash\s+2\s+0\.16M/,
    "usage counters per day, broken line skipped",
  );
  assert.doesNotMatch(
    summary,
    /wrun_OLD/,
    "counters older than the window stay home",
  );

  const skeleton = readFileSync(join(pkg, "turn-skeleton.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  const received = skeleton.find((r) => r.type === "message.received");
  assert.equal(received?.parts, 1);
  assert.ok(
    skeleton.some(
      (r) => r.type === "step.completed" && r.finish === "tool-calls",
    ),
  );

  const env = readFileSync(join(pkg, "env-model.txt"), "utf8");
  assert.match(env, /OLLAMA_MODEL=glm-5\.3-flash/);
  assert.match(env, /^OLLAMA_API_KEY$/m, "other keys by name only");
  assert.ok(
    readFileSync(join(pkg, "journal.log"), "utf8").includes(
      "session usage limit",
    ),
  );
});

test("no chat text, tool input or output and no secret leaves the machine", (t) => {
  const { home, run } = install(t);
  run();
  const everything = readAll(unpack(home));
  for (const secret of [
    CHAT_TEXT,
    TOOL_INPUT,
    TOOL_OUTPUT,
    BOT_TOKEN,
    API_KEY,
    "Ленина",
  ]) {
    assert.ok(!everything.includes(secret), `leaked: ${secret}`);
  }
});

test("no eve store and no counters still gives a package that says so", (t) => {
  const { home, run } = install(t);
  rmSync(join(home, "iva", ".eve"), { recursive: true });
  rmSync(join(home, "iva", "data", "usage.jsonl"));
  assert.match(run({ IVA_DIAG_NO_SEND: "1" }), /Package written, not sent:/);
  const pkg = unpack(home);
  assert.match(
    readFileSync(join(pkg, "summary.txt"), "utf8"),
    /no eve store events in the window/,
  );
  assert.match(
    readFileSync(join(pkg, "versions.txt"), "utf8"),
    /store: \(not found\)/,
  );
});

test("a failed upload names the reason and keeps the file", (t) => {
  const { home, run } = install(t);
  writeFileSync(
    join(home, "bin", "curl"),
    '#!/usr/bin/env bash\necho \'{"ok":false,"description":"Forbidden"}\'\n',
  );
  assert.throws(
    () => run(),
    (e: { stderr?: string }) =>
      /could not send the package: .*Forbidden.*The file is here: /.test(
        e.stderr ?? "",
      ),
  );
});

test("turns set aside by a reset are read from the kept copy of the store", (t) => {
  const { home, run } = install(t);
  const trash = join(
    home,
    "iva",
    ".eve",
    ".workflow-data.trash-2026-09-24T09-45-15-000Z",
    "streams",
    "chunks",
    "strm_01BBB_user",
  );
  mkdirSync(trash, { recursive: true });
  const at = new Date(Date.now() - 7_200_000).toISOString();
  const events = [
    { type: "turn.started", data: { turnId: "turn_7" } },
    ...[0, 1].flatMap((i) => [
      {
        type: "step.started",
        data: { turnId: "turn_7", stepIndex: i, modelId: "m" },
      },
      {
        type: "step.completed",
        data: { turnId: "turn_7", stepIndex: i, finishReason: "other" },
      },
    ]),
  ];
  events.forEach((event, i) =>
    writeFileSync(
      join(trash, `chnk_${String(i).padStart(4, "0")}.bin`),
      chunk({ ...event, meta: { at } }),
    ),
  );
  run({ IVA_DIAG_NO_SEND: "1" });
  const pkg = unpack(home);
  const summary = readFileSync(join(pkg, "summary.txt"), "utf8");
  assert.match(summary, /wrun_01BBB turn_7/);
  assert.match(summary, /steps=2 withTool=0 withText=0 silent=2/);
  assert.match(summary, /wrun_01AAA turn_0/, "the live store is still read");
  assert.match(
    readFileSync(join(pkg, "versions.txt"), "utf8"),
    /stores set aside by reset\/update: 1/,
  );
});

test("vision rows without a turn count per day but never make a heaviest turn", (t) => {
  const { home, run } = install(t);
  const at = new Date(Date.now() - 1_800_000).toISOString();
  const vision = (input: number) =>
    JSON.stringify({
      ts: at,
      source: "vision",
      provider: "ollama",
      model: "gemma4:31b",
      sessionId: "",
      turnId: "#vision",
      step: 0,
      in: input,
      out: 40,
      cacheRead: 0,
      cacheWrite: 0,
      total: input + 40,
    });
  appendFileSync(
    join(home, "iva", "data", "usage.jsonl"),
    `${vision(900_000)}\n${vision(800_000)}\n`,
  );
  run({ IVA_DIAG_NO_SEND: "1" });
  const summary = readFileSync(join(unpack(home), "summary.txt"), "utf8");
  assert.match(summary, /vision\s+gemma4:31b\s+2\s+1\.70M/);
  assert.doesNotMatch(summary, /#vision/);
});
