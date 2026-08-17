/**
 * Where a plugin comes from, as one string the owner can type.
 *
 * Four written forms, one parsed value, and an inverse: `formatPluginSource`
 * gives back the string the owner typed. That inverse is not decoration - the
 * source string is what `plugins.json` records and what `iva plugin sync`
 * replays, so a form that cannot be written back is a form that cannot be
 * restored.
 *
 * Pure: no filesystem, no network, no `~` expansion (the caller owns the home
 * directory it belongs to). A plugin name from a Marketplace is still not a form
 * here: the name is resolved into one of these forms before the parser sees it
 * (`scripts/lib/marketplace.ts`), so what `plugins.json` records and what
 * `sync` replays stays a source string with a repository behind it.
 */

export type PluginSource =
  | { readonly kind: "local"; readonly path: string }
  | {
      readonly kind: "git";
      /** What git is asked to fetch. */
      readonly url: string;
      /** `owner/repo` when written in shorthand - kept so the string round-trips. */
      readonly shorthand: string | null;
      /**
       * Subdirectory inside the repository holding the plugin root. Written as a
       * plain path segment after the shorthand (`owner/repo/sub`) and after a
       * go-getter `//` on a URL (`https://host/repo.git//sub`) - a URL has no
       * shorthand boundary, so without the separator there is nothing telling the
       * repository apart from the path inside it.
       */
      readonly subdir: string | null;
      /** Branch, tag or sha being tracked; null means the remote's HEAD. */
      readonly ref: string | null;
    };

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//iu;
const SCP_LIKE = /^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*:/u;
// A path segment of a shorthand source. It starts alphanumeric on purpose, which
// rules out two things at once: `.`/`..`, which would name a directory outside the
// fetched checkout (and the installer would then move THAT into the plugins folder),
// and a leading `-`, which arrives at git as an option rather than a path.
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
// A ref is one or more path segments: `main`, `v1.2`, `feature/x`, `refs/tags/v1`,
// a sha. Slashes are what makes the `@` split delicate - see splitRef. The first
// character is alphanumeric so a ref can never arrive at git looking like an option.
const REF = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9._-]+)*$/u;

/**
 * Is this the `git@host:path` form? Asked by callers that accept only some written
 * forms - the marketplace allowlist, for one. The grammar has one owner, so the
 * pattern is not copied out of here.
 */
export function isScpLikeUrl(value: string): boolean {
  return SCP_LIKE.test(value.trim());
}

function isLocal(raw: string): boolean {
  return (
    raw === "." ||
    raw === ".." ||
    raw === "~" ||
    raw.startsWith("./") ||
    raw.startsWith("../") ||
    raw.startsWith("/") ||
    raw.startsWith("~/")
  );
}

/**
 * Split a trailing `@ref`, searching only from where a ref can legally start.
 *
 * The `@` that opens a ref is the FIRST one past that point, not the last: refs
 * carry slashes (`feature/x`) and a "last @ wins" rule would cut inside one. The
 * two `@` that are not refs - `git@host:` and `https://user@host/` - stay behind
 * `searchFrom`, which is why the caller decides the form before the ref.
 */
function splitRef(
  raw: string,
  searchFrom: number,
): { readonly base: string; readonly ref: string | null } {
  const at = raw.indexOf("@", searchFrom);
  if (at === -1) return { base: raw, ref: null };
  const ref = raw.slice(at + 1);
  if (!ref || !REF.test(ref))
    throw new Error(
      `plugin source has an unusable ref: ${JSON.stringify(ref)}`,
    );
  return { base: raw.slice(0, at), ref };
}

/**
 * Split a trailing `//subdir` off a URL, searching from where its path starts.
 *
 * The FIRST `//` past that point wins, and the segments that follow obey the same
 * rule as everywhere else, so `//..`, `//` alone and a leading dash never become a
 * subdirectory. Searching from the path start is what keeps the `//` of the scheme
 * itself out of the way.
 */
function splitSubdir(
  base: string,
  searchFrom: number,
): { readonly url: string; readonly subdir: string | null } {
  const at = base.indexOf("//", searchFrom);
  if (at === -1) return { url: base, subdir: null };
  const subdir = base.slice(at + 2);
  if (!subdir || !subdir.split("/").every((part) => SEGMENT.test(part)))
    throw new Error(
      `plugin source has an unusable subdirectory: ${JSON.stringify(subdir)}`,
    );
  return { url: base.slice(0, at), subdir };
}

/** Parse one source string. Anything unrecognized is an Error, never a guess. */
export function parsePluginSource(raw: string): PluginSource {
  const value = raw.trim();
  if (!value) throw new Error("plugin source is empty");
  if (isLocal(value)) return { kind: "local", path: value };

  const scheme = SCHEME.exec(value);
  if (scheme) {
    // Past the authority: a path slash, or nothing at all when the URL has no path.
    const pathStart = value.indexOf("/", scheme[0].length);
    const searchFrom = pathStart === -1 ? value.length : pathStart;
    const { base, ref } = splitRef(value, searchFrom);
    const { url, subdir } = splitSubdir(base, searchFrom);
    return { kind: "git", url, shorthand: null, subdir, ref };
  }
  const scp = SCP_LIKE.exec(value);
  if (scp) {
    const { base, ref } = splitRef(value, scp[0].length);
    const { url, subdir } = splitSubdir(base, scp[0].length);
    return { kind: "git", url, shorthand: null, subdir, ref };
  }

  const { base, ref } = splitRef(value, 0);
  const parts = base.split("/");
  if (parts.length < 2 || !parts.every((part) => SEGMENT.test(part)))
    throw new Error(
      `unknown plugin source ${JSON.stringify(raw)} - use ./path, owner/repo[/subdir], https://… or git@…`,
    );
  const [owner, repo, ...rest] = parts;
  return {
    kind: "git",
    url: `https://github.com/${owner}/${repo}.git`,
    shorthand: `${owner}/${repo}`,
    subdir: rest.length ? rest.join("/") : null,
    ref,
  };
}

/** The inverse: the string the owner typed. */
export function formatPluginSource(source: PluginSource): string {
  if (source.kind === "local") return source.path;
  const base = source.shorthand ?? source.url;
  const separator = source.shorthand ? "/" : "//";
  const subdir = source.subdir ? `${separator}${source.subdir}` : "";
  const ref = source.ref ? `@${source.ref}` : "";
  return `${base}${subdir}${ref}`;
}
