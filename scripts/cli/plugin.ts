// `iva plugin` — the owner's only way to install, remove and inspect plugins.
//
// Only the owner, only the terminal (ADR-0009): a plugin is code in the agent's
// process with the installation's tokens, so an injected message must never be
// able to install one. There is no model tool and no Telegram command by design.
//
// A plugin that only ships skills needs no build and no restart: the live resolver
// (agent/lib/custom-skills.ts) re-reads `data/custom/plugins/` on every turn.
// Building code and starting MCP servers arrive in later tickets; this command
// already reads and reports both, so the owner sees what a plugin carries before
// it is installed.
//
// Everything that lives in the authored tree comes through `loadPluginCore()`,
// never a static import: `iva` has to start on an installation whose `agent/` is
// missing (ADR-0003, scripts/authored-tree-guard.test.ts).
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { PluginManifest, PluginReport } from "#lib/plugin-reader.ts";
import type { PluginEntry, PluginsState } from "#lib/plugin-store.ts";
import { loadPluginCore, type PluginCore } from "../lib/plugin-core.ts";
import {
  formatPluginSource,
  parsePluginSource,
  type PluginSource,
} from "../lib/plugin-source.ts";
import { acquireUpdateLock } from "../lib/version-store.ts";
import type { createCliRuntime } from "./runtime.ts";

type CliRuntime = ReturnType<typeof createCliRuntime>;
type Translate = (en: string, ru: string) => string;

type PluginDependencies = {
  readonly now?: () => Date;
  readonly log?: (...args: unknown[]) => void;
  /** Where a relative local source is resolved from: the owner's shell, not ROOT. */
  readonly cwd?: () => string;
  readonly translate?: Translate;
};

type Staged = {
  readonly root: string;
  readonly sha: string;
  readonly ref: string;
};

/** Префиксы наших временных папок; всё остальное в каталоге плагинов не наше. */
const STAGING_PREFIX = ".staging-";
const REPLACED_MARK = ".replaced-";

/** Пришло из ADR-0008 «Принятый риск»: показывается один раз, перед первой установкой. */
const RISK_EN =
  "A plugin runs with the agent's environment: bash inside its skill sees every key of this installation " +
  "(Telegram, the model provider, everything else). Installing someone else's plugin means handing it those keys. " +
  "The manifest does not help: plugin.json describes what is inside, not what it does. Install what you trust.";
const RISK_RU =
  "Плагин работает в окружении агента: bash внутри его скилла видит все ключи этой инсталляции " +
  "(Telegram, провайдер модели, всё остальное). Поставить чужой плагин — отдать ему эти ключи. " +
  "Манифест от этого не спасает: plugin.json описывает состав, а не поведение. Ставь то, чему доверяешь.";

/** Наши недоделанные папки: их оставляет только прерванная установка. */
export function leftoverPluginDirs(pluginsDirectory: string): string[] {
  if (!existsSync(pluginsDirectory)) return [];
  return readdirSync(pluginsDirectory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        (entry.name.startsWith(STAGING_PREFIX) ||
          entry.name.includes(REPLACED_MARK)),
    )
    .map((entry) => entry.name)
    .sort();
}

