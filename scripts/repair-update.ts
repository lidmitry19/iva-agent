import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { resolveDataDir } from "./lib/data-dir.ts";
import { isEntrypoint } from "./lib/version-layout.ts";
import { createVersionStore, parseVersionName } from "./lib/version-store.ts";
import { z } from "zod";

const BOOTSTRAP_FILES = [
  "scripts/cli/update.ts",
  "scripts/lib/update-safety.ts",
  "scripts/lib/custom-layer.ts",
  "scripts/lib/telegram-status.ts",
] as const;
const DEFAULT_UPDATE_BRANCH = "main";
const UPDATE_BRANCH_CONFIG = "iva.updateBranch";

type Checkout = { root: string; origin: string };

const RepairOptionsSchema = z.strictObject({
  inputRoot: z.string().min(1).optional(),
  expectedTarget: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function gitOk(root: string, ...args: string[]): boolean {
  return (
    spawnSync("git", args, {
      cwd: root,
      stdio: "ignore",
    }).status === 0
  );
}

/**
 * Whether the repaired updater really put the target in charge. A legacy install
 * shows it as a moved HEAD; one that the bridge has since converted has no
 * working tree at all and shows it as the version `current` points at.
 */
function activated(root: string, target: string): boolean {
  const active = createVersionStore(root).currentName();
  const sha = active ? parseVersionName(active)?.sha : null;
  return sha
    ? target.startsWith(sha)
    : gitOk(root, "merge-base", "--is-ancestor", target, "HEAD");
}

function optionalGit(root: string, ...args: string[]): string | null {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result.status === 0 ? String(result.stdout ?? "").trim() : null;
}

// The repository is smixs/iva-agent. Installs made before 2026-08-19 still keep
// origin = smixs/iva, which GitHub redirects, so both paths stay official.
const OFFICIAL_REPO_PATHS = new Set(["smixs/iva-agent", "smixs/iva"]);

export function isOfficialIvaOrigin(value: string): boolean {
  const scp = value.match(/^git@([^:]+):(.+)$/i);
  if (scp)
    return (
      scp[1]?.toLowerCase() === "github.com" &&
      OFFICIAL_REPO_PATHS.has(
        scp[2]?.replace(/\.git$/i, "").toLowerCase() ?? "",
      )
    );
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "ssh:") &&
      url.hostname.toLowerCase() === "github.com" &&
      url.port === "" &&
      OFFICIAL_REPO_PATHS.has(
        url.pathname
          .replace(/^\//, "")
          .replace(/\.git$/i, "")
          .toLowerCase(),
      )
    );
  } catch {
    return false;
  }
}

export function validateOfficialCheckout(inputRoot: string): Checkout {
  const root = realpathSync(inputRoot);
  const packagePath = join(root, "package.json");
  if (!existsSync(packagePath)) throw new Error("package.json is missing");
  const pkg: unknown = JSON.parse(readFileSync(packagePath, "utf8"));
  if (
    !pkg ||
    typeof pkg !== "object" ||
    (pkg as { name?: unknown }).name !== "iva"
  )
    throw new Error("this is not an Iva checkout");
  const top = realpathSync(git(root, "rev-parse", "--show-toplevel"));
  if (top !== root) throw new Error("run repair from the Iva repository root");
  const origin = git(root, "remote", "get-url", "origin");
  if (!isOfficialIvaOrigin(origin))
    throw new Error("origin is not the official smixs/iva-agent repository");
  return { root, origin };
}

function fetchRepairBranch(root: string, branch: string): string {
  if (!gitOk(root, "check-ref-format", "--branch", branch))
    throw new Error(`invalid update branch: ${branch}`);
  git(root, "fetch", "--prune", "origin", `refs/heads/${branch}`);
  const target = git(root, "rev-parse", "FETCH_HEAD^{commit}");
  if (!/^[0-9a-f]{40}$/.test(target))
    throw new Error(`origin/${branch} did not resolve to a commit SHA`);
  return target;
}

function resolveRepairTarget(root: string): string {
  const configured = optionalGit(
    root,
    "config",
    "--local",
    "--get",
    UPDATE_BRANCH_CONFIG,
  );
  if (configured) return fetchRepairBranch(root, configured);

  const currentBranch = git(root, "rev-parse", "--abbrev-ref", "HEAD");
  if (!currentBranch || currentBranch === "HEAD")
    throw new Error("detached HEAD: switch to the update branch first");
  if (currentBranch !== DEFAULT_UPDATE_BRANCH) {
    const defaultTarget = fetchRepairBranch(root, DEFAULT_UPDATE_BRANCH);
    if (gitOk(root, "merge-base", "--is-ancestor", "HEAD", defaultTarget))
      return defaultTarget;
  }
  return fetchRepairBranch(root, currentBranch);
}

