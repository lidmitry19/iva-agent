/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await -- Node's test runner owns registrations and async doubles preserve production boundaries. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { MODEL_PROVIDER_NAMES } from "#lib/model-provider.ts";
import { createCliRuntime } from "./runtime.ts";
import { ACCEPTED_PROVIDERS, createUpdateCommand } from "./update.ts";

type Runtime = ReturnType<typeof createCliRuntime>;
type UpdateFactoryOptions = Parameters<typeof createUpdateCommand>[0];
type UpdateOperations = NonNullable<UpdateFactoryOptions["operations"]>;

type TransactionState = {
  changed: boolean;
  outputTouched: boolean;
  hadLocalChanges: boolean;
  buildCode?: number;
  /** `update-compat.json` of the fetched tree; undefined means the tree carries none. */
  compatMarker?: string;
};

async function sandbox(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "iva-cli-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function assertOrder(events: readonly string[], expected: readonly string[]) {
  let offset = -1;
  for (const event of expected) {
    const next = events.indexOf(event, offset + 1);
    assert.notEqual(
      next,
      -1,
      `missing ${event} after ${events[offset] ?? "start"}`,
    );
    offset = next;
  }
}

function fakeSystemd(events: string[], activeUserbot = false) {
  return {
    query: (...args: string[]) => {
      events.push(`systemd.query:${args.join(" ")}`);
      return { code: 0, out: "" };
    },
    isEnabled: (unit: string) => {
      events.push(`systemd.isEnabled:${unit}`);
      return true;
    },
    isActive: (unit: string) => {
      events.push(`systemd.isActive:${unit}`);
      return unit === "iva-telegram-userbot.service" ? activeUserbot : true;
    },
    activate: (units: readonly string[]) => {
      events.push(`systemd.activate:${units.join(",")}`);
    },
    restart: (units: readonly string[]) => {
      events.push(`systemd.restart:${units.join(",")}`);
    },
    stop: (units: readonly string[]) => {
      events.push(`systemd.stop:${units.join(",")}`);
    },
    disableNow: (units: readonly string[]) => {
      events.push(`systemd.disableNow:${units.join(",")}`);
    },
    resetFailed: (units: readonly string[] = []) => {
      events.push(`systemd.resetFailed:${units.join(",")}`);
      return { code: 0, out: "" };
    },
    daemonReload: () => {
      events.push("systemd.daemonReload");
      return { code: 0, out: "" };
    },
  };
}

function runtimeFixture(
  root: string,
  events: string[],
  {
    systemdAvailable = false,
    activeUserbot = false,
    provider = "codex",
  }: {
    systemdAvailable?: boolean;
    activeUserbot?: boolean;
    provider?: string;
  } = {},
): Runtime {
  const base = createCliRuntime(root);
  let envRead = 0;
  return {
    ...base,
    NPM: "npm-test",
    childEnv: { IVA_UPDATE_TEST: "1" },
    readEnv: () => {
      events.push(`runtime.readEnv:${++envRead}`);
      return {
        AGENT_LANGUAGE: "en",
        ASSISTANT_DATA_DIR: "data",
        MODEL_PROVIDER: provider,
        CODEX_MODEL: "gpt-test",
      };
    },
    dataDirAbs: () => {
      events.push("runtime.dataDirAbs");
      return join(root, "data");
    },
    hasSystemd: () => {
      events.push("runtime.hasSystemd");
      return systemdAvailable;
    },
    systemd: fakeSystemd(events, activeUserbot),
    cap: () => ({ code: 0, out: "package==1\n", err: "" }),
  };
}

