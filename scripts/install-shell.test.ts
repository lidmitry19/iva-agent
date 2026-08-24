import assert from "node:assert/strict";
import {
  execFileSync,
  spawn,
  spawnSync,
  type SpawnSyncReturns,
} from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

/**
 * Every stand-in records the call and succeeds: what the installer must be judged on is
 * which stages it decides to run, so the log is the artifact. `$0` names the tool, so one
 * script serves sudo, systemctl, loginctl, uv and the two globals npm "installs".
 */
const RECORDER = `#!/bin/sh
echo "$(basename "$0") $*" >> "$IVA_TEST_CALLS"
exit 0
`;

/** sudo records root calls and models only D13's private cleanup and failure boundary. */
const SUDO = `#!/bin/sh
echo "sudo $*" >> "$IVA_TEST_CALLS"

replace_managed_path() {
  [ -n "$IVA_TEST_REPLACE_GH_PATH" ] || return
  marker="$IVA_TEST_GH_ETC_DIR/.replacement-$IVA_TEST_REPLACE_GH_PATH-done"
  [ ! -e "$marker" ] || return
  case "$IVA_TEST_REPLACE_GH_PATH" in
    keyring)
      path="$IVA_TEST_GH_ETC_DIR/keyrings/githubcli-archive-keyring.gpg"
      bytes=FOREIGN_KEYRING_PRESENT
      ;;
    source)
      path="$IVA_TEST_GH_ETC_DIR/sources.list.d/github-cli.list"
      bytes=FOREIGN_SOURCE_PRESENT
      ;;
    *) return ;;
  esac
  replacement="$path.foreign.$$"
  printf '%s\n' "$bytes" >"$replacement"
  chmod 0640 "$replacement"
  mv -f "$replacement" "$path"
  : >"$marker"
}

last=""
for arg in "$@"; do last="$arg"; done
case "$last" in
  "$TMPDIR"/iva-gh-apt-??????)
    if [ "$1" = rm ]; then
      marker="$TMPDIR/.iva-gh-cleanup-failed-once"
      if [ "$IVA_TEST_FAIL_GH_CLEANUP_ALWAYS" = 1 ]; then exit 74; fi
      if [ "$IVA_TEST_FAIL_GH_CLEANUP_ONCE" = 1 ] && [ ! -e "$marker" ]; then
        : >"$marker"
        exit 73
      fi
      /bin/rm -rf -- "$last"
      exit
    fi
    ;;
esac

saw_apt_get=false
saw_update=false
saw_private_gh_config=false
for arg in "$@"; do
  [ "$arg" = apt-get ] && saw_apt_get=true
  [ "$arg" = update ] && saw_update=true
  case "$arg" in *iva-gh-apt-*) saw_private_gh_config=true ;; esac
done
if [ "$saw_apt_get" = true ] && [ "$saw_update" = true ] \
  && [ "$saw_private_gh_config" = true ]; then
  replace_managed_path
fi

if [ "$IVA_TEST_FAIL_GH_PACKAGE" = 1 ]; then
  for arg in "$@"; do
    if [ "$arg" = gh ]; then exit 1; fi
  done
fi
exit 0
`;

const PINNED_ARTIFACTS = {
  uv: {
    url: "https://github.com/astral-sh/uv/releases/download/0.12.5/uv-installer.sh",
    sha256: "504511fbbbd811aeaba6738abc79408956b6c7da0ca35437b3dcc24a41efc111",
  },
  nvm: {
    url: "https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh",
    sha256: "abdb525ee9f5b48b34d8ed9fc67c6013fb0f659712e401ecd88ab989b3af8f53",
  },
  agentBrowser: {
    url: "https://registry.npmjs.org/agent-browser/-/agent-browser-0.34.0.tgz",
    sha256: "a4744fb189e598467abcfb3acdde07118d9e5cb43dc3b31727f869af4eb9d598",
  },
  gws: {
    url: "https://registry.npmjs.org/@googleworkspace/cli/-/cli-0.22.5.tgz",
    sha256: "b3d415a6d1b09589b13f6a71451d3d3927c4dc4701822d6aae549f8ff8f3380a",
  },
} as const;

/** A network-free curl that materializes only the synthetic artifacts the installer knows. */
const CURL = `#!/bin/sh
echo "curl $*" >> "$IVA_TEST_CALLS"
out=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) shift; out="$1" ;;
    http://*|https://*) url="$1" ;;
  esac
  shift
done
case "$url" in
  *cli.github.com*)
    if [ "$IVA_TEST_FAIL_GH_REPOSITORY" = 1 ]; then exit 22; fi
    printf 'synthetic github keyring\n'
    ;;
  *uv-installer.sh)
    if [ "$IVA_TEST_FAIL_ARTIFACT_DOWNLOAD" = uv ]; then exit 22; fi
    cat >"$out" <<'IVA_UV_INSTALLER'
#!/bin/sh
echo "execute uv installer" >> "$IVA_TEST_CALLS"
if [ "$IVA_TEST_FAIL_ARTIFACT_EXECUTE" = uv ]; then exit 70; fi
mkdir -p "$HOME/.local/bin"
ln -sf "$IVA_TEST_RECORDER" "$HOME/.local/bin/uv"
IVA_UV_INSTALLER
    ;;
  *nvm-sh/nvm/v0.40.1/install.sh)
    if [ "$IVA_TEST_FAIL_ARTIFACT_DOWNLOAD" = nvm ]; then exit 22; fi
    cat >"$out" <<'IVA_NVM_INSTALLER'
#!/bin/sh
echo "execute nvm installer" >> "$IVA_TEST_CALLS"
mkdir -p "$NVM_DIR"
cat >"$NVM_DIR/nvm.sh" <<'IVA_NVM_SH'
nvm() {
  case "$1" in
    install)
      mkdir -p "$NVM_DIR/versions/node/v24.19.0/bin"
      ln -sf "$IVA_TEST_NODE" "$NVM_DIR/versions/node/v24.19.0/bin/node"
      : >"$IVA_TEST_NODE_READY_MARKER"
      ;;
    which) printf '%s\n' "$NVM_DIR/versions/node/v24.19.0/bin/node" ;;
  esac
}
IVA_NVM_SH
IVA_NVM_INSTALLER
    ;;
  *agent-browser-0.34.0.tgz|*cli-0.22.5.tgz)
    case "$url" in
      *agent-browser*) artifact=agent-browser ;;
      *) artifact=gws ;;
    esac
    if [ "$IVA_TEST_FAIL_ARTIFACT_DOWNLOAD" = "$artifact" ]; then exit 22; fi
    printf 'synthetic npm package\n' >"$out"
    ;;
esac
exit 0
`;

/** The real hash tool's contract, with one deterministic corruption switch per artifact. */
const SHA256SUM = `#!/bin/sh
echo "sha256sum $*" >> "$IVA_TEST_CALLS"
last=""
for arg in "$@"; do last="$arg"; done
case "$last" in
  */iva-uv-*) artifact=uv; expected=${PINNED_ARTIFACTS.uv.sha256} ;;
  */iva-nvm-*) artifact=nvm; expected=${PINNED_ARTIFACTS.nvm.sha256} ;;
  */iva-agent-browser-*) artifact=agent-browser; expected=${PINNED_ARTIFACTS.agentBrowser.sha256} ;;
  */iva-gws-*) artifact=gws; expected=${PINNED_ARTIFACTS.gws.sha256} ;;
  *) exit 2 ;;
esac
if [ "$IVA_TEST_CORRUPT_ARTIFACT" = "$artifact" ]; then
  expected=0000000000000000000000000000000000000000000000000000000000000000
fi
printf '%s  %s\n' "$expected" "$last"
`;

/** Package-manager stand-in that can reject only an install containing gh. */
const PACKAGE_MANAGER = `#!/bin/sh
echo "$(basename "$0") $*" >> "$IVA_TEST_CALLS"
if [ "$IVA_TEST_FAIL_GH_PACKAGE" = 1 ]; then
  for arg in "$@"; do
    if [ "$arg" = gh ]; then exit 1; fi
  done
fi
exit 0
`;

/**
 * Non-interactive bash reads this file before install.sh. It lets a world model missing
 * commands without exposing the real host binaries or adding a production-only test hook.
 */
const COMMAND_MASK = `command() {
  if [ "$1" = -v ]; then
    case " $IVA_TEST_MISSING_COMMANDS " in
      *" $2 "*)
        if [ "$2" = node ] && [ -e "$IVA_TEST_NODE_READY_MARKER" ]; then
          builtin command "$@"
          return
        fi
        if [ "$2" = gh ] && [ "$IVA_TEST_GH_READY_AFTER_INSTALL" = 1 ]; then
          if [ -e "$IVA_TEST_GH_READY_MARKER" ]; then
            builtin command "$@"
            return
          fi
          : >"$IVA_TEST_GH_READY_MARKER"
        fi
        return 1
        ;;
    esac
  fi
  builtin command "$@"
}
`;

