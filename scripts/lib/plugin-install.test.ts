/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Как плагин попадает на диск: разрешение ref, shallow-fetch одного sha, sparse-checkout
// подпапки, копия локальной папки и переезд в стор. Всё против настоящего git и
// настоящего локального bare-репозитория — подделывать здесь нечего.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import {
  copyPluginTree,
  fetchGitPlugin,
  localChanges,
  resolveRemoteSha,
  swapIntoStore,
  type GitRunner,
} from "./plugin-install.ts";

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "iva-test",
  GIT_AUTHOR_EMAIL: "iva@test.local",
  GIT_COMMITTER_NAME: "iva-test",
  GIT_COMMITTER_EMAIL: "iva@test.local",
};

const worlds: string[] = [];

after(() => {
  for (const dir of worlds) rmSync(dir, { recursive: true, force: true });
});

function world(): string {
  const dir = mkdtempSync(join(tmpdir(), "iva-plugin-install-"));
  worlds.push(dir);
  return dir;
}

const git: GitRunner = (args, cwd) => {
  const result = spawnSync("git", [...args], {
    cwd: cwd ?? process.cwd(),
    encoding: "utf8",
    env: GIT_ENV,
  });
  return {
    code: result.status ?? 1,
    out: (result.stdout || "").trim(),
    err: (result.stderr || "").trim(),
  };
};

function mustGit(args: readonly string[], cwd: string): string {
  const result = git(args, cwd);
  if (result.code !== 0)
    throw new Error(`git ${args.join(" ")}: ${result.err || result.out}`);
  return result.out;
}

