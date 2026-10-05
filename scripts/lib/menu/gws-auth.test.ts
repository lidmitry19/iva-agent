/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registration promises. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { servicePath } from "../../../packages/claude-command/index.ts";
import {
  parseAuthChallenge,
  extractCallbackQuery,
  gwsBin,
  childEnv,
} from "./gws-auth.ts";

test("parseAuthChallenge extracts the Google URL and loopback port", () => {
  const log = [
    "Open this URL in your browser to authenticate:",
    "",
    "  https://accounts.google.com/o/oauth2/auth?scope=x&redirect_uri=http://localhost:44369&response_type=code&client_id=abc",
    "",
  ].join("\n");
  const r = parseAuthChallenge(log);
  assert.ok(r);
  assert.equal(r.port, 44369);
  assert.ok(r.url.startsWith("https://accounts.google.com/o/oauth2/auth?"));
  assert.ok(r.url.includes("redirect_uri=http://localhost:44369"));
});

test("parseAuthChallenge accepts 127.0.0.1 loopback", () => {
  const log =
    "go: https://accounts.google.com/o/oauth2/auth?redirect_uri=http://127.0.0.1:51000&x=1";
  const r = parseAuthChallenge(log);
  assert.ok(r);
  assert.equal(r.port, 51000);
});

test("parseAuthChallenge returns null when the URL is not printed yet", () => {
  assert.equal(parseAuthChallenge("starting auth..."), null);
  assert.equal(parseAuthChallenge(""), null);
});

const SEED = 20260924;

function consentUrl(redirect: string): string {
  return `https://accounts.google.com/o/oauth2/auth?scope=x&redirect_uri=${redirect}&response_type=code&client_id=synthetic`;
}

test("parseAuthChallenge reads a URL-encoded loopback redirect_uri (gws 0.22.5)", () => {
  const url = consentUrl("http%3A%2F%2Flocalhost%3A41803%2F");
  assert.deepEqual(
    parseAuthChallenge(`Open this URL in your browser:\n\n${url}\n`),
    { url, port: 41803 },
  );
});

test("parseAuthChallenge reads a URL-encoded 127.0.0.1 redirect_uri", () => {
  const url = consentUrl("http%3A%2F%2F127.0.0.1%3A51000%2F");
  assert.deepEqual(parseAuthChallenge(`go: ${url}`), { url, port: 51000 });
});

test("parseAuthChallenge keeps an explicit :80 that URL treats as the default port", () => {
  for (const redirect of [
    "http%3A%2F%2Flocalhost%3A80%2F",
    "http://127.0.0.1:80",
  ]) {
    assert.equal(parseAuthChallenge(consentUrl(redirect))?.port, 80, redirect);
  }
});

test("parseAuthChallenge rejects a redirect_uri that is not a valid loopback port", () => {
  const rejected = [
    "http%3A%2F%2Fexample.com%3A41803%2F",
    "http://example.com:41803",
    "https%3A%2F%2Flocalhost%3A41803%2F",
    "https://localhost:41803",
    "http%3A%2F%2Flocalhost%2F",
    "http://localhost",
    "http%3A%2F%2Flocalhost%3A0%2F",
    "http://localhost:0",
    "http%3A%2F%2Flocalhost%3A65536%2F",
    "http://localhost:65536",
    "http%3A%2F%2F%5B%3A41803%2F",
    "not-a-url",
    "",
  ];
  for (const redirect of rejected) {
    assert.equal(parseAuthChallenge(consentUrl(redirect)), null, redirect);
  }
  assert.equal(
    parseAuthChallenge("https://accounts.google.com/o/oauth2/auth?scope=x"),
    null,
  );
});

test(`parseAuthChallenge reads the same port from encoded and raw redirect_uri (seed ${SEED})`, () => {
  fc.assert(
    fc.property(
      fc.oneof(
        fc.integer({ min: 1, max: 65535 }),
        fc.constantFrom(1, 80, 65535),
      ),
      fc.constantFrom("localhost", "127.0.0.1"),
      fc.boolean(),
      (port, host, slash) => {
        const raw = `http://${host}:${port}${slash ? "/" : ""}`;
        const encoded = parseAuthChallenge(consentUrl(encodeURIComponent(raw)));
        const plain = parseAuthChallenge(consentUrl(raw));
        assert.equal(encoded?.port, port);
        assert.equal(plain?.port, port);
      },
    ),
    { seed: SEED, numRuns: 300 },
  );
});