/**
 * npm as far as install.sh can tell: it records every call, writes the hidden lockfile the
 * way a real `npm ci` does, produces a .output the way a real build does, and drops the
 * global binaries where `npm prefix -g` says they go.
 */
const NPM = `#!/bin/sh
echo "npm $*" >> "$IVA_TEST_CALLS"
# What npm really got: a local path is a tarball only if it is a file with a tarball
# extension, otherwise npm opens <path>/package.json and dies with ENOTDIR.
for arg in "$@"; do
  case "$arg" in
    *iva-agent-browser-*|*iva-gws-*)
      [ -f "$arg" ] && echo "verified tarball file $arg" >> "$IVA_TEST_CALLS"
      ;;
  esac
done
case "$*" in
  *iva-agent-browser-*) [ "$IVA_TEST_FAIL_VERIFIED_NPM" = agent-browser ] && exit 71 ;;
  *iva-gws-*) [ "$IVA_TEST_FAIL_VERIFIED_NPM" = gws ] && exit 71 ;;
esac
case "$1" in
  prefix)
    printf '%s\\n' "$IVA_TEST_NPM_PREFIX"
    ;;
  ci|install)
    mkdir -p node_modules/.bin
    cp package-lock.json node_modules/.package-lock.json
    ln -sf "$IVA_TEST_RECORDER" node_modules/.bin/patch-package
    ;;
  exec)
    case "$*" in
      *"eve build"*)
        # The build is where a weak VPS dies: the OOM killer takes it (137), and where the
        # test needs a run to still be alive, it waits here after saying so.
        if [ -n "$IVA_TEST_FREEZE_LOG" ]; then
          # The log every rollback command redirects into stops being writable while the
          # run is still going - a revoked mount, a full disk, another hand on the box.
          chmod 000 "$TMPDIR"/iva-install-*.log
        fi
        if [ -n "$IVA_TEST_BUILD_EXIT" ]; then
          # A real build clears the output directory before it writes into it, which is
          # why a build that dies half-way takes the working installation with it.
          rm -rf .output
          echo "Killed" >&2
          exit "$IVA_TEST_BUILD_EXIT"
        fi
        if [ -n "$IVA_TEST_BUILD_WAIT" ]; then
          : > "$IVA_TEST_BUILD_WAIT"
          sleep 10
        fi
        mkdir -p .output
        printf 'built' > .output/server.mjs
        ;;
    esac
    ;;
  i)
    tool=""
    case "$*" in
      *agent-browser*) tool=agent-browser ;;
      *googleworkspace*|*iva-gws-*) tool=gws ;;
    esac
    if [ -n "$tool" ]; then
      mkdir -p "$IVA_TEST_NPM_PREFIX/bin"
      ln -sf "$IVA_TEST_RECORDER" "$IVA_TEST_NPM_PREFIX/bin/$tool"
    fi
    ;;
esac
exit 0
`;

/**
 * The iva CLI the installer delegates the units to, including the failure it is famous
 * for. It is also the only thing the test can ask about the installation while the run is
 * still going: on request it writes down where the copy of .env is at that moment, with
 * what permissions, and what the run has put in TMPDIR.
 */
const IVA_CLI = `import { appendFileSync, chmodSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
if (process.env.IVA_TEST_CALLS)
  appendFileSync(process.env.IVA_TEST_CALLS, \`iva \${args.join(" ")}\\n\`);
const entries = (dir) => {
  try {
    return readdirSync(dir).map((name) => ({
      name,
      mode: (statSync(join(dir, name)).mode & 0o777).toString(8),
    }));
  } catch {
    return [];
  }
};
if (process.env.IVA_TEST_SNAPSHOT && args[0] === "_install-units") {
  const backups = join(process.cwd(), "data/update-backups");
  let dirMode = "";
  try {
    dirMode = (statSync(backups).mode & 0o777).toString(8);
  } catch {}
  writeFileSync(
    process.env.IVA_TEST_SNAPSHOT,
    JSON.stringify({
      cwd: process.cwd(),
      backupsMode: dirMode,
      backups: entries(backups),
      tmp: entries(process.env.TMPDIR ?? "/tmp"),
    }),
  );
}
// Something in the tree where a stashed file has to go back: a directory in its place is
// what an interrupted tool leaves, and it is what makes a restore fail for real.
if (process.env.IVA_TEST_BLOCK_RESTORE && args[0] === "_install-units") {
  const at = join(process.cwd(), process.env.IVA_TEST_BLOCK_RESTORE);
  rmSync(at, { force: true, recursive: true });
  mkdirSync(at, { recursive: true });
  writeFileSync(join(at, "in-the-way"), "blocked\\n");
}
// A tree that stops accepting writes half-way through - a full disk, a revoked mount, a
// directory somebody made read-only - so the undo cannot finish either.
if (process.env.IVA_TEST_FREEZE_TREE && args[0] === "_install-units")
  chmodSync(process.cwd(), 0o500);
if (args[0] === "_activate-units" && process.env.IVA_TEST_UNITS_FAIL) {
  process.stderr.write("Failed to connect to bus: No such file or directory\\n");
  process.exit(1);
}
`;

type RunOptions = {
  readonly calls?: string;
  readonly env?: Readonly<Record<string, string>>;
  /** The installer to run, when it must be one sitting inside the installation. */
  readonly script?: string;
  /** Run it with no stderr at all, the way a terminal that went away leaves it. */
  readonly closedStderr?: boolean;
};

type World = {
  readonly dir: string;
  readonly install: string;
  readonly home: string;
  readonly tmp: string;
  run(options?: RunOptions): SpawnSyncReturns<string>;
  /**
   * The same run without blocking, so a signal can arrive while it is working - which is
   * the only way to see what a dropped SSH session does to an install.
   */
  runAsync(options?: RunOptions): {
    signal(name: NodeJS.Signals): void;
    done: Promise<{
      code: number | null;
      signal: string | null;
      output: string;
    }>;
  };
  git(...args: string[]): string;
  /** Everything the run called, in order. */
  calls(path?: string): string;
};

const IDENTITY = {
  GIT_AUTHOR_NAME: "iva",
  GIT_AUTHOR_EMAIL: "iva@example.invalid",
  GIT_COMMITTER_NAME: "iva",
  GIT_COMMITTER_EMAIL: "iva@example.invalid",
};

/**
 * The stand-ins are stateless — every path they touch comes from the environment — so one
 * copy serves every world. Written once because macOS verifies each newly created
 * executable the first time it runs, which is seconds per world otherwise.
 */
const TOOLS = realpathSync(mkdtempSync(join(tmpdir(), "iva-install-tools-")));
const RECORDER_PATH = join(TOOLS, "recorder");
writeFileSync(RECORDER_PATH, RECORDER);
chmodSync(RECORDER_PATH, 0o755);
// Everything the installer may reach for, stubbed by name. The package layer is here on
// purpose: on Ubuntu - the platform this script is written for - /usr/bin carries a real
// apt-get and a real dpkg, and a missing `gh` sends the installer to cli.github.com over
// the network. A test suite must not run either.
for (const name of [
  "systemctl",
  "loginctl",
  "uv",
  "dpkg",
  "gh",
  "python3",
  "ffmpeg",
  "pandoc",
  "pdftotext",
])
  symlinkSync(RECORDER_PATH, join(TOOLS, name));
writeFileSync(join(TOOLS, "sudo"), SUDO);
chmodSync(join(TOOLS, "sudo"), 0o755);
for (const name of ["apt-get", "dnf", "brew"]) {
  writeFileSync(join(TOOLS, name), PACKAGE_MANAGER);
  chmodSync(join(TOOLS, name), 0o755);
}
writeFileSync(join(TOOLS, "curl"), CURL);
chmodSync(join(TOOLS, "curl"), 0o755);
writeFileSync(join(TOOLS, "sha256sum"), SHA256SUM);
chmodSync(join(TOOLS, "sha256sum"), 0o755);
const COMMAND_MASK_PATH = join(TOOLS, "command-mask.sh");
writeFileSync(COMMAND_MASK_PATH, COMMAND_MASK);
writeFileSync(join(TOOLS, "npm"), NPM);
chmodSync(join(TOOLS, "npm"), 0o755);
// node comes in by name, not by its directory: on nvm and fnm the real node sits beside
// the developer's global binaries, and putting that directory on PATH is how a fixture
// ends up finding a real gws - or launching a real browser and downloading Chromium.
symlinkSync(process.execPath, join(TOOLS, "node"));
after(() => rmSync(TOOLS, { recursive: true, force: true }));

/**
 * A whole installed Iva as the reported failure had it: a checkout at INSTALL_DIR with an
 * origin to fetch from, the installer running from somewhere else (which is what
 * `curl | bash` does), and a HOME of its own. install.sh itself is the real file.
 */