function transactionFixture(events: string[], state: TransactionState) {
  return {
    protect: async () => {
      events.push("tx.protect");
    },
    resolveTarget: async () => {
      events.push("tx.resolveTarget");
      return { changed: state.changed, remote: "target-head" };
    },
    restoreLocalChanges: async () => {
      events.push("tx.restoreLocalChanges");
      return { status: "none" as const, conflicts: [] as const };
    },
    versions: async () => {
      events.push("tx.versions");
      return {
        beforeHead: "before-head",
        afterHead: "after-head",
        beforeVersion: "v1.0.0",
        afterVersion: "v1.0.1",
      };
    },
    buildCandidate: async () => {
      events.push("tx.buildCandidate");
      return null;
    },
    fetchAndIntegrate: async () => {
      events.push("tx.fetchAndIntegrate");
      return { changed: false };
    },
    promoteCandidate: async () => {
      events.push("tx.promoteCandidate");
      return false;
    },
    git: async (...args: string[]) => {
      events.push(`tx.git:${args.join(" ")}`);
      if (args[0] === "ls-tree")
        return {
          code: 0,
          stdout:
            state.compatMarker === undefined
              ? ""
              : `100644 blob ${"0".repeat(40)}\tupdate-compat.json`,
          stderr: "",
        };
      if (args[0] === "show" && args[1]?.endsWith(":update-compat.json"))
        return { code: 0, stdout: state.compatMarker ?? "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    run: async (command: string, args: string[]) => {
      events.push(`tx.run:${command} ${args.join(" ")}`);
      return { code: state.buildCode ?? 0, stdout: "", stderr: "" };
    },
    backupOutput: () => {
      events.push("tx.backupOutput");
    },
    adoptOutput: () => {
      events.push("tx.adoptOutput");
    },
    rollback: async () => {
      events.push("tx.rollback");
    },
    commit: async () => {
      events.push("tx.commit");
    },
    teardownCandidate: async () => {
      events.push("tx.teardownCandidate");
    },
    get hadLocalChanges() {
      events.push("tx.get:hadLocalChanges");
      return state.hadLocalChanges;
    },
    get outputTouched() {
      events.push("tx.get:outputTouched");
      return state.outputTouched;
    },
  };
}

function operationsFixture(
  events: string[],
  transaction: ReturnType<typeof transactionFixture>,
  { failDonePhase }: { failDonePhase?: string } = {},
): UpdateOperations {
  const terminal = {
    start: (text: string) => events.push(`terminal.start:${text}`),
    done: (text: string) => events.push(`terminal.done:${text}`),
    fail: (text: string) => events.push(`terminal.fail:${text}`),
    info: (text: string) => events.push(`terminal.info:${text}`),
    dispose: () => events.push("terminal.dispose"),
  };
  const reporter = {
    start: async (phase: string) => {
      events.push(`reporter.start:${phase}`);
    },
    done: async (phase: string) => {
      events.push(`reporter.done:${phase}`);
      if (phase === failDonePhase) throw new Error("reporter done failed");
    },
    fail: async (phase: string, beforeVersion: string) => {
      events.push(`reporter.fail:${phase}:${beforeVersion}`);
    },
    busy: async () => {
      events.push("reporter.busy");
    },
    badProvider: async (value: string, accepted: string) => {
      events.push(`reporter.badProvider:${value}:${accepted}`);
    },
    updaterTooOld: async (version: string) => {
      events.push(`reporter.updaterTooOld:${version}`);
    },
    postCommitFailure: async (message: string) => {
      events.push(`reporter.postCommitFailure:${message}`);
    },
    complete: async (versions: { changedLocal?: boolean }) => {
      events.push(`reporter.complete:${String(versions.changedLocal)}`);
      return true;
    },
    dispose: () => events.push("reporter.dispose"),
  };
  return {
    createTerminalProgress: () => {
      events.push("ops.createTerminalProgress");
      return terminal;
    },
    loadTelegramJob: async () => {
      events.push("ops.loadTelegramJob");
      return { path: "/tmp/update-job.json", job: { chatId: 1, messageId: 2 } };
    },
    createTelegramUpdateReporter: () => {
      events.push("ops.createTelegramUpdateReporter");
      return reporter;
    },
    removeTelegramJob: async () => {
      events.push("ops.removeTelegramJob");
    },
    acquireUpdateLock: () => {
      events.push("ops.acquireUpdateLock");
      return { ok: true, path: "/tmp/update.lock", owner: "test" };
    },
    createUpdateLog: () => {
      events.push("ops.createUpdateLog");
      return "/tmp/update.log";
    },
    createUpdateTransaction: () => {
      events.push("ops.createUpdateTransaction");
      return transaction;
    },
    releaseUpdateLock: () => {
      events.push("ops.releaseUpdateLock");
    },
    spawnSync: () => {
      events.push("ops.spawnSync");
      return { status: 0, stdout: " 0 file(s)" };
    },
    fetch: async () => ({ ok: true }),
    sleep: async () => {},
  };
}

test("no-change update preserves phase order, live getter reads and finalizers", async (t) => {
  const root = await sandbox(t);
  const events: string[] = [];
  const state = {
    changed: false,
    outputTouched: false,
    hadLocalChanges: true,
  };
  const transaction = transactionFixture(events, state);
  const runtime = runtimeFixture(root, events);
  const command = createUpdateCommand({
    runtime,
    systemdLifecycle: {
      writeUnits: () => {
        events.push("lifecycle.writeUnits");
        return [];
      },
      migrateEnv: () => false,
    },
    showTree: async () => {
      events.push("callback.showTree");
    },
    restartUserbotIfActive: () => events.push("callback.restartUserbot"),
    operations: operationsFixture(events, transaction),
  });

  await command(["--telegram-job", "job-1"]);

  assertOrder(events, [
    "runtime.readEnv:1",
    "callback.showTree",
    "runtime.readEnv:2",
    "runtime.dataDirAbs",
    "ops.loadTelegramJob",
    "ops.createTelegramUpdateReporter",
    "ops.createTerminalProgress",
    "ops.acquireUpdateLock",
    "ops.createUpdateLog",
    "ops.createUpdateTransaction",
    "terminal.start:Saving your changes",
    "reporter.start:protect",
    "tx.protect",
    "terminal.done:Changes saved",
    "reporter.done:protect",
    "terminal.start:Getting the update",
    "reporter.start:fetch",
    "tx.resolveTarget",
    "tx.restoreLocalChanges",
    "tx.versions",
    "terminal.done:Update received",
    "reporter.done:fetch",
    "tx.commit",
    "runtime.hasSystemd",
    "terminal.info:✅ Iva is already up to date (v1.0.1)",
    "tx.get:hadLocalChanges",
    "reporter.complete:true",
    "tx.teardownCandidate",
    "terminal.dispose",
    "reporter.dispose",
    "ops.releaseUpdateLock",
    "ops.removeTelegramJob",
  ]);
  assert.equal(events.includes("tx.rollback"), false);
  assert.equal(events.includes("tx.get:outputTouched"), false);
});

test("a telegram update that finds the lock taken says so in the chat", async (t) => {
  const previousExitCode = process.exitCode;
  t.after(() => {
    process.exitCode = previousExitCode;
  });
  process.exitCode = undefined;
  const root = await sandbox(t);
  const events: string[] = [];
  const transaction = transactionFixture(events, {
    changed: false,
    outputTouched: false,
    hadLocalChanges: false,
  });
  const command = createUpdateCommand({
    runtime: runtimeFixture(root, events),
    systemdLifecycle: { writeUnits: () => [], migrateEnv: () => false },
    showTree: async () => {},
    restartUserbotIfActive: () => {},
    operations: {
      ...operationsFixture(events, transaction),
      acquireUpdateLock: () => ({ ok: false, path: "", owner: "someone-else" }),
    },
  });

  await command(["--telegram-job", "job-1"]);

  // The job file is deleted here, so a message left on "Saving your changes"
  // would never be corrected by anything.
  assertOrder(events, [
    "terminal.fail:An update is already running",
    "reporter.busy",
    "reporter.dispose",
    "ops.removeTelegramJob",
  ]);
  assert.equal(events.includes("ops.createUpdateTransaction"), false);
  assert.equal(process.exitCode, 1);
});

test("post-commit timer failure reports failure without rollback", async (t) => {
  const previousExitCode = process.exitCode;
  t.after(() => {
    process.exitCode = previousExitCode;
  });
  process.exitCode = undefined;
  const root = await sandbox(t);
  const events: string[] = [];
  const transaction = transactionFixture(events, {
    changed: false,
    outputTouched: false,
    hadLocalChanges: false,
  });
  const runtime = runtimeFixture(root, events, { systemdAvailable: true });
  runtime.systemd.activate = (units: readonly string[]) => {
    events.push(`systemd.activate:${units.join(",")}`);
    throw new Error("timer activation failed");
  };
  const command = createUpdateCommand({
    runtime,
    systemdLifecycle: {
      writeUnits: () => {
        events.push("lifecycle.writeUnits");
        return [];
      },
      migrateEnv: () => false,
    },
    showTree: async () => {
      events.push("callback.showTree");
    },
    restartUserbotIfActive: () => events.push("callback.restartUserbot"),
    operations: operationsFixture(events, transaction),
  });

  await command([]);

  assertOrder(events, [
    "tx.commit",
    "runtime.hasSystemd",
    "lifecycle.writeUnits",
    "systemd.activate:iva-update-check.timer",
    "terminal.fail:Iva is ready, but the automatic update timer could not be activated",
    "terminal.info:timer activation failed",
    "reporter.postCommitFailure:timer activation failed",
    "tx.teardownCandidate",
    "terminal.dispose",
    "reporter.dispose",
    "ops.releaseUpdateLock",
    "ops.removeTelegramJob",
  ]);
  assert.equal(events.includes("tx.rollback"), false);
  assert.equal(
    events.some((event) => event.startsWith("reporter.complete")),
    false,
  );
  assert.equal(process.exitCode, 1);
});

test("a Symbol-valued post-commit message preserves legacy interpolation failure and rollback", async (t) => {
  const previousExitCode = process.exitCode;
  t.after(() => {
    process.exitCode = previousExitCode;
  });
  process.exitCode = undefined;
  const root = await sandbox(t);
  const events: string[] = [];
  const transaction = transactionFixture(events, {
    changed: false,
    outputTouched: false,
    hadLocalChanges: false,
  });
  const runtime = runtimeFixture(root, events, { systemdAvailable: true });
  runtime.systemd.activate = (units: readonly string[]) => {
    events.push(`systemd.activate:${units.join(",")}`);
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- characterize the legacy CLI's handling of a truthy non-string error.message
    throw { message: Symbol("timer failure") };
  };
  const command = createUpdateCommand({
    runtime,
    systemdLifecycle: {
      writeUnits: () => {
        events.push("lifecycle.writeUnits");
        return [];
      },
      migrateEnv: () => false,
    },
    showTree: async () => {
      events.push("callback.showTree");
    },
    restartUserbotIfActive: () => events.push("callback.restartUserbot"),
    operations: operationsFixture(events, transaction),
  });

  await command([]);

  assertOrder(events, [
    "tx.commit",
    "runtime.hasSystemd",
    "lifecycle.writeUnits",
    "systemd.activate:iva-update-check.timer",
    "terminal.fail:Iva is ready, but the automatic update timer could not be activated",
    "terminal.fail:Couldn't get the update",
    "tx.rollback",
    "reporter.fail:fetch:v1.0.0",
    "terminal.info:Cannot convert a Symbol value to a string. Rollback: OK. Log: /tmp/update.log",
    "tx.teardownCandidate",
    "terminal.dispose",
    "reporter.dispose",
    "ops.releaseUpdateLock",
    "ops.removeTelegramJob",
  ]);
  assert.equal(
    events.some((event) => event.startsWith("reporter.postCommitFailure")),
    false,
  );
  assert.equal(process.exitCode, 1);
});

test("build failure consults live output state, rolls back and always tears down", async (t) => {
  const previousExitCode = process.exitCode;
  t.after(() => {
    process.exitCode = previousExitCode;
  });
  process.exitCode = undefined;
  const root = await sandbox(t);
  const events: string[] = [];
  const transaction = transactionFixture(events, {
    changed: true,
    outputTouched: true,
    hadLocalChanges: false,
    buildCode: 1,
  });
  const runtime = runtimeFixture(root, events, { systemdAvailable: true });
  const command = createUpdateCommand({
    runtime,
    systemdLifecycle: {
      writeUnits: () => {
        events.push("lifecycle.writeUnits");
        return [];
      },
      migrateEnv: () => {
        events.push("lifecycle.migrateEnv");
        return true;
      },
    },
    showTree: async () => {
      events.push("callback.showTree");
    },
    restartUserbotIfActive: () => events.push("callback.restartUserbot"),
    operations: operationsFixture(events, transaction),
  });

  await command(["--force"]);

  assertOrder(events, [
    "tx.buildCandidate",
    "tx.fetchAndIntegrate",
    "tx.restoreLocalChanges",
    "tx.versions",
    "lifecycle.migrateEnv",
    "ops.spawnSync",
    "tx.backupOutput",
    "tx.run:npm-test run build",
    "tx.adoptOutput",
    "terminal.fail:Couldn't build Iva",
    "tx.rollback",
    "tx.get:outputTouched",
    "runtime.hasSystemd",
    "lifecycle.writeUnits",
    "systemd.restart:iva.service,iva-telegram-poll.service",
    "reporter.fail:build:v1.0.0",
    "terminal.info:build failed. Rollback: OK. Log: /tmp/update.log",
    "tx.teardownCandidate",
    "terminal.dispose",
    "reporter.dispose",
    "ops.releaseUpdateLock",
    "ops.removeTelegramJob",
  ]);
  assert.equal(process.exitCode, 1);
});

test("a null thrown value preserves the direct error.message failure after rollback", async (t) => {
  const root = await sandbox(t);
  const events: string[] = [];
  const transaction = transactionFixture(events, {
    changed: false,
    outputTouched: false,
    hadLocalChanges: false,
  });
  transaction.protect = async () => {
    events.push("tx.protect:null");
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- characterize the legacy CLI's direct error.message access for non-Error throws
    throw null;
  };
  const command = createUpdateCommand({
    runtime: runtimeFixture(root, events),
    systemdLifecycle: {
      writeUnits: () => [],
      migrateEnv: () => false,
    },
    showTree: async () => {
      events.push("callback.showTree");
    },
    restartUserbotIfActive: () => events.push("callback.restartUserbot"),
    operations: operationsFixture(events, transaction),
  });

  await assert.rejects(() => command([]), TypeError);

  assertOrder(events, [
    "tx.protect:null",
    "terminal.fail:Couldn't save your changes",
    "tx.rollback",
    "reporter.fail:protect:the previous version",
    "tx.teardownCandidate",
    "terminal.dispose",
    "reporter.dispose",
    "ops.releaseUpdateLock",
    "ops.removeTelegramJob",
  ]);
});

test("a Symbol-valued error.message preserves the direct interpolation failure", async (t) => {
  const root = await sandbox(t);
  const events: string[] = [];
  const transaction = transactionFixture(events, {
    changed: false,
    outputTouched: false,
    hadLocalChanges: false,
  });
  transaction.protect = async () => {
    events.push("tx.protect:symbol-message");
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- characterize the legacy CLI's direct interpolation of non-string error.message
    throw { message: Symbol("protect failure") };
  };
  const command = createUpdateCommand({
    runtime: runtimeFixture(root, events),
    systemdLifecycle: {
      writeUnits: () => [],
      migrateEnv: () => false,
    },
    showTree: async () => {
      events.push("callback.showTree");
    },
    restartUserbotIfActive: () => events.push("callback.restartUserbot"),
    operations: operationsFixture(events, transaction),
  });

  await assert.rejects(() => command([]), TypeError);

  assertOrder(events, [
    "tx.protect:symbol-message",
    "terminal.fail:Couldn't save your changes",
    "tx.rollback",
    "reporter.fail:protect:the previous version",
    "tx.teardownCandidate",
    "terminal.dispose",
    "reporter.dispose",
    "ops.releaseUpdateLock",
    "ops.removeTelegramJob",
  ]);
});

test("a post-userbot failure restores its frozen dependencies through the injected callback", async (t) => {
  const previousExitCode = process.exitCode;
  t.after(() => {
    process.exitCode = previousExitCode;
  });
  process.exitCode = undefined;
  const root = await sandbox(t);
  const events: string[] = [];
  const transaction = transactionFixture(events, {
    changed: true,
    outputTouched: true,
    hadLocalChanges: false,
  });
  const runtime = runtimeFixture(root, events, {
    systemdAvailable: true,
    activeUserbot: true,
  });
  const command = createUpdateCommand({
    runtime,
    systemdLifecycle: {
      writeUnits: () => {
        events.push("lifecycle.writeUnits");
        return [];
      },
      migrateEnv: () => false,
    },
    showTree: async () => {
      events.push("callback.showTree");
    },
    restartUserbotIfActive: (options = {}) => {
      events.push(
        options.requireHashes === false
          ? `callback.restartUserbot:rollback:${String(Boolean(options.requirementsPath))}`
          : "callback.restartUserbot:fresh",
      );
    },
    operations: operationsFixture(events, transaction, {
      failDonePhase: "build",
    }),
  });

  await command([]);

  assertOrder(events, [
    "tx.run:npm-test run build",
    "tx.run:npm-test i -g @googleworkspace/cli@latest",
    "runtime.hasSystemd",
    "lifecycle.writeUnits",
    "systemd.restart:iva.service,iva-telegram-poll.service",
    "systemd.isActive:iva.service",
    "systemd.isActive:iva-telegram-poll.service",
    "systemd.isActive:iva-telegram-userbot.service",
    "callback.restartUserbot:fresh",
    "reporter.done:build",
    "terminal.fail:Couldn't build Iva",
    "tx.rollback",
    "tx.get:outputTouched",
    "runtime.hasSystemd",
    "lifecycle.writeUnits",
    "systemd.restart:iva.service,iva-telegram-poll.service",
    "callback.restartUserbot:rollback:true",
    "reporter.fail:build:v1.0.0",
    "terminal.info:reporter done failed. Rollback: OK. Log: /tmp/update.log",
    "tx.teardownCandidate",
    "terminal.dispose",
    "reporter.dispose",
    "ops.releaseUpdateLock",
    "ops.removeTelegramJob",
  ]);
  assert.equal(process.exitCode, 1);
});

// До ветки такие установки обновлялись. После неё новая версия на невалидном имени не
// поднимается — и без этой проверки апдейт прошёл бы целиком, упёрся в health-check и
// откатился, ни разу не назвав причину (ADR-0003). Отказ обязан быть ДО замка и до первой
// записи: установка остаётся ровно такой, какой была.
test("an update refuses to start on an invalid MODEL_PROVIDER and names the fix", async (t) => {
  const previousExitCode = process.exitCode;
  t.after(() => {
    process.exitCode = previousExitCode;
  });
  process.exitCode = undefined;
  const root = await sandbox(t);
  const events: string[] = [];
  const transaction = transactionFixture(events, {
    changed: true,
    outputTouched: false,
    hadLocalChanges: false,
  });
  const command = createUpdateCommand({
    runtime: runtimeFixture(root, events, { provider: "ollmaa" }),
    systemdLifecycle: { writeUnits: () => [], migrateEnv: () => false },
    showTree: async () => {},
    restartUserbotIfActive: () => {},
    operations: operationsFixture(events, transaction),
  });

  await command(["--telegram-job", "job-1"]);

  const refusal = `Fix MODEL_PROVIDER in .env first (iva config) — Iva won't start on this value: "ollmaa" (${ACCEPTED_PROVIDERS})`;
  assertOrder(events, [
    `terminal.fail:${refusal}`,
    `reporter.badProvider:ollmaa:${ACCEPTED_PROVIDERS}`,
    "reporter.dispose",
    "ops.removeTelegramJob",
  ]);
  // Ни замка, ни транзакции, ни сборки: сломанная конфигурация не стоит целого цикла
  // обновления с откатом.
  assert.equal(events.includes("ops.acquireUpdateLock"), false);
  assert.equal(events.includes("ops.createUpdateTransaction"), false);
  assert.equal(process.exitCode, 1);
});

test("every accepted provider name passes the update preflight", async (t) => {
  for (const name of MODEL_PROVIDER_NAMES) {
    const root = await sandbox(t);
    const events: string[] = [];
    const transaction = transactionFixture(events, {
      changed: false,
      outputTouched: false,
      hadLocalChanges: false,
    });
    const command = createUpdateCommand({
      runtime: runtimeFixture(root, events, { provider: name }),
      systemdLifecycle: { writeUnits: () => [], migrateEnv: () => false },
      showTree: async () => {},
      restartUserbotIfActive: () => {},
      operations: operationsFixture(events, transaction),
    });

    await command([]);

    assert.equal(events.includes("ops.acquireUpdateLock"), true, name);
    assert.equal(
      events.some((event) => event.startsWith("terminal.fail:Fix MODEL")),
      false,
      name,
    );
  }
});

test("a release that names a newer updater stops the update before any write", async (t) => {
  const previousExitCode = process.exitCode;
  t.after(() => {
    process.exitCode = previousExitCode;
  });
  process.exitCode = undefined;
  const root = await sandbox(t);
  const events: string[] = [];
  const transaction = transactionFixture(events, {
    changed: true,
    outputTouched: false,
    hadLocalChanges: true,
    compatMarker: '{"minUpdater":"99.0.0"}',
  });
  const command = createUpdateCommand({
    runtime: runtimeFixture(root, events, { systemdAvailable: true }),
    systemdLifecycle: {
      writeUnits: () => {
        events.push("lifecycle.writeUnits");
        return [];
      },
      migrateEnv: () => {
        events.push("lifecycle.migrateEnv");
        return false;
      },
    },
    showTree: async () => {},
    restartUserbotIfActive: () => events.push("callback.restartUserbot"),
    operations: operationsFixture(events, transaction),
  });

  await command(["--telegram-job", "job-1"]);

  // The local changes go back and the protection is released — the exit the
  // "already up to date" path takes — and nothing after the fetch runs.
  assertOrder(events, [
    "tx.resolveTarget",
    "tx.git:ls-tree target-head -- update-compat.json",
    "tx.git:show target-head:update-compat.json",
    "tx.restoreLocalChanges",
    "tx.commit",
    "tx.teardownCandidate",
    "ops.releaseUpdateLock",
  ]);
  for (const forbidden of [
    "tx.fetchAndIntegrate",
    "tx.buildCandidate",
    "tx.promoteCandidate",
    "tx.rollback",
    "lifecycle.migrateEnv",
    "callback.restartUserbot",
  ])
    assert.equal(events.includes(forbidden), false, forbidden);
  assert.equal(
    events.some((event) => event.startsWith("reporter.complete")),
    false,
  );

  const failure = events.find((event) => event.startsWith("terminal.fail:"));
  assert.ok(failure, "the refusal is said in the terminal");
  assert.match(
    failure,
    /Your Iva \(\d+\.\d+\.\d+\) is too old to update itself/,
  );
  assert.match(
    failure,
    /curl -fsSL https:\/\/raw\.githubusercontent\.com\/smixs\/iva-agent\/main\/repair\.sh \| bash/,
  );
  assert.match(failure, /Your data and \.env stay in place\./);
  assert.equal(
    events.some((event) => event.startsWith("reporter.updaterTooOld:")),
    true,
  );
  assert.equal(process.exitCode, 1);
});

test("a marker this updater satisfies, or none at all, changes nothing", async (t) => {
  for (const compatMarker of ['{"minUpdater":"0.0.1"}', undefined]) {
    const root = await sandbox(t);
    const events: string[] = [];
    const transaction = transactionFixture(events, {
      changed: true,
      outputTouched: false,
      hadLocalChanges: false,
      compatMarker,
    });
    const command = createUpdateCommand({
      runtime: runtimeFixture(root, events),
      systemdLifecycle: { writeUnits: () => [], migrateEnv: () => false },
      showTree: async () => {},
      restartUserbotIfActive: () => {},
      operations: operationsFixture(events, transaction),
    });

    await command([]);

    const label = String(compatMarker);
    assert.equal(events.includes("tx.fetchAndIntegrate"), true, label);
    assert.equal(
      events.some((event) => event.startsWith("reporter.updaterTooOld")),
      false,
      label,
    );
    assert.equal(
      events.includes("tx.git:show target-head:update-compat.json"),
      compatMarker !== undefined,
      label,
    );
  }
});
