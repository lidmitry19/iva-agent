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
 * directory it belongs to). A marketplace name is not a form here - it becomes
 * one when the marketplace itself arrives.
 */

export type PluginSource =
  | { readonly kind: "local"; readonly path: string }
  | {
      readonly kind: "git";
      /** What git is asked to fetch. */
      readonly url: string;
      /** `owner/repo` when written in shorthand - kept so the string round-trips. */
      readonly shorthand: string | null;
      /** Subdirectory inside the repository holding the plugin root. */
      readonly subdir: string | null;
      /** Branch, tag or sha being tracked; null means the remote's HEAD. */
      readonly ref: string | null;
    };

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//iu;
const SCP_LIKE = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:/u;
// A path segment of a shorthand source. `.` and `..` are excluded on purpose: a
// subdirectory that climbs would name a directory outside the fetched checkout, and
// the installer would then move THAT into the store.
const SEGMENT = /^[A-Za-z0-9._-]+$/u;
const DOTS = /^\.{1,2}$/u;
// A ref is one or more path segments: `main`, `v1.2`, `feature/x`, `refs/tags/v1`,
// a sha. Slashes are what makes the `@` split delicate - see splitRef. The first
// character is alphanumeric so a ref can never arrive at git looking like an option.
const REF = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9._-]+)*$/u;

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

/** Parse one source string. Anything unrecognized is an Error, never a guess. */
export function parsePluginSource(raw: string): PluginSource {
  const value = raw.trim();
  if (!value) throw new Error("plugin source is empty");
  if (isLocal(value)) return { kind: "local", path: value };

  const scheme = SCHEME.exec(value);
  if (scheme) {
    // Past the authority: a path slash, or nothing at all when the URL has no path.
    const pathStart = value.indexOf("/", scheme[0].length);
    const { base, ref } = splitRef(
      value,
      pathStart === -1 ? value.length : pathStart,
    );
    return { kind: "git", url: base, shorthand: null, subdir: null, ref };
  }
  const scp = SCP_LIKE.exec(value);
  if (scp) {
    const { base, ref } = splitRef(value, scp[0].length);
    return { kind: "git", url: base, shorthand: null, subdir: null, ref };
  }

  const { base, ref } = splitRef(value, 0);
  const parts = base.split("/");
  if (
    parts.length < 2 ||
    !parts.every((part) => SEGMENT.test(part) && !DOTS.test(part))
  )
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
  const subdir = source.subdir ? `/${source.subdir}` : "";
  const ref = source.ref ? `@${source.ref}` : "";
  return `${base}${subdir}${ref}`;
}
