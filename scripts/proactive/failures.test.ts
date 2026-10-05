/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Источник «сбои» (спека проактивности, T3): systemctl подменён, дроссель Alert — настоящий
// файл во временной папке, часы закреплены. На проводе — аргументы вызовов systemctl; время
// выхода — оба формата systemd (@секунды с v251, обычный до v250); PBT на мусоре.
import "../fixtures/no-host-anthropic.ts";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import fc from "fast-check";

const ROOT = mkdtempSync(join(tmpdir(), "iva-proactive-failures-"));
process.env.ASSISTANT_DATA_DIR = join(ROOT, "data");
after(() => rmSync(ROOT, { recursive: true, force: true }));

const { exitTime, failuresSource, unfixedFailures } =
  await import("./precheck.ts");
const { recordAlert } = await import("../lib/notice-policy.ts");
const { recordFact, jobFactsFile } = await import("#lib/job-facts.ts");

import type { Systemctl } from "./precheck.ts";

const SEED = Number(process.env.FC_SEED ?? Date.now() % 2 ** 31);
/** 2026-10-05 12:00 UTC. */
const NOON = Date.UTC(2026, 9, 5, 12, 0);
const HOUR = 3_600_000;
const sec = (ms: number) => `@${Math.floor(ms / 1000)}`;

type Unit = {
  readonly status?: string;
  readonly result?: string;
  readonly exited?: string;
};

/** Поддельный systemctl: таймеры → их сервисы, юниты плагинов, свойства по Id. */
function fakeSystemctl(
  {
    timers = {},
    plugins = {},
    units = {},
  }: {
    timers?: Record<string, string>;
    /** Состояние в list-units: ACTIVE или «ACTIVE SUB» (`activating auto-restart`). */
    plugins?: Record<string, string>;
    units?: Record<string, Unit>;
  },
  calls: string[][] = [],
): Systemctl {
  return (args) => {
    calls.push([...args]);
    if (args[0] === "list-timers")
      return Promise.resolve({
        code: 0,
        stdout: Object.entries(timers)
          .map(
            ([timer, service]) =>
              `Mon 2026-10-05 13:00:00 UTC 59min left Mon 2026-10-05 12:00:00 UTC 1min ago ${timer} ${service}`,
          )
          .join("\n"),
      });
    if (args[0] === "list-units")
      return Promise.resolve({
        code: 0,
        stdout: Object.entries(plugins)
          .map(
            ([unit, active]) =>
              `${unit} loaded ${active.includes(" ") ? active : `${active} ${active === "active" ? "running" : active}`} Plugin`,
          )
          .join("\n"),
      });
    const names = args.slice(args.indexOf("--") + 1);
    return Promise.resolve({
      code: 0,
      stdout: names
        .map((id) => {
          const u = units[id] ?? {};
          return [
            `Id=${id}`,
            `Result=${u.result ?? "success"}`,
            `ExecMainStatus=${u.status ?? "0"}`,
            `ExecMainExitTimestamp=${u.exited ?? ""}`,
          ].join("\n");
        })
        .join("\n\n"),
    });
  };
}

const dir = () => mkdtempSync(join(ROOT, "run-"));
const since = (failuresSeenUpToMs = NOON - 24 * HOUR) => ({
  now: NOON,
  failuresSeenUpToMs,
});
const alerts = (d: string): unknown => {
  try {
    return JSON.parse(readFileSync(join(d, "alert-state.json"), "utf8"));
  } catch {
    return null;
  }
};

test("exit time: @seconds and the plain systemd format with UTC or an offset; empty — never exited", () => {
  assert.equal(exitTime("@1759548647"), 1759548647000);
  assert.equal(
    exitTime("Sat 2026-10-04 03:30:47 UTC"),
    Date.UTC(2026, 9, 4, 3, 30, 47),
  );
  assert.equal(
    exitTime("Sat 2026-10-04 08:30:47 +05"),
    Date.UTC(2026, 9, 4, 3, 30, 47),
  );
  assert.equal(
    exitTime("Sat 2026-10-04 09:00:47 +0530"),
    Date.UTC(2026, 9, 4, 3, 30, 47),
  );
  assert.equal(exitTime(""), null);
  for (const bad of ["Sat 2026-10-04 03:30:47 MSK", "yesterday", "@", "n/a"])
    assert.throws(() => exitTime(bad), /exit time not understood/u);
});

