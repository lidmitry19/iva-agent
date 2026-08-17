/**
 * The code of a plugin inside the build of a version (ADR-0009).
 *
 * A plugin's code is an eve Extension under `sh.iva/`, and the only place it is ever
 * built is a version build: copy the plugin into the version, install its production
 * dependencies, build the extension with the version's own eve, and generate the mount
 * that makes eve pick it up. Nothing here starts, flips or restarts anything - the rails
 * are the updater's (scripts/lib/version-update.ts), so a plugin arrives the same way a
 * release does: build, probe, flip, restart.
 *
 * The plugin store lives in the authored tree, which `iva` and the updater's second half
 * must load without (ADR-0003, scripts/authored-tree-guard.test.ts). Everything from
 * `agent/` is therefore reached through `tryLoadPluginCore()`, and a missing tree is a
 * diagnostic, not a crash: a version that cannot read its plugins still builds.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tryLoadPluginCore } from "./plugin-core.ts";
import type { Runner } from "./version-update.ts";

type Say = (message: string) => void;

/** Folder eve reads mounts from; the file name in it is the namespace. */
export const MOUNT_DIR = "agent/extensions";
/** Where a version keeps the copies it builds plugin code from. */
export const PLUGIN_DIR = "plugins";
/** The namespace folder of a plugin's code, as ADR-0009 pins it. */
export const CODE_DIR = "sh.iva";
/** The version's own eve: a plugin is always built by the eve that will run it. */
const EVE_BIN = "node_modules/.bin/eve";
const EVE_BUILD = ["extension", "build"];
const PLUGIN_INSTALL = ["--omit=dev", "--no-audit", "--no-fund"];
const LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json"];
/** What eve accepts as a mount file name (its EXTENSION_SLUG_PATTERN, lowercased). */
const MOUNT_SLUG = /^[a-z][a-z0-9_]{0,63}$/u;
/** Enough of a failed step to explain it, little enough to fit a chat message. */
const OUTPUT_TAIL = 4000;

export type CodePlugin = {
  readonly name: string;
  /** The plugin in the Custom layer: `data/custom/plugins/<name>`. */
  readonly root: string;
  /** Mount file name, and therefore the prefix of every tool the plugin contributes. */
  readonly namespace: string;
  /** The mount inside a version: `agent/extensions/<ns>.ts`. */
  readonly mount: string;
  /** The copy inside a version: `plugins/<name>`. */
  readonly directory: string;
  /** Digest of the folder as it lies now - what the version is built from. */
  readonly digest: string;
  /** `<name>.config.json` as written, or "" - part of what names the version. */
  readonly config: string;
};

export type CodePlugins = {
  readonly plugins: readonly CodePlugin[];
  /** Everything skipped, by name: a plugin left out silently is a lost capability. */
  readonly diagnostics: readonly string[];
};

/** One plugin the build refused, with the output that says why. */
export type PluginFailure = {
  readonly name: string;
  /** Which content failed: a changed plugin is a new problem and speaks at once. */
  readonly digest: string;
  readonly reason: string;
};

/** The mount namespace of a plugin: its name with `.` and `-` folded to `_`. */
export function pluginNamespace(name: string): string {
  return name.replace(/[.-]/gu, "_");
}

/** The mount of a plugin inside a version, relative to its root. */
export function pluginMount(name: string): string {
  return `${MOUNT_DIR}/${pluginNamespace(name)}.ts`;
}

/** The copy of a plugin inside a version, relative to its root. */
export function pluginDirectory(name: string): string {
  return `${PLUGIN_DIR}/${name}`;
}

/**
 * Why this plugin cannot carry code, or null. The mount file name is the namespace,
 * and eve accepts a letter first and then letters, digits and underscores - a plugin
 * name is allowed to start with a digit, so this is a real refusal, not a formality.
 */
export function namespaceProblem(name: string): string | null {
  const namespace = pluginNamespace(name);
  return MOUNT_SLUG.test(namespace)
    ? null
    : `${name} cannot carry code: its extension mount would be named ${JSON.stringify(namespace)}, and eve accepts a letter followed by letters, digits or underscores, up to 64 characters`;
}

