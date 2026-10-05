import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { wrapLanguageModel } from "ai";
import { MockLanguageModelV4, convertReadableStreamToArray } from "ai/test";
import type {
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { inspectRepeatGuard, repeatGuardMiddleware } from "./repeat-guard.ts";
import {
  traceDay,
  traceFilePath,
  traceRepeatGuard,
  traceWithScope,
} from "./trace.ts";

const testDataDir = mkdtempSync(join(tmpdir(), "iva-repeat-guard-tests-"));
const previousDataDir = process.env.ASSISTANT_DATA_DIR;
process.env.ASSISTANT_DATA_DIR = testDataDir;
process.on("exit", () => {
  if (previousDataDir === undefined) delete process.env.ASSISTANT_DATA_DIR;
  else process.env.ASSISTANT_DATA_DIR = previousDataDir;
  rmSync(testDataDir, { recursive: true, force: true });
});

function pair(
  id: string,
  tool: string,
  input: unknown,
  output: {
    type: "text" | "error-text" | "json" | "error-json";
    value: unknown;
  },
): LanguageModelV4Prompt {
  return [
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: id, toolName: tool, input }],
    },
    {
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: id, toolName: tool, output },
      ],
    },
  ] as LanguageModelV4Prompt;
}

const user: LanguageModelV4Prompt[number] = {
  role: "user",
  content: [{ type: "text", text: "сделай" }],
};
const failed = (id: string, input: unknown = { path: "x" }) =>
  pair(id, "read_file", input, {
    type: "error-text",
    value: "ENOENT /tmp/work-1234 at 06:00:01 pid 12345",
  });
const success = (id: string) =>
  pair(id, "read_file", { path: "ok" }, { type: "text", value: "готово" });

function parallelStep(
  label: string,
  results: Array<{ ok: boolean; error?: string }>,
): LanguageModelV4Prompt {
  return [
    {
      role: "assistant",
      content: results.map((_, i) => ({
        type: "tool-call",
        toolCallId: `${label}-${i}`,
        toolName: "web_fetch",
        input: { url: `https://example.test/${i}` },
      })),
    },
    {
      role: "tool",
      content: results.map((result, i) => ({
        type: "tool-result",
        toolCallId: `${label}-${i}`,
        toolName: "web_fetch",
        output: result.ok
          ? { type: "text", value: "page opened" }
          : { type: "error-text", value: result.error ?? "HTTP 403" },
      })),
    },
  ] as LanguageModelV4Prompt;
}

void test("R2: eight failed web_fetch calls in one model step count as one", () => {
  const step = parallelStep(
    "one",
    Array.from({ length: 8 }, () => ({ ok: false })),
  );
  assert.equal(inspectRepeatGuard([user, ...step]).stop, undefined);
});

void test("R2: two opened pages among eight 403 responses keep the step successful", () => {
  const mixed = [
    { ok: true },
    ...Array.from({ length: 8 }, () => ({ ok: false })),
    { ok: true },
  ];
  assert.equal(
    inspectRepeatGuard([user, ...parallelStep("mixed", mixed)]).stop,
    undefined,
  );
  assert.equal(
    inspectRepeatGuard([
      user,
      ...failed("a"),
      ...failed("b"),
      ...parallelStep("mixed", mixed),
      ...failed("c"),
    ]).stop,
    undefined,
  );
});

void test("R2: three duplicate calls in one model step do not stop the turn", () => {
  const p = parallelStep(
    "dup",
    Array.from({ length: 3 }, () => ({ ok: false })),
  );
  const assistant = p[0];
  if (assistant.role !== "assistant") throw new Error("bad test fixture");
  for (const part of assistant.content)
    if (part.type === "tool-call")
      part.input = { url: "https://example.test/same" };
  assert.equal(inspectRepeatGuard([user, ...p]).stop, undefined);
});