test(`PBT: exit time round-trips both formats; garbage is null, a number or an Error — never a crash (seed ${SEED})`, () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 0, max: 4_102_444_800 }),
      fc.integer({ min: -12, max: 14 }),
      (seconds, offset) => {
        const ms = seconds * 1000;
        assert.equal(exitTime(`@${seconds}`), ms);
        const local = new Date(ms + offset * HOUR).toISOString();
        const sign = offset < 0 ? "-" : "+";
        const zone = `${sign}${String(Math.abs(offset)).padStart(2, "0")}`;
        const plain = `Mon ${local.slice(0, 10)} ${local.slice(11, 19)} ${zone}`;
        assert.equal(exitTime(plain), ms);
      },
    ),
    { seed: SEED },
  );
  fc.assert(
    fc.property(fc.string({ maxLength: 60 }), (value) => {
      try {
        const at = exitTime(value);
        assert.ok(at === null || Number.isFinite(at));
      } catch (error) {
        assert.ok(error instanceof Error);
        assert.match(error.message, /exit time not understood/u);
      }
    }),
    { seed: SEED },
  );
});

test("on the wire: list-timers, list-units of plugin units, one show with the four properties and no --timestamp (systemd < 251 rejects unix)", async () => {
  const calls: string[][] = [];
  const source = failuresSource(
    dir(),
    fakeSystemctl(
      {
        timers: { "backup.timer": "backup.service" },
        plugins: { "iva-plugin-x.service": "failed" },
      },
      calls,
    ),
  );
  await source.check(since());
  assert.deepEqual(calls, [
    ["list-timers", "--all", "--no-legend"],
    [
      "list-units",
      "--all",
      "--plain",
      "--no-legend",
      "iva-plugin-*",
      "iva-mcp-*",
      "iva-telegram-userbot.service",
    ],
    [
      "show",
      "-p",
      "Id",
      "-p",
      "Result",
      "-p",
      "ExecMainStatus",
      "-p",
      "ExecMainExitTimestamp",
      "--",
      "backup.service",
      "iva-plugin-x.service",
    ],
  ]);
  assert.equal(source.always, true, "failures run with the toggle off");
});