test("extractCallbackQuery pulls the query from a full redirect URL", () => {
  const q = extractCallbackQuery(
    "http://localhost:44369/?code=4/0ABC_def-123&scope=email%20profile&authuser=0",
  );
  assert.equal(q, "code=4/0ABC_def-123&scope=email%20profile&authuser=0");
});

test("extractCallbackQuery tolerates surrounding whitespace/newlines", () => {
  const q = extractCallbackQuery("  http://localhost:1/?code=4/0X&state=y \n");
  assert.equal(q, "code=4/0X&state=y");
});

test("extractCallbackQuery accepts a bare query string", () => {
  assert.equal(extractCallbackQuery("code=4/0X&scope=y"), "code=4/0X&scope=y");
});

test("extractCallbackQuery accepts a bare authorization code", () => {
  assert.equal(
    extractCallbackQuery("4/0AXEQabc-DEF_123"),
    "code=4/0AXEQabc-DEF_123",
  );
});

test("extractCallbackQuery returns null when there is no code", () => {
  assert.equal(extractCallbackQuery("hello there"), null);
  assert.equal(extractCallbackQuery("http://localhost:1/?scope=y"), null);
  assert.equal(extractCallbackQuery(""), null);
});

test(`Google auth and service PATH prefer the updated user CLI over an older Node-prefix CLI (seed ${SEED})`, (t) => {
  const root = mkdtempSync(join(tmpdir(), "iva-gws-path-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let run = 0;
  fc.assert(
    fc.property(
      fc.constantFrom("home", "user with spaces", "пользователь"),
      fc.boolean(),
      fc.boolean(),
      (name, localPresent, symlinked) => {
        const home = join(root, `${run++}-${name}`);
        // Represents an old gws in the same bin directory as system/nvm Node.
        const nodeBin = join(home, "old-node/bin");
        const localBin = join(home, ".local/bin");
        mkdirSync(nodeBin, { recursive: true });
        mkdirSync(localBin, { recursive: true });
        const old = join(nodeBin, "gws");
        writeFileSync(old, "#!/bin/sh\nprintf old");
        chmodSync(old, 0o755);
        const local = join(localBin, "gws");
        if (localPresent) {
          const target = symlinked ? join(home, "npm-launcher") : local;
          writeFileSync(target, "#!/bin/sh\nprintf updated");
          chmodSync(target, 0o755);
          if (symlinked) symlinkSync(target, local);
        }
        assert.equal(gwsBin(nodeBin, home), localPresent ? local : old);
        assert.equal(
          execFileSync("gws", [], {
            env: { PATH: servicePath(nodeBin, home) },
            encoding: "utf8",
          }),
          localPresent ? "updated" : "old",
        );
      },
    ),
    { seed: SEED, numRuns: 30 },
  );
});

test("Google auth falls back to PATH when neither npm location has a CLI", (t) => {
  const home = mkdtempSync(join(tmpdir(), "iva-gws-missing-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  assert.equal(gwsBin(join(home, "node/bin"), home), "gws");
});

test("Google auth child environment finds the user CLI before an older shell CLI", (t) => {
  const home = mkdtempSync(join(tmpdir(), "iva-gws-child-"));
  const previousHome = process.env.HOME;
  const previousPath = process.env.PATH;
  t.after(() => {
    process.env.HOME = previousHome;
    process.env.PATH = previousPath;
    rmSync(home, { recursive: true, force: true });
  });
  for (const [dir, answer] of [
    [join(home, ".local/bin"), "updated"],
    [join(home, "old-bin"), "old"],
  ]) {
    mkdirSync(dir, { recursive: true });
    const bin = join(dir, "gws");
    writeFileSync(bin, `#!/bin/sh\nprintf ${answer}`);
    chmodSync(bin, 0o755);
  }
  process.env.HOME = home;
  process.env.PATH = join(home, "old-bin");
  assert.equal(
    execFileSync("gws", [], { env: childEnv(), encoding: "utf8" }),
    "updated",
  );
});
