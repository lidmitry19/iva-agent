/**
 * Getting a plugin folder onto the disk: git fetch, local copy, and the swap into
 * the store. Nothing here decides policy - `scripts/cli/plugin-cli-install.ts` owns
 * the order of steps, the messages, and what is written to `plugins.json`.
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
import { dirname, join, relative, resolve } from "node:path";
import { walkPluginTree } from "#lib/plugin-reader.ts";
import { positional } from "./plugin-source.ts";

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
    git(["ls-remote", "--", ...positional([url, wanted, `${wanted}^{}`])]),
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
  // Всё, что пришло из строки источника, проверяется ДО первой команды git: иначе
  // отказ на третьем шаге оставил бы половину инициализированного checkout.
  positional([url, sha, ...(subdir ? [subdir] : [])]);
  // `--` everywhere git takes it: after it, a value that starts with a dash is a
  // path or a ref, never an option. `positional` refuses such values outright.
  must(git(["init", "-q"], staging), "git init");
  must(
    git(["remote", "add", "--", "origin", ...positional([url])], staging),
    "git remote add",
  );
  if (subdir) {
    must(
      git(["sparse-checkout", "init", "--cone"], staging),
      "git sparse-checkout init",
    );
    must(
      git(["sparse-checkout", "set", "--", ...positional([subdir])], staging),
      "git sparse-checkout set",
    );
  }
  must(
    git(
      [
        "fetch",
        "--depth",
        "1",
        "--filter=blob:none",
        "--",
        "origin",
        ...positional([sha]),
      ],
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
  // Второй замок на подпапку: источник её уже проверил, но каталог отсюда уезжает
  // в data/custom/plugins/ целиком, и промах здесь стоил бы чужой папки на диске.
  if (relative(resolve(staging), resolve(root)).startsWith(".."))
    throw new Error(`${subdir} climbs out of the fetched checkout`);
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

/**
 * Put the staged plugin in place, atomically enough that a failure leaves the
 * previous copy where it was: the old directory is moved aside first and only
 * removed once the new one is in.
 *
 * `retain` keeps that displaced copy and hands back its path. A plugin with code is
 * only really installed once a version carrying it builds (ADR-0009), and until then
 * the copy it replaced is the only way back - `restoreDisplaced` is that way.
 */
export function swapIntoStore(
  staged: string,
  store: string,
  { retain = false }: { readonly retain?: boolean } = {},
): string | null {
  mkdirSync(dirname(store), { recursive: true });
  // Имя временной папки начинается с точки, а имя плагина по спеке начинается с
  // буквы или цифры: пересечься они не могут, поэтому уборка недоделок никогда не
  // унесёт установленный плагин (`helper.replaced-x` — законное имя плагина).
  const displaced = existsSync(store)
    ? join(dirname(store), `.replaced-${randomUUID().slice(0, 8)}`)
    : null;
  if (displaced) renameSync(store, displaced);
  try {
    renameSync(staged, store);
  } catch (error) {
    if (displaced) renameSync(displaced, store);
    throw error;
  }
  if (!displaced) return null;
  if (retain) return displaced;
  rmSync(displaced, { recursive: true, force: true });
  return null;
}

/** Put a displaced copy back, dropping the one that took its place. */
export function restoreDisplaced(displaced: string, store: string): void {
  rmSync(store, { recursive: true, force: true });
  renameSync(displaced, store);
}