function createWorld(t: TestContext, options: { env?: boolean } = {}): World {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "iva-install-shell-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const install = join(dir, "iva");
  const remote = join(dir, "remote.git");
  const home = join(dir, "home");
  const tmp = join(dir, "tmp");
  const npmPrefix = join(dir, "npm-global");
  const ghEtc = join(dir, "gh-etc");
  const defaultCalls = join(dir, "calls.log");

  for (const path of [
    home,
    tmp,
    npmPrefix,
    join(ghEtc, "keyrings"),
    join(ghEtc, "sources.list.d"),
  ])
    mkdirSync(path, { recursive: true });
  // The installer never sits next to a package.json here, so it takes the branch a piped
  // `curl | bash` takes: the checkout at INSTALL_DIR.
  cpSync(join(ROOT, "install.sh"), join(dir, "install.sh"));

  mkdirSync(join(install, "bin"), { recursive: true });
  mkdirSync(join(install, "scripts/lib"), { recursive: true });
  mkdirSync(join(install, "packages/data-dir"), { recursive: true });
  writeFileSync(
    join(install, "package.json"),
    `${JSON.stringify(
      {
        name: "iva",
        version: "0.0.0",
        private: true,
        type: "module",
        dependencies: { eve: "0.30.8" },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(install, "package-lock.json"),
    `${JSON.stringify(
      {
        name: "iva",
        version: "0.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": { name: "iva", version: "0.0.0" },
          "node_modules/eve": { version: "0.30.8" },
        },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(install, "bin/iva.mjs"), IVA_CLI);
  writeFileSync(join(install, "scripts/init-vault.mjs"), "");
  cpSync(
    join(ROOT, "packages/data-dir/index.ts"),
    join(install, "packages/data-dir/index.ts"),
  );
  for (const name of ["env-file.ts", "version-layout.ts", "version-store.ts"])
    cpSync(join(ROOT, "scripts/lib", name), join(install, "scripts/lib", name));
  writeFileSync(join(install, "README.md"), "# fixture\n");
  // A patched dependency, like the real installation has: the hook that applies it is
  // npm's, so skipping npm has to apply it instead.
  mkdirSync(join(install, "patches"), { recursive: true });
  writeFileSync(join(install, "patches/eve+0.30.8.patch"), "");
  // The shipped ignore rules, so what the installer leaves behind is judged by them.
  cpSync(join(ROOT, ".gitignore"), join(install, ".gitignore"));

  const git = (...args: string[]): string =>
    execFileSync("git", args, {
      cwd: install,
      encoding: "utf8",
      env: { ...process.env, ...IDENTITY },
    }).trim();

  git("init", "--quiet", "--initial-branch=main");
  git("add", "-A");
  git("commit", "--quiet", "-m", "fixture");
  execFileSync("git", ["clone", "--quiet", "--bare", install, remote]);
  git("remote", "add", "origin", remote);

  if (options.env !== false)
    writeFileSync(join(install, ".env"), "AGENT_LANGUAGE=en\nIVA_PORT=8723\n");

  const environment = (runOptions: RunOptions): Record<string, string> => ({
    ...IDENTITY,
    PATH: `${TOOLS}:/usr/bin:/bin:/usr/sbin`,
    HOME: home,
    TMPDIR: tmp,
    NO_COLOR: "1",
    TERM: "dumb",
    INSTALL_DIR: install,
    BRANCH: "main",
    REPO_URL: remote,
    IVA_TEST_CALLS: runOptions.calls ?? defaultCalls,
    IVA_TEST_NPM_PREFIX: npmPrefix,
    IVA_TEST_RECORDER: RECORDER_PATH,
    IVA_TEST_NODE: process.execPath,
    IVA_TEST_NODE_READY_MARKER: join(dir, "node-ready"),
    IVA_TEST_GH_ETC_DIR: ghEtc,
    IVA_TEST_GH_READY_AFTER_INSTALL: "",
    IVA_TEST_GH_READY_MARKER: join(dir, "gh-ready"),
    IVA_TEST_MISSING_COMMANDS: "",
    BASH_ENV: COMMAND_MASK_PATH,
    ...runOptions.env,
  });

  return {
    dir,
    install,
    home,
    tmp,
    git,
    calls: (path = defaultCalls) =>
      existsSync(path) ? readFileSync(path, "utf8") : "",
    run: (runOptions = {}) => {
      const installer = runOptions.script ?? join(dir, "install.sh");
      const argv = runOptions.closedStderr
        ? [
            "-c",
            'exec 2>&-; exec bash "$0" "$@"',
            installer,
            "--non-interactive",
          ]
        : [installer, "--non-interactive"];
      return spawnSync("bash", argv, {
        cwd: dir,
        encoding: "utf8",
        env: environment(runOptions),
      });
    },
    runAsync: (runOptions = {}) => {
      const child = spawn(
        "bash",
        [runOptions.script ?? join(dir, "install.sh"), "--non-interactive"],
        { cwd: dir, env: environment(runOptions) },
      );
      let output = "";
      const collect = (chunk: unknown): void => {
        output += String(chunk);
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      return {
        signal: (name) => {
          child.kill(name);
        },
        done: new Promise((resolve) =>
          child.on("close", (code, signal) =>
            resolve({ code, signal, output }),
          ),
        ),
      };
    },
  };
}

/** Temp files this run created; the install log is the one it means to leave. */
function leftovers(tmp: string): string[] {
  return readdirSync(tmp).filter((name) => !name.startsWith("iva-install-"));
}

function backups(install: string): string[] {
  const dir = join(install, "data/update-backups");
  return existsSync(dir) ? readdirSync(dir) : [];
}

function outputBackups(install: string): string[] {
  return readdirSync(install).filter((name) =>
    name.startsWith(".output.iva-install-backup-"),
  );
}

function optionalGhWarnings(output: string): string[] {
  return output
    .split(/\r?\n/u)
    .filter((line) => /^! .*?(?:GitHub CLI|\bgh\b)/u.test(line));
}

function ghAptFiles(world: World): { keyring: string; source: string } {
  return {
    keyring: join(world.dir, "gh-etc/keyrings/githubcli-archive-keyring.gpg"),
    source: join(world.dir, "gh-etc/sources.list.d/github-cli.list"),
  };
}

function assertNoSharedGhAptPaths(calls: string): void {
  assert.doesNotMatch(
    calls,
    /\/etc\/apt\/(?:keyrings\/githubcli-archive-keyring\.gpg|sources\.list\.d\/github-cli\.list)/u,
  );
}

function assertPrivateGhAptBoundary(world: World, calls: string): void {
  assertNoSharedGhAptPaths(calls);
  assert.deepEqual(
    readdirSync(world.tmp).filter((name) => name.startsWith("iva-gh-apt-")),
    [],
  );
}

void test("install.sh is valid bash", () => {
  execFileSync("bash", ["-n", join(ROOT, "install.sh")]);
});

void test("all downloaded installers and packages use exact pinned artifacts", () => {
  const source = readFileSync(join(ROOT, "install.sh"), "utf8");
  for (const artifact of Object.values(PINNED_ARTIFACTS)) {
    assert.match(
      source,
      new RegExp(artifact.url.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
    );
    assert.match(source, new RegExp(`\\b${artifact.sha256}\\b`, "u"));
  }
  assert.doesNotMatch(source, /npm i -g agent-browser(?:\s|$)/u);
  assert.doesNotMatch(source, /npm i -g @googleworkspace\/cli@latest(?:\s|$)/u);
  assert.doesNotMatch(source, /https:\/\/astral\.sh\/uv\/install\.sh/u);
});

void test("matching uv and nvm downloads execute only after SHA-256 verification", (t) => {
  const world = createWorld(t);
  const result = world.run({
    env: { IVA_TEST_MISSING_COMMANDS: "uv node" },
  });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  const calls = world.calls();
  for (const artifact of [PINNED_ARTIFACTS.uv, PINNED_ARTIFACTS.nvm]) {
    assert.match(
      calls,
      new RegExp(artifact.url.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
    );
  }
  const uvHash = calls.indexOf("sha256sum ", calls.indexOf("iva-uv-"));
  const uvExec = calls.indexOf("execute uv installer");
  const nvmHash = calls.indexOf("sha256sum ", calls.indexOf("iva-nvm-"));
  const nvmExec = calls.indexOf("execute nvm installer");
  assert.ok(uvHash >= 0 && uvExec > uvHash, calls);
  assert.ok(nvmHash > uvHash && nvmExec > nvmHash, calls);
  assert.deepEqual(leftovers(world.tmp), []);
});

void test("a missing SHA-256 tool stops before executing a download", (t) => {
  const world = createWorld(t);
  const result = world.run({
    env: { IVA_TEST_MISSING_COMMANDS: "uv sha256sum shasum" },
  });

  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /SHA-256/iu);
  assert.doesNotMatch(world.calls(), /execute uv installer/u);
  assert.deepEqual(leftovers(world.tmp), []);
});

void test("a failed artifact download leaves no verified-download temp file", (t) => {
  const world = createWorld(t);
  const result = world.run({
    env: {
      IVA_TEST_FAIL_ARTIFACT_DOWNLOAD: "uv",
      IVA_TEST_MISSING_COMMANDS: "uv",
    },
  });

  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(world.calls(), /sha256sum|execute uv installer/u);
  assert.deepEqual(leftovers(world.tmp), []);
});

void test("a verified installer failure leaves no downloaded script", (t) => {
  const world = createWorld(t);
  const result = world.run({
    env: {
      IVA_TEST_FAIL_ARTIFACT_EXECUTE: "uv",
      IVA_TEST_MISSING_COMMANDS: "uv",
    },
  });

  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(world.calls(), /sha256sum[\s\S]*execute uv installer/u);
  assert.deepEqual(leftovers(world.tmp), []);
});

void test("a verified npm install failure leaves no downloaded tarball", (t) => {
  const world = createWorld(t);
  const result = world.run({
    env: { IVA_TEST_FAIL_VERIFIED_NPM: "agent-browser" },
  });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(
    result.stdout + result.stderr,
    /couldn't install agent-browser/u,
  );
  assert.match(world.calls(), /^npm i -g .*iva-agent-browser-/mu);
  assert.deepEqual(leftovers(world.tmp), []);
});

void test("npm is handed the tarball itself, and the download outlives nothing", (t) => {
  const world = createWorld(t);
  const result = world.run();

  assert.equal(result.status, 0, result.stdout + result.stderr);
  const calls = world.calls();
  // npm takes a local path without a tarball extension for a package directory and opens
  // <path>/package.json in it, which is ENOTDIR when the path is the downloaded file.
  for (const [label, artifact] of [
    ["agent-browser", PINNED_ARTIFACTS.agentBrowser],
    ["gws", PINNED_ARTIFACTS.gws],
  ] as const) {
    const file = artifact.url.slice(artifact.url.lastIndexOf("/") + 1);
    assert.ok(file.endsWith(".tgz"), artifact.url);
    assert.match(
      calls,
      new RegExp(
        `^verified tarball file .*/iva-${label}-[^/\\s]+/${file.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`,
        "mu",
      ),
    );
  }
  assert.deepEqual(leftovers(world.tmp), []);
});

for (const scenario of [
  {
    name: "uv",
    missing: "uv",
    url: PINNED_ARTIFACTS.uv.url,
    forbidden: /execute uv installer/u,
  },
  {
    name: "nvm",
    missing: "node",
    url: PINNED_ARTIFACTS.nvm.url,
    forbidden: /execute nvm installer/u,
  },
  {
    name: "agent-browser",
    missing: "",
    url: PINNED_ARTIFACTS.agentBrowser.url,
    forbidden: /^npm i -g .*iva-agent-browser-/mu,
  },
  {
    name: "gws",
    missing: "",
    url: PINNED_ARTIFACTS.gws.url,
    forbidden: /^npm i -g .*iva-gws-/mu,
  },
] as const) {
  void test(`${scenario.name} checksum mismatch stops before execution or install`, (t) => {
    const world = createWorld(t);
    const result = world.run({
      env: {
        IVA_TEST_CORRUPT_ARTIFACT: scenario.name,
        IVA_TEST_MISSING_COMMANDS: scenario.missing,
      },
    });

    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /SHA-256|checksum/iu);
    const calls = world.calls();
    assert.match(
      calls,
      new RegExp(scenario.url.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
    );
    assert.match(calls, /sha256sum/u);
    assert.doesNotMatch(calls, scenario.forbidden);
    assert.doesNotMatch(result.stdout, /Installation complete/u);
    assert.deepEqual(leftovers(world.tmp), []);
  });
}

void test("optional GitHub CLI repository failure does not stop required apt work", (t) => {
  const world = createWorld(t);
  const result = world.run({
    env: {
      IVA_TEST_MISSING_COMMANDS: "gh pandoc",
      IVA_TEST_FAIL_GH_REPOSITORY: "1",
    },
  });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  const calls = world.calls();
  const requiredInstall = calls
    .split("\n")
    .find(
      (line) =>
        line.includes("apt-get") &&
        line.includes("install") &&
        line.includes("pandoc"),
    );
  assert.ok(requiredInstall, `required package was not attempted:\n${calls}`);
  assert.doesNotMatch(requiredInstall, /(?:^| )gh(?: |$)/u);
  assert.match(calls, /^npm ci$/mu);
  assert.match(calls, /^iva _activate-units$/mu);
  assert.match(result.stdout, /Installation complete/u);
  assertPrivateGhAptBoundary(world, calls);
  const managed = ghAptFiles(world);
  assert.equal(existsSync(managed.keyring), false);
  assert.equal(existsSync(managed.source), false);
  assert.deepEqual(optionalGhWarnings(result.stdout + result.stderr), [
    "! GitHub CLI is optional and could not be installed; continuing without it",
  ]);
});

void test("optional GitHub CLI apt package failure warns once and installation completes", (t) => {
  const world = createWorld(t);
  const result = world.run({
    env: {
      IVA_TEST_MISSING_COMMANDS: "gh pandoc",
      IVA_TEST_FAIL_GH_PACKAGE: "1",
    },
  });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  const calls = world.calls();
  const requiredInstall = calls
    .split("\n")
    .find(
      (line) =>
        line.includes("apt-get") &&
        line.includes("install") &&
        line.includes("pandoc"),
    );
  assert.ok(requiredInstall, `required package was not attempted:\n${calls}`);
  assert.doesNotMatch(requiredInstall, /(?:^| )gh(?: |$)/u);
  assert.match(calls, /^iva _activate-units$/mu);
  assert.match(result.stdout, /Installation complete/u);
  assert.match(calls, /Dir::Etc::sourcelist=.*iva-gh-apt-/u);
  assert.match(calls, /Dir::Etc::sourceparts=-/u);
  assert.match(calls, /Dir::State::lists=.*iva-gh-apt-/u);
  assertPrivateGhAptBoundary(world, calls);
  const managed = ghAptFiles(world);
  assert.equal(existsSync(managed.keyring), false);
  assert.equal(existsSync(managed.source), false);
  assert.deepEqual(optionalGhWarnings(result.stdout + result.stderr), [
    "! GitHub CLI is optional and could not be installed; continuing without it",
  ]);
});

void test("optional GitHub CLI availability wins over a package-manager failure", (t) => {
  const world = createWorld(t);
  const result = world.run({
    env: {
      IVA_TEST_MISSING_COMMANDS: "gh pandoc",
      IVA_TEST_FAIL_GH_PACKAGE: "1",
      IVA_TEST_GH_READY_AFTER_INSTALL: "1",
    },
  });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  const calls = world.calls();
  assert.match(calls, /^iva _activate-units$/mu);
  assert.match(result.stdout, /Installation complete/u);
  assert.match(result.stdout, /^✓ gh ready$/mu);
  assert.deepEqual(optionalGhWarnings(result.stdout + result.stderr), []);
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /GitHub CLI is optional and could not be installed/u,
  );
  assertPrivateGhAptBoundary(world, calls);
});

void test("optional GitHub CLI retries a transient private cleanup failure", (t) => {
  const world = createWorld(t);
  const result = world.run({
    env: {
      IVA_TEST_MISSING_COMMANDS: "gh pandoc",
      IVA_TEST_GH_READY_AFTER_INSTALL: "1",
      IVA_TEST_FAIL_GH_CLEANUP_ONCE: "1",
    },
  });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  const calls = world.calls();
  assert.equal(
    calls
      .split("\n")
      .filter((line) => /sudo rm -rf -- .*\/iva-gh-apt-/u.test(line)).length,
    2,
  );
  assertPrivateGhAptBoundary(world, calls);
  assert.match(calls, /^iva _activate-units$/mu);
  assert.match(result.stdout, /Installation complete/u);
  assert.deepEqual(optionalGhWarnings(result.stdout + result.stderr), []);
});

void test("optional GitHub CLI reports a persistent private cleanup failure", (t) => {
  const world = createWorld(t);
  const result = world.run({
    env: {
      IVA_TEST_MISSING_COMMANDS: "gh pandoc",
      IVA_TEST_GH_READY_AFTER_INSTALL: "1",
      IVA_TEST_FAIL_GH_CLEANUP_ALWAYS: "1",
    },
  });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  const calls = world.calls();
  assert.equal(
    calls
      .split("\n")
      .filter((line) => /sudo rm -rf -- .*\/iva-gh-apt-/u.test(line)).length,
    2,
  );
  assertNoSharedGhAptPaths(calls);
  const retained = readdirSync(world.tmp).filter((name) =>
    name.startsWith("iva-gh-apt-"),
  );
  assert.equal(retained.length, 1);
  assert.match(calls, /^iva _activate-units$/mu);
  assert.match(result.stdout, /Installation complete/u);
  assert.deepEqual(optionalGhWarnings(result.stdout + result.stderr), [
    `! GitHub CLI is ready, but private apt cleanup failed; retained directory: ${join(world.tmp, retained[0])}`,
  ]);
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /GitHub CLI is optional and could not be installed/u,
  );
});

void test("optional GitHub CLI apt failure preserves foreign repository files exactly", (t) => {
  const world = createWorld(t);
  const managed = ghAptFiles(world);
  writeFileSync(managed.keyring, "foreign keyring bytes\n");
  writeFileSync(managed.source, "foreign source bytes\n");
  chmodSync(managed.keyring, 0o600);
  chmodSync(managed.source, 0o640);

  const result = world.run({
    env: {
      IVA_TEST_MISSING_COMMANDS: "gh pandoc",
      IVA_TEST_FAIL_GH_PACKAGE: "1",
    },
  });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(
    readFileSync(managed.keyring, "utf8"),
    "foreign keyring bytes\n",
  );
  assert.equal(readFileSync(managed.source, "utf8"), "foreign source bytes\n");
  assert.equal(statSync(managed.keyring).mode & 0o777, 0o600);
  assert.equal(statSync(managed.source).mode & 0o777, 0o640);
  const calls = world.calls();
  assert.match(calls, /^iva _activate-units$/mu);
  assertPrivateGhAptBoundary(world, calls);
  assert.deepEqual(optionalGhWarnings(result.stdout + result.stderr), [
    "! GitHub CLI is optional and could not be installed; continuing without it",
  ]);
});

for (const replacementKind of ["keyring", "source"] as const) {
  void test(`optional GitHub CLI private apt failure preserves a foreign ${replacementKind} replacement`, (t) => {
    const world = createWorld(t);
    const result = world.run({
      env: {
        IVA_TEST_MISSING_COMMANDS: "gh pandoc",
        IVA_TEST_FAIL_GH_PACKAGE: "1",
        IVA_TEST_REPLACE_GH_PATH: replacementKind,
      },
    });

    assert.equal(result.status, 0, result.stdout + result.stderr);
    const managed = ghAptFiles(world);
    const replaced = managed[replacementKind];
    const owned =
      replacementKind === "keyring" ? managed.source : managed.keyring;
    assert.equal(
      readFileSync(replaced, "utf8"),
      `FOREIGN_${replacementKind.toUpperCase()}_PRESENT\n`,
    );
    assert.equal(statSync(replaced).mode & 0o777, 0o640);
    assert.equal(existsSync(owned), false);
    const calls = world.calls();
    assert.ok(
      calls
        .split("\n")
        .some(
          (line) =>
            line.includes("apt-get") &&
            line.includes("install") &&
            line.includes("pandoc"),
        ),
      `required package was not attempted:\n${calls}`,
    );
    assert.match(calls, /^iva _activate-units$/mu);
    assert.match(result.stdout, /Installation complete/u);
    assert.match(calls, /Dir::Etc::sourcelist=.*iva-gh-apt-/u);
    assertPrivateGhAptBoundary(world, calls);
    assert.deepEqual(optionalGhWarnings(result.stdout + result.stderr), [
      "! GitHub CLI is optional and could not be installed; continuing without it",
    ]);
  });
}

for (const manager of ["dnf", "brew"] as const) {
  void test(`optional GitHub CLI package failure is isolated under ${manager}`, (t) => {
    const world = createWorld(t);
    const hidden =
      manager === "dnf" ? "apt-get gh pandoc" : "apt-get dnf gh pandoc";
    const result = world.run({
      env: {
        IVA_TEST_MISSING_COMMANDS: hidden,
        IVA_TEST_FAIL_GH_PACKAGE: "1",
      },
    });

    assert.equal(result.status, 0, result.stdout + result.stderr);
    const calls = world.calls();
    const requiredInstall = calls
      .split("\n")
      .find(
        (line) =>
          line.includes(`${manager} install `) && line.includes("pandoc"),
      );
    assert.ok(requiredInstall, `required package was not attempted:\n${calls}`);
    assert.doesNotMatch(requiredInstall, /(?:^| )gh(?: |$)/u);
    assert.match(calls, /^npm ci$/mu);
    assert.match(calls, /^iva _activate-units$/mu);
    assert.deepEqual(optionalGhWarnings(result.stdout + result.stderr), [
      "! GitHub CLI is optional and could not be installed; continuing without it",
    ]);
  });
}

void test("an exit before any work is done stays quiet and succeeds", () => {
  // --help is the earliest exit there is, and it runs the same exit handler every failure
  // runs: everything it touches has to exist by then.
  const help = spawnSync("bash", [join(ROOT, "install.sh"), "--help"], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", TERM: "dumb" },
  });
  assert.equal(help.status, 0, help.stdout + help.stderr);
  assert.equal(help.stderr, "");
  assert.match(help.stdout, /--skip-setup/u);
});

void test("a stage killed mid-way fails the install and gives the old build back", (t) => {
  const world = createWorld(t);
  writeFileSync(join(world.install, "README.md"), "# fixture\nlocal edit\n");
  mkdirSync(join(world.install, ".output"), { recursive: true });
  writeFileSync(join(world.install, ".output/marker"), "previous build\n");

  // 137: what the OOM killer leaves on a 512MB VPS, the failure this installer exists for.
  const result = world.run({ env: { IVA_TEST_BUILD_EXIT: "137" } });

  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /Installation complete/u);
  assert.match(result.stderr, /Install stopped during/u);
  // The previous build is back where it was, not deleted as if the install had worked.
  assert.equal(
    readFileSync(join(world.install, ".output/marker"), "utf8"),
    "previous build\n",
  );
  assert.deepEqual(outputBackups(world.install), []);
  assert.equal(
    readFileSync(join(world.install, "README.md"), "utf8"),
    "# fixture\nlocal edit\n",
  );
  assert.deepEqual(leftovers(world.tmp), []);
  assert.equal(world.git("stash", "list"), "");
  assert.equal(world.git("for-each-ref", "refs/iva/update-backups"), "");
  // The units were never touched: the run stopped at the build.
  assert.doesNotMatch(world.calls(), /iva _install-units/u);
});

