import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnvText } from "./env-file.ts";
import { DEFAULT_PORT } from "./ports.ts";

const LOG_TAIL = 4000;
/**
 * Set for the probe only; the code that runs on boot reads it to stay passive. The reader
 * is `agent/instrumentation.ts`, which carries the same name in `agent/lib/eve-health.ts`
 * — `iva update` writes this environment on a tree whose `agent/` may be missing or
 * half-written, so the writer cannot reach for the authored tree. The two spellings are
 * pinned together in `scripts/lib/health-probe.test.ts`.
 */
export const PROBE_FLAG = "IVA_HEALTH_PROBE";
const BUSY_PORT = "the probe port was already answering";
/** How long a restarted service is given to answer. Every caller waits the same. */
export const SERVING_TIMEOUT_MS = 90_000;
/** What `systemctl --user is-active` prints for a unit systemd has given up on. */
const FAILED = "failed";
const ACTIVE = "active";
/** What a start that lost the port to somebody else says, whatever starts it. */
const TAKEN = /EADDRINUSE/u;

/** Whatever answers on the port, or null when nothing does in time. */
async function answering(port: number, ms = 1000): Promise<Response | null> {
  try {
    const url = `http://127.0.0.1:${port}/`;
    return await fetch(url, { signal: AbortSignal.timeout(ms) });
  } catch {
    return null;
  }
}

export type ProbeOptions = {
  /** The version directory: both the cwd and the source of the command. */
  readonly dir: string;
  readonly port: number;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly stopGraceMs?: number;
};

export type ProbeResult = {
  readonly ok: boolean;
  readonly log: string;
  /**
   * The port was gone by the time the start reached it, so this says nothing
   * about the version: whoever asked for the probe should offer another port.
   */
  readonly busy?: boolean;
};

/**
 * The environment the service starts with, adjusted for a probe: the unit's own
 * `.env`, or the check proves a configuration nobody runs; the probe's port in
 * both spellings, or code reaching for `IVA_PORT` talks to the live service; and
 * the version's state directories, because that `.env` may name absolute ones and
 * a start about to be thrown away writes to them as it comes up.
 */
export function probeEnvironment(
  envPath: string,
  port: number,
  dir: string,
): Record<string, string> {
  let values: Record<string, string> = {};
  try {
    values = parseEnvText(readFileSync(envPath, "utf8"));
  } catch {
    // A missing .env is a valid state; an unreadable one is the service's to report.
  }
  return {
    ...values,
    ASSISTANT_DATA_DIR: join(dir, "data"),
    ASSISTANT_VAULT_DIR: join(dir, "vault"),
    PORT: String(port),
    IVA_PORT: String(port),
    [PROBE_FLAG]: "1",
  };
}

/** The port the service really listens on, as the installation's own .env spells it. */
export function servicePort(envPath: string): number {
  let values: Record<string, string> = {};
  try {
    values = parseEnvText(readFileSync(envPath, "utf8"));
  } catch {
    // No readable .env: the service is on the port it defaults to.
  }
  const port = Number(
    (values.IVA_PORT ?? "").trim() || (values.PORT ?? "").trim(),
  );
  return Number.isInteger(port) && port > 0 && port <= 65535
    ? port
    : DEFAULT_PORT;
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait for the service to answer on its own port after it has been restarted.
 * The probe before the flip starts a version on scratch state, so this is the
 * first and only moment anything checks the version against the installation the
 * user actually has: its cards, its port, the environment of its unit.
 */
export async function awaitServing({
  port,
  timeoutMs = SERVING_TIMEOUT_MS,
  intervalMs = 1000,
}: {
  readonly port: number;
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
}): Promise<ProbeResult> {
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 1; ; attempt++) {
    if ((await answering(port, Math.min(intervalMs * 2, 2000)))?.ok)
      return { ok: true, log: "" };
    if (Date.now() >= deadline)
      return {
        ok: false,
        log: `nothing answered on port ${port} within ${timeoutMs}ms (${attempt} attempts)`,
      };
    await wait(intervalMs);
  }
}

