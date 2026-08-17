/* eslint-disable @typescript-eslint/no-floating-promises -- Node owns test registration */
import test from "node:test";
import assert from "node:assert/strict";
import {
  alertOwnerAboutPlugins,
  captureOptionalWriterState,
  restoreMigratedWriterState,
  restoreOptionalWriterState,
  restoreWriterOwnership,
  stopWriterUnits,
  tombstoned,
} from "./update-finish.ts";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LEGACY_BRAIN_UNITS,
  LEGACY_MEMORY_UNITS,
} from "./lib/legacy-memory-units.ts";
import { layoutFor } from "./lib/version-store.ts";

type WriterRuntime = Parameters<typeof stopWriterUnits>[0];
const USERBOT = "iva-telegram-userbot.service";

test("tombstones follow the canonical custom data directory", (t) => {
  const home = mkdtempSync(join(tmpdir(), "iva-tombstones-c4-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const dataDir = join(home, "state", "custom-data");
  mkdirSync(join(dataDir, "custom"), { recursive: true });
  writeFileSync(join(home, ".env"), "ASSISTANT_DATA_DIR=state/custom-data\n");
  writeFileSync(
    join(dataDir, "custom/manifest.json"),
    `${JSON.stringify({ entries: { "agent/removed.ts": { tombstone: true } } })}\n`,
  );

  assert.deepEqual(tombstoned(home), ["agent/removed.ts"]);
});

function fakeRuntime({
  active,
  enabled,
  presentUnits = [],
  unavailable = [],
}: {
  active: readonly string[];
  enabled: readonly string[];
  presentUnits?: readonly string[];
  unavailable?: readonly string[];
}) {
  const activeUnits = new Set(active);
  const enabledUnits = new Set(enabled);
  const unavailableUnits = new Set(unavailable);
  const knownUnits = new Set([
    "iva.service",
    "iva-telegram-poll.service",
    ...presentUnits,
    ...active,
    ...enabled,
  ]);
  for (const unit of unavailable) knownUnits.delete(unit);
  const events: string[] = [];
  const systemd = {
    isActive(unit: string) {
      events.push(`is-active ${unit}`);
      return activeUnits.has(unit);
    },
    isEnabled(unit: string) {
      events.push(`is-enabled ${unit}`);
      return enabledUnits.has(unit);
    },
    stop(units: readonly string[]) {
      events.push(`stop ${units.join(" ")}`);
      for (const unit of units) activeUnits.delete(unit);
    },
    disableNow(units: readonly string[]) {
      events.push(`disable-now ${units.join(" ")}`);
      for (const unit of units) {
        activeUnits.delete(unit);
        enabledUnits.delete(unit);
      }
    },
    query(action: string, unit: string) {
      events.push(`${action} ${unit}`);
      if (action === "show")
        return {
          code: 0,
          out: knownUnits.has(unit) ? "loaded" : "not-found",
          err: "",
        };
      if (action === "is-active")
        return {
          code: activeUnits.has(unit) ? 0 : 3,
          out: activeUnits.has(unit)
            ? "active"
            : unavailableUnits.has(unit)
              ? "unknown"
              : "inactive",
          err: "",
        };
      if (action === "is-enabled")
        return {
          code: enabledUnits.has(unit) ? 0 : 1,
          out: enabledUnits.has(unit)
            ? "enabled"
            : unavailableUnits.has(unit)
              ? "not-found"
              : "disabled",
          err: "",
        };
      if (unavailableUnits.has(unit))
        return { code: 1, out: "unit not found", err: "" };
      if (action === "enable") enabledUnits.add(unit);
      if (action === "start") activeUnits.add(unit);
      return { code: 0, out: "", err: "" };
    },
  };
  return {
    runtime: {
      BRAIN_TIMER: "iva-brain.timer",
      BRAIN_SERVICE: "iva-brain.service",
      SVC_USERBOT: USERBOT,
      SERVICES: ["iva.service", "iva-telegram-poll.service"],
      systemd,
    } as unknown as WriterRuntime,
    activeUnits,
    enabledUnits,
    knownUnits,
    events,
  };
}

test("quiesce stops every old writer and leaves update-check alone", () => {
  const fake = fakeRuntime({
    active: [
      "iva.service",
      "iva-telegram-poll.service",
      "iva-brain.timer",
      "iva-brain.service",
      "iva-update-check.timer",
    ],
    enabled: ["iva-brain.timer", "iva-update-check.timer"],
  });
  const before = captureOptionalWriterState(fake.runtime);
  fake.events.length = 0;

  stopWriterUnits(fake.runtime, before);

  assert.deepEqual(
    fake.events.filter((event) => event.startsWith("stop ")),
    [
      "stop iva-brain.timer",
      "stop iva-brain.service",
      "stop iva.service iva-telegram-poll.service",
    ],
  );
  assert.equal(fake.activeUnits.has("iva-update-check.timer"), true);
});

test("a legacy install with no optional units quiesces only mandatory writers", () => {
  const fake = fakeRuntime({
    active: ["iva.service", "iva-telegram-poll.service"],
    enabled: [],
  });
  const before = captureOptionalWriterState(fake.runtime);
  fake.events.length = 0;

  stopWriterUnits(fake.runtime, before);

  assert.equal(fake.events[0], "stop iva.service iva-telegram-poll.service");
});

test("an unreadable optional unit state blocks quiesce before stop", () => {
  const fake = fakeRuntime({ active: [], enabled: [] });
  Object.assign(fake.runtime.systemd, {
    query(action: string, unit: string) {
      fake.events.push(`${action} ${unit}`);
      return { code: 1, out: "", err: "bus unavailable" };
    },
  });

  assert.throws(
    () => captureOptionalWriterState(fake.runtime),
    /could not read load state/u,
  );
  assert.equal(
    fake.events.some((event) => event.startsWith("stop ")),
    false,
  );
});

test("quiesce fails if systemd leaves any writer active", () => {
  const fake = fakeRuntime({ active: ["iva.service"], enabled: [] });
  const before = captureOptionalWriterState(fake.runtime);
  Object.assign(fake.runtime.systemd, {
    stop(units: readonly string[]) {
      fake.events.push(`stop ${units.join(" ")}`);
    },
  });

  assert.throws(
    () => stopWriterUnits(fake.runtime, before),
    /writer iva\.service remained active/u,
  );
});

test("a timer race cannot leave an optional service writing", () => {
  const fake = fakeRuntime({
    active: ["iva-brain.timer", "iva.service"],
    enabled: ["iva-brain.timer"],
    presentUnits: ["iva-brain.service"],
  });
  const before = captureOptionalWriterState(fake.runtime);
  assert.equal(
    before.find((state) => state.unit === "iva-brain.service")?.active,
    false,
  );
  Object.assign(fake.runtime.systemd, {
    stop(units: readonly string[]) {
      fake.events.push(`stop ${units.join(" ")}`);
      for (const unit of units) {
        if (unit === "iva-brain.timer")
          fake.activeUnits.add("iva-brain.service");
        fake.activeUnits.delete(unit);
      }
    },
  });

  stopWriterUnits(fake.runtime, before);

  assert.equal(fake.activeUnits.has("iva-brain.service"), false);
  assert.deepEqual(
    fake.events.filter((event) => event.startsWith("stop ")),
    [
      "stop iva-brain.timer",
      "stop iva-brain.service",
      "stop iva.service iva-telegram-poll.service",
    ],
  );
});

test("the timer barrier stops userbot even when it starts after capture", () => {
  const fake = fakeRuntime({
    active: ["iva-brain.timer", "iva.service"],
    enabled: ["iva-brain.timer"],
    presentUnits: [USERBOT],
  });
  const before = captureOptionalWriterState(fake.runtime);
  assert.equal(before.find((state) => state.unit === USERBOT)?.active, false);
  Object.assign(fake.runtime.systemd, {
    stop(units: readonly string[]) {
      fake.events.push(`stop ${units.join(" ")}`);
      for (const unit of units) {
        if (unit === "iva-brain.timer") fake.activeUnits.add(USERBOT);
        fake.activeUnits.delete(unit);
      }
    },
  });
  fake.events.length = 0;

  stopWriterUnits(fake.runtime, before);

  assert.equal(fake.activeUnits.has(USERBOT), false);
  assert.deepEqual(
    fake.events.filter((event) => event.startsWith("stop ")),
    [
      "stop iva-brain.timer",
      `stop ${USERBOT}`,
      "stop iva.service iva-telegram-poll.service",
    ],
  );
});

test("a userbot stop fault restores its captured active and enabled state", () => {
  const fake = fakeRuntime({
    active: [USERBOT],
    enabled: [USERBOT],
    presentUnits: ["iva-brain.timer", "iva-brain.service"],
  });
  const before = captureOptionalWriterState(fake.runtime);
  Object.assign(fake.runtime.systemd, {
    stop(units: readonly string[]) {
      fake.events.push(`stop ${units.join(" ")}`);
      for (const unit of units) fake.activeUnits.delete(unit);
      if (units.includes(USERBOT)) throw new Error("userbot stop fault");
    },
  });

  assert.throws(
    () => stopWriterUnits(fake.runtime, before),
    /userbot stop fault/u,
  );
  restoreWriterOwnership(fake.runtime, before, {
    unitMigrationStarted: true,
    legacyMemoryOwnerProven: false,
  });

  assert.equal(fake.activeUnits.has(USERBOT), true);
  assert.equal(fake.enabledUnits.has(USERBOT), true);
});

test("a disabled userbot stays disabled and stopped after unit migration", () => {
  const fake = fakeRuntime({
    active: [],
    enabled: [],
    presentUnits: [USERBOT, "iva-brain.timer", "iva-brain.service"],
  });
  const before = captureOptionalWriterState(fake.runtime);
  assert.deepEqual(
    before.find((state) => state.unit === USERBOT),
    {
      unit: USERBOT,
      loadState: "loaded",
      active: false,
      enabled: false,
    },
  );
  stopWriterUnits(fake.runtime, before);
  fake.activeUnits.add(USERBOT);
  fake.enabledUnits.add(USERBOT);
  fake.events.length = 0;

  restoreWriterOwnership(fake.runtime, before, {
    unitMigrationStarted: true,
    legacyMemoryOwnerProven: false,
  });

  assert.equal(fake.activeUnits.has(USERBOT), false);
  assert.equal(fake.enabledUnits.has(USERBOT), false);
  assert.equal(fake.events.includes(`start ${USERBOT}`), false);
  assert.equal(fake.events.includes(`enable ${USERBOT}`), false);
});

test("a previously missing userbot is never started during restoration", () => {
  const fake = fakeRuntime({
    active: [],
    enabled: [],
    presentUnits: ["iva-brain.timer", "iva-brain.service"],
  });
  const before = captureOptionalWriterState(fake.runtime);
  assert.deepEqual(
    before.find((state) => state.unit === USERBOT),
    {
      unit: USERBOT,
      loadState: "not-found",
      active: false,
      enabled: false,
    },
  );
  stopWriterUnits(fake.runtime, before);
  fake.knownUnits.add(USERBOT);
  fake.events.length = 0;

  restoreWriterOwnership(fake.runtime, before, {
    unitMigrationStarted: true,
    legacyMemoryOwnerProven: false,
  });

  assert.equal(
    fake.events.some(
      (event) => event === `start ${USERBOT}` || event === `enable ${USERBOT}`,
    ),
    false,
  );
});

test("an enabled legacy timer stays stopped through migration and returns inactive", () => {
  const legacyTimer = [...LEGACY_BRAIN_UNITS, ...LEGACY_MEMORY_UNITS].find(
    (unit) => unit.endsWith(".timer"),
  );
  assert.ok(legacyTimer);
  const fake = fakeRuntime({ active: [], enabled: [legacyTimer] });
  const before = captureOptionalWriterState(fake.runtime);
  fake.events.length = 0;

  stopWriterUnits(fake.runtime, before);
  assert.equal(fake.activeUnits.has(legacyTimer), false);
  restoreOptionalWriterState(fake.runtime, before);

  assert.equal(fake.enabledUnits.has(legacyTimer), true);
  assert.equal(fake.activeUnits.has(legacyTimer), false);
  assert.ok(fake.events[0]?.includes(legacyTimer));
  assert.equal(fake.events.includes(`start ${legacyTimer}`), false);
});

test("Brain units regain their exact enabled and active state", () => {
  const fake = fakeRuntime({
    active: ["iva-brain.timer"],
    enabled: ["iva-brain.timer"],
    presentUnits: ["iva-brain.service"],
  });
  const before = captureOptionalWriterState(fake.runtime);
  stopWriterUnits(fake.runtime);
  // Unit refresh can change optional state. Restoration still follows the snapshot.
  fake.activeUnits.add("iva-brain.service");
  fake.enabledUnits.add("iva-brain.service");

  restoreOptionalWriterState(fake.runtime, before);

  assert.deepEqual(fake.activeUnits, new Set(["iva-brain.timer"]));
  assert.deepEqual(fake.enabledUnits, new Set(["iva-brain.timer"]));
  assert.equal(fake.events.includes("start iva-brain.service"), false);
});

test("an active but disabled Brain unit restarts without being enabled", () => {
  const fake = fakeRuntime({
    active: ["iva-brain.service"],
    enabled: [],
  });
  const before = captureOptionalWriterState(fake.runtime);
  stopWriterUnits(fake.runtime);

  restoreOptionalWriterState(fake.runtime, before);

  assert.equal(fake.activeUnits.has("iva-brain.service"), true);
  assert.equal(fake.enabledUnits.has("iva-brain.service"), false);
  assert.ok(fake.events.includes("start iva-brain.service"));
  assert.equal(fake.events.includes("enable iva-brain.service"), false);
});

test("a partial quiesce fault can restore the captured optional state", () => {
  const fake = fakeRuntime({
    active: ["iva-brain.timer", "iva-brain.service"],
    enabled: ["iva-brain.timer"],
  });
  const before = captureOptionalWriterState(fake.runtime);
  Object.assign(fake.runtime.systemd, {
    stop(units: readonly string[]) {
      for (const unit of units) fake.activeUnits.delete(unit);
      throw new Error("stop fault");
    },
  });

  assert.throws(() => stopWriterUnits(fake.runtime, before), /stop fault/u);
  Object.assign(fake.runtime.systemd, {
    stop(units: readonly string[]) {
      for (const unit of units) fake.activeUnits.delete(unit);
    },
  });
  restoreOptionalWriterState(fake.runtime, before);

  assert.equal(fake.activeUnits.has("iva-brain.timer"), true);
  assert.equal(fake.activeUnits.has("iva-brain.service"), true);
  assert.equal(fake.enabledUnits.has("iva-brain.timer"), true);
  assert.equal(fake.enabledUnits.has("iva-brain.service"), false);
});

test("legacy Brain state moves to the current semantic owner", () => {
  const legacyTimer = LEGACY_BRAIN_UNITS.find((unit) =>
    unit.endsWith(".timer"),
  );
  const legacyService = LEGACY_BRAIN_UNITS.find((unit) =>
    unit.endsWith(".service"),
  );
  assert.ok(legacyTimer);
  assert.ok(legacyService);
  const fake = fakeRuntime({
    active: [legacyService],
    enabled: [legacyTimer],
    presentUnits: ["iva-brain.timer", "iva-brain.service"],
  });
  const before = captureOptionalWriterState(fake.runtime);
  stopWriterUnits(fake.runtime, before);
  fake.enabledUnits.delete(legacyTimer);
  fake.events.length = 0;

  restoreMigratedWriterState(fake.runtime, before);

  assert.equal(fake.enabledUnits.has("iva-brain.timer"), true);
  assert.equal(fake.activeUnits.has("iva-brain.timer"), false);
  assert.equal(fake.activeUnits.has("iva-brain.service"), true);
  assert.equal(fake.enabledUnits.has("iva-brain.service"), false);
  assert.equal(
    fake.events.some((event) => event.includes(legacyTimer)),
    false,
  );
  assert.equal(
    fake.events.some((event) => event.includes(legacyService)),
    false,
  );
});

test("a migrated legacy memory timer keeps an active live service owner", () => {
  const legacyTimer = LEGACY_MEMORY_UNITS.find((unit) =>
    unit.endsWith(".timer"),
  );
  assert.ok(legacyTimer);
  const fake = fakeRuntime({
    active: ["iva.service"],
    enabled: [legacyTimer],
    presentUnits: [
      legacyTimer.replace(/\.timer$/u, ".service"),
      "iva-brain.timer",
      "iva-brain.service",
    ],
  });
  const before = captureOptionalWriterState(fake.runtime);
  stopWriterUnits(fake.runtime, before);
  fake.enabledUnits.delete(legacyTimer);
  fake.knownUnits.delete(legacyTimer);
  fake.knownUnits.delete(legacyTimer.replace(/\.timer$/u, ".service"));
  fake.activeUnits.add("iva.service");
  fake.events.length = 0;

  restoreMigratedWriterState(fake.runtime, before, {
    legacyMemoryOwnerProven: true,
  });

  assert.equal(fake.activeUnits.has("iva.service"), true);
  assert.equal(fake.events.includes(`enable ${legacyTimer}`), false);
  assert.equal(fake.events.includes(`start ${legacyTimer}`), false);
  assert.equal(
    fake.events.some((event) => event.startsWith(`stop ${legacyTimer}`)),
    false,
  );
});

test("a legacy memory timer retained by writeUnits regains its exact state", () => {
  const legacyTimer = LEGACY_MEMORY_UNITS.find((unit) =>
    unit.endsWith(".timer"),
  );
  assert.ok(legacyTimer);
  const fake = fakeRuntime({
    active: [],
    enabled: [legacyTimer],
    presentUnits: [
      legacyTimer.replace(/\.timer$/u, ".service"),
      "iva-brain.timer",
      "iva-brain.service",
    ],
  });
  const before = captureOptionalWriterState(fake.runtime);
  stopWriterUnits(fake.runtime, before);
  fake.enabledUnits.delete(legacyTimer);
  fake.events.length = 0;

  restoreMigratedWriterState(fake.runtime, before);

  assert.equal(fake.enabledUnits.has(legacyTimer), true);
  assert.equal(fake.activeUnits.has(legacyTimer), false);
  assert.ok(fake.events.includes(`enable ${legacyTimer}`));
  assert.equal(fake.activeUnits.has("iva.service"), false);
});

test("a migrated legacy memory schedule fails without its live owner", () => {
  const legacyTimer = LEGACY_MEMORY_UNITS.find((unit) =>
    unit.endsWith(".timer"),
  );
  assert.ok(legacyTimer);
  const fake = fakeRuntime({
    active: [],
    enabled: [legacyTimer],
    presentUnits: [
      legacyTimer.replace(/\.timer$/u, ".service"),
      "iva-brain.timer",
      "iva-brain.service",
    ],
  });
  const before = captureOptionalWriterState(fake.runtime);
  stopWriterUnits(fake.runtime, before);
  fake.enabledUnits.delete(legacyTimer);
  fake.knownUnits.delete(legacyTimer);
  fake.knownUnits.delete(legacyTimer.replace(/\.timer$/u, ".service"));

  assert.throws(
    () =>
      restoreMigratedWriterState(fake.runtime, before, {
        legacyMemoryOwnerProven: true,
      }),
    /no active service owner/u,
  );
});

test("an active service alone does not prove a migrated memory owner", () => {
  const legacyTimer = LEGACY_MEMORY_UNITS.find((unit) =>
    unit.endsWith(".timer"),
  );
  assert.ok(legacyTimer);
  const legacyService = legacyTimer.replace(/\.timer$/u, ".service");
  const fake = fakeRuntime({
    active: ["iva.service"],
    enabled: [legacyTimer],
    presentUnits: [legacyService, "iva-brain.timer", "iva-brain.service"],
  });
  const before = captureOptionalWriterState(fake.runtime);
  stopWriterUnits(fake.runtime, before);
  fake.enabledUnits.delete(legacyTimer);
  fake.knownUnits.delete(legacyTimer);
  fake.knownUnits.delete(legacyService);
  fake.activeUnits.add("iva.service");

  assert.throws(
    () => restoreMigratedWriterState(fake.runtime, before),
    /owner was not proven by writeUnits/u,
  );
});

test("a unit-write fault restores the captured legacy Brain owner", () => {
  const legacyTimer = LEGACY_BRAIN_UNITS.find((unit) =>
    unit.endsWith(".timer"),
  );
  assert.ok(legacyTimer);
  const fake = fakeRuntime({
    active: [legacyTimer],
    enabled: [legacyTimer],
    unavailable: ["iva-brain.timer"],
  });
  const before = captureOptionalWriterState(fake.runtime);
  stopWriterUnits(fake.runtime, before);

  restoreWriterOwnership(fake.runtime, before, {
    unitMigrationStarted: false,
    legacyMemoryOwnerProven: false,
  });

  assert.equal(fake.activeUnits.has(legacyTimer), true);
  assert.equal(fake.enabledUnits.has(legacyTimer), true);
  assert.equal(fake.activeUnits.has("iva-brain.timer"), false);
  assert.equal(fake.enabledUnits.has("iva-brain.timer"), false);
});

// ── Alert о выключенном плагине (ADR-0007 + ADR-0009) ────────────────────────────────────

/** Установка с настроенным чатом: `.env` — единственный источник токена и чата. */
function installationWithChat(
  t: { after(fn: () => void): void },
  env = "TELEGRAM_BOT_TOKEN=token\nTELEGRAM_DIGEST_CHAT_ID=42\nAGENT_LANGUAGE=en\n",
): ReturnType<typeof layoutFor> {
  const home = mkdtempSync(join(tmpdir(), "iva-plugin-alert-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, "data"), { recursive: true });
  writeFileSync(join(home, ".env"), env);
  return layoutFor(home);
}

const refused = (digest: string) => ({
  name: "trace",
  digest,
  reason: "eve: extension build failed on extension/extension.ts",
});

test("the owner hears about a switched-off plugin once a week, sooner if it changed", async (t) => {
  const layout = installationWithChat(t);
  const sent: string[] = [];
  const said: string[] = [];
  const send = (text: string): Promise<boolean> => {
    sent.push(text);
    return Promise.resolve(true);
  };
  const say = (message: string): void => {
    said.push(message);
  };

  await alertOwnerAboutPlugins(layout, [refused("aaa")], say, send);
  await alertOwnerAboutPlugins(layout, [refused("aaa")], say, send);

  // Один Alert на проблему: второй прогон с тем же плагином и тем же содержимым молчит.
  assert.equal(sent.length, 1, sent.join("\n---\n"));
  assert.match(sent[0], /trace/u);
  assert.match(sent[0], /iva plugin update trace/u);
  assert.match(sent[0], /iva plugin enable trace/u);
  // Вывод самого апдейта — не Alert: его владелец и просил, и он печатается всегда.
  assert.equal(said.length, 2);
  assert.match(said[0], /switched off/u);
  assert.match(said[0], /extension build failed/u);

  // Плагин изменился — существо проблемы другое, и говорить надо сразу.
  await alertOwnerAboutPlugins(layout, [refused("bbb")], say, send);
  assert.equal(sent.length, 2);
});

test("one Alert names every plugin the build switched off", async (t) => {
  const layout = installationWithChat(t);
  const sent: string[] = [];
  const send = (text: string): Promise<boolean> => {
    sent.push(text);
    return Promise.resolve(true);
  };

  await alertOwnerAboutPlugins(
    layout,
    [refused("aaa"), { name: "other", digest: "bbb", reason: "boom" }],
    () => {},
    send,
  );

  assert.equal(sent.length, 1);
  assert.match(sent[0], /trace/u);
  assert.match(sent[0], /other/u);
});

test("without a chat the reason stays in the update output and nothing is throttled", async (t) => {
  const layout = installationWithChat(t, "AGENT_LANGUAGE=en\n");
  const said: string[] = [];

  await alertOwnerAboutPlugins(layout, [refused("aaa")], (message) =>
    said.push(message),
  );

  assert.equal(said.length, 1);
  assert.match(said[0], /trace/u);
  // Ничего не отправлено — и дроссель не отмечен: настроят чат, Alert придёт сразу.
  assert.equal(existsSync(join(layout.data, "alert-state.json")), false);
});

test("an Alert that could not be sent says so and is not remembered", async (t) => {
  const layout = installationWithChat(t);
  const said: string[] = [];

  await alertOwnerAboutPlugins(
    layout,
    [refused("aaa")],
    (message) => said.push(message),
    () => Promise.resolve(false),
  );

  assert.match(said.join("\n"), /could not tell you in Telegram about trace/u);
  assert.equal(existsSync(join(layout.data, "alert-state.json")), false);
});