void test("the installer run from inside the checkout undoes its own failure too", (t) => {
  const world = createWorld(t);
  // Path B: the command the installer prints, and the one docs/install.md promises is
  // undone on failure - `cd ~/iva && bash install.sh`, no git update involved.
  cpSync(join(ROOT, "install.sh"), join(world.install, "install.sh"));
  const script = join(world.install, "install.sh");
  writeFileSync(join(world.install, "README.md"), "# fixture\nlocal edit\n");
  writeFileSync(join(world.install, "mine.txt"), "mine\n");
  mkdirSync(join(world.install, ".output"), { recursive: true });
  writeFileSync(join(world.install, ".output/marker"), "previous build\n");
  const before = readFileSync(join(world.install, ".env"), "utf8");

  const result = world.run({ script, env: { IVA_TEST_BUILD_EXIT: "137" } });

  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /Installation complete/u);
  // Exactly what path A gives back: the previous build, the edits, the untracked file.
  assert.equal(
    readFileSync(join(world.install, ".output/marker"), "utf8"),
    "previous build\n",
  );
  assert.equal(existsSync(join(world.install, ".output/server.mjs")), false);
  assert.deepEqual(outputBackups(world.install), []);
  assert.equal(
    readFileSync(join(world.install, "README.md"), "utf8"),
    "# fixture\nlocal edit\n",
  );
  assert.equal(readFileSync(join(world.install, "mine.txt"), "utf8"), "mine\n");
  assert.equal(readFileSync(join(world.install, ".env"), "utf8"), before);
  assert.deepEqual(
    backups(world.install).filter((name) => name.startsWith(".env")),
    [],
  );
  assert.deepEqual(leftovers(world.tmp), []);
  // And it never touched the units, because it stopped at the build.
  assert.doesNotMatch(world.calls(), /iva _install-units/u);
});

