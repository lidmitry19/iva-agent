/**
 * Getting a plugin folder onto the disk: git fetch, local copy, and the swap into
 * the store. Nothing here decides policy - `scripts/cli/plugin.ts` owns the order
 * of steps, the messages, and what is written to `plugins.json`.
 *
 * Every install stages first and swaps last. A plugin that fails validation must
 * leave the store exactly as it was (ADR-0003: the box stays sacred), and a
 * half-written plugin directory would be the one state nothing can recover from.
 *
 * Git is driven exactly as ADR-0009 pins it: resolve the ref with `ls-remote`,
 * fetch that one sha shallow and blobless, check out FETCH_HEAD, then confirm
 * `rev-parse HEAD`. The confirmation is the point - it is what makes "pinned to a
 * sha" true rather than hopeful.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { chmod, copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { walkPluginTree } from "#lib/plugin-reader.ts";

export type GitResult = {
  readonly code: number;
  readonly out: string;
  readonly err: string;
};

/** How this process runs git. The CLI passes its own captured runner. */
export type GitRunner = (args: readonly string[], cwd?: string) => GitResult;

export const SHA = /^[a-f0-9]{40,64}$/u;

function must(result: GitResult, what: string): string {
  if (result.code !== 0)
    throw new Error(
      `${what} failed: ${result.err || result.out || "git error"}`,
    );
  return result.out;
}

/**
 * Which commit a ref points at right now. A ref that is already a sha is taken
 * as is: there is nothing for the remote to resolve, and asking would only fail
 * on a server that does not advertise it.
 */
export function resolveRemoteSha(
  git: GitRunner,
  url: string,
  ref: string | null,
): { readonly sha: string; readonly ref: string } {
  const wanted = ref ?? "HEAD";
  if (SHA.test(wanted)) return { sha: wanted, ref: wanted };

  // Оба шаблона: `ls-remote` сопоставляет их по имени ссылки, и строку `…^{}`
  // (коммит аннотированного тега) без второго шаблона он не покажет вовсе.
  const listing = must(
    git(["ls-remote", url, wanted, `${wanted}^{}`]),
    `git ls-remote ${url} ${wanted}`,
  );
  const lines = listing
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/u));
  if (lines.length === 0)
    throw new Error(`${url} has no ref ${JSON.stringify(wanted)}`);
  // An annotated tag advertises both the tag object and the commit it peels to
  // (`^{}`); the commit is what gets checked out.
  const peeled = lines.find(([, name]) => name?.endsWith("^{}"));
  const sha = (peeled ?? lines[0])[0];
  if (!SHA.test(sha))
    throw new Error(
      `${url} answered with an unusable sha: ${JSON.stringify(sha)}`,
    );
  return { sha, ref: wanted };
}

/**
 * Fetch one commit into an empty staging directory and return the plugin root
 * inside it. With a subdirectory source the checkout is sparse, and the plugin
 * root is that subdirectory - the git checkout itself stays behind in staging.
 */
export function fetchGitPlugin(
  git: GitRunner,
  staging: string,
  url: string,
  sha: string,
  subdir: string | null,
): string {
  if (!SHA.test(sha))
    throw new Error(`refusing to fetch an unusable sha: ${sha}`);
  must(git(["init", "-q"], staging), "git init");
  must(git(["remote", "add", "origin", url], staging), "git remote add");
  if (subdir) {
    must(
      git(["sparse-checkout", "init", "--cone"], staging),
      "git sparse-checkout init",
    );
    must(
      git(["sparse-checkout", "set", subdir], staging),
      "git sparse-checkout set",
    );
  }
  must(
    git(
      ["fetch", "--depth", "1", "--filter=blob:none", "origin", sha],
      staging,
    ),
    `git fetch ${url} ${sha}`,
  );
  must(
    git(["checkout", "-q", "FETCH_HEAD"], staging),
    "git checkout FETCH_HEAD",
  );
  const head = must(git(["rev-parse", "HEAD"], staging), "git rev-parse HEAD");
  if (head !== sha)
    throw new Error(
      `checked out ${head}, expected ${sha} - refusing to install`,
    );

  const root = subdir ? join(staging, subdir) : staging;
  if (!existsSync(root))
    throw new Error(`${url} has no ${subdir} at ${sha.slice(0, 12)}`);
  return root;
}

/**
 * Copy a plugin folder into staging. The walk runs first and rejects symlinks,
 * special files and oversized trees, so the copy never follows a link out of the
 * source (which is what a plain `cp -r` would do).
 */
export async function copyPluginTree(
  source: string,
  destination: string,
): Promise<void> {
  const files = await walkPluginTree(source);
  await mkdir(destination, { recursive: true });
  for (const file of files) {
    const target = join(destination, ...file.path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(source, ...file.path.split("/")), target);
    // Skills legitimately ship scripts; the executable bit is part of the plugin.
    await chmod(target, file.mode & 0o777);
  }
}

/** Does the store copy carry edits of its own? `null` - it is not a git checkout. */
export function localChanges(git: GitRunner, dir: string): string | null {
  if (!existsSync(join(dir, ".git"))) return null;
  const status = git(["status", "--porcelain"], dir);
  return status.code === 0 ? status.out : null;
}

/**
 * Put the staged plugin in the store, atomically enough that a failure leaves the
 * previous copy in place: the old directory is moved aside first and only removed
 * once the new one is in.
 */
export function swapIntoStore(staged: string, store: string): void {
  mkdirSync(dirname(store), { recursive: true });
  const displaced = existsSync(store)
    ? `${store}.replaced-${randomUUID().slice(0, 8)}`
    : null;
  if (displaced) renameSync(store, displaced);
  try {
    renameSync(staged, store);
  } catch (error) {
    if (displaced) renameSync(displaced, store);
    throw error;
  }
  if (displaced) rmSync(displaced, { recursive: true, force: true });
}
