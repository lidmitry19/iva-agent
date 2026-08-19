import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  isOfficialIvaOrigin,
  runRepairUpdate,
  validateOfficialCheckout,
} from "./repair-update.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

void test("repair bootstrap accepts only the canonical Iva GitHub remote", () => {
  assert.equal(isOfficialIvaOrigin("git@github.com:smixs/iva.git"), true);
  assert.equal(isOfficialIvaOrigin("https://github.com/smixs/iva.git"), true);
  assert.equal(isOfficialIvaOrigin("ssh://git@github.com/smixs/iva"), true);
  assert.equal(isOfficialIvaOrigin("https://github.com/smixs/iva-evil"), false);
  assert.equal(isOfficialIvaOrigin("http://github.com/smixs/iva.git"), false);
  assert.equal(isOfficialIvaOrigin("ftp://github.com/smixs/iva.git"), false);
  assert.equal(isOfficialIvaOrigin("git://github.com/smixs/iva.git"), false);
  assert.equal(
    isOfficialIvaOrigin("https://github.com:444/smixs/iva.git"),
    false,
  );
  assert.equal(isOfficialIvaOrigin("https://github.com//smixs/iva.git"), false);
  assert.equal(isOfficialIvaOrigin("https://github.com/SMIXS/IVA.GIT"), true);
  assert.equal(isOfficialIvaOrigin("git@example.com:smixs/iva.git"), false);
});

void test("repair bootstrap accepts the renamed repository alongside the old name", () => {
  assert.equal(isOfficialIvaOrigin("git@github.com:smixs/iva-agent"), true);
  assert.equal(isOfficialIvaOrigin("git@github.com:smixs/iva-agent.git"), true);
  assert.equal(isOfficialIvaOrigin("https://github.com/smixs/iva-agent"), true);
  assert.equal(
    isOfficialIvaOrigin("https://github.com/smixs/iva-agent.git"),
    true,
  );
  assert.equal(
    isOfficialIvaOrigin("ssh://git@github.com/smixs/iva-agent"),
    true,
  );
  assert.equal(
    isOfficialIvaOrigin("ssh://git@github.com/smixs/iva-agent.git"),
    true,
  );
  assert.equal(
    isOfficialIvaOrigin("https://github.com/SMIXS/IVA-AGENT.GIT"),
    true,
  );
  assert.equal(
    isOfficialIvaOrigin("https://github.com/smixs/iva-agentx"),
    false,
  );
  assert.equal(
    isOfficialIvaOrigin("https://github.com/smixs/iva-plugins"),
    false,
  );
  assert.equal(
    isOfficialIvaOrigin("git@example.com:smixs/iva-agent.git"),
    false,
  );
  assert.equal(
    isOfficialIvaOrigin("http://github.com/smixs/iva-agent.git"),
    false,
  );
});

void test("repair bootstrap validates the checkout before changing files", () => {
  const root = mkdtempSync(join(tmpdir(), "iva-repair-"));
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Iva Test");
  writeFileSync(join(root, "package.json"), '{"name":"iva"}\n');
  git(root, "add", "package.json");
  git(root, "commit", "-m", "fixture");
  git(root, "remote", "add", "origin", "git@github.com:smixs/iva.git");

  assert.doesNotThrow(() => validateOfficialCheckout(root));
  git(
    root,
    "remote",
    "set-url",
    "origin",
    "git@github.com:smixs/iva-agent.git",
  );
  assert.doesNotThrow(() => validateOfficialCheckout(root));
  git(root, "remote", "set-url", "origin", "git@example.com:smixs/iva.git");
  assert.throws(
    () => validateOfficialCheckout(root),
    /official smixs\/iva-agent/,
  );
});

void test("repair bootstrap validates runtime input before filesystem access", () => {
  assert.throws(
    () => runRepairUpdate({ inputRoot: 42 as never }),
    (error: unknown) => (error as Error).name === "ZodError",
  );
  assert.throws(
    () =>
      runRepairUpdate({
        inputRoot: "",
        expectedTarget: "ABCDEF",
      }),
    (error: unknown) => (error as Error).name === "ZodError",
  );
});

type RepairFixture = {
  temp: string;
  remote: string;
  seed: string;
  local: string;
  baseHead: string;
};

