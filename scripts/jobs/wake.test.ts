/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Точка входа пробуждения (scripts/jobs/wake.ts:main) на настоящих файлах: настройки и
// jobs.json на диске, ход и Telegram подменены, часы закреплены. Держит подключение
// failureWaitsForBrief (не голый isQuietHour) и адресата — личный чат владельца, не
// TELEGRAM_DIGEST_CHAT_ID.
import "../fixtures/no-host-anthropic.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const ROOT = mkdtempSync(join(tmpdir(), "iva-jobs-wake-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));

const { main } = await import("./wake.ts");
const { jobFactsFile, readFacts, recordFact } =
  await import("#lib/job-facts.ts");

/** 02:00 UTC — тихий час владельца в зоне UTC. */
const NIGHT = Date.UTC(2026, 9, 5, 2, 0);
const STARTED = NIGHT - 60_000;

type Sent = { readonly chat: string; readonly text: string };

async function run(settings: unknown) {
  const dir = mkdtempSync(join(ROOT, "data-"));
  process.env.ASSISTANT_DATA_DIR = dir;
  writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
  await recordFact(
    jobFactsFile(dir),
    {
      name: "memory-night",
      startedAt: STARTED,
      finishedAt: NIGHT - 1000,
      ok: false,
      error: "exited 1",
      exitCode: 1,
      tail: "",
      acked: false,
      wake: null,
    },
    NIGHT,
  );
  const sent: Sent[] = [];
  const code = await main(
    ["memory-night", String(STARTED)],
    {
      TELEGRAM_BOT_TOKEN: "123:abc",
      TELEGRAM_ALLOWED_USER_IDS: "111, 222",
      TELEGRAM_DIGEST_CHAT_ID: "-100500",
      ASSISTANT_TIMEZONE: "UTC",
      AGENT_LANGUAGE: "ru",
    },
    {
      now: () => NIGHT,
      runTurn: () =>
        Promise.resolve({ status: "completed", message: "ночь упала" }),
      sendHtml: (_token, chat, text) => {
        sent.push({ chat, text: String(text) });
        return Promise.resolve({ ok: true, fellBack: false, error: "" });
      },
      log: () => undefined,
    },
  );
  const [fact] = await readFacts(jobFactsFile(dir));
  return { code, sent, wake: fact?.wake };
}

test("toggle off, quiet hour: the failure is told at once, to the owner's private chat", async () => {
  const { code, sent, wake } = await run({ proactive: { enabled: false } });
  assert.equal(code, 0);
  assert.deepEqual(sent, [{ chat: "111", text: "ночь упала" }]);
  assert.equal(wake?.status, "answered");
});

test("toggle on but no Brief slots, quiet hour: no Brief will come, the failure is told at once", async () => {
  const { sent, wake } = await run({ proactive: { briefTimes: [] } });
  assert.deepEqual(sent, [{ chat: "111", text: "ночь упала" }]);
  assert.equal(wake?.status, "answered");
});

test("toggle on, Brief slots, quiet hour: nothing sent, the failure waits for the morning Brief", async () => {
  const { code, sent, wake } = await run({});
  assert.equal(code, 0);
  assert.deepEqual(sent, []);
  assert.deepEqual(wake, {
    at: NIGHT,
    status: "empty",
    error: null,
    deferred: true,
  });
});
