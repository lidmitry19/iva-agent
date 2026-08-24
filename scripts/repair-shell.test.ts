import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

const runScript = promisify(execFile);

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const LEGACY_HEAD = "9a1b00dcd0ac85eafc969ba863d0773012a3fc6e";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

void test("repair bridges a dirty legacy install and preserves arbitrary files", () => {
  const fixture = mkdtempSync(join(tmpdir(), "iva-repair-shell-"));
  const remote = join(fixture, "remote.git");
  const install = join(fixture, "iva");
  const fakeBin = join(fixture, "bin");
  try {
    const target = git(ROOT, "rev-parse", "HEAD");
    const repairBranch = "repair-test-target";
    execFileSync("git", ["clone", "--quiet", "--bare", ROOT, remote]);
    execFileSync(
      "git",
      ["--git-dir", remote, "update-ref", `refs/heads/${repairBranch}`, target],
      { cwd: ROOT },
    );
    execFileSync("git", ["clone", "--quiet", remote, install]);
    assert.doesNotThrow(
      () => git(install, "cat-file", "-e", `${LEGACY_HEAD}^{commit}`),
      `LEGACY_HEAD ${LEGACY_HEAD} is unreachable; run the test on a full clone`,
    );
    git(install, "checkout", "-B", "main", LEGACY_HEAD);
    git(install, "config", "user.name", "Iva Repair Test");
    git(install, "config", "user.email", "repair@example.invalid");

    writeFileSync(
      join(install, "docs/index.html"),
      "<html>local docs</html>\n",
    );
    writeFileSync(
      join(install, "scripts/telegram-poll.mjs"),
      "// local Telegram buttons\n",
    );
    writeFileSync(
      join(install, "agent/channels/eve.ts"),
      `${readFileSync(join(install, "agent/channels/eve.ts"), "utf8")}\n// local compatible change\n`,
    );
    mkdirSync(join(install, "scripts"), { recursive: true });
    writeFileSync(
      join(install, "scripts/custom-telegram-button.ts"),
      "export const customButton = true;\n",
    );
    mkdirSync(join(install, "agent/skills/my-skill"), { recursive: true });
    writeFileSync(join(install, "agent/skills/my-skill/SKILL.md"), "# Mine\n");
    // Gitignored, and none of it comes back on its own: the skill's credential and
    // the Telethon session are the user's, the venv and node_modules are the repo's.
    writeFileSync(
      join(install, "agent/skills/my-skill/api-token.json"),
      '{"token":"kept"}\n',
    );
    mkdirSync(join(install, "services/telegram-userbot/.venv/bin"), {
      recursive: true,
    });
    writeFileSync(
      join(install, "services/telegram-userbot/telegram-userbot.session"),
      "SQLite format 3\n",
    );
    writeFileSync(
      join(install, "services/telegram-userbot/.venv/bin/python"),
      "#!/bin/sh\n",
    );
    mkdirSync(join(install, "node_modules/left-pad"), { recursive: true });
    writeFileSync(
      join(install, "node_modules/left-pad/index.js"),
      "module.exports = 1;\n",
    );
    writeFileSync(join(install, ".env"), "IVA_PORT=8723\n");
    mkdirSync(join(install, "vault"), { recursive: true });
    writeFileSync(join(install, "vault/CORE.md"), "# memory\n");
    mkdirSync(join(install, "attachments"), { recursive: true });
    writeFileSync(join(install, "attachments/voice.ogg"), "audio\n");
    mkdirSync(join(install, "data"), { recursive: true });
    writeFileSync(join(install, "data/settings.json"), '{"saved":true}\n');
    mkdirSync(join(install, ".workflow-data"), { recursive: true });
    writeFileSync(join(install, ".workflow-data/run.json"), '{"run":1}\n');
    mkdirSync(join(install, ".eve/.workflow-data"), { recursive: true });
    writeFileSync(join(install, ".eve/.workflow-data/eve.json"), '{"eve":1}\n');

    mkdirSync(fakeBin);
    const fakeNpm = join(fakeBin, "npm");
    writeFileSync(
      fakeNpm,
      '#!/bin/sh\nif [ "$1" = "run" ] && [ "$2" = "build" ]; then mkdir -p .output/server; printf ok > .output/server/index.mjs; fi\nexit 0\n',
    );
    chmodSync(fakeNpm, 0o755);

    const output = execFileSync("bash", [join(ROOT, "repair.sh")], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        IVA_INSTALL_DIR: install,
        IVA_REPAIR_REPO_URL: remote,
        IVA_REPAIR_BRANCH: repairBranch,
        IVA_REPAIR_SKIP_RESTART: "1",
      },
    });

    assert.equal(git(install, "rev-parse", "HEAD"), target);
    assert.equal(
      readFileSync(join(install, ".env"), "utf8"),
      "IVA_PORT=8723\n",
    );
    assert.equal(
      readFileSync(join(install, "data/settings.json"), "utf8"),
      '{"saved":true}\n',
    );
    assert.equal(
      readFileSync(join(install, "vault/CORE.md"), "utf8"),
      "# memory\n",
    );
    assert.equal(
      readFileSync(join(install, "attachments/voice.ogg"), "utf8"),
      "audio\n",
    );
    assert.equal(
      readFileSync(join(install, ".workflow-data/run.json"), "utf8"),
      '{"run":1}\n',
    );
    assert.equal(
      readFileSync(join(install, ".eve/.workflow-data/eve.json"), "utf8"),
      '{"eve":1}\n',
    );
    assert.equal(
      readFileSync(join(install, "scripts/custom-telegram-button.ts"), "utf8"),
      "export const customButton = true;\n",
    );
    assert.equal(
      readFileSync(join(install, "agent/skills/my-skill/SKILL.md"), "utf8"),
      "# Mine\n",
    );
    assert.equal(
      readFileSync(
        join(install, "agent/skills/my-skill/api-token.json"),
        "utf8",
      ),
      '{"token":"kept"}\n',
    );
    assert.equal(
      readFileSync(
        join(install, "services/telegram-userbot/telegram-userbot.session"),
        "utf8",
      ),
      "SQLite format 3\n",
    );
    assert.throws(
      () =>
        readFileSync(
          join(install, "services/telegram-userbot/.venv/bin/python"),
        ),
      { code: "ENOENT" },
    );
    assert.throws(
      () => readFileSync(join(install, "node_modules/left-pad/index.js")),
      { code: "ENOENT" },
    );
    assert.match(
      readFileSync(join(install, "agent/channels/eve.ts"), "utf8"),
      /local compatible change/,
    );
    assert.equal(
      readFileSync(join(install, "docs/index.html"), "utf8"),
      execFileSync("git", ["show", "HEAD:docs/index.html"], {
        cwd: ROOT,
        encoding: "utf8",
      }),
    );
    assert.match(output, /Iva is repaired and updated\./);
    const backup = output.match(/Your complete backup: (.+)/)?.[1];
    assert.ok(backup);
    assert.equal(
      readFileSync(join(backup, "docs/index.html"), "utf8"),
      "<html>local docs</html>\n",
    );
    assert.equal(
      readFileSync(join(backup, "scripts/telegram-poll.mjs"), "utf8"),
      "// local Telegram buttons\n",
    );
    const conflicts = readFileSync(
      join(
        install,
        "data/update-recovery",
        readdirSync(join(install, "data/update-recovery"))[0],
        "conflicts.txt",
      ),
      "utf8",
    );
    assert.match(conflicts, /docs\/index\.html/);
    assert.match(conflicts, /scripts\/telegram-poll\.mjs/);
    // State copied byte-for-byte is not a conflict with itself: without that filter
    // every repair would tell the user their own memory and workflow state need review.
    assert.doesNotMatch(conflicts, /^data\/?$/mu);
    assert.doesNotMatch(conflicts, /^vault\/?$/mu);
    assert.doesNotMatch(conflicts, /^\.workflow-data\/?$/mu);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

void test("repair falls back to clean core when customized dependencies fail", () => {
  const fixture = mkdtempSync(join(tmpdir(), "iva-repair-shell-fallback-"));
  const remote = join(fixture, "remote.git");
  const install = join(fixture, "iva");
  const fakeBin = join(fixture, "bin");
  const npmState = join(fixture, "npm-state");
  try {
    const target = git(ROOT, "rev-parse", "HEAD");
    const repairBranch = "repair-test-target";
    execFileSync("git", ["clone", "--quiet", "--bare", ROOT, remote]);
    execFileSync(
      "git",
      ["--git-dir", remote, "update-ref", `refs/heads/${repairBranch}`, target],
      { cwd: ROOT },
    );
    execFileSync("git", ["clone", "--quiet", remote, install]);
    assert.doesNotThrow(
      () => git(install, "cat-file", "-e", `${LEGACY_HEAD}^{commit}`),
      `LEGACY_HEAD ${LEGACY_HEAD} is unreachable; run the test on a full clone`,
    );
    git(install, "checkout", "-B", "main", LEGACY_HEAD);
    writeFileSync(
      join(install, "scripts/custom-telegram-button.ts"),
      "export const customButton = true;\n",
    );
    mkdirSync(join(install, "agent/skills/my-skill"), { recursive: true });
    writeFileSync(
      join(install, "agent/skills/my-skill/api-token.json"),
      '{"token":"kept"}\n',
    );
    mkdirSync(join(install, "data"), { recursive: true });
    writeFileSync(join(install, "data/settings.json"), '{"saved":true}\n');

    mkdirSync(fakeBin);
    const fakeNpm = join(fakeBin, "npm");
    writeFileSync(
      fakeNpm,
      '#!/bin/sh\nset -eu\nstate=${IVA_TEST_NPM_STATE:?}\nif [ "$1" = "ci" ]; then printf "ci\\n" >> "$state.log"; if [ ! -e "$state.failed" ]; then : > "$state.failed"; exit 1; fi; exit 0; fi\nif [ "$1" = "run" ] && [ "$2" = "build" ]; then printf "build\\n" >> "$state.log"; mkdir -p .output/server; printf ok > .output/server/index.mjs; fi\n',
    );
    chmodSync(fakeNpm, 0o755);

    const output = execFileSync("bash", [join(ROOT, "repair.sh")], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        IVA_INSTALL_DIR: install,
        IVA_REPAIR_REPO_URL: remote,
        IVA_REPAIR_BRANCH: repairBranch,
        IVA_REPAIR_SKIP_RESTART: "1",
        IVA_TEST_NPM_STATE: npmState,
      },
    });

    assert.equal(git(install, "rev-parse", "HEAD"), target);
    assert.equal(
      readFileSync(join(install, "data/settings.json"), "utf8"),
      '{"saved":true}\n',
    );
    assert.throws(
      () => readFileSync(join(install, "scripts/custom-telegram-button.ts")),
      { code: "ENOENT" },
    );
    // A credential never built anything, so the fallback has no claim on it.
    assert.equal(
      readFileSync(
        join(install, "agent/skills/my-skill/api-token.json"),
        "utf8",
      ),
      '{"token":"kept"}\n',
    );
    assert.equal(readFileSync(`${npmState}.log`, "utf8"), "ci\nci\nbuild\n");
    const backup = output.match(/Your complete backup: (.+)/)?.[1];
    assert.ok(backup);
    assert.equal(
      readFileSync(join(backup, "scripts/custom-telegram-button.ts"), "utf8"),
      "export const customButton = true;\n",
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

void test("repair survives a file it cannot read and names it for review", (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root reads a mode 000 file, so nothing is refused");
    return;
  }
  const fixture = mkdtempSync(join(tmpdir(), "iva-repair-unreadable-"));
  const remote = join(fixture, "remote.git");
  const install = join(fixture, "iva");
  const fakeBin = join(fixture, "bin");
  const unreadable = join(install, "agent/skills/my-skill/api-token.json");
  try {
    const target = git(ROOT, "rev-parse", "HEAD");
    const repairBranch = "repair-test-target";
    execFileSync("git", ["clone", "--quiet", "--bare", ROOT, remote]);
    execFileSync(
      "git",
      ["--git-dir", remote, "update-ref", `refs/heads/${repairBranch}`, target],
      { cwd: ROOT },
    );
    execFileSync("git", ["clone", "--quiet", remote, install]);
    git(install, "checkout", "-B", "main", LEGACY_HEAD);

    // A dirty legacy checkout collects files written under sudo or left at mode 000.
    // They are exactly what this script exists to rescue, and it cannot read them.
    mkdirSync(join(install, "agent/skills/my-skill"), { recursive: true });
    writeFileSync(unreadable, '{"token":"locked"}\n');
    chmodSync(unreadable, 0o000);
    mkdirSync(join(install, "services/telegram-userbot"), { recursive: true });
    writeFileSync(
      join(install, "services/telegram-userbot/telegram-userbot.session"),
      "SQLite format 3\n",
    );
    writeFileSync(join(install, "notes.md"), "# my notes\n");
    // The typical ignored entry is a whole DIRECTORY: --directory collapses one into a
    // single name, and cp -a copies a directory file by file, so an unreadable member
    // leaves a partial tree behind at the destination. Half a directory that looks
    // whole is worse than none: the user would never know to open the backup.
    mkdirSync(join(install, ".claude"), { recursive: true });
    writeFileSync(join(install, ".claude/settings.json"), '{"local":true}\n');
    writeFileSync(join(install, ".claude/notes.md"), "# agent notes\n");
    writeFileSync(join(install, ".claude/locked.json"), '{"secret":true}\n');
    chmodSync(join(install, ".claude/locked.json"), 0o000);
    mkdirSync(join(install, "data"), { recursive: true });
    writeFileSync(join(install, "data/settings.json"), '{"saved":true}\n');

    mkdirSync(fakeBin);
    const fakeNpm = join(fakeBin, "npm");
    writeFileSync(
      fakeNpm,
      '#!/bin/sh\nif [ "$1" = "run" ] && [ "$2" = "build" ]; then mkdir -p .output/server; printf ok > .output/server/index.mjs; fi\nexit 0\n',
    );
    chmodSync(fakeNpm, 0o755);

    const output = execFileSync("bash", [join(ROOT, "repair.sh")], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        IVA_INSTALL_DIR: install,
        IVA_REPAIR_REPO_URL: remote,
        IVA_REPAIR_BRANCH: repairBranch,
        IVA_REPAIR_SKIP_RESTART: "1",
      },
    });

    assert.match(output, /Iva is repaired and updated\./);
    // Everything readable still arrives, ignored files included.
    assert.equal(
      readFileSync(
        join(install, "services/telegram-userbot/telegram-userbot.session"),
        "utf8",
      ),
      "SQLite format 3\n",
    );
    assert.equal(
      readFileSync(join(install, "notes.md"), "utf8"),
      "# my notes\n",
    );
    assert.equal(
      readFileSync(join(install, "data/settings.json"), "utf8"),
      '{"saved":true}\n',
    );
    // Not half-copied into the fresh checkout, and named where the user will look.
    assert.throws(() => readFileSync(unreadable), { code: "ENOENT" });
    // The directory goes whole or not at all — no two-of-three tree pretending to be
    // the real thing.
    assert.throws(() => statSync(join(install, ".claude")), { code: "ENOENT" });
    const conflicts = readFileSync(
      join(
        install,
        "data/update-recovery",
        readdirSync(join(install, "data/update-recovery"))[0],
        "conflicts.txt",
      ),
      "utf8",
    );
    assert.match(
      conflicts,
      /agent\/skills\/my-skill\/api-token\.json \(could not be copied/,
    );
    assert.match(conflicts, /^\.claude \(could not be copied/mu);
    assert.match(output, /Files needing review:/);
    // And no byte of any of it was lost: the complete backup still holds every file,
    // the readable members of the refused directory included.
    const backup = output.match(/Your complete backup: (.+)/)?.[1];
    assert.ok(backup);
    const rescued = join(backup, "agent/skills/my-skill/api-token.json");
    chmodSync(rescued, 0o600);
    assert.equal(readFileSync(rescued, "utf8"), '{"token":"locked"}\n');
    assert.equal(
      readFileSync(join(backup, ".claude/settings.json"), "utf8"),
      '{"local":true}\n',
    );
    assert.equal(
      readFileSync(join(backup, ".claude/notes.md"), "utf8"),
      "# agent notes\n",
    );
    chmodSync(join(backup, ".claude/locked.json"), 0o600);
    assert.equal(
      readFileSync(join(backup, ".claude/locked.json"), "utf8"),
      '{"secret":true}\n',
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

/**
 * `systemctl --user` for a repair that is allowed to restart. `is-active` answers from
 * the state the restart itself sets, because that is the order the failure happens in:
 * `systemctl restart` is accepted, the unit is active for a moment, and only then does
 * the crash loop run out of attempts and leave the unit failed.
 */
const SYSTEMCTL = `#!/bin/sh
set -eu
verb="$2"
if [ "\${IVA_TEST_UNIT_BROKEN:-0}" = "1" ] && [ "$verb" = "is-active" ] && [ -f "$IVA_TEST_RESTART_STAMP" ]; then
  began="$(cat "$IVA_TEST_RESTART_STAMP")"
  now="$(date +%s)"
  if [ "$(( now - began ))" -ge 2 ]; then printf 'failed\\n'; exit 3; fi
fi
case "$verb" in
  is-active) printf 'active\\n' ;;
  is-enabled) printf 'enabled\\n' ;;
  restart) date +%s > "$IVA_TEST_RESTART_STAMP" ;;
esac
exit 0
`;

/** A port nothing holds, so the wait is never answered by a neighbour. */
function freePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    }),
  );
}

/** An installation the repair may restart for real, with systemd and npm stubbed out. */
async function restartFixture(t: { after(fn: () => void): void }) {
  const fixture = mkdtempSync(join(tmpdir(), "iva-repair-restart-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const remote = join(fixture, "remote.git");
  const install = join(fixture, "iva");
  const fakeBin = join(fixture, "bin");
  const target = git(ROOT, "rev-parse", "HEAD");
  const repairBranch = "repair-test-target";
  execFileSync("git", ["clone", "--quiet", "--bare", ROOT, remote]);
  execFileSync(
    "git",
    ["--git-dir", remote, "update-ref", `refs/heads/${repairBranch}`, target],
    { cwd: ROOT },
  );
  execFileSync("git", ["clone", "--quiet", remote, install]);
  git(install, "checkout", "-B", "main", LEGACY_HEAD);

  const port = await freePort();
  writeFileSync(join(install, ".env"), `IVA_PORT=${port}\n`);
  mkdirSync(join(install, "data"), { recursive: true });
  writeFileSync(join(install, "data/settings.json"), '{"saved":true}\n');

  mkdirSync(fakeBin);
  const fakeNpm = join(fakeBin, "npm");
  // `ci` links this repository's node_modules instead of fetching them: the CLI the
  // repair then runs is the real one, and it imports real dependencies.
  writeFileSync(
    fakeNpm,
    '#!/bin/sh\nif [ "$1" = "ci" ]; then ln -sfn "$IVA_TEST_NODE_MODULES" node_modules; fi\nif [ "$1" = "run" ] && [ "$2" = "build" ]; then mkdir -p .output/server; printf ok > .output/server/index.mjs; fi\nexit 0\n',
  );
  chmodSync(fakeNpm, 0o755);
  const fakeSystemctl = join(fakeBin, "systemctl");
  writeFileSync(fakeSystemctl, SYSTEMCTL);
  chmodSync(fakeSystemctl, 0o755);

  const run = (broken: boolean) =>
    runScript("bash", [join(ROOT, "repair.sh")], {
      encoding: "utf8",
      env: {
        ...process.env,
        // The units and the state this run writes belong to the fixture, never to the
        // developer's own installation.
        HOME: fixture,
        PATH: `${fakeBin}:${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
        IVA_INSTALL_DIR: install,
        IVA_REPAIR_REPO_URL: remote,
        IVA_REPAIR_BRANCH: repairBranch,
        IVA_TEST_NODE_MODULES: join(ROOT, "node_modules"),
        IVA_TEST_RESTART_STAMP: join(fixture, "restarted-at"),
        IVA_TEST_UNIT_BROKEN: broken ? "1" : "0",
      },
    });

  return { fixture, install, port, target, run };
}

void test("a repair whose service comes up reports the repair", async (t) => {
  const { install, port, target, run } = await restartFixture(t);
  const server = createServer((_request, response) =>
    response.writeHead(200).end("ok"),
  );
  await new Promise<void>((resolve) =>
    server.listen(port, "127.0.0.1", resolve),
  );
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const { stdout } = await run(false);

  assert.equal(git(install, "rev-parse", "HEAD"), target);
  assert.match(stdout, /Iva is repaired and updated\./);
  assert.doesNotMatch(stdout, /Iva did not come up/);
  const backup = stdout.match(/Your complete backup: (.+)/)?.[1];
  assert.ok(backup);
  assert.equal(
    readFileSync(join(backup, "data/settings.json"), "utf8"),
    '{"saved":true}\n',
  );
});

void test("a repair whose service never comes up says so and fails", async (t) => {
  // Nothing listens on the port and the unit ends up failed: the install the issue
  // reported, which the script used to call repaired because `restart` was accepted.
  const { install, target, run } = await restartFixture(t);

  const failure = await run(true).then(
    (result) => assert.fail(`repair.sh should have failed: ${result.stdout}`),
    (error: { code?: number; stdout?: string }) => error,
  );

  assert.equal(failure.code, 1);
  const stdout = String(failure.stdout);
  assert.match(
    stdout,
    /^Iva did not come up after the repair\. Check: journalctl --user -u iva\.service -n 100 --no-pager$/mu,
  );
  assert.doesNotMatch(stdout, /Iva is repaired and updated/);
  // The repaired tree stays: the backup is the way back, and it is still there.
  assert.equal(git(install, "rev-parse", "HEAD"), target);
  const backup = stdout.match(/Your complete backup: (.+)/)?.[1];
  assert.ok(backup);
  assert.equal(
    readFileSync(join(backup, "data/settings.json"), "utf8"),
    '{"saved":true}\n',
  );
});

void test("repair refuses a versioned install and names the commands that fit it", () => {
  const fixture = mkdtempSync(join(tmpdir(), "iva-repair-versioned-"));
  try {
    const install = join(fixture, "iva");
    mkdirSync(join(install, "versions/0.3.15-0123456789ab"), {
      recursive: true,
    });
    const result = execFileSync("bash", [join(ROOT, "repair.sh")], {
      cwd: fixture,
      encoding: "utf8",
      env: { ...process.env, IVA_INSTALL_DIR: install },
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.fail(`repair.sh should have refused: ${result}`);
  } catch (error) {
    const failure = error as { status?: number; stderr?: string };
    assert.equal(failure.status, 1);
    assert.match(String(failure.stderr), /iva update.*iva rollback/u);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
