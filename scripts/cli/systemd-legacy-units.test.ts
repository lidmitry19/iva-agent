/* eslint-disable @typescript-eslint/no-floating-promises -- Node owns test registration. */
// Дешёвый CRAP-тест границы: legacy-юниты памяти снимаются только когда сборка
// содержит все четыре расписания. In-process: рантайм с подменённым UNIT_DIR/ROOT,
// systemd — двойник. Фикстура маркеров — та же форма, что в systemd-control.test.ts.
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCliRuntime } from "./runtime.ts";
import { createCliSystemd } from "./systemd.ts";

const NO_COLOR = { g: "", y: "", r: "", c: "", b: "", d: "", x: "" };

const markerMjs = (period: string): string =>
  `var eve_schedule_default = { meta: { description: 'Run eve schedule "memory-${period}" from "schedules/memory-${period}.ts".' } };\n`;

function seedSchedules(project: string, periods: readonly string[]): void {
  mkdirSync(join(project, ".output/server/_virtual"), { recursive: true });
  for (const period of periods)
    writeFileSync(
      join(project, `.output/server/_virtual/eve-${period}.schedule.mjs`),
      markerMjs(period),
    );
}

function services(
  project: string,
  unitDir: string,
  events: string[],
): ReturnType<typeof createCliSystemd> {
  return createCliSystemd({
    ...createCliRuntime(project),
    C: NO_COLOR,
    UNIT_DIR: unitDir,
    hasSystemd: () => true,
    systemd: {
      isActive: () => true,
      disableNow: (units: readonly string[]) => {
        events.push(`disable:${units.join(",")}`);
      },
      daemonReload: () => {
        events.push("reload");
      },
      resetFailed: () => {
        events.push("reset");
      },
    },
    warn: (message: string) => {
      events.push(`warn:${message}`);
    },
  } as never);
}

test("расписания есть — legacy-юниты снимаются", () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-legacy-units-"));
  try {
    const project = join(dir, "iva");
    const unitDir = join(dir, "home/.config/systemd/user");
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(join(unitDir, "iva-memory-daily.timer"), "[Unit]\n");
    seedSchedules(project, ["daily", "weekly", "monthly", "yearly"]);
    const events: string[] = [];

    const removed = services(
      project,
      unitDir,
      events,
    ).retireLegacyMemoryUnits();

    assert.deepEqual(removed, ["iva-memory-daily.timer"]);
    assert.equal(existsSync(join(unitDir, "iva-memory-daily.timer")), false);
    assert.ok(
      events.some((e) => e === "disable:iva-memory-daily.timer"),
      JSON.stringify(events),
    );
    assert.ok(
      events.every((e) => !e.includes("skipping legacy memory-timer cleanup")),
      JSON.stringify(events),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("расписаний нет — «skipping legacy memory-timer cleanup», файлы целы", () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-legacy-units-"));
  try {
    const project = join(dir, "iva");
    const unitDir = join(dir, "home/.config/systemd/user");
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(join(unitDir, "iva-memory-daily.timer"), "[Unit]\n");
    mkdirSync(join(project, ".output/server"), { recursive: true });
    const events: string[] = [];

    const removed = services(
      project,
      unitDir,
      events,
    ).retireLegacyMemoryUnits();

    assert.deepEqual(removed, []);
    assert.equal(existsSync(join(unitDir, "iva-memory-daily.timer")), true);
    assert.ok(
      events.some((e) => e.includes("skipping legacy memory-timer cleanup")),
      JSON.stringify(events),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("retired Bitrix and night-watchdog units are removed by exact name", () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-retired-aux-units-"));
  try {
    const project = join(dir, "iva");
    const unitDir = join(dir, "home/.config/systemd/user");
    mkdirSync(unitDir, { recursive: true });
    mkdirSync(join(project, "deploy"), { recursive: true });
    const obsolete = [
      "iva-bitrix-sync.service",
      "iva-bitrix-sync.timer",
      "iva-night-watchdog.service",
      "iva-night-watchdog.timer",
    ];
    for (const unit of obsolete) writeFileSync(join(unitDir, unit), "[Unit]\n");
    writeFileSync(join(unitDir, "iva-owner-extra.timer"), "[Unit]\n");
    const events: string[] = [];

    services(project, unitDir, events).writeUnits();
    for (const unit of obsolete)
      assert.equal(existsSync(join(unitDir, unit)), false, unit);
    assert.equal(existsSync(join(unitDir, "iva-owner-extra.timer")), true);
    assert.deepEqual(events, [
      "reload",
      ...obsolete.map((unit) => `disable:${unit}`),
      "reload",
      "reset",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
