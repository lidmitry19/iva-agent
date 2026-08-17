// `iva plugin` — the owner's only way to install, remove and inspect plugins.
//
// Only the owner, only the terminal (ADR-0009): a plugin is code in the agent's
// process with the installation's tokens, so an injected message must never be
// able to install one. There is no model tool and no Telegram command by design.
//
// A plugin that only ships skills needs no build and no restart: the live resolver
// (agent/lib/custom-skills.ts) re-reads the store on every turn. Building code and
// starting MCP servers arrive in later tickets; this command already reads and
// reports both so the owner sees what a plugin carries before it is installed.
//
// Everything that lives in the authored tree is loaded INSIDE the command, never at
// module load: `iva` has to start on an installation whose `agent/` is missing or
// half-written, because that is exactly when `iva doctor` and `iva repair` are run
// (ADR-0003, scripts/authored-tree-guard.test.ts).
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { PluginManifest, PluginReport } from "#lib/plugin-reader.ts";
import type { PluginEntry, PluginsState } from "#lib/plugin-store.ts";
import type { GitRunner } from "../lib/plugin-install.ts";
import {
  formatPluginSource,
  parsePluginSource,
  type PluginSource,
} from "../lib/plugin-source.ts";
import type { createCliRuntime } from "./runtime.ts";

type CliRuntime = ReturnType<typeof createCliRuntime>;
type Translate = (en: string, ru: string) => string;

type PluginDependencies = {
  readonly now?: () => Date;
  readonly log?: (...args: unknown[]) => void;
  /** Where a relative local source is resolved from: the owner's shell, not ROOT. */
  readonly cwd?: () => string;
  readonly git?: GitRunner;
  readonly translate?: Translate;
};

/** Модули плагинов живут в authored tree, поэтому приходят по требованию. */
type PluginCore = {
  readonly reader: typeof import("#lib/plugin-reader.ts");
  readonly store: typeof import("#lib/plugin-store.ts");
  readonly install: typeof import("../lib/plugin-install.ts");
};

type Staged = {
  readonly root: string;
  readonly sha: string;
  readonly ref: string;
};

/** Пришло из ADR-0008 «Принятый риск»: показывается один раз, перед первой установкой. */
const RISK_EN =
  "A plugin runs with the agent's environment: bash inside its skill sees every key of this installation " +
  "(Telegram, the model provider, everything else). Installing someone else's plugin means handing it those keys. " +
  "The manifest does not help: plugin.json describes what is inside, not what it does. Install what you trust.";
const RISK_RU =
  "Плагин работает в окружении агента: bash внутри его скилла видит все ключи этой инсталляции " +
  "(Telegram, провайдер модели, всё остальное). Поставить чужой плагин — отдать ему эти ключи. " +
  "Манифест от этого не спасает: plugin.json описывает состав, а не поведение. Ставь то, чему доверяешь.";