function safeChild(root: string, relative: string): string {
  const target = resolve(root, relative);
  if (!target.startsWith(`${resolve(root)}${sep}`))
    throw new Error("unsafe path in repair state");
  return target;
}

function targetFile(root: string, target: string, relative: string): Buffer {
  return execFileSync("git", ["show", `${target}:${relative}`], {
    cwd: root,
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function installBootstrapFiles(root: string, target: string): void {
  for (const relative of BOOTSTRAP_FILES) {
    const path = safeChild(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, targetFile(root, target, relative), { mode: 0o644 });
  }
}

function restoreOriginalState({
  root,
  originalHead,
  originalStash,
  originalUntracked,
}: {
  root: string;
  originalHead: string;
  originalStash: string;
  originalUntracked: readonly string[];
}): void {
  spawnSync("git", ["rebase", "--abort"], { cwd: root, stdio: "ignore" });
  git(root, "reset", "--hard", originalHead);
  for (const relative of originalUntracked)
    rmSync(safeChild(root, relative), { recursive: true, force: true });
  if (originalStash) {
    const restored = spawnSync(
      "git",
      ["stash", "apply", "--index", originalStash],
      { cwd: root, stdio: "inherit" },
    );
    if (restored.status !== 0)
      throw new Error(
        `repair failed and the original changes remain in stash ${originalStash}`,
      );
  }
}

export function runRepairUpdate(
  options: {
    inputRoot?: string;
    expectedTarget?: string;
  } = {},
): void {
  const parsed = RepairOptionsSchema.parse(options);
  const inputRoot = parsed.inputRoot ?? process.cwd();
  const { expectedTarget } = parsed;
  if (Number(process.versions.node.split(".")[0]) < 24)
    throw new Error("Iva update repair requires Node 24 or newer");
  const { root } = validateOfficialCheckout(inputRoot);
  const originalHead = git(root, "rev-parse", "HEAD");
  const status = git(root, "status", "--porcelain=v1");
  const originalUntracked = status
    ? git(root, "ls-files", "--others", "--exclude-standard", "-z")
        .split("\0")
        .filter(Boolean)
    : [];
  let originalStash = "";
  let originalStateCaptured = !status;

  try {
    const target = resolveRepairTarget(root);
    if (expectedTarget && expectedTarget !== target)
      throw new Error("update target does not match the requested repair SHA");
    if (!gitOk(root, "merge-base", "--is-ancestor", originalHead, target))
      throw new Error(
        "the current checkout cannot fast-forward to the update target",
      );

    if (status) {
      git(
        root,
        "stash",
        "push",
        "--include-untracked",
        "--message",
        `iva-repair-bootstrap-${new Date().toISOString()}`,
      );
      originalStash = git(root, "rev-parse", "refs/stash");
      originalStateCaptured = true;
    }
    installBootstrapFiles(root, target);
    if (originalStash) {
      const applied = spawnSync(
        "git",
        ["stash", "apply", "--index", originalStash],
        { cwd: root, stdio: "inherit" },
      );
      if (applied.status !== 0) {
        const conflicts = git(root, "diff", "--name-only", "--diff-filter=U")
          .split("\n")
          .filter(Boolean);
        const bootstrapFiles: readonly string[] = BOOTSTRAP_FILES;
        if (conflicts.some((path) => !bootstrapFiles.includes(path)))
          throw new Error(
            "could not compose the repair updater with local changes",
          );
        installBootstrapFiles(root, target);
        git(root, "add", "--", ...BOOTSTRAP_FILES);
      }
    }

    const update = spawnSync(
      process.execPath,
      [join(root, "bin/iva.mjs"), "update", "--force", "--verbose"],
      {
        cwd: root,
        stdio: "inherit",
        env: { ...process.env, ASSISTANT_DATA_DIR: resolveDataDir(root) },
      },
    );
    if (update.status !== 0) throw new Error("the repaired updater failed");
    if (!activated(root, target))
      throw new Error(
        "the repaired updater did not activate the fetched target",
      );
    process.stdout.write(
      originalStash
        ? `Iva updated. Original recovery stash retained: ${originalStash}\n`
        : "Iva updated.\n",
    );
  } catch (error) {
    if (originalStateCaptured) {
      try {
        restoreOriginalState({
          root,
          originalHead,
          originalStash,
          originalUntracked,
        });
      } catch (restoreError) {
        if (error instanceof Error && error.cause === undefined)
          error.cause = restoreError;
      }
    }
    throw error;
  }
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`${name} requires a value`);
  return value;
}

if (isEntrypoint(import.meta.url)) {
  try {
    runRepairUpdate({
      inputRoot: argument("--root") || process.cwd(),
      expectedTarget: argument("--target"),
    });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