void test("a restore that could not finish keeps the stash and says where it is", (t) => {
  const world = createWorld(t);
  writeFileSync(join(world.install, "README.md"), "# fixture\nlocal edit\n");
  writeFileSync(join(world.install, "mine.txt"), "mine\n");

  // The units fail, and by then a directory sits where the stashed file has to go back, so
  // the rollback's `stash apply` cannot finish. The one copy of the user's work is the
  // stash entry: dropping it here would destroy it.
  const result = world.run({
    env: { IVA_TEST_UNITS_FAIL: "1", IVA_TEST_BLOCK_RESTORE: "mine.txt" },
  });

  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  const stash = world.git("stash", "list");
  assert.match(
    stash,
    /iva-install-/u,
    "the stash entry was dropped after a failed restore",
  );
  const refs = world.git("for-each-ref", "refs/iva/update-backups");
  assert.match(refs, /refs\/iva\/update-backups\//u);
  // And the user is told where both are, by name.
  const said = result.stdout + result.stderr;
  assert.match(said, /git stash list/u);
  assert.match(said, /refs\/iva\/update-backups\//u);
});

void test("a build that could not be put back is kept and named", (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root writes into a read-only directory, so nothing fails here");
    return;
  }
  const world = createWorld(t);
  mkdirSync(join(world.install, ".output"), { recursive: true });
  writeFileSync(join(world.install, ".output/marker"), "previous build\n");

  // The tree stops accepting writes after the build has already replaced .output, so the
  // rollback cannot move the backup back into place.
  const result = world.run({
    env: { IVA_TEST_UNITS_FAIL: "1", IVA_TEST_FREEZE_TREE: "1" },
  });
  chmodSync(world.install, 0o700);

  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  const said = result.stdout + result.stderr;
  // The only copy of the previous build is that backup: removing it because the run is
  // over would destroy it, so it stays and the user is told where.
  const kept = outputBackups(world.install);
  assert.equal(kept.length, 1, `the backup was removed: ${said}`);
  assert.equal(
    readFileSync(join(world.install, kept[0], "marker"), "utf8"),
    "previous build\n",
  );
  assert.match(said, /previous build is kept at/u);
  assert.match(said, new RegExp(kept[0], "u"));
});

void test("a log that stops being writable does not stop the undo", (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root writes into a read-only directory, so nothing fails here");
    return;
  }
  const world = createWorld(t);
  writeFileSync(join(world.install, "README.md"), "# fixture\nlocal edit\n");
  mkdirSync(join(world.install, ".output"), { recursive: true });
  writeFileSync(join(world.install, ".output/marker"), "previous build\n");

  // Every command of the rollback redirects into the install log. With the log gone, a
  // redirect fails before its command runs - and the undo would be skipped in silence.
  const result = world.run({
    env: { IVA_TEST_FREEZE_LOG: "1", IVA_TEST_BUILD_EXIT: "137" },
  });
  for (const name of readdirSync(world.tmp))
    chmodSync(join(world.tmp, name), 0o600);

  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.equal(
    readFileSync(join(world.install, ".output/marker"), "utf8"),
    "previous build\n",
    "the previous build was not restored once the log went away",
  );
  assert.deepEqual(outputBackups(world.install), []);
  assert.equal(
    readFileSync(join(world.install, "README.md"), "utf8"),
    "# fixture\nlocal edit\n",
  );
  assert.equal(world.git("stash", "list"), "");
  assert.equal(world.git("for-each-ref", "refs/iva/update-backups"), "");
});

