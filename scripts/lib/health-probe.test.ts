/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registration promises */
import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { PROBE_FLAG as AUTHORED_PROBE_FLAG } from "#lib/eve-health.ts";
import {
  PROBE_FLAG,
  awaitHealthy,
  awaitServing,
  probeEnvironment,
  probeVersion,
  servicePort,
} from "./health-probe.ts";
import { DEFAULT_PORT } from "./ports.ts";

const PROBE_PORT = 18730;

/** A port nothing holds: a wait for the service must not be answered by a neighbour. */
function freePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    }),
  );
}

function versionDir(t: { after(fn: () => void): void }, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "iva-health-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "server.mjs"), body);
  return dir;
}

/** A stand-in for the built server: it records where and how it was started. */
const SERVER = `import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
writeFileSync(join(process.cwd(), "started.json"), JSON.stringify({
  pid: process.pid,
  cwd: process.cwd(),
  port: process.env.PORT,
  tag: process.env.IVA_PROBE_TAG,
}));
createServer((_request, response) => {
  response.writeHead(200).end("ok");
}).listen(Number(process.env.PORT), "127.0.0.1");
`;

function probe(
  dir: string,
  extra: Record<string, string> = {},
  timeoutMs = 15_000,
) {
  return probeVersion({
    dir,
    port: PROBE_PORT,
    command: process.execPath,
    args: [join(dir, "server.mjs")],
    env: { IVA_PROBE_TAG: "probe", ...extra },
    timeoutMs,
    intervalMs: 50,
  });
}

test("the probe environment is the service's, with the probe's own port", (t) => {
  const dir = versionDir(t, "");
  const env = join(dir, ".env");
  writeFileSync(
    env,
    "MODEL_PROVIDER=anthropic\nIVA_PORT=8723\n" +
      'TELEGRAM_BOT_TOKEN="42:secret"\n' +
      "ASSISTANT_DATA_DIR=/home/user/iva/data\n" +
      "ASSISTANT_VAULT_DIR=/home/user/iva/vault\n",
  );

  const probeEnv = probeEnvironment(env, 8901, dir);
  // What systemd hands the unit through EnvironmentFile - a probe without it
  // would prove a version starts under a configuration nobody runs.
  assert.equal(probeEnv.MODEL_PROVIDER, "anthropic");
  assert.equal(probeEnv.TELEGRAM_BOT_TOKEN, "42:secret");
  // Both spellings of the port name the probe's server, never the live one.
  assert.equal(probeEnv.PORT, "8901");
  assert.equal(probeEnv.IVA_PORT, "8901");
  assert.equal(probeEnv.IVA_HEALTH_PROBE, "1");
  // And the state it opens is the version's own, whatever absolute paths that
  // .env names: those are the live installation's, and a probe is thrown away.
  assert.equal(probeEnv.ASSISTANT_DATA_DIR, join(dir, "data"));
  assert.equal(probeEnv.ASSISTANT_VAULT_DIR, join(dir, "vault"));

  // An installation without an .env is still worth checking a version against.
  const bare = probeEnvironment(join(dir, "missing.env"), 8901, dir);
  assert.deepEqual(bare, {
    ASSISTANT_DATA_DIR: join(dir, "data"),
    ASSISTANT_VAULT_DIR: join(dir, "vault"),
    PORT: "8901",
    IVA_PORT: "8901",
    IVA_HEALTH_PROBE: "1",
  });
});

test("the service port is the one the installation's .env names", (t) => {
  const dir = versionDir(t, "");
  const env = join(dir, ".env");

  writeFileSync(env, "AGENT_LANGUAGE=en\nIVA_PORT=8901\n");
  assert.equal(servicePort(env), 8901);
  // The spelling the unit uses when the installation predates IVA_PORT.
  writeFileSync(env, "PORT=8902\n");
  assert.equal(servicePort(env), 8902);
  writeFileSync(env, "IVA_PORT=\nPORT=8903\n");
  assert.equal(servicePort(env), 8903);
  // Nonsense and a missing file both mean the port the service defaults to:
  // waiting on a port nothing was ever on would roll back a healthy version.
  writeFileSync(env, "IVA_PORT=eight-thousand\n");
  assert.equal(servicePort(env), DEFAULT_PORT);
  writeFileSync(env, "IVA_PORT=99999\n");
  assert.equal(servicePort(env), DEFAULT_PORT);
  assert.equal(servicePort(join(dir, "missing.env")), DEFAULT_PORT);
});

