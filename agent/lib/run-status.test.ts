/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns test registration promises. */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { acquireFileLockSync, releaseFileLock } from "./fs-atomic.ts";

const dataDir = mkdtempSync(join(tmpdir(), "iva-run-status-"));
process.env.ASSISTANT_DATA_DIR = dataDir;
process.env.IVA_RUN_STATUS_LOCK_STALE_MS = "300";
process.env.IVA_RUN_STATUS_LOCK_TIMEOUT_MS = "150";
const modulePath = fileURLToPath(new URL("./run-status.ts", import.meta.url));
const status = (await import(
  `${pathToFileURL(modulePath).href}?test=${Date.now()}`
)) as typeof import("./run-status.ts");

test("legacy whole-map is read and each touched key migrates independently", () => {
  const legacy = join(dataDir, "run-status.json");
  writeFileSync(
    legacy,
    JSON.stringify({
      "legacy-a:": { status: "running", sessionId: "a" },
      "legacy-b:7": { status: "running", sessionId: "b" },
    }),
  );

  assert.equal(status.getChatStatus("legacy-a:")?.sessionId, "a");
  status.setChatStatus("legacy-a:", { status: "idle", sessionId: null });

  // The untouched key remains available from the legacy file.
  assert.equal(status.getChatStatus("legacy-b:7")?.sessionId, "b");
  // Once migrated, the per-chat file wins over stale legacy bytes.
  writeFileSync(
    legacy,
    JSON.stringify({
      "legacy-a:": { status: "running", sessionId: "stale" },
      "legacy-b:7": { status: "running", sessionId: "b" },
    }),
  );
  assert.equal(status.getChatStatus("legacy-a:")?.status, "idle");
  assert.equal(status.getChatStatus("legacy-a:")?.sessionId, undefined);
});

test("the first normal rewrite removes the retired routing field", () => {
  const legacy = join(dataDir, "run-status.json");
  const key = "legacy-routing:";
  writeFileSync(
    legacy,
    JSON.stringify({
      [key]: {
        status: "running",
        sessionId: "session-current",
        [status.RETIRED_SESSION_ROUTING_FIELD]: "retired-value",
      },
    }),
  );

  const rewritten = status.setChatStatus(key, { status: "idle" });

  assert.equal(rewritten[status.RETIRED_SESSION_ROUTING_FIELD], undefined);
  assert.equal(
    status.getChatStatus(key)?.[status.RETIRED_SESSION_ROUTING_FIELD],
    undefined,
  );
  assert.equal(rewritten.sessionId, "session-current");
});

test("update rewrite expires every valid chat and preserves session cleanup fields", () => {
  const key = "update-rewrite:";
  status.setChatStatus(key, {
    status: "idle",
    sessionId: "session-to-reset",
    statusMessageId: 4242,
    custom: "preserved",
  });
  const dir = join(dataDir, "run-status.d");
  writeFileSync(join(dir, "damaged.json"), "{not json", { mode: 0o600 });

  status.rewriteRunStatusesForUpdate(dataDir);

  assert.equal(status.isRunning(key), false);
  assert.deepEqual(status.getChatStatus(key), {
    generation: 1,
    status: "running",
    updatedAt: 0,
    sessionId: "session-to-reset",
    statusMessageId: 4242,
    custom: "preserved",
  });
  assert.equal(readFileSync(join(dir, "damaged.json"), "utf8"), "{not json");
});