void test("a terminal that went away does not take the undo with it", (t) => {
  const world = createWorld(t);
  writeFileSync(join(world.install, "README.md"), "# fixture\nlocal edit\n");
  mkdirSync(join(world.install, ".output"), { recursive: true });
  writeFileSync(join(world.install, ".output/marker"), "previous build\n");

  // No stderr at all, which is what a dropped session leaves behind: the first thing the
  // exit handler does is say where it stopped, and that write fails. Under errexit that
  // ends the handler before it restores anything - and rewrites the exit code on the way.
  const result = world.run({
    closedStderr: true,
    env: { IVA_TEST_BUILD_EXIT: "137" },
  });

  assert.equal(
    readFileSync(join(world.install, ".output/marker"), "utf8"),
    "previous build\n",
    "the undo stopped at the line it could not print",
  );
  assert.deepEqual(outputBackups(world.install), []);
  assert.equal(world.git("stash", "list"), "");
  assert.equal(world.git("for-each-ref", "refs/iva/update-backups"), "");
  // The code the build died with, not one invented by a handler that fell over.
  assert.equal(result.status, 137);
});

void test("a failure is reported once, with the stage that failed", (t) => {
  const world = createWorld(t);
  writeFileSync(join(world.install, "README.md"), "# fixture\nlocal edit\n");

  const result = world.run({ env: { IVA_TEST_UNITS_FAIL: "1" } });

  assert.notEqual(result.status, 0);
  const said = result.stdout + result.stderr;
  // The rollback runs commands that fail as a matter of course - `git rebase --abort`
  // with no rebase in progress is the usual one - and `set +e` does not disarm the ERR
  // trap. Left armed, each of them printed an "Install aborted (code 128)" over the real
  // reason, which is how the cause of a failure gets lost.
  assert.deepEqual(
    said.match(/Install aborted[^\n]*/gu) ?? [],
    [],
    `the rollback reported failures of its own:\n${said}`,
  );
  // The real reason is stated once, and the stage is named.
  assert.equal(
    (said.match(/couldn't enable and start the systemd units/gu) ?? []).length,
    1,
  );
  assert.equal(
    (said.match(/Install stopped during: systemd units/gu) ?? []).length,
    1,
  );
});

void test("an unwritable temporary directory stops the install before it starts", (t) => {
  const world = createWorld(t);
  const blocked = join(world.dir, "blocked-tmp");
  mkdirSync(blocked, { recursive: true });
  chmodSync(blocked, 0o500);

  const result = world.run({ env: { TMPDIR: `${blocked}/` } });
  chmodSync(blocked, 0o700);

  // Every step of the undo redirects into that log. Failing here, before anything has been
  // touched, beats a rollback that silently does nothing later.
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /install log/iu);
  assert.match(result.stderr, /TMPDIR/u);
  assert.doesNotMatch(world.calls(), /npm ci/u);
});

void test("a second installer in the same checkout is refused, a dead one is not", (t) => {
  const world = createWorld(t);
  const lock = join(world.install, "data/install.lock");
  mkdirSync(lock, { recursive: true });
  // A live owner: this test process itself.
  writeFileSync(join(lock, "pid"), `${process.pid}\n`);

  const refused = world.run();
  assert.notEqual(refused.status, 0, refused.stdout + refused.stderr);
  assert.match(refused.stderr, new RegExp(`pid ${process.pid}`, "u"));
  // The path is part of the answer: a pid the system has since reused is a dead end
  // without it.
  assert.match(refused.stderr, /data\/install\.lock/u);
  assert.doesNotMatch(world.calls(), /npm ci/u);
  // A refused run touches nothing at all.
  assert.equal(world.git("stash", "list"), "");
  assert.deepEqual(backups(world.install), []);

  // A lock with no owner written into it yet belongs to an installer that is a moment from
  // writing one - taking it over would run two of them at once.
  rmSync(join(lock, "pid"));
  const starting = world.run();
  assert.notEqual(starting.status, 0, starting.stdout + starting.stderr);
  assert.match(starting.stderr, /starting/u);

  // The same lock left by a run that really is gone is taken over, not honoured forever.
  const dead = spawnSync(process.execPath, ["-e", "0"]);
  assert.equal(dead.status, 0);
  writeFileSync(join(lock, "pid"), `${dead.pid}\n`);
  const taken = world.run({ calls: join(world.dir, "second.log") });
  assert.equal(taken.status, 0, taken.stdout + taken.stderr);
  assert.equal(
    existsSync(lock),
    false,
    "the lock outlived the run that took it",
  );
});

void test("installer ownership files follow the canonical custom data directory", async (t) => {
  const world = createWorld(t);
  writeFileSync(
    join(world.install, ".env"),
    "AGENT_LANGUAGE=en\nASSISTANT_DATA_DIR= state/../runtime \n",
  );
  const dataDir = join(world.install, "runtime");
  const lock = join(dataDir, "install.lock");
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, "pid"), `${process.pid}\n`);

  const refused = world.run();
  assert.notEqual(refused.status, 0, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /runtime\/install\.lock/u);
  assert.equal(existsSync(join(world.install, "data/install.lock")), false);

  rmSync(lock, { recursive: true, force: true });
  writeFileSync(join(world.install, "README.md"), "# fixture\nlocal edit\n");
  const waiting = join(world.dir, "custom-data-building");
  const run = world.runAsync({ env: { IVA_TEST_BUILD_WAIT: waiting } });
  for (let waited = 0; !existsSync(waiting) && waited < 20000; waited += 50)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(existsSync(waiting), "the run never reached the build");
  assert.equal(existsSync(lock), true);
  assert.match(
    readdirSync(join(dataDir, "update-backups")).join("\n"),
    /^\.env-/mu,
  );
  assert.equal(existsSync(join(world.install, "data/update-backups")), false);

  run.signal("SIGHUP");
  const result = await run.done;
  assert.notEqual(result.code, 0);
  assert.equal(existsSync(lock), false);
});

void test("the fallback copy of .env is private from the first byte", (t) => {
  const world = createWorld(t);
  // data/ cannot be written, so the copy has to go to TMPDIR - the path that used to
  // inherit 0644 from a world-readable .env through `cp -p`.
  chmodSync(join(world.install, ".env"), 0o644);
  mkdirSync(join(world.install, "data"), { recursive: true });
  chmodSync(join(world.install, "data"), 0o500);
  const snapshot = join(world.dir, "snapshot.json");

  const result = world.run({ env: { IVA_TEST_SNAPSHOT: snapshot } });
  chmodSync(join(world.install, "data"), 0o700);
  assert.equal(result.status, 0, result.stdout + result.stderr);

  const live = JSON.parse(readFileSync(snapshot, "utf8")) as {
    tmp: { name: string; mode: string }[];
  };
  const copy = live.tmp.filter((entry) => entry.name.startsWith("iva-env."));
  assert.equal(copy.length, 1, JSON.stringify(live.tmp));
  assert.equal(copy[0].mode, "600");
  assert.deepEqual(leftovers(world.tmp), []);
});