function repairFixture({
  updaterScript = 'import { execFileSync } from "node:child_process";\n' +
    'execFileSync("git", ["reset", "--hard", "origin/main"], { stdio: "ignore" });\n' +
    "process.exitCode = 1;\n",
}: { updaterScript?: string } = {}): RepairFixture {
  const temp = mkdtempSync(join(tmpdir(), "iva-repair-flow-"));
  const remote = join(temp, "remote.git");
  const seed = join(temp, "seed");
  const local = join(temp, "local");
  git(temp, "init", "--bare", remote);
  git(temp, "init", "-b", "main", seed);
  git(seed, "config", "user.email", "test@example.com");
  git(seed, "config", "user.name", "Iva Test");
  mkdirSync(join(seed, "bin"), { recursive: true });
  mkdirSync(join(seed, "scripts/cli"), { recursive: true });
  mkdirSync(join(seed, "scripts/lib"), { recursive: true });
  writeFileSync(join(seed, "package.json"), '{"name":"iva"}\n');
  writeFileSync(join(seed, "user.txt"), "base\n");
  writeFileSync(join(seed, "bin/iva.mjs"), updaterScript);
  for (const relative of [
    "scripts/cli/update.ts",
    "scripts/lib/update-safety.ts",
    "scripts/lib/custom-layer.ts",
    "scripts/lib/telegram-status.ts",
  ])
    writeFileSync(join(seed, relative), `base ${relative}\n`);
  git(seed, "add", ".");
  git(seed, "commit", "-m", "base");
  const baseHead = git(seed, "rev-parse", "HEAD");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-u", "origin", "main");
  git(temp, "clone", "--branch", "main", remote, local);
  git(local, "config", "user.email", "test@example.com");
  git(local, "config", "user.name", "Iva Test");

  writeFileSync(join(seed, "core.txt"), "new core\n");
  for (const relative of [
    "scripts/cli/update.ts",
    "scripts/lib/update-safety.ts",
    "scripts/lib/custom-layer.ts",
    "scripts/lib/telegram-status.ts",
  ])
    writeFileSync(join(seed, relative), `target ${relative}\n`);
  git(seed, "add", ".");
  git(seed, "commit", "-m", "target");
  git(seed, "push", "origin", "main");
  return { temp, remote, seed, local, baseHead };
}

function withRepairGit(
  fixture: RepairFixture,
  { failStash = false }: { failStash?: boolean },
  run: () => void,
): void {
  const bin = join(fixture.temp, "bin");
  mkdirSync(bin);
  const wrapper = join(bin, "git");
  writeFileSync(
    wrapper,
    "#!/bin/sh\n" +
      'if [ "$1" = "remote" ] && [ "$2" = "get-url" ]; then\n' +
      '  printf "%s\\n" "git@github.com:smixs/iva.git"\n' +
      "  exit 0\n" +
      "fi\n" +
      'if [ "$1" = "fetch" ]; then\n' +
      "  for IVA_TEST_REF do :; done\n" +
      "  IVA_TEST_BRANCH=${IVA_TEST_REF#refs/heads/}\n" +
      '  exec "$IVA_TEST_REAL_GIT" fetch "$IVA_TEST_REMOTE" "+refs/heads/$IVA_TEST_BRANCH:refs/remotes/origin/$IVA_TEST_BRANCH"\n' +
      "fi\n" +
      'if [ "$1" = "stash" ] && [ "$2" = "push" ] && [ "$IVA_TEST_STASH_FAIL" = "1" ]; then\n' +
      "  exit 97\n" +
      "fi\n" +
      'exec "$IVA_TEST_REAL_GIT" "$@"\n',
  );
  chmodSync(wrapper, 0o755);
  const previous = {
    PATH: process.env.PATH,
    realGit: process.env.IVA_TEST_REAL_GIT,
    remote: process.env.IVA_TEST_REMOTE,
    failStash: process.env.IVA_TEST_STASH_FAIL,
  };
  process.env.PATH = `${bin}:${previous.PATH ?? ""}`;
  process.env.IVA_TEST_REAL_GIT = execFileSync("which", ["git"], {
    encoding: "utf8",
    env: { ...process.env, PATH: previous.PATH },
  }).trim();
  process.env.IVA_TEST_REMOTE = fixture.remote;
  process.env.IVA_TEST_STASH_FAIL = failStash ? "1" : "0";
  try {
    run();
  } finally {
    if (previous.PATH === undefined) delete process.env.PATH;
    else process.env.PATH = previous.PATH;
    if (previous.realGit === undefined) delete process.env.IVA_TEST_REAL_GIT;
    else process.env.IVA_TEST_REAL_GIT = previous.realGit;
    if (previous.remote === undefined) delete process.env.IVA_TEST_REMOTE;
    else process.env.IVA_TEST_REMOTE = previous.remote;
    if (previous.failStash === undefined)
      delete process.env.IVA_TEST_STASH_FAIL;
    else process.env.IVA_TEST_STASH_FAIL = previous.failStash;
  }
}

