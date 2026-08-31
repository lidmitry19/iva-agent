import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

async function runSymlinkedModule(moduleName, args = []) {
  const stage = await mkdtemp(join(tmpdir(), "iva-bitrix-entrypoint-"));
  const link = join(stage, moduleName);
  const target = fileURLToPath(
    new URL(`../../services/bitrix-gateway/${moduleName}`, import.meta.url),
  );
  await symlink(target, link);

  try {
    const child = spawn(process.execPath, [link, ...args], {
      env: { ...process.env, BITRIX_WEBHOOK_URL: "not-a-valid-url" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const [code, signal] = await new Promise((resolve) =>
      child.once("close", (exitCode, exitSignal) =>
        resolve([exitCode, exitSignal]),
      ),
    );
    return { code, signal, stderr, stdout };
  } finally {
    await rm(stage, { force: true, recursive: true });
  }
}

test("gateway server runs when systemd invokes its current symlink", async () => {
  const result = await runSymlinkedModule("server.mjs");
  assert.equal(result.signal, null);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Bitrix gateway failed to start\./u);
});

test("read-state preflight runs when invoked through current symlink", async () => {
  const result = await runSymlinkedModule("preflight-read-state.mjs", ["bad"]);
  assert.equal(result.signal, null);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /"error_code":"INVALID_TASK_ID"/u);
});