void test("an unreadable untracked file rebuilds instead of answering blind", (t) => {
  const world = createWorld(t);
  // A source file of the user's own, and a symlink with nothing behind it. git cannot hash
  // the symlink and the hashing stops there, so everything after it - the source file
  // included - drops out of the answer while its name stays in the file list.
  writeFileSync(join(world.install, "extra.ts"), "export const version = 1;\n");
  symlinkSync(
    join(world.dir, "nothing-here"),
    join(world.install, "dangling.ts"),
  );
  assert.equal(world.run().status, 0);

  // Only contents change now: the set of paths is exactly the one the first run saw.
  writeFileSync(join(world.install, "extra.ts"), "export const version = 2;\n");

  const second = world.run({ calls: join(world.dir, "second.log") });
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.match(
    world.calls(join(world.dir, "second.log")),
    /eve build/u,
    "the changed source was not rebuilt",
  );
});

void test("a dropped connection rolls the install back like any other failure", async (t) => {
  const world = createWorld(t);
  writeFileSync(join(world.install, "README.md"), "# fixture\nlocal edit\n");
  writeFileSync(join(world.install, "mine.txt"), "mine\n");
  mkdirSync(join(world.install, ".output"), { recursive: true });
  writeFileSync(join(world.install, ".output/marker"), "previous build\n");

  const waiting = join(world.dir, "building");
  const run = world.runAsync({ env: { IVA_TEST_BUILD_WAIT: waiting } });
  // Hang up the moment the run is provably inside the build, past the point where it has
  // moved the old output aside and written down everything it has to put back.
  for (let waited = 0; !existsSync(waiting) && waited < 20000; waited += 50)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(existsSync(waiting), "the run never reached the build");
  run.signal("SIGHUP");
  const result = await run.done;

  assert.notEqual(result.code, 0);
  assert.equal(
    readFileSync(join(world.install, ".output/marker"), "utf8"),
    "previous build\n",
  );
  assert.deepEqual(outputBackups(world.install), []);
  assert.equal(
    readFileSync(join(world.install, "README.md"), "utf8"),
    "# fixture\nlocal edit\n",
  );
  assert.equal(readFileSync(join(world.install, "mine.txt"), "utf8"), "mine\n");
  assert.deepEqual(leftovers(world.tmp), []);
  assert.deepEqual(
    backups(world.install).filter((name) => name.startsWith(".env")),
    [],
  );
  assert.equal(world.git("stash", "list"), "");
  assert.equal(world.git("for-each-ref", "refs/iva/update-backups"), "");
});

void test("the copy of .env lives beside the installation, never in /tmp", (t) => {
  const world = createWorld(t);
  writeFileSync(join(world.install, "README.md"), "# fixture\nlocal edit\n");
  const snapshot = join(world.dir, "snapshot.json");

  const result = world.run({ env: { IVA_TEST_SNAPSHOT: snapshot } });
  assert.equal(result.status, 0, result.stdout + result.stderr);

  // Taken while the install was still running, so it is the live state, not the leftovers.
  const live = JSON.parse(readFileSync(snapshot, "utf8")) as {
    backupsMode: string;
    backups: { name: string; mode: string }[];
    tmp: { name: string; mode: string }[];
  };
  const envCopy = live.backups.filter((entry) => entry.name.startsWith(".env"));
  assert.equal(envCopy.length, 1, JSON.stringify(live.backups));
  assert.equal(envCopy[0].mode, "600");
  assert.equal(live.backupsMode, "700");
  // The only thing this run may leave in a world-readable directory is its log.
  assert.deepEqual(
    live.tmp.filter((entry) => !entry.name.startsWith("iva-install-")),
    [],
  );
  assert.deepEqual(leftovers(world.tmp), []);
  assert.deepEqual(
    backups(world.install).filter((name) => name.startsWith(".env")),
    [],
  );
});

void test("a failure while preserving the checkout keeps the files it was preserving", (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root can read a file with no permissions, so nothing fails here");
    return;
  }
  const world = createWorld(t);
  writeFileSync(join(world.install, "README.md"), "# fixture\nlocal edit\n");
  writeFileSync(join(world.install, "mine.txt"), "mine\n");
  // The copy of .env is the first thing a run saves, and it cannot be made: the failure
  // lands before anything else has been written down, while the user's files sit in the
  // tree with nothing holding a second copy of them.
  chmodSync(join(world.install, ".env"), 0o000);

  const result = world.run();
  chmodSync(join(world.install, ".env"), 0o600);

  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  // The user's files are still theirs - a rollback with nothing to restore from must not
  // delete what it recorded.
  assert.equal(readFileSync(join(world.install, "mine.txt"), "utf8"), "mine\n");
  assert.equal(
    readFileSync(join(world.install, "README.md"), "utf8"),
    "# fixture\nlocal edit\n",
  );
  // And the ref it had already written is gone with it.
  assert.equal(world.git("for-each-ref", "refs/iva/update-backups"), "");
  assert.equal(world.git("stash", "list"), "");
  assert.deepEqual(leftovers(world.tmp), []);
  assert.deepEqual(backups(world.install), []);
});

void test("a failure between the backup ref and the stash orphans neither", (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root reads a file with no permissions, so the stash does not fail");
    return;
  }
  const world = createWorld(t);
  writeFileSync(join(world.install, "README.md"), "# fixture\nlocal edit\n");
  // git cannot put this into a stash, so the run dies after the backup ref is written and
  // before the stash that ref exists to accompany - the one window the arming order is for.
  writeFileSync(join(world.install, "unreadable.txt"), "mine\n");
  chmodSync(join(world.install, "unreadable.txt"), 0o000);

  const result = world.run();
  chmodSync(join(world.install, "unreadable.txt"), 0o600);

  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /Install stopped during: saving your changes/u);
  // The ref was written and then taken back with the rest of the run: not left behind for
  // the next one to trip over, and not silently reported as changes that were saved.
  assert.equal(world.git("for-each-ref", "refs/iva/update-backups"), "");
  assert.equal(world.git("stash", "list"), "");
  assert.doesNotMatch(result.stdout, /changes are in the stash/u);
  // And everything of the user's is still where it was.
  assert.equal(
    readFileSync(join(world.install, "README.md"), "utf8"),
    "# fixture\nlocal edit\n",
  );
  assert.equal(
    readFileSync(join(world.install, "unreadable.txt"), "utf8"),
    "mine\n",
  );
  assert.deepEqual(leftovers(world.tmp), []);
  assert.deepEqual(
    backups(world.install).filter((name) => name.startsWith(".env")),
    [],
  );
});

void test("a run that can save nothing at all leaves nothing behind", (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root reads a file with no permissions, so nothing fails here");
    return;
  }
  const world = createWorld(t);
  // Both places a copy of .env could go are refused: the installation's own directory
  // cannot be written, and the file itself cannot be read.
  mkdirSync(join(world.install, "data"), { recursive: true });
  chmodSync(join(world.install, "data"), 0o500);
  chmodSync(join(world.install, ".env"), 0o000);

  const result = world.run();
  chmodSync(join(world.install, "data"), 0o700);
  chmodSync(join(world.install, ".env"), 0o600);

  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /Cannot copy/u);
  // Not even the empty file the fallback had to create to try: a run that copied nothing
  // leaves no stub of a copy anywhere.
  assert.deepEqual(leftovers(world.tmp), []);
});

void test("a pending reboot stops a first install and only warns over a configured one", (t) => {
  const world = createWorld(t, { env: false });
  const flag = join(world.dir, "reboot-required");
  writeFileSync(flag, "");
  writeFileSync(`${flag}.pkgs`, "linux-headers-6.8.0-137\n");

  // Nothing is configured yet, and every package stage is still ahead: refuse.
  const fresh = world.run({ env: { IVA_REBOOT_FLAG: flag } });
  assert.notEqual(fresh.status, 0, fresh.stdout + fresh.stderr);
  assert.match(fresh.stderr, /sudo reboot/u);
  assert.doesNotMatch(world.calls(), /npm ci/u);

  // Configured: unattended-upgrades raises this flag for any security update, and a re-run
  // that installs nothing must not be refused for days.
  writeFileSync(
    join(world.install, ".env"),
    "AGENT_LANGUAGE=en\nIVA_PORT=8723\n",
  );
  const rerun = world.run({
    calls: join(world.dir, "rerun.log"),
    env: { IVA_REBOOT_FLAG: flag },
  });
  assert.equal(rerun.status, 0, rerun.stdout + rerun.stderr);
  assert.match(rerun.stdout, /reboot/iu);
  assert.match(
    world.calls(join(world.dir, "rerun.log")),
    /iva _activate-units/u,
  );
});

void test("an installation without git rebuilds instead of trusting the stamp", (t) => {
  const world = createWorld(t);
  // A tree unpacked from an archive: the installer sits inside it and there is no history
  // to compare against, so nothing can prove the output matches the code.
  cpSync(join(ROOT, "install.sh"), join(world.install, "install.sh"));
  rmSync(join(world.install, ".git"), { recursive: true, force: true });

  const script = join(world.install, "install.sh");
  const first = world.run({ calls: join(world.dir, "first.log"), script });
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.match(world.calls(join(world.dir, "first.log")), /eve build/u);

  const second = world.run({ calls: join(world.dir, "second.log"), script });
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.match(world.calls(join(world.dir, "second.log")), /eve build/u);
});