void test("repair leaves dirty files untouched when stash creation fails", () => {
  const fixture = repairFixture();
  writeFileSync(join(fixture.local, "user.txt"), "local tracked\n");
  writeFileSync(join(fixture.local, "local-only.txt"), "local untracked\n");

  withRepairGit(fixture, { failStash: true }, () => {
    assert.throws(
      () => runRepairUpdate({ inputRoot: fixture.local }),
      /Command failed/,
    );
  });

  assert.equal(
    readFileSync(join(fixture.local, "user.txt"), "utf8"),
    "local tracked\n",
  );
  assert.equal(
    readFileSync(join(fixture.local, "local-only.txt"), "utf8"),
    "local untracked\n",
  );
});

void test("repair restores dirty state when updater changes HEAD then fails", () => {
  const fixture = repairFixture();
  const originalHead = git(fixture.local, "rev-parse", "HEAD");
  writeFileSync(join(fixture.local, "user.txt"), "local tracked\n");
  writeFileSync(join(fixture.local, "local-only.txt"), "local untracked\n");

  withRepairGit(fixture, {}, () => {
    assert.throws(
      () => runRepairUpdate({ inputRoot: fixture.local }),
      /repaired updater failed/,
    );
  });

  assert.equal(git(fixture.local, "rev-parse", "HEAD"), originalHead);
  assert.equal(
    readFileSync(join(fixture.local, "user.txt"), "utf8"),
    "local tracked\n",
  );
  assert.equal(
    readFileSync(join(fixture.local, "local-only.txt"), "utf8"),
    "local untracked\n",
  );
});

void test("repair follows the configured update channel", () => {
  const fixture = repairFixture({
    updaterScript:
      'import { execFileSync } from "node:child_process";\n' +
      'execFileSync("git", ["reset", "--hard", "origin/stable"], { stdio: "ignore" });\n',
  });
  git(fixture.seed, "checkout", "-b", "stable", fixture.baseHead);
  writeFileSync(join(fixture.seed, "stable.txt"), "stable target\n");
  for (const relative of [
    "scripts/cli/update.ts",
    "scripts/lib/update-safety.ts",
    "scripts/lib/custom-layer.ts",
    "scripts/lib/telegram-status.ts",
  ])
    writeFileSync(join(fixture.seed, relative), `stable ${relative}\n`);
  git(fixture.seed, "add", ".");
  git(fixture.seed, "commit", "-m", "stable target");
  const stableHead = git(fixture.seed, "rev-parse", "HEAD");
  git(fixture.seed, "push", "origin", "stable");
  git(fixture.local, "config", "--local", "iva.updateBranch", "stable");

  withRepairGit(fixture, {}, () => {
    assert.doesNotThrow(() =>
      runRepairUpdate({
        inputRoot: fixture.local,
        expectedTarget: stableHead,
      }),
    );
  });

  assert.equal(git(fixture.local, "rev-parse", "HEAD"), stableHead);
  assert.equal(
    readFileSync(join(fixture.local, "stable.txt"), "utf8"),
    "stable target\n",
  );
});

void test("repair accepts an updater that activated a version instead of moving HEAD", () => {
  // What the bridge does to an install the repair is bootstrapping: the working
  // tree stays where it was and `current` is what says the target is live.
  const fixture = repairFixture({
    updaterScript:
      'import { execFileSync } from "node:child_process";\n' +
      'import { mkdirSync, symlinkSync } from "node:fs";\n' +
      'import { join } from "node:path";\n' +
      'const sha = execFileSync("git", ["rev-parse", "origin/main"], { encoding: "utf8" }).trim();\n' +
      'const dir = join(process.cwd(), "versions", `0.3.15-${sha.slice(0, 12)}`);\n' +
      "mkdirSync(dir, { recursive: true });\n" +
      'symlinkSync(dir, join(process.cwd(), "current"));\n',
  });
  const head = git(fixture.local, "rev-parse", "HEAD");
  const target = git(fixture.seed, "rev-parse", "HEAD");

  withRepairGit(fixture, {}, () => {
    assert.doesNotThrow(() =>
      runRepairUpdate({ inputRoot: fixture.local, expectedTarget: target }),
    );
  });

  assert.equal(git(fixture.local, "rev-parse", "HEAD"), head);
});
