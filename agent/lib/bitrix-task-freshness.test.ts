/* eslint-disable @typescript-eslint/no-floating-promises -- Node owns test registrations. */
import assert from "node:assert/strict";
import test from "node:test";
import { verifiedBriefTasks } from "./bitrix-task-freshness.ts";
import type { BriefTask, BitrixStatus } from "./bitrix-task-freshness.ts";

const NOW = Date.parse("2026-10-05T05:00:00Z");
const task = (id: number, link?: string, done = false): BriefTask => ({
  id,
  text: `local-${id}`,
  priority: "med",
  due: null,
  done,
  createdAt: "2026-10-01T00:00:00Z",
  ...(link ? { bitrixTaskId: link } : {}),
});
const status = (id: string, state = "in_progress"): BitrixStatus => ({
  id,
  title: `live-${id}`,
  status: state,
  deadline: "2026-10-06",
  checkedAt: new Date(NOW).toISOString(),
});

test("Brief uses live titles/deadlines, excludes closed tasks and preserves local tasks without mutation", async () => {
  const tasks = [
    task(1),
    task(2, "20", true),
    task(3, "30"),
    task(4, "40"),
    task(5, undefined, true),
  ];
  const before = structuredClone(tasks);
  const result = await verifiedBriefTasks(
    tasks,
    (id) =>
      Promise.resolve(
        status(
          id,
          id === "30" ? "completed" : id === "40" ? "declined" : "in_progress",
        ),
      ),
    () => NOW,
  );
  assert.deepEqual(
    result.tasks.map((t) => t.id),
    [1, 2],
  );
  assert.equal(result.tasks[1]?.text, "live-20");
  assert.equal(result.tasks[1]?.due, "2026-10-06");
  assert.equal(result.tasks[1]?.done, false);
  assert.deepEqual(result.freshness, {
    verified: 3,
    excluded: 2,
    unchecked: 0,
  });
  assert.equal(result.warning, null);
  assert.deepEqual(tasks, before);
});

test("deleted/denied/unavailable tasks never leak stale titles and do not suppress local tasks", async () => {
  for (const failure of ["deleted", "access_denied", "timeout"]) {
    const result = await verifiedBriefTasks(
      [task(1, "10"), task(2)],
      () => Promise.reject(new Error(failure)),
      () => NOW,
    );
    assert.deepEqual(
      result.tasks.map((t) => t.id),
      [2],
    );
    assert.deepEqual(result.freshness, {
      verified: 0,
      excluded: 0,
      unchecked: 1,
    });
    assert.match(result.warning ?? "", /не удалось проверить/u);
    assert.ok(!JSON.stringify(result).includes("local-1"));
  }
});

test("invalid, stale or mismatched remote responses are unverified", async () => {
  for (const patch of [
    { id: "other" },
    { status: "unknown" },
    { checkedAt: "invalid" },
    { checkedAt: new Date(NOW - 60_000).toISOString() },
  ]) {
    const result = await verifiedBriefTasks(
      [task(1, "10")],
      (id) => Promise.resolve({ ...status(id), ...patch }),
      () => NOW,
    );
    assert.equal(result.tasks.length, 0);
    assert.equal(result.freshness.unchecked, 1);
  }
});

test("review/deferred states remain distinguishable and each request has a bounded timeout", async () => {
  const timeouts: number[] = [];
  const result = await verifiedBriefTasks(
    [task(1, "10"), task(2, "20")],
    (id, timeout) => {
      timeouts.push(timeout);
      return Promise.resolve(
        status(id, id === "10" ? "supposed_completed" : "deferred"),
      );
    },
    () => NOW,
  );
  assert.deepEqual(
    result.tasks.map((t) => t.remoteStatus),
    ["supposed_completed", "deferred"],
  );
  assert.deepEqual(timeouts, [10_000, 10_000]);
});

test("overall time budget exhaustion skips further reads and returns an explicit warning", async () => {
  let clock = NOW;
  let reads = 0;
  const result = await verifiedBriefTasks(
    [task(1, "10"), task(2, "20")],
    () => {
      reads++;
      clock += 90_001;
      return Promise.reject(new Error("timeout"));
    },
    () => clock,
  );
  assert.equal(reads, 1);
  assert.equal(result.freshness.unchecked, 2);
});