void test("R2: three separate identical failed steps stop the turn", () => {
  const same = (id: string) =>
    pair(
      id,
      "web_fetch",
      { url: "https://example.test/same" },
      { type: "error-text", value: "HTTP 403" },
    );
  assert.equal(
    inspectRepeatGuard([user, ...same("a"), ...same("b")]).stop,
    undefined,
  );
  assert.equal(
    inspectRepeatGuard([user, ...same("a"), ...same("b"), ...same("c")]).stop
      ?.count,
    3,
  );
});

void test("R2: all failures for a tool within each step must share one signature", () => {
  const varied = ["v1", "v2", "v3"].flatMap((label) =>
    parallelStep(label, [{ ok: false }, { ok: false }]),
  );
  assert.equal(inspectRepeatGuard([user, ...varied]).stop, undefined);
  const identical = ["i1", "i2", "i3"].flatMap((label) => {
    const step = parallelStep(label, [{ ok: false }, { ok: false }]);
    const assistant = step[0];
    if (assistant.role !== "assistant") throw new Error("bad test fixture");
    for (const part of assistant.content)
      if (part.type === "tool-call")
        part.input = { url: "https://example.test/same" };
    return step;
  });
  assert.equal(inspectRepeatGuard([user, ...identical]).stop?.count, 3);
});

void test("R2: success of another tool in a step resets the failed web_fetch streak", () => {
  const step = parallelStep("mixed-tools", [{ ok: false }]);
  const assistant = step[0];
  const result = step[1];
  if (assistant.role !== "assistant" || result.role !== "tool")
    throw new Error("bad test fixture");
  assistant.content.push({
    type: "tool-call",
    toolCallId: "read-ok",
    toolName: "read_file",
    input: {},
  });
  result.content.push({
    type: "tool-result",
    toolCallId: "read-ok",
    toolName: "read_file",
    output: { type: "text", value: "opened" },
  });
  const same = (id: string) =>
    pair(
      id,
      "web_fetch",
      { url: "https://example.test/same" },
      { type: "error-text", value: "HTTP 403" },
    );
  assert.equal(
    inspectRepeatGuard([
      user,
      ...same("a"),
      ...same("b"),
      ...step,
      ...same("c"),
    ]).stop,
    undefined,
  );
});

void test("R2: seven separate varied failed steps pass; eight stop with correct plural", () => {
  const steps = Array.from({ length: 8 }, (_, i) =>
    pair(
      `var-${i}`,
      "web_fetch",
      { url: `https://example.test/${i}` },
      { type: "error-text", value: `HTTP ${400 + i}` },
    ),
  );
  assert.equal(
    inspectRepeatGuard([user, ...steps.slice(0, 7).flat()]).stop,
    undefined,
  );
  const stop = inspectRepeatGuard([user, ...steps.flat()]).stop;
  assert.equal(stop?.count, 8);
  assert.match(stop?.message ?? "", /8 раз подряд/u);
});

void test("R2: HTML response body is omitted from the human error", () => {
  const step = (id: string) =>
    pair(
      id,
      "web_fetch",
      {},
      {
        type: "error-text",
        value: "HTTP 403\n<html><body>private page</body></html>",
      },
    );
  const stop = inspectRepeatGuard([
    user,
    ...step("a"),
    ...step("b"),
    ...step("c"),
  ]).stop;
  assert.ok(stop);
  assert.match(stop.message, /HTTP 403/u);
  assert.doesNotMatch(stop.message, /<html|private page/u);
});

void test("R2: English setting produces an English stop message", () => {
  const script = `import { inspectRepeatGuard } from './agent/lib/repeat-guard.ts';
    const user = { role: 'user', content: [{ type: 'text', text: 'go' }] };
    const pair = (id) => [
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: id, toolName: 'web_fetch', input: {} }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: id, toolName: 'web_fetch', output: { type: 'error-text', value: 'HTTP 403' } }] },
    ];
    console.log(inspectRepeatGuard([user, ...pair('a'), ...pair('b'), ...pair('c')]).stop.message);`;
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      cwd: process.cwd(),
      env: { ...process.env, AGENT_LANGUAGE: "en" },
      encoding: "utf8",
    },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /web_fetch.*3 times in a row/u);
  assert.doesNotMatch(child.stdout, /Инструмент|Ход остановлен/u);
});