test("the wait after a restart ends as soon as the service answers", async (t) => {
  const port = await freePort();
  const server = createServer((_request, response) =>
    response.writeHead(200).end("ok"),
  );
  t.after(() => new Promise((resolve) => server.close(resolve)));
  // Started late, the way a service that has to bundle its sources comes up.
  setTimeout(() => server.listen(port, "127.0.0.1"), 300);

  const result = await awaitServing({
    port,
    timeoutMs: 15_000,
    intervalMs: 50,
  });
  assert.deepEqual(result, { ok: true, log: "" });
});

test("a service that never answers ends the wait on the deadline", async () => {
  const port = await freePort();
  const began = Date.now();

  const result = await awaitServing({ port, timeoutMs: 600, intervalMs: 50 });
  assert.equal(result.ok, false);
  assert.match(result.log, new RegExp(`nothing answered on port ${port}`, "u"));
  // Bounded: an update that hangs here never finishes and never rolls back.
  assert.ok(Date.now() - began < 10_000, `waited ${Date.now() - began}ms`);
});

test("the wait ends when the unit is active and the service answers", async (t) => {
  const port = await freePort();
  const server = createServer((_request, response) =>
    response.writeHead(200).end("ok"),
  );
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const states = ["activating", "activating", "active"];
  setTimeout(() => server.listen(port, "127.0.0.1"), 100);

  const result = await awaitHealthy({
    unit: "iva.service",
    port,
    state: () => states.shift() ?? "active",
    timeoutMs: 15_000,
    intervalMs: 50,
  });
  assert.deepEqual(result, { ok: true, log: "" });
});

test("an active unit whose service never answers ends on the deadline", async () => {
  // The whole point of asking both: this is exactly what a restart loop looks like
  // through `is-active` alone, and it is what repair.sh used to call repaired.
  const port = await freePort();
  const began = Date.now();

  const result = await awaitHealthy({
    unit: "iva.service",
    port,
    state: () => "active",
    timeoutMs: 600,
    intervalMs: 50,
  });
  assert.equal(result.ok, false);
  assert.match(result.log, /iva\.service was active/u);
  assert.match(result.log, new RegExp(`nothing answered on port ${port}`, "u"));
  assert.ok(Date.now() - began < 10_000, `waited ${Date.now() - began}ms`);
});

test("a failed unit ends the wait at once instead of on the deadline", async () => {
  const port = await freePort();
  const began = Date.now();
  let asked = 0;

  const result = await awaitHealthy({
    unit: "iva.service",
    port,
    state: () => {
      asked++;
      return "failed";
    },
    timeoutMs: 90_000,
    intervalMs: 1000,
  });
  assert.equal(result.ok, false);
  assert.match(result.log, /iva\.service is failed/u);
  assert.equal(asked, 1);
  assert.ok(Date.now() - began < 5000, `waited ${Date.now() - began}ms`);
});

test("a service that answers with an error is not serving", async (t) => {
  // The agent's process is up and its endpoint is not: a card store it cannot
  // open answers 503 as honestly as it answers nothing.
  const port = await freePort();
  const server = createServer((_request, response) =>
    response.writeHead(503).end("cannot open the card store"),
  );
  await new Promise<void>((resolve) =>
    server.listen(port, "127.0.0.1", resolve),
  );
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const result = await awaitServing({ port, timeoutMs: 600, intervalMs: 50 });
  assert.equal(result.ok, false);
});

test("a healthy build answers on the probe port and is stopped again", async (t) => {
  const dir = versionDir(t, SERVER);

  const result = await probe(dir);
  assert.equal(result.ok, true, result.log);

  const started = JSON.parse(
    readFileSync(join(dir, "started.json"), "utf8"),
  ) as { pid: number; cwd: string; port: string; tag: string };
  // Started from the version's own final directory - the same paths it will run on.
  assert.equal(realpathSync(started.cwd), realpathSync(dir));
  assert.equal(started.port, String(PROBE_PORT));
  assert.equal(started.tag, "probe");
  assert.throws(() => process.kill(started.pid, 0), { code: "ESRCH" });
});

test("a build that dies on start fails fast and reports its own output", async (t) => {
  const dir = versionDir(
    t,
    `process.stderr.write("Cannot find module '../scripts/lib/provider.ts'\\n");\nprocess.exit(1);\n`,
  );

  const began = Date.now();
  const result = await probe(dir, {}, 15_000);
  assert.equal(result.ok, false);
  assert.match(result.log, /Cannot find module/);
  assert.ok(
    Date.now() - began < 10_000,
    `a dead process must not be waited out: ${Date.now() - began}ms`,
  );
});