export type HealthyOptions = {
  readonly unit: string;
  readonly port: number;
  /** The unit's state, exactly as `systemctl --user is-active` prints it. */
  readonly state: () => string;
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
};

/**
 * Wait until the unit is active AND the service answers on its own port. Both, because
 * neither alone is the service being up: a unit in a restart loop reads `active` in the
 * moment between two crashes, and an accepted `systemctl restart` says nothing at all.
 * Whoever restarted the service asks this before telling the user it is back.
 */
export async function awaitHealthy({
  unit,
  port,
  state,
  timeoutMs = SERVING_TIMEOUT_MS,
  intervalMs = 1000,
}: HealthyOptions): Promise<ProbeResult> {
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 1; ; attempt++) {
    const current = state();
    // systemd has stopped restarting it: waiting out the deadline only delays this answer.
    if (current === FAILED)
      return {
        ok: false,
        log: `${unit} is failed after ${attempt} attempt(s)`,
      };
    if (
      current === ACTIVE &&
      (await answering(port, Math.min(intervalMs * 2, 2000)))?.ok
    )
      return { ok: true, log: "" };
    if (Date.now() >= deadline)
      return {
        ok: false,
        log:
          `${unit} was ${current || "unknown"} and nothing answered on port ${port} ` +
          `within ${timeoutMs}ms (${attempt} attempts)`,
      };
    await wait(intervalMs);
  }
}

/**
 * Start a built version from its final directory and wait for it to answer: the
 * only check that tells a green build from a service that comes up, because the
 * server bundles TypeScript from its own paths as it starts.
 */
export async function probeVersion({
  dir,
  port,
  command = process.execPath,
  args = [
    join(dir, "node_modules/eve/bin/eve.js"),
    "start",
    "--host",
    "127.0.0.1",
  ],
  env = {},
  timeoutMs = 90_000,
  intervalMs = 500,
  stopGraceMs = 5000,
}: ProbeOptions): Promise<ProbeResult> {
  // Whatever answers before anything is started cannot be the version.
  if (await answering(port))
    return { ok: false, busy: true, log: `${BUSY_PORT} on ${port}` };

  let log = "";
  let exit: { code: number | null; signal: NodeJS.Signals | null } | null =
    null;
  const child = spawn(command, [...args], {
    cwd: dir,
    env: { ...process.env, ...env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const collect = (chunk: unknown): void => {
    log = `${log}${String(chunk)}`.slice(-LOG_TAIL);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  child.on("error", (error) => {
    collect(`${error.message}\n`);
    exit = { code: 1, signal: null };
  });
  const stopped = new Promise<void>((resolve) =>
    child.on("close", (code, signal) => {
      exit ??= { code, signal };
      resolve();
    }),
  );

  const deadline = Date.now() + timeoutMs;
  let ok = false;
  while (!ok && !exit && Date.now() < deadline) {
    ok = (await answering(port, Math.min(intervalMs * 4, 2000)))?.ok ?? false;
    await wait(intervalMs);
    if (ok && exit) ok = false; // The answer is only the version's if it is alive.
  }

  // Captured before the shutdown below turns every run into an "exited" one.
  const crash = exit as { code: number | null; signal: string | null } | null;
  if (crash) await stopped;
  else {
    child.kill("SIGTERM");
    // The port has to be free before the real service takes it: escalate, do not hope.
    const killer = setTimeout(() => child.kill("SIGKILL"), stopGraceMs);
    await stopped;
    clearTimeout(killer);
  }
  if (ok) return { ok: true, log };
  const reason = crash
    ? `exited with code ${crash.code ?? "null"}${crash.signal ? ` (${crash.signal})` : ""}`
    : `did not become healthy on port ${port} within ${timeoutMs}ms`;
  // A port free when it was chosen and taken when it was bound is a race with
  // whoever took it, not a version that cannot start.
  return { ok: false, log: `${reason}\n${log}`, busy: TAKEN.test(log) };
}