void test("two identical failures pass; three stop", () => {
  assert.equal(
    inspectRepeatGuard([user, ...failed("a"), ...failed("b")]).stop,
    undefined,
  );
  const verdict = inspectRepeatGuard([
    user,
    ...failed("a"),
    ...failed("b"),
    ...failed("c"),
  ]).stop;
  assert.equal(verdict?.tool, "read_file");
  assert.equal(verdict?.count, 3);
  assert.ok(verdict?.message.includes("3 раза подряд"));
});

void test("success resets the streak, including a JSON success", () => {
  const jsonSuccess = pair(
    "ok",
    "read_file",
    {},
    { type: "json", value: { ok: true } },
  );
  assert.equal(
    inspectRepeatGuard([
      user,
      ...failed("a"),
      ...failed("b"),
      ...success("ok"),
      ...failed("c"),
    ]).stop,
    undefined,
  );
  assert.equal(
    inspectRepeatGuard([
      user,
      ...failed("a"),
      ...failed("b"),
      ...jsonSuccess,
      ...failed("c"),
    ]).stop,
    undefined,
  );
});

void test("seven varied failures pass; eight of one tool stop", () => {
  const attempts = Array.from({ length: 8 }, (_, i) =>
    failed(String(i), { path: String(i) }),
  );
  assert.equal(
    inspectRepeatGuard([user, ...attempts.slice(0, 7).flat()]).stop,
    undefined,
  );
  assert.equal(inspectRepeatGuard([user, ...attempts.flat()]).stop?.count, 8);
});

void test("timestamps, numeric IDs and tmp paths do not split one error", () => {
  const p = [
    ...failed("a"),
    ...pair(
      "b",
      "read_file",
      { path: "x" },
      {
        type: "error-text",
        value: "ENOENT /tmp/other-9876 at 06:01:49 pid 76543",
      },
    ),
    ...pair(
      "c",
      "read_file",
      { path: "x" },
      {
        type: "error-text",
        value: "ENOENT /private/tmp/third-3456 at 06:02:20 pid 87654",
      },
    ),
  ];
  assert.equal(inspectRepeatGuard([user, ...p]).stop?.count, 3);
});

void test("new user turn cuts the series; 100 successful calls pass", () => {
  assert.equal(
    inspectRepeatGuard([
      user,
      ...failed("a"),
      ...failed("b"),
      user,
      ...failed("c"),
    ]).stop,
    undefined,
  );
  assert.equal(
    inspectRepeatGuard([
      user,
      ...Array.from({ length: 100 }, (_, i) => success(String(i))).flat(),
    ]).stop,
    undefined,
  );
});

void test("JSON key order is canonical; different tools and error text break exact streak", () => {
  const same = [
    ...pair(
      "a",
      "read_file",
      { b: 2, a: { z: 1, y: 2 } },
      { type: "error-json", value: { error: "denied" } },
    ),
    ...pair(
      "b",
      "read_file",
      { a: { y: 2, z: 1 }, b: 2 },
      { type: "error-json", value: { error: "denied" } },
    ),
    ...pair(
      "c",
      "read_file",
      { a: { y: 2, z: 1 }, b: 2 },
      { type: "error-json", value: { error: "denied" } },
    ),
  ];
  assert.equal(inspectRepeatGuard([user, ...same]).stop?.count, 3);
  assert.equal(
    inspectRepeatGuard([
      user,
      ...failed("a"),
      ...pair("b", "write_file", {}, { type: "error-text", value: "bad" }),
      ...failed("c"),
    ]).stop,
    undefined,
  );
});