test("distinct chats survive bounded concurrent writers", async () => {
  const workers = 8;
  const keysPerWorker = 100;
  const workerSource = `
    import { setChatStatus } from ${JSON.stringify(pathToFileURL(modulePath).href)};
    const worker = Number(process.argv[1]);
    const count = Number(process.argv[2]);
    for (let i = 0; i < count; i++) {
      setChatStatus("worker-" + worker + "-" + i + ":", {
        status: "running",
        sessionId: "session-" + worker + "-" + i
      });
    }
  `;
  const runs = Array.from(
    { length: workers },
    (_, worker) =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            workerSource,
            String(worker),
            String(keysPerWorker),
          ],
          {
            env: { ...process.env, ASSISTANT_DATA_DIR: dataDir },
            stdio: ["ignore", "ignore", "pipe"],
          },
        );
        let stderr = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.once("error", reject);
        child.once("exit", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`worker ${worker} exited ${code}: ${stderr}`));
        });
      }),
  );
  await Promise.all(runs);

  for (let worker = 0; worker < workers; worker++) {
    for (let i = 0; i < keysPerWorker; i++) {
      assert.equal(
        status.getChatStatus(`worker-${worker}-${i}:`)?.sessionId,
        `session-${worker}-${i}`,
      );
    }
  }
});

test("conditional update checks sessionId under the same per-chat lock", () => {
  status.setChatStatus("cas:", {
    status: "running",
    sessionId: "fresh-session",
    turnId: "fresh-turn",
  });

  assert.equal(
    status.setChatStatusIf(
      "cas:",
      { sessionId: "retired-session" },
      { status: "idle", turnId: null },
    ),
    null,
  );
  assert.equal(status.getChatStatus("cas:")?.status, "running");
  assert.equal(status.getChatStatus("cas:")?.turnId, "fresh-turn");

  assert.ok(
    status.setChatStatusIf(
      "cas:",
      { status: "running", sessionId: "fresh-session" },
      { status: "idle", sessionId: null, turnId: null },
    ),
  );
  assert.equal(status.getChatStatus("cas:")?.status, "idle");
});

test("each accepted status write advances a monotonic per-chat generation", () => {
  const first = status.setChatStatus("generation:", {
    status: "running",
    sessionId: "session-1",
  });
  const second = status.setChatStatus("generation:", {
    status: "idle",
    sessionId: null,
  });

  assert.equal(first.generation, 1);
  assert.equal(second.generation, 2);
});

test("a write with no fields still refreshes updatedAt (the turn heartbeat rides on this)", () => {
  // Пульс живого хода (markTelegramTurnAlive) шлёт ПУСТОЙ патч: сообщать ему нечего,
  // кроме «ход ещё жив», а жизнь измеряется возрастом updatedAt. Если запись без полей
  // перестанет двигать updatedAt, молчаливый длинный ход снова начнёт жаться жнецом.
  const before = status.setChatStatus("heartbeat:", {
    status: "running",
    sessionId: "session-1",
  });
  assert.equal(before.status, "running");
  // Обе записи умещаются в одну миллисекунду, и тогда «updatedAt двинулся» нечем
  // измерить. Ждём смену часов, а не таймер: ограничено одной миллисекундой и не
  // зависит от загрузки машины.
  const startedAt = Date.now();
  while (Date.now() === startedAt) {
    /* смена миллисекунды */
  }

  const beat = status.setChatStatusIf(
    "heartbeat:",
    { status: "running", sessionId: "session-1" },
    {},
  );
  assert.ok(beat);
  assert.equal(beat.status, "running");
  assert.equal(beat.sessionId, "session-1");
  assert.equal(beat.generation, (before.generation as number) + 1);
  assert.ok((beat.updatedAt as number) > (before.updatedAt as number));
  assert.ok(Date.now() - (beat.updatedAt as number) < 60_000);

  // Чужая сессия пульс не пишет: CAS не совпал.
  assert.equal(
    status.setChatStatusIf(
      "heartbeat:",
      { status: "running", sessionId: "session-2" },
      {},
    ),
    null,
  );
});

test("per-chat status enumeration returns decoded keys and records", () => {
  const dir = join(dataDir, "run-status.d");
  status.setChatStatus("listed:-7", {
    status: "running",
    sessionId: "listed-session",
  });
  writeFileSync(
    join(dir, ".json"),
    JSON.stringify({ status: "running", sessionId: "empty-key" }),
  );

  const records = status.listChatStatuses();
  const listed = records.find(
    ({ chatKey }: { chatKey: string }) => chatKey === "listed:-7",
  );
  assert.equal(listed?.status.status, "running");
  assert.equal(listed?.status.sessionId, "listed-session");
  assert.equal(
    records.some(({ chatKey }: { chatKey: string }) => chatKey === ""),
    false,
  );
});

