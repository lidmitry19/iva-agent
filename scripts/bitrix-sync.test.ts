import assert from "node:assert/strict";
import test from "node:test";
import { bitrixFailureMessage } from "./bitrix-sync.ts";

void test("Bitrix failure summary names safe task IDs and codes", () => {
  assert.equal(
    bitrixFailureMessage([{ taskId: "396187", code: "task_id_mismatch" }]),
    "daily sync has 1 failed task(s): 396187:task_id_mismatch",
  );
});

void test("Bitrix failure summary is bounded", () => {
  const message = bitrixFailureMessage(
    Array.from({ length: 7 }, (_, index) => ({
      taskId: String(100 + index),
      code: "gateway_unavailable",
    })),
  );
  assert.match(message, /100:gateway_unavailable/u);
  assert.doesNotMatch(message, /106:gateway_unavailable/u);
  assert.match(message, /\+2 more/u);
});