void test("a string argument remains distinct from a numeric argument", () => {
  const p = [
    ...pair(
      "a",
      "read_file",
      { offset: "123" },
      { type: "error-text", value: "bad" },
    ),
    ...pair(
      "b",
      "read_file",
      { offset: 123 },
      { type: "error-text", value: "bad" },
    ),
    ...pair(
      "c",
      "read_file",
      { offset: "123" },
      { type: "error-text", value: "bad" },
    ),
  ];
  assert.equal(inspectRepeatGuard([user, ...p]).stop, undefined);
});

void test("ordinary text and JSON outputs with ok:false or nonempty error are failures", () => {
  const p = [
    ...pair(
      "a",
      "bash",
      {},
      { type: "json", value: { ok: false, error: "failed" } },
    ),
    ...pair(
      "b",
      "bash",
      {},
      { type: "text", value: '{"error":"failed","ok":false}' },
    ),
    ...pair("c", "bash", {}, { type: "json", value: { error: "failed" } }),
  ];
  assert.equal(inspectRepeatGuard([user, ...p]).stop?.count, 3);
});

void test("unpaired tool results and outstanding calls never trigger a stop", () => {
  const orphan = {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "orphan",
        toolName: "read_file",
        output: { type: "error-text", value: "bad" },
      },
    ],
  } as LanguageModelV4Prompt[number];
  assert.equal(
    inspectRepeatGuard([user, orphan, orphan, orphan]).stop,
    undefined,
  );
  const pending = {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: "pending",
        toolName: "read_file",
        input: {},
      },
    ],
  } as LanguageModelV4Prompt[number];
  assert.equal(
    inspectRepeatGuard([
      user,
      ...failed("a"),
      ...failed("b"),
      ...failed("c"),
      pending,
    ]).stop,
    undefined,
  );
});

void test("seed=76001: every history ending in success passes", () => {
  fc.assert(
    fc.property(fc.array(fc.boolean(), { maxLength: 30 }), (states) => {
      const history = states.flatMap((bad, i) =>
        bad ? failed(String(i)) : success(String(i)),
      );
      return (
        inspectRepeatGuard([user, ...history, ...success("last")]).stop ===
        undefined
      );
    }),
    { seed: 76001 },
  );
});

void test("seed=76002: any history ending in at least three identical failures stops", () => {
  fc.assert(
    fc.property(
      fc.array(fc.boolean(), { maxLength: 30 }),
      fc.integer({ min: 3, max: 12 }),
      (states, count) => {
        const history = states.flatMap((bad, i) =>
          bad ? failed(String(i), { path: String(i) }) : success(String(i)),
        );
        const suffix = Array.from({ length: count }, (_, i) =>
          failed(`tail-${i}`, { path: "same" }),
        ).flat();
        return (
          inspectRepeatGuard([user, ...history, ...suffix]).stop !== undefined
        );
      },
    ),
    { seed: 76002 },
  );
});

void test("stream middleware skips model on stop and passes model stream through otherwise", async () => {
  let called = 0;
  const model = wrapLanguageModel({
    model: new MockLanguageModelV4({
      doStream: () => {
        called++;
        return Promise.resolve({
          stream: new ReadableStream<LanguageModelV4StreamPart>({
            start(c) {
              c.enqueue({ type: "text-start", id: "real" });
              c.enqueue({ type: "text-delta", id: "real", delta: "real" });
              c.close();
            },
          }),
        });
      },
    }),
    middleware: repeatGuardMiddleware,
  });
  const stopped = await convertReadableStreamToArray(
    (
      await model.doStream({
        prompt: [user, ...failed("a"), ...failed("b"), ...failed("c")],
      })
    ).stream,
  );
  assert.equal(called, 0);
  assert.equal(
    stopped.some((part) => part.type === "tool-call"),
    false,
  );
  assert.equal(
    stopped.find((part) => part.type === "finish")?.finishReason.unified,
    "stop",
  );
  assert.ok(
    stopped.some(
      (part) => part.type === "text-delta" && part.delta.includes("read_file"),
    ),
  );
  const passed = await convertReadableStreamToArray(
    (await model.doStream({ prompt: [user, ...failed("a")] })).stream,
  );
  assert.equal(called, 1);
  assert.deepEqual(passed, [
    { type: "text-start", id: "real" },
    { type: "text-delta", id: "real", delta: "real" },
  ]);
});