// Настоящий execFile: на PATH стоит поддельный systemctl версии 249 (Ubuntu 22.04). Он
// отвергает `--timestamp=unix` (значение появилось в 251, раньше — «Invalid value») и печатает
// время выхода в обычном формате с зоной из TZ, как format_timestamp_style systemd.
test("systemd 249 on the wire: no --timestamp=unix, the exit time in UTC through TZ — the failed timer is an item", async () => {
  const bin = join(ROOT, "systemd-249-bin");
  mkdirSync(bin, { recursive: true });
  const fake = join(bin, "systemctl");
  writeFileSync(
    fake,
    [
      "#!/bin/sh",
      'for a in "$@"; do',
      '  case "$a" in --timestamp=unix) echo "Invalid value: unix." >&2; exit 1;; esac',
      "done",
      'case "$2" in',
      "  list-timers) echo 'Mon 2026-10-05 13:00:00 UTC 59min left Mon 2026-10-05 11:00:00 UTC 1h ago backup.timer backup.service';;",
      "  list-units) ;;",
      "  show)",
      '    if [ "$TZ" = UTC ]; then at="Mon 2026-10-05 11:00:00 UTC"; else at="Mon 2026-10-05 14:00:00 MSK"; fi',
      "    printf 'Id=backup.service\\nResult=exit-code\\nExecMainStatus=1\\nExecMainExitTimestamp=%s\\n' \"$at\";;",
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(fake, 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path ?? ""}`;
  try {
    const result = await failuresSource(dir()).check(since());
    assert.equal(result.error, null);
    assert.deepEqual(
      result.items.map((item) => [item.key, item.failure?.at]),
      [["failure:backup.service", Date.UTC(2026, 9, 5, 11, 0)]],
    );
  } finally {
    process.env.PATH = path;
  }
});

test("a failed timer since failuresSeenUpToMs is an item; Iva's own timers are skipped; an older exit is not new", async () => {
  const d = dir();
  const run = fakeSystemctl({
    timers: {
      "backup.timer": "backup.service",
      "old.timer": "old.service",
      "iva-memory.timer": "iva-memory.service",
    },
    units: {
      "backup.service": {
        status: "1",
        result: "exit-code",
        exited: sec(NOON - HOUR),
      },
      "old.service": { status: "2", exited: sec(NOON - 25 * HOUR) },
      "iva-memory.service": { status: "1", exited: sec(NOON - HOUR) },
    },
  });
  const { items, error } = await failuresSource(d, run).check(since());
  assert.equal(error, null);
  assert.deepEqual(items, [
    {
      key: "failure:backup.service",
      unread: 1,
      from: {},
      note: `a regular job failed: backup.service: exit status 1, result exit-code, exited ${new Date(NOON - HOUR).toISOString()}`,
      failure: { essence: "1", at: NOON - HOUR },
    },
  ]);
});

test("a failed plugin service is an item whatever its exit time; the essence is its Result", async () => {
  const run = fakeSystemctl({
    plugins: {
      "iva-plugin-weather.service": "failed",
      "iva-mcp-notes.service": "active",
    },
    units: { "iva-plugin-weather.service": { status: "0", result: "timeout" } },
  });
  const { items } = await failuresSource(dir(), run).check(since(NOON));
  assert.deepEqual(
    items.map((i) => [i.key, i.failure]),
    [["failure:iva-plugin-weather.service", { essence: "timeout", at: 0 }]],
  );
});

// Живой сервер 04.10: сервис плагина с Restart= падает по кругу и в list-units стоит
// «activating auto-restart», до `failed` не доходит никогда. Сбой — и по Result из show.
test("a plugin service in a restart loop (activating auto-restart, Result=exit-code) is an item; a plain start (activating, Result=success) is not", async () => {
  const run = fakeSystemctl({
    plugins: {
      "iva-plugin-hello-smoke2-hello.service": "activating auto-restart",
      "iva-plugin-starting.service": "activating start",
      "iva-telegram-userbot.service": "activating auto-restart",
    },
    units: {
      "iva-plugin-hello-smoke2-hello.service": {
        status: "203",
        result: "exit-code",
      },
      "iva-plugin-starting.service": { status: "0", result: "success" },
      "iva-telegram-userbot.service": { status: "1", result: "exit-code" },
    },
  });
  const { items, error } = await failuresSource(dir(), run).check(since(NOON));
  assert.equal(error, null);
  assert.deepEqual(
    items.map((i) => [i.key, i.failure?.essence]),
    [
      ["failure:iva-plugin-hello-smoke2-hello.service", "exit-code"],
      ["failure:iva-telegram-userbot.service", "exit-code"],
    ],
  );
});

test("the Alert throttle: a recorded failure with the same essence is not an item; a new essence is", async () => {
  const d = dir();
  const timers = { "backup.timer": "backup.service" };
  assert.equal(
    recordAlert(d, "failure:backup.service", "1", NOON - HOUR),
    true,
  );
  const same = fakeSystemctl({
    timers,
    units: { "backup.service": { status: "1", exited: sec(NOON - 30_000) } },
  });
  assert.deepEqual((await failuresSource(d, same).check(since())).items, []);
  const other = fakeSystemctl({
    timers,
    units: { "backup.service": { status: "127", exited: sec(NOON - 30_000) } },
  });
  assert.equal((await failuresSource(d, other).check(since())).items.length, 1);
});

test("alert-state.json broken or missing → fail-open: the failure comes", async () => {
  const run = fakeSystemctl({
    timers: { "backup.timer": "backup.service" },
    units: { "backup.service": { status: "1", exited: sec(NOON - HOUR) } },
  });
  for (const content of [
    null,
    "{ not json",
    "[]",
    '{"failure:backup.service":7}',
  ]) {
    const d = dir();
    if (content !== null) writeFileSync(join(d, "alert-state.json"), content);
    const { items } = await failuresSource(d, run).check(since());
    assert.equal(items.length, 1, String(content));
  }
});

test("a unit no longer failed drops its throttle record (alertResolved): a relapse speaks at once", async () => {
  const d = dir();
  recordAlert(d, "failure:backup.service", "1", NOON - 2 * HOUR);
  recordAlert(d, "failure:iva-plugin-x.service", "exit-code", NOON - 2 * HOUR);
  recordAlert(d, "authored-tree", "broken", NOON - 2 * HOUR);
  const healthy = fakeSystemctl({
    timers: { "backup.timer": "backup.service" },
    plugins: { "iva-plugin-x.service": "active" },
    units: { "backup.service": { status: "0", exited: sec(NOON - HOUR) } },
  });
  assert.deepEqual((await failuresSource(d, healthy).check(since())).items, []);
  assert.deepEqual(Object.keys(alerts(d) as object), ["authored-tree"]);
});

test("systemctl missing (macOS) → the source is empty, the error goes to the log only (silent), no check:timers", async () => {
  const run: Systemctl = () => Promise.resolve({ code: "missing", stdout: "" });
  assert.deepEqual(await failuresSource(dir(), run).check(since()), {
    items: [],
    error: "systemctl not found",
    silent: true,
  });
});

test("unfixed failures without systemctl: the job failures stay, no «check failed» line in the Brief", async () => {
  const d = dir();
  await recordFact(
    jobFactsFile(d),
    {
      name: "memory-night",
      startedAt: NOON - HOUR,
      finishedAt: NOON - HOUR + 1000,
      ok: false,
      error: "exited 1",
      exitCode: 1,
      tail: "",
      acked: false,
      wake: null,
    },
    NOON,
  );
  const run: Systemctl = () => Promise.resolve({ code: "missing", stdout: "" });
  assert.deepEqual(await unfixedFailures(d, NOON, run), [
    "job memory-night: exited 1",
  ]);
});

test("systemctl exit ≠ 0 or a 10 s timeout → error to the log only (silent), no items", async () => {
  for (const code of [1, "timeout"] as const) {
    const run: Systemctl = () => Promise.resolve({ code, stdout: "" });
    const result = await failuresSource(dir(), run).check(since());
    assert.equal(result.silent, true);
    assert.deepEqual(result.items, []);
    assert.match(
      result.error ?? "",
      code === 1 ? /list-timers exited 1/u : /timed out after 10 s/u,
    );
  }
});

test("an exit time not understood → a loud source error (a check:timers item follows in the tick)", async () => {
  const run = fakeSystemctl({
    timers: { "backup.timer": "backup.service" },
    units: {
      "backup.service": { status: "1", exited: "Mon 2026-10-05 11:00:00 MSK" },
    },
  });
  const result = await failuresSource(dir(), run).check(since());
  assert.notEqual(result.silent, true);
  assert.match(result.error ?? "", /exit time not understood/u);
});

test("unfixed failures for the Brief: open job failures and timers whose last exit is not 0", async () => {
  const d = dir();
  await recordFact(
    jobFactsFile(d),
    {
      name: "memory-night",
      startedAt: NOON - 9 * HOUR,
      finishedAt: NOON - 9 * HOUR + 1000,
      ok: false,
      error: "exited 1",
      exitCode: 1,
      tail: "",
      acked: false,
      wake: null,
    },
    NOON,
  );
  const run = fakeSystemctl({
    timers: { "backup.timer": "backup.service", "fine.timer": "fine.service" },
    units: {
      // Старый провал всё ещё непочинен: Brief его называет, хотя Watch о нём уже сказал.
      "backup.service": { status: "1", exited: sec(NOON - 30 * HOUR) },
      "fine.service": { status: "0", exited: sec(NOON - HOUR) },
    },
  });
  const lines = await unfixedFailures(d, NOON, run);
  assert.equal(lines.length, 2);
  assert.match(lines[0] ?? "", /^job memory-night: exited 1$/u);
  assert.match(
    lines[1] ?? "",
    /^a regular job failed: backup\.service: exit status 1/u,
  );
});