void test("patches with nothing to apply them mean a full install, not a reuse", (t) => {
  const world = createWorld(t);
  assert.equal(world.run().status, 0);

  // What `npm prune --production` leaves behind: the tree still matches the lockfile by
  // npm's own record, but the tool that puts the patches on top is gone.
  rmSync(join(world.install, "node_modules/.bin/patch-package"), {
    force: true,
  });

  const second = world.run({ calls: join(world.dir, "second.log") });
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.match(world.calls(join(world.dir, "second.log")), /^npm ci$/mu);
});

void test("a failure at the last stage restores the checkout and leaves nothing behind", (t) => {
  const world = createWorld(t);
  // What the user has: an edit of their own, a file of their own, and a build.
  writeFileSync(join(world.install, "README.md"), "# fixture\nlocal edit\n");
  writeFileSync(join(world.install, "mine.txt"), "mine\n");
  mkdirSync(join(world.install, ".output"), { recursive: true });
  writeFileSync(join(world.install, ".output/marker"), "previous build\n");

  const result = world.run({ env: { IVA_TEST_UNITS_FAIL: "1" } });

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /Install stopped during/u);

  // Nothing of this run survives it: no copy of .env anywhere, no stash entry, no backup
  // ref, no half-moved build output.
  assert.deepEqual(leftovers(world.tmp), []);
  assert.deepEqual(
    backups(world.install).filter((name) => name.startsWith(".env")),
    [],
  );
  assert.equal(world.git("stash", "list"), "");
  assert.equal(world.git("for-each-ref", "refs/iva/update-backups"), "");
  assert.deepEqual(outputBackups(world.install), []);

  // And everything of the user's survives it.
  assert.equal(
    readFileSync(join(world.install, "README.md"), "utf8"),
    "# fixture\nlocal edit\n",
  );
  assert.equal(readFileSync(join(world.install, "mine.txt"), "utf8"), "mine\n");
  assert.equal(
    readFileSync(join(world.install, ".env"), "utf8"),
    "AGENT_LANGUAGE=en\nIVA_PORT=8723\n",
  );
  assert.equal(
    readFileSync(join(world.install, ".output/marker"), "utf8"),
    "previous build\n",
  );
  assert.equal(existsSync(join(world.install, ".output/server.mjs")), false);

  // The ignore rules keep a backup that somehow survives out of the next stash.
  mkdirSync(join(world.install, ".output.iva-install-backup-999"), {
    recursive: true,
  });
  writeFileSync(
    join(world.install, ".output.iva-install-backup-999/server.mjs"),
    "old\n",
  );
  assert.doesNotMatch(
    world.git("status", "--porcelain=v1", "--untracked-files=all"),
    /iva-install-backup/u,
  );
});

void test("a re-run over a finished install skips the stages that are already done", (t) => {
  const world = createWorld(t);
  writeFileSync(join(world.install, "README.md"), "# fixture\nlocal edit\n");
  writeFileSync(join(world.install, "mine.txt"), "mine\n");

  const first = world.run({ calls: join(world.dir, "first.log") });
  assert.equal(first.status, 0, first.stdout + first.stderr);

  const firstCalls = world.calls(join(world.dir, "first.log"));
  assert.match(firstCalls, /^npm ci$/mu);
  assert.match(
    firstCalls,
    /^npm i -g .*\/iva-agent-browser-[^/\s]+\/[^/\s]+$/mu,
  );
  assert.match(firstCalls, /^npm i -g .*\/iva-gws-[^/\s]+\/[^/\s]+$/mu);
  assert.match(firstCalls, /^npm exec -- eve build$/mu);
  // A finished install keeps nothing either.
  assert.deepEqual(leftovers(world.tmp), []);
  assert.equal(world.git("stash", "list"), "");
  assert.equal(world.git("for-each-ref", "refs/iva/update-backups"), "");
  assert.deepEqual(
    backups(world.install).filter((name) => name.startsWith(".env")),
    [],
  );

  const second = world.run({ calls: join(world.dir, "second.log") });
  assert.equal(second.status, 0, second.stdout + second.stderr);

  const secondCalls = world.calls(join(world.dir, "second.log"));
  assert.doesNotMatch(secondCalls, /^npm ci$/mu);
  assert.doesNotMatch(secondCalls, /^npm install$/mu);
  assert.doesNotMatch(secondCalls, /^npm i -g /mu);
  assert.doesNotMatch(secondCalls, /eve build/u);
  assert.doesNotMatch(secondCalls, /agent-browser install/u);
  // Skipped, not forgotten: the dependencies are still checked against the lockfile and
  // the patches re-applied, and the units are still written and enabled.
  assert.match(secondCalls, /^patch-package\s*$/mu);
  assert.match(secondCalls, /^iva _install-units$/mu);
  assert.match(secondCalls, /^iva _activate-units$/mu);

  // The user's own state is still theirs after two runs.
  assert.equal(
    readFileSync(join(world.install, "README.md"), "utf8"),
    "# fixture\nlocal edit\n",
  );
  assert.equal(readFileSync(join(world.install, "mine.txt"), "utf8"), "mine\n");
  assert.equal(
    readFileSync(join(world.install, ".output/server.mjs"), "utf8"),
    "built",
  );
  assert.deepEqual(leftovers(world.tmp), []);
  assert.equal(world.git("stash", "list"), "");
  assert.equal(world.git("for-each-ref", "refs/iva/update-backups"), "");
});

void test("a changed .env rebuilds instead of reusing the output", (t) => {
  const world = createWorld(t);
  assert.equal(world.run().status, 0);
  writeFileSync(
    join(world.install, ".env"),
    "AGENT_LANGUAGE=en\nIVA_PORT=8724\n",
  );
  const second = world.run({ calls: join(world.dir, "second.log") });
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.match(world.calls(join(world.dir, "second.log")), /eve build/u);
});

void test("a first install into an empty directory still runs every stage", (t) => {
  const world = createWorld(t);
  const fresh = join(world.dir, "fresh");

  const result = world.run({ env: { INSTALL_DIR: fresh } });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  const calls = world.calls();
  for (const stage of [
    /^npm ci$/mu,
    /^npm i -g .*\/iva-agent-browser-[^/\s]+\/[^/\s]+$/mu,
    /^agent-browser install --with-deps$/mu,
    /^npm i -g .*\/iva-gws-[^/\s]+\/[^/\s]+$/mu,
    /^npm exec -- eve build$/mu,
  ])
    assert.match(calls, stage);
  assert.equal(existsSync(join(fresh, ".output/server.mjs")), true);
  // Nothing was preserved, so nothing had to be cleaned up either.
  assert.deepEqual(leftovers(world.tmp), []);
  assert.deepEqual(backups(fresh), []);
  assert.equal(
    execFileSync("git", ["stash", "list"], { cwd: fresh, encoding: "utf8" }),
    "",
  );
});

void test("the deferred wizard ends with enabled units and lingering, in that order", (t) => {
  const world = createWorld(t, { env: false });

  const first = world.run({ calls: join(world.dir, "first.log") });
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const firstCalls = world.calls(join(world.dir, "first.log"));
  assert.doesNotMatch(firstCalls, /iva _install-units/u);
  // Both places that tell the user what to do next name the same two commands: the
  // wizard, then the installer - never `iva restart`, which leaves the units disabled.
  const advice = (first.stdout + first.stderr).match(
    /npm run setup[\s\S]*?install\.sh/gu,
  );
  assert.equal(advice?.length, 2, first.stdout + first.stderr);
  assert.doesNotMatch(first.stdout, /iva restart/u);

  // What `npm run setup` leaves behind.
  writeFileSync(
    join(world.install, ".env"),
    "AGENT_LANGUAGE=en\nIVA_PORT=8723\n",
  );

  const second = world.run({ calls: join(world.dir, "second.log") });
  assert.equal(second.status, 0, second.stdout + second.stderr);
  const secondCalls = world.calls(join(world.dir, "second.log"));
  const linger = secondCalls.indexOf("loginctl enable-linger");
  const activate = secondCalls.indexOf("iva _activate-units");
  assert.ok(linger >= 0, `lingering was never enabled:\n${secondCalls}`);
  assert.match(secondCalls, /^iva _install-units$/mu);
  assert.ok(
    activate > linger,
    `the units were activated before lingering:\n${secondCalls}`,
  );
});

void test("a versioned install is refused instead of cloned into", (t) => {
  const world = createWorld(t);
  const versioned = join(world.dir, "v2");
  mkdirSync(join(versioned, "versions/0.3.20-0123456789ab"), {
    recursive: true,
  });
  const result = world.run({ env: { INSTALL_DIR: versioned } });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /iva update/u);
  assert.match(result.stderr, /iva rollback/u);
  assert.equal(existsSync(join(versioned, ".git")), false);
});