export function createPluginCommands(
  runtime: CliRuntime,
  dependencies: PluginDependencies = {},
) {
  const { C, ok, warn, bad, step, cap, dataDirAbs } = runtime;
  const now = dependencies.now ?? (() => new Date());
  const cwd = dependencies.cwd ?? (() => process.cwd());
  const log =
    dependencies.log ?? ((...args: unknown[]) => console.log(...args));
  const git: GitRunner =
    dependencies.git ??
    ((args, dir) => cap("git", args, dir ? { cwd: dir } : {}));

  // Английский, пока язык не спрошен: таблица переводов тоже живёт в authored tree,
  // а помощь команда обязана печатать и без него.
  let translate: Translate = dependencies.translate ?? ((en) => en);

  async function resolveTranslate(): Promise<void> {
    if (dependencies.translate) return;
    try {
      translate = (await import("#lib/i18n.ts")).tr;
    } catch {
      // agent/ ещё не собран — остаёмся на английском, это не повод падать.
    }
  }

  async function loadCore(): Promise<PluginCore> {
    return {
      reader: await import("#lib/plugin-reader.ts"),
      store: await import("#lib/plugin-store.ts"),
      install: await import("../lib/plugin-install.ts"),
    };
  }

  function help(): void {
    log(`
${C.b}iva plugin${C.x} — ${translate("install and manage plugins", "установка плагинов и уход за ними")}

  ${C.c}iva plugin add${C.x} <source>   ${translate("install from a folder, owner/repo[/subdir][@ref], https:// or git@", "поставить из папки, owner/repo[/подпапка][@ref], https:// или git@")}
  ${C.c}iva plugin list${C.x}           ${translate("what is installed: sha, toggles, components", "что стоит: sha, тумблеры, компоненты")}
  ${C.c}iva plugin update${C.x} [name]  ${translate("pull the tracked ref, printing old → new", "подтянуть отслеживаемый ref, печатая old → new")}
  ${C.c}iva plugin enable${C.x} <name>  ${translate("turn the plugin back on", "включить плагин обратно")}
  ${C.c}iva plugin disable${C.x} <name> ${translate("turn the plugin off without removing it", "выключить плагин, не удаляя")}
  ${C.c}iva plugin remove${C.x} <name>  ${translate("remove the plugin; its data is kept", "удалить плагин; данные плагина остаются")}
  ${C.c}iva plugin sync${C.x}           ${translate("restore every plugin listed in plugins.json", "восстановить все плагины из plugins.json")}

  ${C.d}${translate("Skills of an installed plugin work from the next turn: no build, no restart.", "Скиллы поставленного плагина работают со следующего хода: без сборки и рестарта.")}${C.x}
`);
  }

  async function run(
    core: PluginCore,
    sub: string,
    args: readonly string[],
  ): Promise<void> {
    const { readPlugin } = core.reader;
    const {
      findPlugin,
      pluginDataDir,
      pluginRoot,
      pluginsDir,
      readPluginsState,
      removePlugin,
      upsertPlugin,
      writePluginsState,
    } = core.store;
    const {
      copyPluginTree,
      fetchGitPlugin,
      localChanges,
      resolveRemoteSha,
      swapIntoStore,
    } = core.install;

    /** Что плагин несёт — одной строкой, до установки и в `list`. */
    function components(report: PluginReport): string {
      const parts: string[] = [];
      if (report.skills.length)
        parts.push(
          `skills: ${report.skills.map((skill) => skill.name).join(", ")}`,
        );
      if (report.code) parts.push("code: sh.iva");
      const servers = Object.keys(report.mcp);
      if (servers.length) parts.push(`mcp: ${servers.join(", ")}`);
      return parts.length
        ? parts.join("; ")
        : translate("no components", "компонент нет");
    }

    function expandHome(path: string): string {
      if (path === "~") return homedir();
      return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
    }

    /**
     * Локальный источник записывается абсолютным путём: `plugins.json` читает потом
     * `iva plugin sync`, а он запускается из другого каталога, и `./my-plugin` там
     * означал бы совсем другую папку.
     */
    function absolute(source: PluginSource): PluginSource {
      return source.kind === "local"
        ? { kind: "local", path: resolve(cwd(), expandHome(source.path)) }
        : source;
    }

    /** Плагин во временной папке: git-источник — fetch, локальный — копия. */
    async function stage(
      source: PluginSource,
      staging: string,
    ): Promise<Staged> {
      if (source.kind === "local") {
        await copyPluginTree(source.path, staging);
        return { root: staging, sha: "", ref: "" };
      }
      const { sha, ref } = resolveRemoteSha(git, source.url, source.ref);
      return {
        root: fetchGitPlugin(git, staging, source.url, sha, source.subdir),
        sha,
        ref,
      };
    }

    /** Читает плагин или отказывает, назвав все причины. */
    async function accept(
      root: string,
      label: string,
    ): Promise<{
      readonly report: PluginReport;
      readonly manifest: PluginManifest;
    }> {
      const report = await readPlugin(root);
      if (!report.manifest) {
        for (const line of report.diagnostics) bad(line);
        throw new Error(`${label} is not a usable Agent Plugins folder`);
      }
      for (const line of report.diagnostics) warn(line);
      return { report, manifest: report.manifest };
    }

    /**
     * Одноимённый скилл у двух плагинов — отказ на add: две папки претендуют на одно
     * имя в промпте, и молча выбрать одну значило бы отключить другую втихую.
     */
    async function skillOwners(
      data: string,
      state: PluginsState,
      except: string,
    ): Promise<Map<string, string>> {
      const owners = new Map<string, string>();
      for (const entry of state.plugins) {
        if (entry.name === except) continue;
        const report = await readPlugin(pluginRoot(data, entry.name));
        for (const skill of report.skills)
          if (!owners.has(skill.name)) owners.set(skill.name, entry.name);
      }
      return owners;
    }

    async function install(
      data: string,
      state: PluginsState,
      raw: PluginSource,
      previous: PluginEntry | null,
    ): Promise<{ readonly entry: PluginEntry; readonly report: PluginReport }> {
      const source = absolute(raw);
      mkdirSync(pluginsDir(data), { recursive: true });
      // Staging живёт внутри стора: переезд в стор обязан быть переименованием, а
      // переименование работает только в пределах одной файловой системы.
      const staging = mkdtempSync(join(pluginsDir(data), ".staging-"));
      try {
        const staged = await stage(source, staging);
        const { report, manifest } = await accept(
          staged.root,
          formatPluginSource(source),
        );
        const name = manifest.name;
        if (previous && previous.name !== name)
          throw new Error(
            `${formatPluginSource(source)} now calls itself ${JSON.stringify(name)}, not ${JSON.stringify(previous.name)} — remove the old one first`,
          );
        if (
          !previous &&
          (findPlugin(state, name) || existsSync(pluginRoot(data, name)))
        )
          throw new Error(
            `${name} is already installed — use: iva plugin update ${name}`,
          );

        const owners = await skillOwners(data, state, name);
        for (const skill of report.skills) {
          const owner = owners.get(skill.name);
          if (owner)
            throw new Error(
              `skill ${JSON.stringify(skill.name)} is already provided by the plugin ${owner} — remove one of them first`,
            );
        }

        swapIntoStore(staged.root, pluginRoot(data, name));
        // PLUGIN_DATA переживает и обновление, и удаление плагина (спека §9.1).
        await mkdir(pluginDataDir(data, name), { recursive: true });
        return {
          entry: {
            name,
            source: formatPluginSource(source),
            ref: staged.ref,
            sha: staged.sha,
            enabled: previous?.enabled ?? true,
            trusted: previous?.trusted ?? false,
            installedAt: now().toISOString(),
          },
          report,
        };
      } finally {
        rmSync(staging, { recursive: true, force: true });
      }
    }

    async function add(): Promise<void> {
      const raw = args[0];
      if (!raw)
        throw new Error(
          "iva plugin add <source> — a folder, owner/repo[/subdir][@ref], https://… or git@…",
        );
      const source = parsePluginSource(raw);
      const data = dataDirAbs();
      const state = await readPluginsState(data);

      if (!state.riskNoticeShownAt) {
        warn(translate(RISK_EN, RISK_RU));
        log();
      }
      step(`Installing ${formatPluginSource(source)}`);

      const { entry, report } = await install(data, state, source, null);
      await writePluginsState(data, {
        ...upsertPlugin(state, entry),
        riskNoticeShownAt: state.riskNoticeShownAt ?? now().toISOString(),
      });

      ok(
        `${entry.name}${report.manifest?.version ? ` ${report.manifest.version}` : ""} installed — ${components(report)}`,
      );
      if (report.skills.length)
        ok(
          translate(
            "skills work from the next turn: no build, no restart",
            "скиллы работают со следующего хода: без сборки и рестарта",
          ),
        );
      if (report.code || Object.keys(report.mcp).length)
        warn(
          translate(
            "code and MCP servers are read and reported, but not built or started yet",
            "код и MCP-серверы прочитаны и показаны, но пока не собираются и не запускаются",
          ),
        );
    }

    async function list(): Promise<void> {
      const data = dataDirAbs();
      const state = await readPluginsState(data);
      if (state.plugins.length === 0) {
        log(
          translate(
            "No plugins installed. Add one: iva plugin add <source>",
            "Плагинов нет. Поставить: iva plugin add <источник>",
          ),
        );
        return;
      }
      for (const entry of state.plugins) {
        const root = pluginRoot(data, entry.name);
        const flags = [
          entry.enabled ? "enabled" : "disabled",
          entry.trusted ? "trusted" : "untrusted",
        ].join(" · ");
        if (!existsSync(root)) {
          bad(
            `${entry.name}  ${flags}  ${translate("missing from the store — run: iva plugin sync", "нет в сторе — запусти: iva plugin sync")}`,
          );
          continue;
        }
        const report = await readPlugin(root);
        const sha = entry.sha ? entry.sha.slice(0, 12) : "local";
        const version = report.manifest?.version ?? "-";
        log(
          `${C.b}${entry.name}${C.x}  ${version}  ${sha}  ${flags}  ${components(report)}`,
        );
        log(
          `  ${C.d}${entry.source}${entry.ref ? ` @${entry.ref}` : ""}${C.x}`,
        );
        for (const line of report.diagnostics) warn(`  ${line}`);
      }
    }

    function mustFind(
      state: PluginsState,
      name: string | undefined,
    ): PluginEntry {
      if (!name) throw new Error("which plugin? — iva plugin list");
      const entry = findPlugin(state, name);
      if (!entry) throw new Error(`${name} is not installed — iva plugin list`);
      return entry;
    }

    async function toggle(enabled: boolean): Promise<void> {
      const data = dataDirAbs();
      const state = await readPluginsState(data);
      const entry = mustFind(state, args[0]);
      if (entry.enabled === enabled) {
        ok(`${entry.name} is already ${enabled ? "enabled" : "disabled"}`);
        return;
      }
      await writePluginsState(data, upsertPlugin(state, { ...entry, enabled }));
      ok(
        enabled
          ? translate(
              `${entry.name} enabled — its skills return on the next turn`,
              `${entry.name} включён — скиллы вернутся со следующего хода`,
            )
          : translate(
              `${entry.name} disabled — its skills are gone from the next turn`,
              `${entry.name} выключен — скиллов не будет со следующего хода`,
            ),
      );
    }

    async function remove(): Promise<void> {
      const data = dataDirAbs();
      const state = await readPluginsState(data);
      const entry = mustFind(state, args[0]);
      rmSync(pluginRoot(data, entry.name), { recursive: true, force: true });
      await writePluginsState(data, removePlugin(state, entry.name));
      ok(
        translate(
          `${entry.name} removed — its data stays in ${pluginDataDir(data, entry.name)}`,
          `${entry.name} удалён — данные плагина остались в ${pluginDataDir(data, entry.name)}`,
        ),
      );
    }

    async function updateOne(
      data: string,
      state: PluginsState,
      entry: PluginEntry,
    ): Promise<PluginsState> {
      const source = parsePluginSource(entry.source);
      const root = pluginRoot(data, entry.name);
      const changes = existsSync(root) ? localChanges(git, root) : null;
      if (changes) {
        warn(
          translate(
            `${entry.name} has local changes in ${root} — not touching it`,
            `${entry.name} правили на месте (${root}) — не трогаю`,
          ),
        );
        return state;
      }
      if (source.kind === "git") {
        const { sha } = resolveRemoteSha(git, source.url, source.ref);
        if (sha === entry.sha && existsSync(root)) {
          ok(`${entry.name} is already at ${sha.slice(0, 12)}`);
          return state;
        }
      }
      const { entry: installed, report } = await install(
        data,
        state,
        source,
        entry,
      );
      ok(
        entry.sha && installed.sha
          ? `${entry.name}: ${entry.sha.slice(0, 12)} → ${installed.sha.slice(0, 12)} — ${components(report)}`
          : `${entry.name} reinstalled from ${installed.source} — ${components(report)}`,
      );
      return upsertPlugin(state, installed);
    }

    async function update(): Promise<void> {
      const data = dataDirAbs();
      const state = await readPluginsState(data);
      const targets = args[0] ? [mustFind(state, args[0])] : [...state.plugins];
      if (targets.length === 0) {
        ok("no plugins to update");
        return;
      }
      let next = state;
      const failed: string[] = [];
      for (const entry of targets) {
        try {
          next = await updateOne(data, next, entry);
        } catch (error) {
          failed.push(entry.name);
          bad(`${entry.name}: ${(error as Error).message}`);
        }
      }
      await writePluginsState(data, next);
      if (failed.length)
        throw new Error(`could not update: ${failed.join(", ")}`);
    }

    async function sync(): Promise<void> {
      const data = dataDirAbs();
      const state = await readPluginsState(data);
      const missing = state.plugins.filter(
        (entry) => !existsSync(pluginRoot(data, entry.name)),
      );
      if (missing.length === 0) {
        ok(
          translate(
            `every plugin in plugins.json is in the store (${state.plugins.length})`,
            `все плагины из plugins.json на месте (${state.plugins.length})`,
          ),
        );
        return;
      }
      let next = state;
      const failed: string[] = [];
      for (const entry of missing) {
        step(`Restoring ${entry.name} from ${entry.source}`);
        try {
          // Восстанавливаем ИМЕННО запиненный sha: sync возвращает то, что стояло,
          // а не то, что успело выйти с тех пор (это работа `iva plugin update`).
          const source = parsePluginSource(entry.source);
          const pinned: PluginSource =
            source.kind === "git" && entry.sha
              ? { ...source, ref: entry.sha }
              : source;
          const { entry: installed, report } = await install(
            data,
            next,
            pinned,
            entry,
          );
          next = upsertPlugin(next, {
            ...installed,
            source: entry.source,
            ref: entry.ref,
          });
          ok(`${entry.name} restored — ${components(report)}`);
        } catch (error) {
          failed.push(entry.name);
          bad(`${entry.name}: ${(error as Error).message}`);
        }
      }
      await writePluginsState(data, next);
      if (failed.length)
        throw new Error(`could not restore: ${failed.join(", ")}`);
    }

    switch (sub) {
      case "add":
        return add();
      case "list":
        return list();
      case "remove":
        return remove();
      case "enable":
        return toggle(true);
      case "disable":
        return toggle(false);
      case "update":
        return update();
      case "sync":
        return sync();
      default:
        throw new Error(
          `unknown: iva plugin ${sub} — add, list, update, enable, disable, remove, sync`,
        );
    }
  }

  async function cmdPlugin(args: readonly string[]): Promise<void> {
    const [sub, ...rest] = args;
    await resolveTranslate();
    if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h")
      return help();
    return run(await loadCore(), sub, rest);
  }

  return { cmdPlugin };
}