/**
 * Who else folds onto the namespace of `name`, or null. `a.b` and `a-b` are two
 * plugins and one mount file, so they may not be installed together: silently keeping
 * one of them would switch the other off without saying so. Asked at install time, so
 * the answer belongs to the command that caused it rather than to a later build.
 */
export function namespaceTaken(
  name: string,
  installed: readonly string[],
): string | null {
  const namespace = pluginNamespace(name);
  return (
    installed.find(
      (other) => other !== name && pluginNamespace(other) === namespace,
    ) ?? null
  );
}

/**
 * The enabled plugins that carry code, with what a version is named after. Read from
 * the store, never from the digest recorded at install time: a folder edited in place
 * is a different version, and the owner who edited it expects the next build to carry
 * the edit.
 */
export async function codePlugins(dataDir: string): Promise<CodePlugins> {
  const loaded = await tryLoadPluginCore();
  if (!loaded)
    return {
      plugins: [],
      diagnostics: [
        "plugin code is left out of this build: the agent tree is missing",
      ],
    };
  const { readPlugin, pluginTreeDigest } = loaded.reader;
  const { enabledPlugins, pluginConfigFile, pluginRoot, readPluginsStateSafe } =
    loaded.store;
  const diagnostics: string[] = [];
  const { state, damaged } = await readPluginsStateSafe(dataDir);
  if (damaged)
    diagnostics.push(
      `plugin code is left out of this build: ${damaged.message}`,
    );
  const plugins: CodePlugin[] = [];
  for (const entry of enabledPlugins(state)) {
    const root = pluginRoot(dataDir, entry.name);
    const report = await readPlugin(root);
    if (!report.manifest) {
      diagnostics.push(
        `plugin ${entry.name} is left out of this build: ${report.diagnostics.at(-1) ?? "the folder is not a usable plugin"}`,
      );
      continue;
    }
    if (!report.code) continue;
    const problem = namespaceProblem(entry.name);
    if (problem) {
      diagnostics.push(problem);
      continue;
    }
    let digest: string;
    try {
      digest = await pluginTreeDigest(root);
    } catch (error) {
      diagnostics.push(
        `plugin ${entry.name} is left out of this build: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    let config = "";
    try {
      config = await readFile(pluginConfigFile(dataDir, entry.name), "utf8");
    } catch {
      // No config file is the normal case; an unreadable one is an empty config,
      // exactly as the runtime reader treats it (agent/lib/plugin-config.ts).
    }
    plugins.push({
      name: entry.name,
      root,
      namespace: pluginNamespace(entry.name),
      mount: pluginMount(entry.name),
      directory: pluginDirectory(entry.name),
      digest,
      config,
    });
  }
  // Two names on one mount file: neither is built, and both are named. `add` refuses
  // such a pair (`namespaceTaken`); this is the second lock, for a pair that reached
  // the store another way - a restored `plugins.json`, a folder put there by hand.
  const names = plugins.map((plugin) => plugin.name);
  const kept = plugins.filter((plugin) => {
    const other = namespaceTaken(plugin.name, names);
    if (other === null) return true;
    diagnostics.push(
      `plugins ${plugin.name} and ${other} want the same extension mount ${plugin.namespace}.ts; neither is built - remove one: iva plugin remove <name>`,
    );
    return false;
  });
  return { plugins: kept, diagnostics };
}

/**
 * The generated mount: what makes eve load the plugin's extension. eve reads it
 * statically for the package specifier and evaluates it at start, so the shape is its
 * (`export default <name>(...)` with a matching import), and the config is a call
 * rather than a value - the owner's settings are not the version's to bake in.
 *
 * The specifiers are held in variables so that this file contains no `import ... from
 * "..."` of its own to be mistaken for one: the walks that read the tree for its
 * imports would follow the text of a generated mount as if it were code here
 * (scripts/lib/version-update.test.ts, scripts/authored-tree-guard.test.ts).
 */
export function mountSource(plugin: CodePlugin): string {
  const code = `"../../${plugin.directory}/${CODE_DIR}"`;
  const reader = `"../lib/plugin-config.ts"`;
  return [
    `// Generated by Iva from data/custom/plugins/${plugin.name} - do not edit.`,
    `// Every version build writes this file again (ADR-0009). The config is read at`,
    `// load time from data/custom/plugins/${plugin.name}.config.json, never baked in.`,
    `import extension from ${code};`,
    `import { readPluginConfig } from ${reader};`,
    ``,
    `export default extension(readPluginConfig("${plugin.name}"));`,
    ``,
  ].join("\n");
}

/** Take a plugin out of a staged version: the copy, the mount, nothing else. */
export function removePluginFromVersion(
  versionDir: string,
  plugin: CodePlugin,
): void {
  rmSync(join(versionDir, plugin.mount), { force: true });
  rmSync(join(versionDir, plugin.directory), {
    recursive: true,
    force: true,
  });
}

/**
 * Put one plugin's code into a staged version: copy, install, build the extension,
 * write the mount. Returns the failing step's own output rather than throwing - the
 * caller decides whether one plugin may fail a build (`iva update`) or must not
 * (`iva plugin add`).
 */
export async function buildPluginExtension({
  versionDir,
  plugin,
  run,
  log = () => {},
}: {
  readonly versionDir: string;
  readonly plugin: CodePlugin;
  readonly run: Runner;
  readonly log?: Say;
}): Promise<{ ok: true } | { ok: false; output: string }> {
  const loaded = await tryLoadPluginCore();
  if (!loaded)
    return {
      ok: false,
      output: "the agent tree is missing, so the plugin cannot be copied",
    };
  const failed = (what: string, output: string) => ({
    ok: false as const,
    output: `${what}:\n${output.slice(-OUTPUT_TAIL)}`,
  });
  const target = join(versionDir, plugin.directory);
  removePluginFromVersion(versionDir, plugin);
  try {
    // The walk-copy of the installer: it rejects symlinks instead of following one
    // out of the store, and the executable bit of a plugin's scripts survives.
    await loaded.install.copyPluginTree(plugin.root, target);
  } catch (error) {
    return failed(
      `copying the plugin ${plugin.name} into the version`,
      error instanceof Error ? error.message : String(error),
    );
  }
  const code = join(target, CODE_DIR);
  const pinned = LOCKFILES.some((name) => existsSync(join(code, name)));
  if (!pinned)
    log(
      `plugin ${plugin.name} ships no package-lock.json; its dependencies are resolved fresh`,
    );
  const install = await run(
    "npm",
    [pinned ? "ci" : "install", ...PLUGIN_INSTALL],
    code,
  );
  if (install.code !== 0)
    return failed(
      `installing the dependencies of the plugin ${plugin.name}`,
      install.output,
    );
  const built = await run(join(versionDir, EVE_BIN), EVE_BUILD, code);
  if (built.code !== 0)
    return failed(`building the extension of ${plugin.name}`, built.output);
  const mount = join(versionDir, plugin.mount);
  mkdirSync(dirname(mount), { recursive: true });
  writeFileSync(mount, mountSource(plugin));
  log(`built the code of ${plugin.name} as ${plugin.namespace}`);
  return { ok: true };
}

/**
 * Switch a plugin off in `plugins.json`, because its code will not build. The skills
 * of a plugin go with its code: half a plugin in the prompt is worse than none, and
 * the owner is told by the Alert that comes with this (ADR-0007).
 */
export async function disableCodePlugin(
  dataDir: string,
  name: string,
): Promise<boolean> {
  const loaded = await tryLoadPluginCore();
  if (!loaded) return false;
  const { findPlugin, readPluginsStateSafe, upsertPlugin, writePluginsState } =
    loaded.store;
  const { state, damaged } = await readPluginsStateSafe(dataDir);
  if (damaged) return false;
  const entry = findPlugin(state, name);
  if (!entry || !entry.enabled) return false;
  await writePluginsState(
    dataDir,
    upsertPlugin(state, { ...entry, enabled: false }),
  );
  return true;
}
