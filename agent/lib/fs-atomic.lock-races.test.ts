/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Порядки событий из контрпримеров TLC к модели замка (T95) на настоящем коде.
// (а) — контракт 3 (specs/FileLock.tla): параллельная уборка может
// снести пустую папку живого претендента, претендент повторяет, двух держателей не
// бывает. Контрпример раунда 1 — коммит 6b8a8978 (ветка feat/t95-filelock-tla-r1).
// (б) — сердцебиение (specs/FileLock.tla): живой держатель асинхронного лока не
// протухает, пока его event loop свободен; упавший, зависший дольше LOCK_MAX_HOLD_MS
// и заблокировавший свой event loop дольше staleMs — протухают.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  LOCK_MAX_HOLD_MS,
  acquireFileLock,
  acquireFileLockSync,
  releaseFileLock,
} from "./fs-atomic.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const HARNESS = join(ROOT, "scripts/fixtures/lock-race-harness.ts");
const UTIMES_FIXTURE = join(ROOT, "scripts/fixtures/lock-heartbeat-utimes.ts");
// chmod не ограничивает root: у него ошибки прав не бывает, тест на неё пропускается.
const isRoot = () => process.getuid?.() === 0;
const rootSkip = { skip: isRoot() && "root ignores mode bits" };
const FS_ATOMIC = fileURLToPath(new URL("./fs-atomic.ts", import.meta.url));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function lockDir(t: { after: (fn: () => void) => void }): string {
  const root = mkdtempSync(join(tmpdir(), "iva-lock-races-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  return root;
}

// Держатель в другом процессе: берёт лок с staleMs 300, печатает HELD, дальше body.
function holderProcess(lock: string, body: string) {
  const code = `const m = await import(${JSON.stringify(FS_ATOMIC)});
    const held = await m.acquireFileLock(${JSON.stringify(lock)}, { staleMs: 300 });
    console.log(held ? "HELD" : "NOLOCK");
    ${body}`;
  const child = spawn(
    process.execPath,
    ["--input-type=module", "--eval", code],
    {
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  const exited = new Promise((resolve) => child.on("exit", resolve));
  const held = new Promise<string>((resolve) =>
    child.stdout.once("data", (chunk) => resolve(String(chunk).trim())),
  );
  return { child, exited, held };
}

// Трасса fast-3p (20 шагов): папка упавшего протухла; два уборщика увидели её пустой и
// той же; первый снёс её, живой претендент создал свою; rmdir второго снёс уже её.
test("a stale-lock cleaner may remove a contender's fresh directory: the contender retries, never two holders", (t) => {
  const run = spawnSync(
    process.execPath,
    ["--experimental-test-module-mocks", HARNESS, lockDir(t)],
    { encoding: "utf8" },
  );
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout) as Record<string, unknown>;
  assert.equal(result.victimDirRemoved, true, "the race was replayed");
  assert.equal(result.victimHeld, true, "the contender took the lock on retry");
  assert.equal(
    result.cleanerHeld,
    false,
    "two live holders of one lock at once",
  );
  assert.equal(result.owners, 1);
});

// Трасса slow-2p (25 шагов): держатель жив, но думает дольше staleMs.
test("a live holder slower than staleMs keeps the lock to itself while its heartbeat runs", async (t) => {
  const lock = join(lockDir(t), "state.lock");
  const holder = await acquireFileLock(lock, { staleMs: 300 });
  assert.ok(holder);
  await new Promise((resolve) => setTimeout(resolve, 900));

  const second = await acquireFileLock(lock, { staleMs: 300, timeoutMs: 100 });
  const holderOwnerKept = readdirSync(lock).some((name) =>
    name.endsWith(holder.token),
  );
  if (second) releaseFileLock(second);
  releaseFileLock(holder);
  const after = await acquireFileLock(lock, { staleMs: 300, timeoutMs: 500 });
  if (after) releaseFileLock(after);

  assert.equal(
    holderOwnerKept,
    true,
    "the live holder's owner entry was removed",
  );
  assert.equal(second, null, "two live holders of one lock at once");
  assert.ok(after, "after release the lock is free");
});

test("the heartbeat does not keep a process alive", (t) => {
  const lock = join(lockDir(t), "state.lock");
  const code = `const m = await import(${JSON.stringify(FS_ATOMIC)});
    const held = await m.acquireFileLock(${JSON.stringify(lock)}, { staleMs: 60 });
    if (!held) process.exit(3);`;
  const run = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", code],
    { encoding: "utf8", timeout: 5_000 },
  );
  assert.equal(run.signal, null, "the process hung on the heartbeat timer");
  assert.equal(run.status, 0, run.stderr);
});

// Сердцебиение бьётся только за свой owner-entry: если в каталоге уже чужой (упавший)
// владелец, прежний держатель не держит его свежим, и лок забирают через staleMs.
test("the heartbeat does not keep a directory fresh once the holder's owner entry is gone", async (t) => {
  const lock = join(lockDir(t), "state.lock");
  const holder = await acquireFileLock(lock, { staleMs: 300 });
  assert.ok(holder);
  rmSync(join(lock, `.owner-${holder.token}`));
  writeFileSync(join(lock, `.owner-${randomUUID()}`), "");

  await new Promise((resolve) => setTimeout(resolve, 900));
  const next = await acquireFileLock(lock, { staleMs: 300, timeoutMs: 300 });
  if (next) releaseFileLock(next);
  releaseFileLock(holder);

  assert.ok(
    next,
    "a crashed owner's lock stayed fresh behind a stale heartbeat",
  );
});

// Период: раз в staleMs/3. Мутант «период = staleMs» доводит возраст до staleMs,
// мутант «мс вместо с в utimes» уносит mtime в будущее.
test("the heartbeat keeps a live holder's directory younger than staleMs/2 and never in the future", async (t) => {
  const lock = join(lockDir(t), "state.lock");
  const holder = await acquireFileLock(lock, { staleMs: 1_200 });
  assert.ok(holder);
  let oldest = 0;
  let newest = 0;
  const started = Date.now();
  while (Date.now() - started < 2_600) {
    const age = Date.now() - statSync(lock).mtimeMs;
    oldest = Math.max(oldest, age);
    newest = Math.min(newest, age);
    await sleep(10);
  }
  releaseFileLock(holder);
  assert.ok(oldest < 600, `directory age reached ${oldest} ms`);
  assert.ok(newest > -1_000, `directory mtime ${-newest} ms in the future`);
});

test("a holder killed after its heartbeat ticked is taken over after staleMs", async (t) => {
  const lock = join(lockDir(t), "state.lock");
  const holder = holderProcess(lock, "setInterval(() => {}, 1_000);");
  assert.equal(await holder.held, "HELD");
  await sleep(500);
  holder.child.kill("SIGKILL");
  await holder.exited;
  const killedAt = Date.now();
  const age = killedAt - statSync(lock).mtimeMs;
  const next = await acquireFileLock(lock, { staleMs: 300, timeoutMs: 3_000 });
  const waited = Date.now() - killedAt;
  if (next) releaseFileLock(next);
  assert.ok(age > -1_000 && age < 300, `directory age ${age} ms at the kill`);
  assert.ok(next, "a crashed holder's lock was never taken over");
  assert.ok(waited < 1_500, `take-over took ${waited} ms`);
});

test("a second release of an old lock does not stop the new holder's heartbeat", async (t) => {
  const lock = join(lockDir(t), "state.lock");
  const first = await acquireFileLock(lock, { staleMs: 150 });
  assert.ok(first);
  releaseFileLock(first);
  const second = await acquireFileLock(lock, { staleMs: 150 });
  assert.ok(second);
  releaseFileLock(first);
  await sleep(450);
  const next = await acquireFileLock(lock, { staleMs: 150, timeoutMs: 100 });
  if (next) releaseFileLock(next);
  releaseFileLock(second);
  assert.equal(
    next,
    null,
    "the old release stopped the new holder's heartbeat",
  );
});

test("a release that cannot remove its owner entry still stops the heartbeat, so the orphan expires", async (t) => {
  const lock = join(lockDir(t), "state.lock");
  const holder = await acquireFileLock(lock, { staleMs: 150 });
  assert.ok(holder);
  chmodSync(lock, 0o500);
  releaseFileLock(holder);
  chmodSync(lock, 0o700);
  await sleep(400);
  const next = await acquireFileLock(lock, { staleMs: 150, timeoutMs: 200 });
  if (next) releaseFileLock(next);
  assert.ok(next, "the released holder's heartbeat kept its orphan fresh");
});

// Гасит сердцебиение только ENOENT/ENOTDIR (лока нет); прочие ошибки — одна строка stderr.
test("EACCES keeps the heartbeat running", rootSkip, async (t) => {
  const lock = join(lockDir(t), "state.lock");
  const holder = await acquireFileLock(lock, { staleMs: 300 });
  assert.ok(holder);
  const stderr = t.mock.method(process.stderr, "write", () => true);
  chmodSync(lock, 0o600); // lstat owner-файла: EACCES
  await sleep(250);
  chmodSync(lock, 0o700);
  await sleep(700);
  const next = await acquireFileLock(lock, { staleMs: 300, timeoutMs: 100 });
  if (next) releaseFileLock(next);
  releaseFileLock(holder);
  const lines = stderr.mock.calls.map((call) => String(call.arguments[0]));
  stderr.mock.restore();
  assert.equal(next, null, "one EACCES switched the heartbeat off for good");
  assert.equal(
    lines.filter((line) => line.includes("heartbeat EACCES")).length,
    1,
  );
});

// staleMs ≤ 0 делал бы любой лок брошенным сразу (два писателя): TypeError до mkdir в обоих API.
test("staleMs must be a positive finite number in both APIs, before anything is created", async (t) => {
  const dir = lockDir(t);
  for (const staleMs of [Infinity, NaN, 0, -1]) {
    const lock = join(dir, `${staleMs}`, "state.lock");
    await assert.rejects(acquireFileLock(lock, { staleMs }), TypeError);
    assert.throws(() => acquireFileLockSync(lock, { staleMs }), TypeError);
    assert.equal(existsSync(join(dir, `${staleMs}`)), false, `${staleMs}`);
  }
});

// Нижняя граница периода: staleMs в единицы мс не даёт горячего цикла.
test("a tiny staleMs does not make the heartbeat tick faster than every 100 ms", async (t) => {
  const lock = join(lockDir(t), "state.lock");
  t.mock.timers.enable({
    apis: ["setInterval", "setTimeout", "Date"],
    now: Date.now(),
  });
  const holder = await acquireFileLock(lock, { staleMs: 1 });
  assert.ok(holder);
  const created = statSync(lock).mtimeMs;
  t.mock.timers.tick(99);
  const at99 = statSync(lock).mtimeMs;
  t.mock.timers.tick(1);
  const at100 = statSync(lock).mtimeMs;
  t.mock.timers.reset();
  releaseFileLock(holder);
  assert.equal(at99, created, "the heartbeat ticked before 100 ms");
  assert.notEqual(at100, created, "the heartbeat did not tick at 100 ms");
});

test("staleMs must be finite, and a huge one does not overflow the heartbeat timer", async (t) => {
  const lock = join(lockDir(t), "state.lock");
  await assert.rejects(acquireFileLock(lock, { staleMs: Infinity }), TypeError);
  const warnings: string[] = [];
  const onWarning = (warning: Error) => warnings.push(warning.name);
  process.on("warning", onWarning);
  t.after(() => process.off("warning", onWarning));
  const holder = await acquireFileLock(lock, { staleMs: 3 * 2 ** 31 });
  assert.ok(holder);
  const before = statSync(lock, { bigint: true }).mtimeNs;
  await sleep(100);
  const after = statSync(lock, { bigint: true }).mtimeNs;
  releaseFileLock(holder);
  assert.equal(after, before, "the heartbeat ran in a 1 ms loop");
  assert.deepEqual(warnings, []);
});

// Граница контракта: сердцебиение — таймер того же event loop. Держатель, занявший
// свой event loop дольше staleMs, не бьётся, и лок забирают (зелёный = контракт).
test("a holder that blocks its own event loop longer than staleMs loses the lock", async (t) => {
  const lock = join(lockDir(t), "state.lock");
  const holder = holderProcess(
    lock,
    `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000);
    m.releaseFileLock(held);`,
  );
  assert.equal(await holder.held, "HELD");
  const next = await acquireFileLock(lock, { staleMs: 300, timeoutMs: 1_500 });
  await holder.exited;
  const owners = readdirSync(lock);
  if (next) releaseFileLock(next);
  assert.ok(next, "a holder with a blocked event loop kept the lock");
  assert.deepEqual(
    owners,
    [`.owner-${next.token}`],
    "the late release removed the new owner",
  );
});

// Предохранитель: живой, но зависший держатель не держит лок вечно.
test("after LOCK_MAX_HOLD_MS the heartbeat stops, so a hung live holder's lock expires", async (t) => {
  const lock = join(lockDir(t), "state.lock");
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
  const holder = await acquireFileLock(lock, { staleMs: 30_000 });
  assert.ok(holder);
  const stderr = t.mock.method(process.stderr, "write", () => true);
  t.mock.timers.tick(LOCK_MAX_HOLD_MS - 30_000);
  const freshAge = Date.now() - statSync(lock).mtimeMs;
  t.mock.timers.tick(60_000);
  const lastBeat = statSync(lock).mtimeMs;
  t.mock.timers.tick(60_000);
  const lines = stderr.mock.calls.map((call) => String(call.arguments[0]));
  stderr.mock.restore();
  const frozen = statSync(lock).mtimeMs === lastBeat;
  const staleAge = Date.now() - lastBeat;
  t.mock.timers.reset();
  releaseFileLock(holder);
  assert.ok(
    freshAge < 15_000,
    `before the limit the directory aged ${freshAge} ms`,
  );
  assert.ok(frozen, "the heartbeat kept running past LOCK_MAX_HOLD_MS");
  assert.ok(staleAge > 30_000, "the hung holder's lock did not expire");
  assert.equal(
    lines.filter((line) => line.includes("heartbeat off:")).length,
    1,
  );
});

// Предохранитель — свой таймер: срабатывает и при периоде сердцебиения дольше предела,
// а release до предела гасит и его.
test("the max-hold fuse fires on its own timer, even when the heartbeat period is longer than the limit", async (t) => {
  const dir = lockDir(t);
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
  const stderr = t.mock.method(process.stderr, "write", () => true);
  const lines = () =>
    stderr.mock.calls.filter((call) =>
      String(call.arguments[0]).includes("heartbeat off:"),
    ).length;
  const released = await acquireFileLock(join(dir, "a.lock"), {
    staleMs: 6 * LOCK_MAX_HOLD_MS,
  });
  assert.ok(released);
  releaseFileLock(released);
  const hung = await acquireFileLock(join(dir, "b.lock"), {
    staleMs: 6 * LOCK_MAX_HOLD_MS,
  });
  assert.ok(hung);
  const mtime = statSync(hung.path).mtimeMs;
  t.mock.timers.tick(LOCK_MAX_HOLD_MS - 1);
  const before = lines();
  t.mock.timers.tick(1);
  const atLimit = lines();
  t.mock.timers.tick(6 * LOCK_MAX_HOLD_MS);
  const later = lines();
  const touched = statSync(hung.path).mtimeMs !== mtime;
  stderr.mock.restore();
  t.mock.timers.reset();
  releaseFileLock(hung);
  assert.equal(before, 0, "the fuse fired early, or for the released lock");
  assert.equal(atLimit, 1, "the fuse did not fire at LOCK_MAX_HOLD_MS");
  assert.equal(later, 1, "the fuse fired more than once");
  assert.equal(touched, false, "a period longer than the limit still touched");
});

// Пропавший лок (ENOENT) или файл вместо папки (ENOTDIR) гасят таймер: вернувшийся на
// путь каталог со старым owner-файлом больше не освежается, stderr молчит.
for (const how of ["ENOENT", "ENOTDIR"] as const) {
  test(`${how} on the owner entry stops the heartbeat for good, silently`, async (t) => {
    const lock = join(lockDir(t), "state.lock");
    const holder = await acquireFileLock(lock, { staleMs: 150 });
    assert.ok(holder);
    const stderr = t.mock.method(process.stderr, "write", () => true);
    rmSync(lock, { recursive: true });
    if (how === "ENOTDIR") writeFileSync(lock, "x");
    await sleep(250);
    if (how === "ENOTDIR") rmSync(lock);
    mkdirSync(lock);
    writeFileSync(join(lock, `.owner-${holder.token}`), "");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    await sleep(400);
    const age = Date.now() - statSync(lock).mtimeMs;
    stderr.mock.restore();
    releaseFileLock(holder);
    assert.ok(
      age > 30_000,
      `the stopped heartbeat touched again: age ${age} ms`,
    );
    assert.deepEqual(
      stderr.mock.calls
        .map((call) => String(call.arguments[0]))
        .filter((line) => line.includes("heartbeat")),
      [],
    );
  });
}

// Ошибка utimes при живом owner-файле (инъекция EPERM/EIO/EACCES/EBUSY через mock.module
// в отдельном процессе): таймер жив, одна строка stderr, после ошибки каталог снова свежий.
test("a utimes error with the owner entry in place keeps the heartbeat: one stderr line, then fresh again", (t) => {
  const codes = ["EPERM", "EIO", "EACCES", "EBUSY"];
  const run = spawnSync(
    process.execPath,
    ["--experimental-test-module-mocks", UTIMES_FIXTURE, lockDir(t), ...codes],
    { encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout) as Record<
    string,
    {
      failed: number;
      after: number;
      age: number;
      contenderHeld: boolean;
      lines: string[];
    }
  >;
  for (const code of codes) {
    const r = result[code];
    assert.ok(r.failed >= 3, `${code}: ${r.failed} failing touches`);
    assert.ok(r.after >= 2, `${code}: ${r.after} touches after the error`);
    assert.ok(r.age < 200, `${code}: directory age ${r.age} ms`);
    assert.equal(r.contenderHeld, false, `${code}: the lock was taken over`);
    assert.equal(r.lines.length, 1, `${code}: ${JSON.stringify(r.lines)}`);
    assert.ok(
      r.lines[0].includes(code) && r.lines[0].includes(".lock"),
      r.lines[0],
    );
  }
});