test("a build that never listens fails on the deadline and leaves no process behind", async (t) => {
  const dir = versionDir(
    t,
    `import { writeFileSync } from "node:fs";\n` +
      `import { join } from "node:path";\n` +
      `writeFileSync(join(process.cwd(), "started.json"), JSON.stringify({ pid: process.pid }));\n` +
      `setInterval(() => {}, 1000);\n`,
  );

  const result = await probe(dir, {}, 1200);
  assert.equal(result.ok, false);
  assert.match(result.log, /did not become healthy/);
  const { pid } = JSON.parse(
    readFileSync(join(dir, "started.json"), "utf8"),
  ) as {
    pid: number;
  };
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("a build that ignores SIGTERM is killed anyway", async (t) => {
  const dir = versionDir(
    t,
    `import { createServer } from "node:http";\n` +
      `import { writeFileSync } from "node:fs";\n` +
      `import { join } from "node:path";\n` +
      `process.on("SIGTERM", () => {});\n` +
      `writeFileSync(join(process.cwd(), "started.json"), JSON.stringify({ pid: process.pid }));\n` +
      `createServer((_r, response) => response.writeHead(200).end("ok"))\n` +
      `  .listen(Number(process.env.PORT), "127.0.0.1");\n`,
  );

  const result = await probeVersion({
    dir,
    port: PROBE_PORT,
    command: process.execPath,
    args: [join(dir, "server.mjs")],
    timeoutMs: 15_000,
    intervalMs: 50,
    stopGraceMs: 200,
  });
  assert.equal(result.ok, true, result.log);
  const { pid } = JSON.parse(
    readFileSync(join(dir, "started.json"), "utf8"),
  ) as {
    pid: number;
  };
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("a missing command is a failed probe, not a crash", async (t) => {
  const dir = versionDir(t, "");
  const result = await probeVersion({
    dir,
    port: PROBE_PORT,
    command: join(dir, "does-not-exist"),
    args: [],
    timeoutMs: 2000,
    intervalMs: 50,
  });
  assert.equal(result.ok, false);
  assert.match(result.log, /ENOENT|does-not-exist/);
  assert.equal(existsSync(join(dir, "started.json")), false);
});

test("a foreign server on the probe port never passes for the version", async (t) => {
  // Two updates on one box can pick the same free port between checking it and
  // taking it, and then a crash-looping version gets a 200 from the other one.
  const squatter = createServer((_request, response) => {
    response.writeHead(200).end("not the version");
  });
  await new Promise<void>((resolve) =>
    squatter.listen(PROBE_PORT, "127.0.0.1", resolve),
  );
  t.after(() => new Promise((resolve) => squatter.close(resolve)));

  const dir = versionDir(
    t,
    'process.stderr.write("boom\\n");\nprocess.exit(1);\n',
  );
  const result = await probe(dir, {}, 3000);
  assert.equal(result.ok, false, result.log);
  assert.match(result.log, /the probe port was already answering/u);
  // The port is somebody else's, so this says nothing about the version: the
  // caller is owed another port, not a failed update.
  assert.equal(result.busy, true);
});

test("a start that loses the port between the check and the bind is busy, not broken", async (t) => {
  // The window no check can close: a port free when it was chosen and taken by
  // the time the version binds it. Held on loopback, where a server really binds,
  // and silently - so nothing answers and only the start itself finds out.
  const squatter = createServer();
  const port = await new Promise<number>((resolve) =>
    squatter.listen(0, "127.0.0.1", () =>
      resolve((squatter.address() as AddressInfo).port),
    ),
  );
  t.after(() => new Promise((resolve) => squatter.close(resolve)));

  const dir = versionDir(t, SERVER);
  const result = await probeVersion({
    dir,
    port,
    command: process.execPath,
    args: [join(dir, "server.mjs")],
    timeoutMs: 15_000,
    intervalMs: 50,
  });
  assert.equal(result.ok, false, result.log);
  assert.equal(result.busy, true, result.log);
  assert.match(result.log, /EADDRINUSE/u);
});

test("a version that cannot start on its own account is not busy", async (t) => {
  const dir = versionDir(
    t,
    `process.stderr.write("Cannot find module '../scripts/lib/provider.ts'\\n");\nprocess.exit(1);\n`,
  );

  // Nothing about this failure is the port's, and a retry elsewhere would only
  // start a broken version again.
  const result = await probe(dir, {}, 15_000);
  assert.equal(result.ok, false);
  assert.equal(result.busy, false, result.log);
});

// The updater writes the flag, the server-start hook reads it, and neither side can import
// the other: the probe environment is built on a tree whose agent/ may be missing. One name,
// two spellings, pinned here.
test("the probe flag the updater writes is the one the authored tree reads", () => {
  assert.equal(PROBE_FLAG, AUTHORED_PROBE_FLAG);
});