void test("generate middleware returns only text with zero usage and does not call model", async () => {
  let called = 0;
  const model = wrapLanguageModel({
    model: new MockLanguageModelV4({
      doGenerate: () => {
        called++;
        throw new Error("model should not run");
      },
    }),
    middleware: repeatGuardMiddleware,
  });
  const result = await model.doGenerate({
    prompt: [user, ...failed("gen-a"), ...failed("gen-b"), ...failed("gen-c")],
  });
  assert.equal(called, 0);
  assert.deepEqual(
    result.content.map((part) => part.type),
    ["text"],
  );
  assert.equal(result.finishReason.unified, "stop");
  assert.equal(result.usage.inputTokens.total, 0);
  assert.equal(result.usage.outputTokens.total, 0);
});

void test("a rejected call is journaled even when no turn scope exists", () => {
  traceRepeatGuard("tool.rejected", {
    tool: "fallback_probe",
    errorHead: "invalid input",
  });
  const lines = readFileSync(traceFilePath(traceDay(), testDataDir), "utf8")
    .trim()
    .split("\n");
  const event = lines
    .map(
      (line) =>
        JSON.parse(line) as {
          kind: string;
          name: string;
          turn: string;
          data: { tool?: string };
        },
    )
    .find((item) => item.data.tool === "fallback_probe");
  assert.equal(event?.kind, "tool");
  assert.equal(event?.name, "rejected");
  assert.equal(event?.turn, "");
});

void test("trace logs each rejected call ID once and records the stop without arguments", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-repeat-guard-"));
  const previous = process.env.ASSISTANT_DATA_DIR;
  process.env.ASSISTANT_DATA_DIR = dir;
  try {
    const model = wrapLanguageModel({
      model: new MockLanguageModelV4({
        doStream: () =>
          Promise.resolve({
            stream: new ReadableStream<LanguageModelV4StreamPart>({
              start(c) {
                c.close();
              },
            }),
          }),
      }),
      middleware: repeatGuardMiddleware,
    });
    const prompts = [
      [user, ...failed("journal-a")],
      [user, ...failed("journal-a"), ...failed("journal-b")],
      [
        user,
        ...failed("journal-a"),
        ...failed("journal-b"),
        ...failed("journal-c"),
      ],
    ];
    await traceWithScope(
      { turn: "turn-76", session: "session-76" },
      async () => {
        for (const prompt of [...prompts, prompts[2]]) {
          await convertReadableStreamToArray(
            (await model.doStream({ prompt })).stream,
          );
        }
      },
    );
    const events = readFileSync(traceFilePath(traceDay(), dir), "utf8")
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            kind: string;
            name: string;
            turn: string;
            data: Record<string, unknown>;
          },
      );
    assert.equal(
      events.filter((e) => e.kind === "tool" && e.name === "rejected").length,
      3,
    );
    assert.equal(
      events.filter((e) => e.kind === "guard" && e.name === "repeat_stop")
        .length,
      2,
    );
    for (const event of events) {
      assert.equal(event.turn, "turn-76");
      assert.ok(String(event.data.errorHead).length <= 160);
      assert.equal("input" in event.data, false);
    }
  } finally {
    if (previous === undefined) delete process.env.ASSISTANT_DATA_DIR;
    else process.env.ASSISTANT_DATA_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