export function createPluginCommands(
  runtime: CliRuntime,
  dependencies: PluginDependencies = {},
) {
  const { C, ok, warn, bad, step, cap, dataDirAbs } = runtime;
  const now = dependencies.now ?? (() => new Date());
  const cwd = dependencies.cwd ?? (() => process.cwd());
  const log =
    dependencies.log ?? ((...args: unknown[]) => console.log(...args));
  const git = (args: readonly string[], dir?: string) =>
    cap("git", args, dir ? { cwd: dir } : {});

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

  function help(): void {
    log(`
${C.b}iva plugin${C.x} — ${translate("install and manage plugins", "установка плагинов и уход за ними")}

  ${C.c}iva plugin add${C.x} <source>   ${translate("install from a folder, owner/repo[/subdir][@ref], https:// or git@", "поставить из папки, owner/repo[/подпапка][@ref], https:// или git@")}
  ${C.c}iva plugin list${C.x}           ${translate("what is installed: sha, toggles, components", "что стоит: sha, тумблеры, компоненты")}
  ${C.c}iva plugin update${C.x} [name] [--force]  ${translate("pull the tracked ref, printing old → new", "подтянуть отслеживаемый ref, печатая old → new")}
  ${C.c}iva plugin enable${C.x} <name>  ${translate("turn the plugin back on", "включить плагин обратно")}
  ${C.c}iva plugin disable${C.x} <name> ${translate("turn the plugin off without removing it", "выключить плагин, не удаляя")}
  ${C.c}iva plugin remove${C.x} <name>  ${translate("remove the plugin; its data is kept", "удалить плагин; данные плагина остаются")}
  ${C.c}iva plugin sync${C.x}           ${translate("repair: rebuild plugins.json and reinstall what is missing", "починка: пересобрать plugins.json и доставить недостающее")}

  ${C.d}${translate("Skills of an installed plugin work from the next turn: no build, no restart.", "Скиллы поставленного плагина работают со следующего хода: без сборки и рестарта.")}${C.x}
`);
  }

  async function run(
    core: PluginCore,
    sub: string,
    argv: readonly string[],
  ): Promise<void> {
    const { pluginTreeDigest, readPlugin } = core.reader;
    const {
      findPlugin,
      pluginDataDir,
      pluginRoot,
      pluginsDir,
      pluginsStateFile,
      readPluginsState,
      readPluginsStateFile,
      readPluginsStateSafe,
      removePlugin,
      upsertPlugin,
      writePluginsState,
    } = core.store;
    const { copyPluginTree, fetchGitPlugin, resolveRemoteSha, swapIntoStore } =
      core.install;

    const force = argv.includes("--force");
    const args = argv.filter((value) => !value.startsWith("--"));

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
      // Staging живёт рядом с плагинами: переезд к ним обязан быть переименованием,
      // а переименование работает только в пределах одной файловой системы.
      const staging = mkdtempSync(join(pluginsDir(data), STAGING_PREFIX));
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
        if (!previous && findPlugin(state, name))
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

        // Владелец видит состав ДО того, как что-то встало на место.
        log(
          `  ${name}${manifest.version ? ` ${manifest.version}` : ""} — ${components(report)}`,
        );
        if (!previous && existsSync(pluginRoot(data, name)))
          warn(
            `a folder named ${name} was there without an entry in plugins.json — replacing it`,
          );

        swapIntoStore(staged.root, pluginRoot(data, name));
        // PLUGIN_DATA переживает и обновление, и удаление плагина (спека §9.1).
        await mkdir(pluginDataDir(data, name), { recursive: true });
        return {
          entry: {
            name,
            source: formatPluginSource(source),
            ref: staged.ref,
            sha: staged.sha,
            digest: await pluginTreeDigest(pluginRoot(data, name)),
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

    /** Недоделки прерванной установки; чистятся под локом, до работы. */
    function sweepLeftovers(data: string): number {
      const directory = pluginsDir(data);
      const leftovers = leftoverPluginDirs(directory);
      for (const name of leftovers)
        rmSync(join(directory, name), { recursive: true, force: true });
      return leftovers.length;
    }

    /**
     * Меняющие команды идут через тот же лок, что `iva update`: установка плагина
     * трогает те же каталоги, и вторая копия команды посреди первой оставила бы
     * ровно те недоделки, которые здесь же и подметаются.
     */
    async function locked<T>(data: string, body: () => Promise<T>): Promise<T> {
      const lock = acquireUpdateLock(data);
      if (!lock)
        throw new Error(
          "an update is running — try again when it finishes (iva status)",
        );
      try {
        const swept = sweepLeftovers(data);
        if (swept)
          warn(
            `cleaned ${swept} leftover folder(s) from an interrupted install`,
          );
        return await body();
      } finally {
        lock.release();
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

      // Установка и запись состояния — под одним локом: между ними вторая копия
      // команды успела бы записать своё, и одна из двух записей пропала бы.
      const { entry, report } = await locked(data, async () => {
        const installed = await install(data, state, source, null);
        await writePluginsState(data, {
          ...upsertPlugin(state, installed.entry),
          riskNoticeShownAt: state.riskNoticeShownAt ?? now().toISOString(),
        });
        return installed;
      });

      ok(`${entry.name} installed`);
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
      for (const name of leftoverPluginDirs(pluginsDir(data)))
        warn(
          `${name} is a leftover of an interrupted install — iva plugin sync`,
        );
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
            `${entry.name}  ${flags}  ${translate("missing — run: iva plugin sync", "папки нет — запусти: iva plugin sync")}`,
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
          `  ${C.d}${entry.source || translate("no source recorded", "источник не записан")}${entry.ref ? ` @${entry.ref}` : ""}${C.x}`,
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
      await locked(data, async () => {
        rmSync(pluginRoot(data, entry.name), { recursive: true, force: true });
        await writePluginsState(data, removePlugin(state, entry.name));
      });
      ok(
        translate(
          `${entry.name} removed — its data stays in ${pluginDataDir(data, entry.name)}`,
          `${entry.name} удалён — данные плагина остались в ${pluginDataDir(data, entry.name)}`,
        ),
      );
    }

    /**
     * Правил ли владелец папку руками. Отпечаток снимается одинаково с git-checkout,
     * подпапки и локальной копии — одно правило на три вида источника.
     */
    async function editedInPlace(
      root: string,
      entry: PluginEntry,
    ): Promise<string | null> {
      if (!entry.digest || !existsSync(root)) return null;
      try {
        const current = await pluginTreeDigest(root);
        return current === entry.digest
          ? null
          : "the folder was edited in place";
      } catch (error) {
        return `the folder is unreadable: ${(error as Error).message}`;
      }
    }

    async function updateOne(
      data: string,
      state: PluginsState,
      entry: PluginEntry,
    ): Promise<PluginsState> {
      if (!entry.source) {
        warn(
          `${entry.name} has no source recorded — reinstall it: iva plugin add <source>`,
        );
        return state;
      }
      const source = parsePluginSource(entry.source);
      const root = pluginRoot(data, entry.name);
      const changed = force ? null : await editedInPlace(root, entry);
      if (changed) {
        warn(
          translate(
            `${entry.name}: ${changed} (${root}) — not touching it; add --force to replace it`,
            `${entry.name}: ${changed} (${root}) — не трогаю; заменить принудительно: --force`,
          ),
        );
        return state;
      }
      if (source.kind === "git") {
        const { sha } = resolveRemoteSha(git, source.url, source.ref);
        if (sha === entry.sha && existsSync(root) && !force) {
          ok(`${entry.name} is already at ${sha.slice(0, 12)}`);
          return state;
        }
      }
      const { entry: installed } = await install(data, state, source, entry);
      ok(
        entry.sha && installed.sha
          ? `${entry.name}: ${entry.sha.slice(0, 12)} → ${installed.sha.slice(0, 12)}`
          : `${entry.name} reinstalled from ${installed.source}`,
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
      const failed: string[] = [];
      await locked(data, async () => {
        let next = state;
        for (const entry of targets) {
          try {
            next = await updateOne(data, next, entry);
          } catch (error) {
            failed.push(entry.name);
            bad(`${entry.name}: ${(error as Error).message}`);
          }
        }
        await writePluginsState(data, next);
      });
      if (failed.length)
        throw new Error(`could not update: ${failed.join(", ")}`);
    }

    /** Что удалось спасти из повреждённого plugins.json и его бэкапов. */
    async function salvageState(data: string): Promise<PluginsState> {
      const file = pluginsStateFile(data);
      const directory = join(file, "..");
      const backups = existsSync(directory)
        ? readdirSync(directory)
            .filter((name) => name.startsWith(`${basename(file)}.corrupt-`))
            .sort()
            .reverse()
        : [];
      for (const backup of backups) {
        const { state, damaged } = await readPluginsStateFile(
          join(directory, backup),
        );
        if (!damaged && state.plugins.length) {
          ok(`recovered ${state.plugins.length} entries from ${backup}`);
          return state;
        }
      }
      return { marketplaces: [], plugins: [] };
    }

    async function sync(): Promise<void> {
      const data = dataDirAbs();
      const read = await readPluginsStateSafe(data);
      await locked(data, async () => {
        let next = read.state;
        if (read.damaged) {
          warn(read.damaged.message);
          next = await salvageState(data);
        }

        // Папка на диске, записи нет — принимаем её обратно в plugins.json, иначе
        // `add` упрётся в существующую папку, а `update` скажет «не установлен».
        const directory = pluginsDir(data);
        const folders = existsSync(directory)
          ? readdirSync(directory, { withFileTypes: true })
              .filter(
                (entry) => entry.isDirectory() && !entry.name.startsWith("."),
              )
              .map((entry) => entry.name)
              .sort()
          : [];
        for (const name of folders) {
          if (findPlugin(next, name)) continue;
          const report = await readPlugin(join(directory, name));
          if (!report.manifest) {
            bad(
              `${name}: ${report.diagnostics.at(-1) ?? "not a usable plugin folder"}`,
            );
            continue;
          }
          if (report.manifest.name !== name) {
            bad(
              `${name}: the manifest calls this plugin ${JSON.stringify(report.manifest.name)} — rename the folder or reinstall it`,
            );
            continue;
          }
          next = upsertPlugin(next, {
            name,
            source: "",
            ref: "",
            sha: "",
            digest: await pluginTreeDigest(join(directory, name)),
            enabled: true,
            trusted: false,
            installedAt: now().toISOString(),
          });
          ok(`${name} taken back into plugins.json — ${components(report)}`);
        }

        // Запись есть, папки нет — доставляем ровно запиненный sha.
        const failed: string[] = [];
        for (const entry of next.plugins) {
          if (existsSync(pluginRoot(data, entry.name))) continue;
          if (!entry.source) {
            bad(
              `${entry.name}: no source recorded — reinstall it: iva plugin add <source>`,
            );
            failed.push(entry.name);
            continue;
          }
          step(`Restoring ${entry.name} from ${entry.source}`);
          try {
            const source = parsePluginSource(entry.source);
            const pinned: PluginSource =
              source.kind === "git" && entry.sha
                ? { ...source, ref: entry.sha }
                : source;
            const { entry: installed } = await install(
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
            ok(`${entry.name} restored`);
          } catch (error) {
            failed.push(entry.name);
            bad(`${entry.name}: ${(error as Error).message}`);
          }
        }

        await writePluginsState(data, next);
        if (!read.damaged && failed.length === 0)
          ok(
            translate(
              `plugins.json and data/custom/plugins/ agree (${next.plugins.length})`,
              `plugins.json и data/custom/plugins/ сходятся (${next.plugins.length})`,
            ),
          );
        if (failed.length)
          throw new Error(`could not restore: ${failed.join(", ")}`);
      });
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
    return run(await loadPluginCore(), sub, rest);
  }

  return { cmdPlugin };
}