function write(root: string, path: string, contents: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

type Fixture = {
  readonly url: string;
  readonly sha: string;
  readonly tagSha: string;
};

/** Bare-репозиторий с плагином в корне, плагином в подпапке и аннотированным тегом. */
function fixture(): Fixture {
  const base = world();
  const bare = join(base, "remote.git");
  mustGit(["init", "-q", "--bare", "--initial-branch=main", bare], base);
  const work = join(base, "work");
  mkdirSync(work, { recursive: true });
  mustGit(["init", "-q", "--initial-branch=main"], work);
  write(work, "plugin.json", '{"name":"root"}');
  write(work, "plugins/trace/plugin.json", '{"name":"trace"}');
  write(work, "plugins/trace/skills/viewer/SKILL.md", "---\nname: v\n---\n");
  write(work, "other/noise.txt", "not the plugin\n");
  mustGit(["add", "-A"], work);
  mustGit(["commit", "-qm", "first"], work);
  const tagSha = mustGit(["rev-parse", "HEAD"], work);
  mustGit(["tag", "-a", "v1.0", "-m", "release"], work);
  write(work, "plugin.json", '{"name":"root","version":"2"}');
  mustGit(["add", "-A"], work);
  mustGit(["commit", "-qm", "second"], work);
  mustGit(["push", "-q", `file://${bare}`, "HEAD:refs/heads/main"], work);
  mustGit(["push", "-q", `file://${bare}`, "v1.0"], work);
  return {
    url: `file://${bare}`,
    sha: mustGit(["rev-parse", "HEAD"], work),
    tagSha,
  };
}

test("a ref resolves to one commit; a sha is taken as it stands", () => {
  const remote = fixture();

  assert.deepEqual(resolveRemoteSha(git, remote.url, null), {
    sha: remote.sha,
    ref: "HEAD",
  });
  assert.deepEqual(resolveRemoteSha(git, remote.url, "main"), {
    sha: remote.sha,
    ref: "main",
  });
  // Аннотированный тег объявляет и себя, и коммит (`^{}`) — берём коммит.
  assert.deepEqual(resolveRemoteSha(git, remote.url, "v1.0"), {
    sha: remote.tagSha,
    ref: "v1.0",
  });
  const pinned = "0".repeat(40);
  assert.deepEqual(resolveRemoteSha(git, remote.url, pinned), {
    sha: pinned,
    ref: pinned,
  });
  assert.throws(
    () => resolveRemoteSha(git, remote.url, "absent"),
    /has no ref "absent"/u,
  );
});

test("fetching pins the checkout to the sha it was asked for", () => {
  const remote = fixture();
  const staging = world();

  const root = fetchGitPlugin(git, staging, remote.url, remote.sha, null);
  assert.equal(root, staging);
  assert.equal(mustGit(["rev-parse", "HEAD"], staging), remote.sha);
  assert.match(
    readFileSync(join(staging, "plugin.json"), "utf8"),
    /"version":"2"/u,
  );

  const older = world();
  fetchGitPlugin(git, older, remote.url, remote.tagSha, null);
  assert.equal(mustGit(["rev-parse", "HEAD"], older), remote.tagSha);
});

test("a subdirectory source checks out only that subdirectory", () => {
  const remote = fixture();
  const staging = world();

  const root = fetchGitPlugin(
    git,
    staging,
    remote.url,
    remote.sha,
    "plugins/trace",
  );

  assert.equal(root, join(staging, "plugins/trace"));
  assert.ok(existsSync(join(root, "plugin.json")));
  assert.ok(existsSync(join(root, "skills/viewer/SKILL.md")));
  assert.equal(existsSync(join(staging, "other")), false);
});

test("a subdirectory that is not there is named, not guessed at", () => {
  const remote = fixture();
  assert.throws(
    () =>
      fetchGitPlugin(git, world(), remote.url, remote.sha, "plugins/absent"),
    /has no plugins\/absent at/u,
  );
});

test("an unusable sha is refused before git is touched", () => {
  const staging = world();
  assert.throws(
    () => fetchGitPlugin(git, staging, "file:///nowhere", "main", null),
    /refusing to fetch an unusable sha/u,
  );
  assert.equal(existsSync(join(staging, ".git")), false);
});

test("copying a folder keeps the executable bit and never follows a symlink out", async () => {
  const source = world();
  write(source, "plugin.json", '{"name":"demo"}');
  write(source, "scripts/run.sh", "#!/bin/sh\necho hi\n");
  chmodSync(join(source, "scripts/run.sh"), 0o755);
  write(source, ".git/HEAD", "ref: refs/heads/main\n");

  const destination = join(world(), "copy");
  await copyPluginTree(source, destination);

  assert.equal(
    readFileSync(join(destination, "plugin.json"), "utf8"),
    '{"name":"demo"}',
  );
  assert.equal(
    statSync(join(destination, "scripts/run.sh")).mode & 0o111,
    0o111,
  );
  // `.git` в корне — служебные объекты git, не содержимое плагина.
  assert.equal(existsSync(join(destination, ".git")), false);

  const outside = world();
  write(outside, "secret", "not yours\n");
  symlinkSync(join(outside, "secret"), join(source, "leak"));
  await assert.rejects(
    copyPluginTree(source, join(world(), "second")),
    /leak is a symlink/u,
  );
});

test("local changes are visible in a checkout and unknown in a plain copy", () => {
  const remote = fixture();
  const staging = world();
  fetchGitPlugin(git, staging, remote.url, remote.sha, null);

  assert.equal(localChanges(git, staging), "");
  writeFileSync(join(staging, "notes.md"), "mine\n");
  assert.match(localChanges(git, staging) ?? "", /notes\.md/u);

  const plain = world();
  writeFileSync(join(plain, "plugin.json"), "{}");
  assert.equal(localChanges(git, plain), null);
});

test("the swap replaces the store copy and leaves nothing behind", () => {
  const base = world();
  const store = join(base, "store", "demo");
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, "plugin.json"), '{"name":"old"}');

  const staged = join(base, ".staging-1");
  mkdirSync(staged, { recursive: true });
  writeFileSync(join(staged, "plugin.json"), '{"name":"new"}');

  swapIntoStore(staged, store);

  assert.equal(
    readFileSync(join(store, "plugin.json"), "utf8"),
    '{"name":"new"}',
  );
  assert.equal(existsSync(staged), false);
  assert.deepEqual(
    spawnSync("ls", [join(base, "store")], { encoding: "utf8" }).stdout.trim(),
    "demo",
  );
});
