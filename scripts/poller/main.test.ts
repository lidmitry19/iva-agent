import assert from "node:assert/strict";
import test from "node:test";

const { conflictBackoff } = await import("./main.ts");

void test("conflictBackoff alerts starting at 10 consecutive conflicts", () => {
  assert.equal(conflictBackoff(9).shouldAlert, false);
  assert.equal(conflictBackoff(10).shouldAlert, true);
});

void test("conflictBackoff sleep grows and caps at 60000", () => {
  assert.equal(conflictBackoff(1).sleepMs, 3000);
  assert.ok(conflictBackoff(2).sleepMs > conflictBackoff(1).sleepMs);
  assert.ok(conflictBackoff(5).sleepMs > conflictBackoff(3).sleepMs);
  for (let n = 1; n <= 20; n += 1) {
    assert.ok(conflictBackoff(n).sleepMs <= 60_000);
  }
  assert.equal(conflictBackoff(20).sleepMs, 60_000);
});

void test("conflictBackoff resets to a short sleep after conflicts clear", () => {
  assert.equal(conflictBackoff(15).sleepMs, 60_000);
  assert.equal(conflictBackoff(15).shouldAlert, true);
  assert.equal(conflictBackoff(0).sleepMs, 3000);
  assert.equal(conflictBackoff(0).shouldAlert, false);
  assert.equal(conflictBackoff(1).sleepMs, 3000);
  assert.equal(conflictBackoff(1).shouldAlert, false);
});
