import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { memoryNightBuildSettings } from "../agent/lib/memory-night-time.ts";

const repo = fileURLToPath(new URL("../", import.meta.url));
const importUrl = (path: string) =>
  JSON.stringify(pathToFileURL(join(repo, path)).href);

void test("eve Schedule, catch-up and menu use compiled time after env changes", (t) => {
  const root = mkdtempSync(join(tmpdir(), "iva-night-boundary-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".output"));
  const dataDir = join(root, "data");
  mkdirSync(dataDir);
  writeFileSync(
    join(root, ".output/iva-memory-night.json"),
    memoryNightBuildSettings("11:37"),
  );
  writeFileSync(join(root, ".env"), "MEMORY_NIGHT_TIME=20:45\n");
  const script = `
    import { writeFileSync } from "node:fs";
    import { join } from "node:path";
    const table = await import(${importUrl("agent/lib/schedule-table.ts")});
    const schedule = await import(${importUrl("agent/schedules/memory-night.ts")});
    const { runScheduleMigration } = await import(${importUrl("agent/lib/schedule-migration.ts")});
    const { default: menu } = await import(${importUrl("scripts/lib/menu/crons.ts")});
    const statusPath = join(process.env.ASSISTANT_DATA_DIR, "rollup-status.json");
    const runs = [];
    for (const now of ["2026-10-02T11:36:00Z", "2026-10-02T11:38:00Z"]) {
      writeFileSync(statusPath, JSON.stringify({ "memory-night": { lastSuccessAt: Date.parse("2026-10-01T12:00:00Z") } }));
      let count = 0;
      await runScheduleMigration({ root: process.cwd(), statusPath, tz: "UTC", now: () => Date.parse(now), runJob: async () => { count++; } });
      runs.push(count);
    }
    const view = await menu.render({ page: 0 }, { deps: { dataDir: process.env.ASSISTANT_DATA_DIR, envPath: join(process.cwd(), ".env") }, tr: en => en });
    writeFileSync(join(process.cwd(), ".env"), "MEMORY_NIGHT_TIME=invalid\\n");
    const invalid = await menu.render({ page: 0 }, { deps: { dataDir: process.env.ASSISTANT_DATA_DIR, envPath: join(process.cwd(), ".env") }, tr: en => en });
    console.log(JSON.stringify({ cron: table.SCHEDULE_CRON["memory-night"], schedule: schedule.default.cron, runs, text: view.text, invalidText: invalid.text }));
  `;
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      join(repo, "scripts/lib/ts-esm-hooks.ts"),
      "--input-type=module",
      "--eval",
      script,
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        ASSISTANT_DATA_DIR: dataDir,
        MEMORY_NIGHT_TIME: "00:01",
        ASSISTANT_TIMEZONE: "UTC",
      },
      timeout: 10_000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout) as {
    cron: string;
    schedule: string;
    runs: number[];
    text: string;
    invalidText: string;
  };
  assert.equal(output.cron, "37 11 * * *");
  assert.equal(output.schedule, output.cron);
  assert.deepEqual(output.runs, [0, 1]);
  assert.match(output.text, /memory-night.*37 11/);
  assert.match(output.text, /Night time 20:45 is pending/);
  assert.match(output.invalidText, /MEMORY_NIGHT_TIME is invalid/);
  assert.match(output.invalidText, /memory-night.*37 11/);
});
