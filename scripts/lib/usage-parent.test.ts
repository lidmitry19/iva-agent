// Строка шага ребёнка встроенного `agent` связана с ходом родителя: eve отдаёт родителя в
// ctx.session.parent, хук пишет его тремя полями. Строки основной сессии не меняются.
await import("./ts-esm-hooks.ts");
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const HOOK = (await import("../../agent/hooks/usage.ts")).default;
type StepHandler = (event: unknown, ctx: unknown) => void;
const STEP_COMPLETED = (HOOK as { events?: Record<string, unknown> }).events?.[
  "step.completed"
] as StepHandler;

const STEP = {
  data: {
    stepIndex: 0,
    turnId: "turn_0",
    usage: {
      inputTokens: 1200,
      outputTokens: 30,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  },
};

function rowsAfter(ctx: unknown): Record<string, unknown>[] {
  const dir = mkdtempSync(join(tmpdir(), "iva-usage-parent-"));
  const previous = process.env.ASSISTANT_DATA_DIR;
  process.env.ASSISTANT_DATA_DIR = dir;
  try {
    STEP_COMPLETED(STEP, ctx);
    return readFileSync(join(dir, "usage.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } finally {
    if (previous === undefined) delete process.env.ASSISTANT_DATA_DIR;
    else process.env.ASSISTANT_DATA_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

await test("шаг ребёнка несёт сессию, ход и вызов родителя", () => {
  const [row] = rowsAfter({
    session: {
      id: "child-1",
      parent: {
        callId: "call_9",
        rootSessionId: "root-1",
        sessionId: "root-1",
        turn: { id: "turn_4", sequence: 4 },
      },
    },
    channel: { kind: "subagent" },
  });
  assert.equal(row.source, "subagent");
  assert.equal(row.sessionId, "child-1");
  assert.equal(row.parentSessionId, "root-1");
  assert.equal(row.parentTurnId, "turn_4");
  assert.equal(row.parentCallId, "call_9");
});

await test("пустой id хода родителя берётся по sequence, как у eve", () => {
  const [row] = rowsAfter({
    session: {
      id: "child-2",
      parent: { callId: "c", sessionId: "root", turn: { id: "", sequence: 7 } },
    },
    channel: { kind: "subagent" },
  });
  assert.equal(row.parentTurnId, "turn_7");
});

await test("строка основной сессии прежняя: без полей родителя, порядок ключей тот же", () => {
  const [row] = rowsAfter({
    session: { id: "s1" },
    channel: { kind: "channel:telegram" },
  });
  assert.deepEqual(Object.keys(row), [
    "ts",
    "source",
    "provider",
    "model",
    "sessionId",
    "turnId",
    "step",
    "in",
    "out",
    "cacheRead",
    "cacheWrite",
    "total",
  ]);
});