test("a stale per-chat lock is reclaimed after a crashed writer", () => {
  const key = "stale-lock:";
  const encoded = Buffer.from(key, "utf8").toString("base64url");
  const dir = join(dataDir, "run-status.d");
  const lock = join(dir, `${encoded}.json.lock`);
  mkdirSync(dir, { recursive: true });
  const crashed = acquireFileLockSync(lock, { timeoutMs: 100, mode: 0o600 });
  assert.ok(crashed);
  const old = new Date(Date.now() - 31_000);
  utimesSync(lock, old, old);

  status.setChatStatus(key, { status: "running", sessionId: "successor" });
  releaseFileLock(crashed);

  assert.equal(status.getChatStatus(key)?.sessionId, "successor");
  assert.equal(existsSync(lock), false);
  assert.equal(
    readdirSync(dir).some((name) => name.includes(".tmp-")),
    false,
  );
});

test("a fresh orphan lock fails within a bounded timeout", () => {
  const key = "fresh-lock:";
  const encoded = Buffer.from(key, "utf8").toString("base64url");
  const dir = join(dataDir, "run-status.d");
  const lock = join(dir, `${encoded}.json.lock`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(lock, "live-or-recent-owner", { mode: 0o600 });

  const started = Date.now();
  assert.throws(
    () => status.setChatStatus(key, { status: "running" }),
    /run-status lock timeout/,
  );
  assert.ok(Date.now() - started >= 100);
  assert.ok(Date.now() - started < 2_000);
  rmSync(lock, { force: true });
});

test("one corrupt per-chat file is quarantined without blocking neighbors", () => {
  const corruptKey = "corrupt:";
  const neighborKey = "neighbor:";
  status.setChatStatus(neighborKey, {
    status: "running",
    sessionId: "neighbor-session",
  });

  const dir = join(dataDir, "run-status.d");
  const encoded = Buffer.from(corruptKey, "utf8").toString("base64url");
  const file = join(dir, `${encoded}.json`);
  const corrupt = '{"status":"running"';
  writeFileSync(file, corrupt, { mode: 0o600 });

  assert.equal(status.getChatStatus(corruptKey), null);
  assert.equal(
    status.getChatStatus(neighborKey)?.sessionId,
    "neighbor-session",
  );
  status.setChatStatus(corruptKey, { status: "idle" });
  assert.equal(status.getChatStatus(corruptKey)?.status, "idle");

  const backups = readdirSync(dir).filter((name) =>
    name.startsWith(`${encoded}.json.corrupt-`),
  );
  assert.equal(backups.length, 1);
  // Compare after the healthy replacement exists: returning {} and overwriting
  // the damaged file would lose these bytes.
  assert.equal(readFileSync(join(dir, backups[0]), "utf8"), corrupt);
});

test(
  "an operational read error is rethrown and the status file is not quarantined",
  {
    skip:
      process.getuid?.() === 0 ? "root bypasses file permission bits" : false,
  },
  () => {
    const key = "unreadable:";
    status.setChatStatus(key, { status: "running", sessionId: "keep" });
    const dir = join(dataDir, "run-status.d");
    const encoded = Buffer.from(key, "utf8").toString("base64url");
    const file = join(dir, `${encoded}.json`);
    chmodSync(file, 0o000);

    try {
      assert.throws(
        () => status.getChatStatus(key),
        (error: unknown) =>
          error !== null &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "EACCES",
      );
      assert.equal(existsSync(file), true);
      assert.equal(
        readdirSync(dir).some((name) =>
          name.startsWith(`${encoded}.json.corrupt-`),
        ),
        false,
      );
    } finally {
      chmodSync(file, 0o600);
    }
  },
);
