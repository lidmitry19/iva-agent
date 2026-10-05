import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

const MODULE_URL = new URL("./schedule-paths.ts", import.meta.url).href;
const PROBE_PROGRAM = `
  const { resolvePaths, memoryNightJob } =
    await import(process.env.SCHEDULE_PATHS_URL);
  const result = process.env.SCHEDULE_PATHS_JOB === "night" ? memoryNightJob() : resolvePaths();
  process.stdout.write(JSON.stringify(result));
`;

function temporaryDirectory(t: TestContext): string {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "iva-schedule-paths-")),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function probe(options: {
  readonly cwd: string;
  readonly dataDir?: string;
  readonly job?: "night";
}): unknown {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SCHEDULE_PATHS_URL: MODULE_URL,
  };
  delete env.ASSISTANT_DATA_DIR;
  delete env.SCHEDULE_PATHS_JOB;
  if (options.dataDir !== undefined) {
    env.ASSISTANT_DATA_DIR = options.dataDir;
  }
  if (options.job !== undefined) {
    env.SCHEDULE_PATHS_JOB = options.job;
  }

  const stdout = execFileSync(
    process.execPath,
    ["--input-type=module", "--eval", PROBE_PROGRAM],
    { cwd: options.cwd, env, encoding: "utf8" },
  );
  return JSON.parse(stdout) as unknown;
}

await test("resolvePaths defaults data paths under the current working directory", (t) => {
  const root = temporaryDirectory(t);

  assert.deepEqual(probe({ cwd: root }), {
    root,
    dataDir: join(root, "data"),
    statusPath: join(root, "data", "rollup-status.json"),
    memoryLockPath: join(root, ".memory.lock"),
    factsPath: join(root, "data", "jobs.json"),
  });
});

await test("resolvePaths resolves a relative ASSISTANT_DATA_DIR from the root", (t) => {
  const root = temporaryDirectory(t);

  assert.deepEqual(probe({ cwd: root, dataDir: "runtime/state" }), {
    root,
    dataDir: join(root, "runtime/state"),
    statusPath: join(root, "runtime/state", "rollup-status.json"),
    memoryLockPath: join(root, ".memory.lock"),
    factsPath: join(root, "runtime/state", "jobs.json"),
  });
});

await test("resolvePaths preserves an absolute data directory without moving the lock", (t) => {
  const root = temporaryDirectory(t);
  const dataDir = temporaryDirectory(t);

  assert.deepEqual(probe({ cwd: root, dataDir }), {
    root,
    dataDir,
    statusPath: join(dataDir, "rollup-status.json"),
    memoryLockPath: join(root, ".memory.lock"),
    factsPath: join(dataDir, "jobs.json"),
  });
});

await test("memoryNightJob returns the exact command contract", (t) => {
  const root = temporaryDirectory(t);
  assert.deepEqual(
    probe({ cwd: root, dataDir: "schedule-data", job: "night" }),
    {
      name: "memory-night",
      argv: ["scripts/memory/night.ts"],
      root,
      nodeBin: process.execPath,
      lockPath: join(root, ".memory.lock"),
      statusPath: join(root, "schedule-data", "rollup-status.json"),
      factsPath: join(root, "schedule-data", "jobs.json"),
      killGraceMs: 90_000,
      wake: false,
    },
  );
});
