// Headless OAuth relay for the `gws` (Google Workspace) CLI.
//
// `gws auth login` only supports the loopback flow: it starts a local HTTP server on
// http://localhost:<random-port> and waits for Google to redirect the browser there with the
// authorization code. On a headless server the user's browser is on a different machine, so the
// redirect never reaches the server's listener and the flow can never complete.
//
// This module drives the same flow from the bot: start gws (capturing its auth URL + loopback
// port), hand the URL to the user over Telegram, and when the user pastes the failed redirect URL
// back, replay it against the loopback listener locally on the server so gws finishes and stores
// the token. Pure parsers are separated for unit testing.
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, openSync, closeSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { servicePath } from "../../../packages/claude-command/index.ts";

export interface AuthChallenge {
  url: string;
  port: number;
}

export interface AuthSession extends AuthChallenge {
  pid: number | undefined;
  logPath: string;
}

export interface RelayResult {
  ok: boolean;
  status: number | undefined;
  error?: string;
}

interface StartAuthOptions {
  services?: string;
  timeoutMs?: number;
}

interface RelayCodeOptions {
  timeoutMs?: number;
}

function textValue(value: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- Preserve the legacy parser's String coercion for arbitrary inputs.
  return value === null || value === undefined ? "" : String(value);
}

// --- Pure parsers (unit-tested in gws-auth.test.ts) ---

// From gws stdout, pull the Google consent URL and the loopback port it registered.
// Returns { url, port } once gws has printed them, else null.
// gws 0.22.5 prints redirect_uri URL-encoded (`http%3A%2F%2Flocalhost%3A41803%2F`), older
// versions raw; searchParams decodes both.
export function parseAuthChallenge(logText: unknown): AuthChallenge | null {
  const text = textValue(logText);
  const url = text.match(/https:\/\/accounts\.google\.com\/[^\s]+/)?.[0];
  if (!url) return null;
  try {
    const redirect = new URL(url).searchParams.get("redirect_uri");
    if (!redirect) return null;
    const port = loopbackPort(redirect);
    return port === null ? null : { url, port };
  } catch {
    return null;
  }
}

// Port of an explicit `http://localhost:<port>` or `http://127.0.0.1:<port>` URL, else null.
function loopbackPort(redirect: string): number | null {
  const target = new URL(redirect);
  if (target.protocol !== "http:") return null;
  if (target.hostname !== "localhost" && target.hostname !== "127.0.0.1") {
    return null;
  }
  // URL drops the scheme's default port, so an explicit :80 reads as "".
  const explicit =
    target.port ||
    (/^http:\/\/[^/?#]*:0*80(?:[/?#]|$)/i.test(redirect) ? "80" : "");
  const port = Number(explicit);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

// Normalize whatever the user pasted back into the raw callback query string (must carry `code`).
// Accepts a full redirect URL, a bare `code=...&...` query, or a bare `4/...` authorization code.
export function extractCallbackQuery(input: unknown): string | null {
  const text = textValue(input).trim();
  if (!text) return null;

  let query = null;
  const urlMatch = text.match(/https?:\/\/\S+/);
  if (urlMatch) {
    const qi = urlMatch[0].indexOf("?");
    if (qi >= 0) query = urlMatch[0].slice(qi + 1);
  } else if (text.includes("=")) {
    query = text.replace(/^\?/, "");
  } else if (/^4\/[\w-]+$/.test(text)) {
    return `code=${text}`;
  }

  if (!query) return null;
  query = query.split(/\s/)[0];
  if (!new URLSearchParams(query).get("code")) return null;
  return query;
}

// --- Environment: resolve gws + node without relying on the service PATH ---
// Prefer the user prefix used by install/update over an older global gws.
// Keep the old nvm location as a fallback before its first update, and make Node
// available for the launcher's `#!/usr/bin/env node` shebang.
const NODE_BIN_DIR = dirname(process.execPath);

export function gwsBin(nodeBinDir = NODE_BIN_DIR, home = homedir()) {
  for (const dir of [join(home, ".local/bin"), nodeBinDir]) {
    const candidate = join(dir, "gws");
    if (existsSync(candidate)) return candidate;
  }
  return "gws";
}

export function childEnv() {
  const bins = servicePath(NODE_BIN_DIR, homedir());
  const path = process.env.PATH ? `${bins}:${process.env.PATH}` : bins;
  return { ...process.env, PATH: path };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Services we request at login. Single source of truth: the menu shows the same list to the user.
export const AUTH_SERVICES = "gmail,calendar,drive,tasks";

// Start `gws auth login` detached, capturing stdout to a temp log. Poll the log until gws prints
// the consent URL + loopback port, then return { pid, port, url, logPath }. Returns null if gws
// never printed the challenge (died early / timed out) — the child is killed in that case.
export async function startAuth({
  services = AUTH_SERVICES,
  timeoutMs = 6000,
}: StartAuthOptions = {}): Promise<AuthSession | null> {
  const logPath = join(
    tmpdir(),
    `iva-gws-auth-${process.pid}-${Date.now()}.log`,
  );
  const fd = openSync(logPath, "a");
  let child;
  try {
    child = spawn(gwsBin(), ["auth", "login", "-s", services], {
      env: childEnv(),
      detached: true,
      stdio: ["ignore", fd, fd],
    });
  } finally {
    closeSync(fd);
  }
  child.unref();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(250);
    let logText = "";
    try {
      logText = await readFile(logPath, "utf8");
    } catch {
      /* not written yet */
    }
    const parsed = parseAuthChallenge(logText);
    if (parsed) return { pid: child.pid, logPath, ...parsed };
    if (child.exitCode !== null || child.signalCode !== null) break; // died before printing
  }
  try {
    if (child.pid) process.kill(child.pid);
  } catch {
    /* already gone */
  }
  return null;
}

// Replay the callback query against the loopback listener on the server, completing the flow gws
// is waiting on. Returns { ok, status }.
export function relayCode(
  port: number,
  query: string,
  { timeoutMs = 8000 }: RelayCodeOptions = {},
): Promise<RelayResult> {
  return new Promise((resolve) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: `/?${query}`,
        method: "GET",
        timeout: timeoutMs,
      },
      (res) => {
        const status = res.statusCode;
        res.resume();
        res.on("end", () =>
          resolve({
            ok: (status ?? 0) >= 200 && (status ?? 0) < 400,
            status,
          }),
        );
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, status: 0 });
    });
    req.on("error", (error) =>
      resolve({ ok: false, status: 0, error: error.message }),
    );
    req.end();
  });
}
