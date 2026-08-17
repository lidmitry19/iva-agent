// `iva plugin` — the owner's only way to install, remove and inspect plugins.
//
// Only the owner, only the terminal (ADR-0009): a plugin is code in the agent's
// process with the installation's tokens, so an injected message must never be
// able to install one. There is no model tool and no Telegram command by design.
//
// A plugin that only ships skills needs no build and no restart: the live resolver
// (agent/lib/custom-skills.ts) re-reads `data/custom/plugins/` on every turn. A plugin
// that carries code is built into a version instead - the same rails as `iva update`,
// down to the probe, the flip and the restart (ADR-0009) - so installing one takes as
// long as an update, and a build that fails undoes the install rather than the box.
// MCP servers and the services a plugin declares are processes on the machine, so they
// wait for a second switch: `trusted`. `add` prints the commands it would start and asks
// once; `trust`/`untrust` answer the same question later. Without trust a plugin still
// gives its skills - only nothing runs and nothing calls out.
//
// Everything that lives in the authored tree comes through `loadPluginCore()`,
// never a static import: `iva` has to start on an installation whose `agent/` is
// missing (ADR-0003, scripts/authored-tree-guard.test.ts).
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { PluginManifest, PluginReport } from "#lib/plugin-reader.ts";
import type { PluginEntry, PluginsState } from "#lib/plugin-store.ts";
import {
  namespaceTaken,
  pluginCodeProblem,
  pluginNamespace,
} from "../lib/plugin-build.ts";
import {
  pluginUnitPlan,
  reconcilePluginUnits,
  unitPartProblem,
  type PluginUnitSource,
} from "../lib/plugin-units.ts";
import { systemdExecArgument } from "../lib/systemd-control.ts";
import { tryLoadPluginCore, type PluginCore } from "../lib/plugin-core.ts";
import {
  DEFAULT_MARKETPLACE,
  loadMarketplace,
  loadMarketplaces,
  marketplaceCachePath,
  MARKETPLACE_FILE,
  marketplaceSources,
  parseMarketplaceRequest,
  resolveMarketplacePlugin,
  type LoadedMarketplace,
} from "../lib/marketplace.ts";
import {
  formatPluginSource,
  parsePluginSource,
  type PluginSource,
} from "../lib/plugin-source.ts";
import { acquireUpdateLock } from "../lib/version-store.ts";
import type { createCliRuntime } from "./runtime.ts";
import type { PluginVersionBuild } from "./version-update-command.ts";

type CliRuntime = ReturnType<typeof createCliRuntime>;
type Translate = (en: string, ru: string) => string;

type PluginDependencies = {
  readonly now?: () => Date;
  readonly log?: (...args: unknown[]) => void;
  /** Where a relative local source is resolved from: the owner's shell, not ROOT. */
  readonly cwd?: () => string;
  readonly translate?: Translate;
  /**
   * Build and install a version carrying today's plugins, on the updater's rails
   * (`iva update`'s own `rebuild`). Absent means nobody can build one here, and a
   * plugin with code is installed with its code left out and said so.
   */
  readonly buildVersion?: (options: {
    readonly requirePlugins: boolean;
  }) => Promise<PluginVersionBuild>;
};

/** What an install has to put back if the version carrying it will not build. */
type Undo = {
  readonly name: string;
  /** The entry `plugins.json` had before, or null when there was none. */
  readonly previous: PluginEntry | null;
  /** The folder the install displaced, kept so an update can be taken back. */
  readonly displaced: string | null;
};

type Staged = {
  readonly root: string;
  readonly sha: string;
  readonly ref: string;
};

/** Откуда пришёл плагин, когда его нашли по имени. */
type Provenance = {
  readonly marketplace: string;
  /** Имя, которое Marketplace обещал: манифест обязан его подтвердить. */
  readonly expect: string;
};

// Префиксы наших временных папок. Обе начинаются с точки, а имя плагина по спеке
// начинается с буквы или цифры (§5.5) — значит уборка не может задеть плагин.
const STAGING_PREFIX = ".staging-";
const REPLACED_PREFIX = ".replaced-";
/**
 * Сколько недоделка считается живой. Столько времени идёт сборка версии, ради которой
 * смещённая копия и держится: лок на это время у апдейтера, и уборка чужой команды —
 * единственный, кто может её унести.
 */
const LEFTOVER_GRACE_MS = 60 * 60 * 1000;

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
          entry.name.startsWith(REPLACED_PREFIX)),
    )
    .map((entry) => entry.name)
    .sort();
}

export function createPluginCommands(
  runtime: CliRuntime,
  dependencies: PluginDependencies = {},
) {
  const {
    C,
    ok,
    warn,
    bad,
    step,
    cap,
    childEnv,
    confirm,
    dataDirAbs,
    hasSystemd,
    systemd,
    NODE,
    NODE_BIN_DIR,
    ROOT,
    UNIT_DIR,
  } = runtime;
  const now = dependencies.now ?? (() => new Date());
  const cwd = dependencies.cwd ?? (() => process.cwd());
  const buildVersion = dependencies.buildVersion;
  const log =
    dependencies.log ?? ((...args: unknown[]) => console.log(...args));
  // `GIT_TERMINAL_PROMPT=0` только здесь, для плагинов и Marketplace: приватный или
  // отсутствующий репозиторий (а дефолтного `smixs/iva-plugins` ещё нет) иначе
  // спросит логин в терминале и будет ждать — держа при этом лок апдейта. Ответ
  // «репозиторий недоступен» приходит сразу, и команда объясняет его фразой.
  // `iva update` этой правкой не тронут: там приглашение как раз уместно.
  const git = (args: readonly string[], dir?: string) =>
    cap("git", args, {
      ...(dir ? { cwd: dir } : {}),
      env: { ...childEnv, GIT_TERMINAL_PROMPT: "0" },
    });

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

  ${C.c}iva plugin add${C.x} <name|source> [--trust]   ${translate("install by name from a Marketplace, or from a folder, owner/repo[/subdir][@ref], https:// or git@", "поставить по имени из Marketplace или из папки, owner/repo[/подпапка][@ref], https:// или git@")}
  ${C.c}iva plugin list${C.x} [--available]  ${translate("what is installed; --available: what the marketplaces offer", "что стоит; --available: что предлагают маркетплейсы")}
  ${C.c}iva plugin update${C.x} [name] [--force]  ${translate("pull the tracked ref, printing old → new", "подтянуть отслеживаемый ref, печатая old → new")}
  ${C.c}iva plugin enable${C.x} <name>  ${translate("turn the plugin back on", "включить плагин обратно")}
  ${C.c}iva plugin disable${C.x} <name> ${translate("turn the plugin off without removing it", "выключить плагин, не удаляя")}
  ${C.c}iva plugin trust${C.x} <name>   ${translate("let its MCP servers and services run on this machine", "разрешить запускать его MCP-серверы и сервисы на этой машине")}
  ${C.c}iva plugin untrust${C.x} <name> ${translate("stop and remove them; the plugin stays installed", "погасить и снять их; сам плагин остаётся")}
  ${C.c}iva plugin remove${C.x} <name>  ${translate("remove the plugin; its data is kept", "удалить плагин; данные плагина остаются")}
  ${C.c}iva plugin sync${C.x}           ${translate("repair: rebuild plugins.json and reinstall what is missing", "починка: пересобрать plugins.json и доставить недостающее")}
  ${C.c}iva plugin marketplace${C.x} add <source> | remove <name> | list  ${translate("lists of plugins to install by name", "списки плагинов, которые ставятся по имени")}

  ${C.d}${translate("Skills of an installed plugin work from the next turn: no build, no restart.", "Скиллы поставленного плагина работают со следующего хода: без сборки и рестарта.")}${C.x}
  ${C.d}${translate(`Marketplace by default: ${DEFAULT_MARKETPLACE}.`, `Marketplace по умолчанию: ${DEFAULT_MARKETPLACE}.`)}${C.x}
  ${C.d}${translate("A plugin with code in sh.iva/ is built into a version: that takes a build and a restart.", "Плагин с кодом в sh.iva/ собирается в версию: это сборка и рестарт.")}${C.x}
`);
  }

  async function run(
    core: PluginCore,
    sub: string,
    argv: readonly string[],
  ): Promise<void> {
    const { expandPluginPlaceholders, pluginTreeDigest, readPlugin } =
      core.reader;
    const {
      assignPluginPorts,
      findPlugin,
      pluginDataDir,
      pluginRoot,
      pluginTokenFile,
      pluginsDir,
      pluginsStateFile,
      readPluginsState,
      readPluginsStateSafe,
      salvagePluginsStateFile,
      removePlugin,
      upsertPlugin,
      writePluginsState,
    } = core.store;
    const {
      copyPluginTree,
      fetchGitPlugin,
      resolveRemoteSha,
      restoreDisplaced,
      swapIntoStore,
    } = core.install;

    const force = argv.includes("--force");
    const trustAsked = argv.includes("--trust");
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
      const services = Object.keys(report.services);
      if (services.length) parts.push(`services: ${services.join(", ")}`);
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
     * Кто из уже стоящих плагинов чем владеет. Одноимённый скилл у двух плагинов —
     * отказ на add: две папки претендуют на одно имя в промпте, и молча выбрать одну
     * значило бы отключить другую втихую. Так же и с кодом: mount у плагинов с кодом
     * один файл на namespace (ADR-0009), и вторая папка на то же имя перезаписала бы
     * первую.
     */
    async function owners(
      data: string,
      state: PluginsState,
      except: string,
    ): Promise<{
      readonly skills: Map<string, string>;
      readonly code: string[];
    }> {
      const skills = new Map<string, string>();
      const code: string[] = [];
      for (const entry of state.plugins) {
        if (entry.name === except) continue;
        const report = await readPlugin(pluginRoot(data, entry.name));
        for (const skill of report.skills)
          if (!skills.has(skill.name)) skills.set(skill.name, entry.name);
        if (report.code) code.push(entry.name);
      }
      return { skills, code };
    }

    async function install(
      data: string,
      state: PluginsState,
      raw: PluginSource,
      previous: PluginEntry | null,
      provenance: Provenance | null = null,
    ): Promise<{
      readonly entry: PluginEntry;
      readonly report: PluginReport;
      readonly undo: Undo;
    }> {
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
        // Marketplace — непроверенный файл: он обещает имя, а имя объявляет манифест.
        // Разошлись — ставится не то, что просили: отказ до переезда в data/custom/plugins/.
        if (provenance && provenance.expect !== name)
          throw new Error(
            `${provenance.marketplace} offers ${provenance.expect}, but this plugin calls itself ${JSON.stringify(name)} — refusing to install it`,
          );
        // Запись БЕЗ источника — не заявка на имя, а след починки (`sync` подобрал
        // папку, из которой она пришла, узнать неоткуда). Такую перекрываем, иначе
        // владельцу некуда идти: `add` упирался бы в неё, а `update` — в пустой
        // источник.
        const recorded = previous ? null : findPlugin(state, name);
        if (recorded?.source)
          throw new Error(
            `${name} is already installed — use: iva plugin update ${name}`,
          );

        const owned = await owners(data, state, name);
        for (const skill of report.skills) {
          const owner = owned.skills.get(skill.name);
          if (owner)
            throw new Error(
              `skill ${JSON.stringify(skill.name)} is already provided by the plugin ${owner} — remove one of them first`,
            );
        }
        if (report.code) {
          // Оба отказа — до переезда в стор: mount пишется во время сборки версии,
          // и коллизия, найденная там, стала бы отказом сборки вместо ответа команде.
          const problem = pluginCodeProblem(staged.root, name);
          if (problem) throw new Error(problem);
          const taken = namespaceTaken(name, owned.code);
          if (taken)
            throw new Error(
              `${name} and ${taken} both need the extension mount ${pluginNamespace(name)}.ts — remove one of them first`,
            );
        }

        // Владелец видит состав ДО того, как что-то встало на место.
        log(
          `  ${name}${manifest.version ? ` ${manifest.version}` : ""} — ${components(report)}`,
        );
        if (!previous && existsSync(pluginRoot(data, name)))
          warn(
            recorded
              ? `${name} was recorded without a source — replacing it and writing the source down`
              : `a folder named ${name} was there without an entry in plugins.json — replacing it`,
          );

        // Папку, которую установка сместила, держим до конца сборки версии: только
        // ею можно вернуть плагин на место, если версия с ним не собралась.
        const displaced = swapIntoStore(staged.root, pluginRoot(data, name), {
          retain: report.code,
        });
        // PLUGIN_DATA переживает и обновление, и удаление плагина (спека §9.1).
        await mkdir(pluginDataDir(data, name), { recursive: true });
        const marketplace =
          provenance?.marketplace ?? (previous ?? recorded)?.marketplace;
        return {
          undo: { name, previous: previous ?? recorded ?? null, displaced },
          entry: {
            name,
            source: formatPluginSource(source),
            ref: staged.ref,
            sha: staged.sha,
            digest: await pluginTreeDigest(pluginRoot(data, name)),
            enabled: (previous ?? recorded)?.enabled ?? true,
            trusted: (previous ?? recorded)?.trusted ?? false,
            installedAt: now().toISOString(),
            ...(marketplace ? { marketplace } : {}),
          },
          report,
        };
      } finally {
        rmSync(staging, { recursive: true, force: true });
      }
    }

    /**
     * Недоделки прерванной установки; чистятся под локом, до работы.
     *
     * Со смещённой копией (`.replaced-`) есть оговорка: она живёт, пока идёт сборка
     * версии, а сборка идёт БЕЗ нашего лока — лок на это время у апдейтера. Свежую
     * такую копию не трогаем: снести её значит отобрать у команды единственный способ
     * вернуть плагин на место, если версия с ним не соберётся. Staging (`.staging-`)
     * оговорки не требует: его создают и убирают под тем же локом, что держим мы,
     * поэтому чужой staging здесь — всегда след прерванного процесса.
     */
    function sweepLeftovers(data: string): number {
      const directory = pluginsDir(data);
      const swept = leftoverPluginDirs(directory).filter((name) => {
        const path = join(directory, name);
        if (name.startsWith(REPLACED_PREFIX) && inUse(path)) return false;
        rmSync(path, { recursive: true, force: true });
        return true;
      });
      return swept.length;
    }

    /** Достаточно свежая, чтобы принадлежать идущей прямо сейчас установке. */
    function inUse(path: string): boolean {
      try {
        return now().getTime() - statSync(path).mtimeMs < LEFTOVER_GRACE_MS;
      } catch {
        return false; // Папки уже нет — держать нечего.
      }
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

    /**
     * Что с Marketplace не так — вслух, до того как его список пойдёт в работу.
     * Диагностики самого файла печатаются там, где владелец просил список
     * (`list --available`, `marketplace add|list`): повторять их на каждой установке
     * значит приучить их не читать.
     */
    function reportMarketplace(one: LoadedMarketplace, listing = true): void {
      if (one.problem)
        (one.stale ? warn : bad)(
          one.stale
            ? translate(
                `${one.label} could not be refreshed (${one.problem}) — using the cached list, it may be stale`,
                `${one.label} не обновился (${one.problem}) — беру список из кэша, он может быть устаревшим`,
              )
            : translate(
                `${one.label} could not be read: ${one.problem}`,
                `${one.label} не читается: ${one.problem}`,
              ),
        );
      // Отказ файлу целиком — причина, по которой имя не нашлось: она нужна и там,
      // где владелец просил не список, а установку.
      if (listing || one.market.name === null)
        for (const line of one.market.diagnostics)
          warn(`${one.label}: ${line}`);
    }

    /**
     * Собрать версию с кодом плагинов, как это делает `iva update`: тот же лок, тот же
     * probe, тот же flip и рестарт (ADR-0009). `requirePlugins` — для команд, ради
     * которых сборка и затевается (`add`, `update`, `enable`): плагин, который не
     * собрался, там валит сборку, а не выключается молча. `disable` и `remove` идут без
     * него: их дело сделано записью в plugins.json, а сборке нечего требовать.
     *
     * Возвращает причину отказа или null. Печатать прогресс не нужно: его печатает сам
     * апдейтер, теми же строками.
     */
    async function buildCode(
      what: string,
      requirePlugins: boolean,
    ): Promise<string | null> {
      if (!buildVersion) {
        warn(
          translate(
            `the code of ${what} is not built here: this Iva has no versions to build`,
            `код ${what} здесь не собирается: у этой Ивы нет версий для сборки`,
          ),
        );
        return null;
      }
      step(
        translate(
          `Building Iva with ${what}`,
          `Собираю Иву с плагином: ${what}`,
        ),
      );
      const built = await buildVersion({ requirePlugins });
      if (built.status === "failed") return built.reason;
      if (built.status === "skipped") warn(built.reason);
      return null;
    }

    /**
     * Вернуть стор и plugins.json в то состояние, из которого вышли установки, чью
     * версию не удалось собрать.
     *
     * Папки возвращаются ДО лока, а не под ним: `locked` первым делом подметает
     * недоделки прерванной установки, а смещённая копия выглядит ровно как они — она
     * бы её и снесла. Состояние пишется одной записью под локом.
     */
    async function undoInstalls(
      data: string,
      undos: readonly Undo[],
    ): Promise<void> {
      for (const undo of undos) {
        const target = pluginRoot(data, undo.name);
        if (undo.displaced) restoreDisplaced(undo.displaced, target);
        else rmSync(target, { recursive: true, force: true });
      }
      await locked(data, async () => {
        let state = await readPluginsState(data);
        for (const undo of undos)
          state = undo.previous
            ? upsertPlugin(state, undo.previous)
            : removePlugin(state, undo.name);
        await writePluginsState(data, state);
      });
    }

    /** Сборка прошла — смещённая папка больше не нужна. */
    function dropDisplaced(undo: Undo): void {
      if (undo.displaced)
        rmSync(undo.displaced, { recursive: true, force: true });
    }

    /**
     * Что плагин просит запустить на этой машине: `stdio`-серверы `mcp.json` и сервисы,
     * объявленные в `sh.iva/`. Ровно эти строки владелец и видит перед вопросом о
     * доверии — не «плагин просит доверия», а команда, которая пойдёт в юнит.
     */
    function processCommands(report: PluginReport): string[] {
      const lines: string[] = [];
      for (const [server, declared] of Object.entries(report.mcp)) {
        if (declared.type !== "stdio") continue;
        lines.push(
          `mcp ${server}: ${[declared.command, ...(declared.args ?? [])].join(" ")}`,
        );
      }
      for (const [service, declared] of Object.entries(report.services))
        lines.push(
          `service ${service}: ${[declared.command, ...(declared.args ?? [])].join(" ")}`,
        );
      return lines;
    }

    /**
     * Есть ли у плагина то, что живёт в версии: код или connection-файлы. Сервисы в
     * версию не попадают вовсе — они запускаются из стора юнитом (ADR-0009), поэтому
     * плагин с одними сервисами ничего не пересобирает.
     */
    function inVersion(report: PluginReport, trusted: boolean): boolean {
      return report.code || (trusted && Object.keys(report.mcp).length > 0);
    }

    /** Серверы, которым нужен MCP proxy: только `stdio`, остальные ходят напрямую. */
    function proxiedServers(report: PluginReport): string[] {
      return Object.entries(report.mcp)
        .filter(([, declared]) => declared.type === "stdio")
        .map(([server]) => server)
        .sort();
    }

    /**
     * Токен MCP proxy: 32 байта hex, режим 0600, создаётся один раз. Существующий не
     * перезаписываем — его уже читает работающий прокси, и новый файл означал бы
     * 401 до рестарта юнита.
     */
    function ensureProxyToken(
      data: string,
      name: string,
      server: string,
    ): void {
      const file = pluginTokenFile(data, name, server);
      if (existsSync(file)) return;
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${randomBytes(32).toString("hex")}\n`, {
        mode: 0o600,
      });
    }

    /** Порты и токены плагина, которому только что доверили. Состояние — наружу. */
    function grantPorts(
      data: string,
      state: PluginsState,
      name: string,
      report: PluginReport,
    ): PluginsState {
      const servers = proxiedServers(report).filter(
        (server) => unitPartProblem("MCP server", server) === null,
      );
      const services: Record<string, number> = {};
      for (const [service, declared] of Object.entries(report.services)) {
        if (unitPartProblem("service", service) === null)
          services[service] = declared.port;
      }
      const next = assignPluginPorts(state, { name, mcp: servers, services });
      // PLUGIN_DATA — дом токена, и он обязан быть до того, как юнит стартует.
      mkdirSync(pluginDataDir(data, name), { recursive: true });
      for (const server of servers) ensureProxyToken(data, name, server);
      return next;
    }

    /** Что юниты должны знать о каждом плагине: прочитанное, а не догадки. */
    async function unitSources(
      data: string,
      state: PluginsState,
    ): Promise<PluginUnitSource[]> {
      const sources: PluginUnitSource[] = [];
      for (const entry of state.plugins) {
        if (!entry.enabled || !entry.trusted) continue;
        const root = pluginRoot(data, entry.name);
        if (!existsSync(root)) continue;
        const report = await readPlugin(root);
        if (!report.manifest) continue;
        const paths = { root, data: pluginDataDir(data, entry.name) };
        sources.push({
          name: entry.name,
          enabled: entry.enabled,
          trusted: entry.trusted,
          root,
          data: paths.data,
          mcp: proxiedServers(report).map((server) => ({
            server,
            port: entry.mcp?.[server]?.port,
            // Имя, из которого нельзя сделать имя файла, до токена не доходит: план
            // назовёт его сам, а `pluginTokenFile` на нём кидает.
            tokenFile:
              unitPartProblem("MCP server", server) === null
                ? pluginTokenFile(data, entry.name, server)
                : "",
          })),
          services: Object.entries(report.services).map(
            ([service, declared]) => ({
              service,
              command: declared.command,
              args: (declared.args ?? []).map((argument) =>
                expandPluginPlaceholders(argument, paths),
              ),
              port: entry.services?.[service]?.port,
            }),
          ),
        });
      }
      return sources;
    }

    /**
     * Привести юниты к состоянию: написать нужные, поднять их, снять лишние. Идёт после
     * каждой команды, которая меняет `plugins.json`, — состояние решает, юниты следуют.
     *
     * Без systemd (macOS, контейнер разработчика) юниты не пишутся вовсе: состояние всё
     * равно обновлено, а на сервере его подхватит первый же `iva plugin sync`.
     */
    async function reconcileUnits(
      data: string,
      state: PluginsState,
    ): Promise<void> {
      const plan = pluginUnitPlan({
        plugins: await unitSources(data, state),
        root: ROOT,
        node: NODE,
        nodeBinDir: NODE_BIN_DIR,
        dataDir: data,
        dataDirEnvironment: systemdExecArgument(`ASSISTANT_DATA_DIR=${data}`),
      });
      for (const line of plan.diagnostics) warn(line);
      if (!hasSystemd()) {
        if (plan.units.length)
          warn(
            translate(
              "no systemd here: the units of the plugin are not written (they only run on a Linux server)",
              "systemd здесь нет: юниты плагина не пишутся (они работают только на Linux-сервере)",
            ),
          );
        return;
      }
      // Отказ systemd не отменяет уже записанное состояние: он называется и остаётся
      // задачей владельца (её же повторит `iva doctor`).
      let done;
      try {
        done = reconcilePluginUnits({
          plan,
          unitDir: UNIT_DIR,
          systemd,
          ensureDataDir: (plugin) =>
            mkdirSync(pluginDataDir(data, plugin), { recursive: true }),
          log: (message) => ok(message),
        });
      } catch (error) {
        bad(
          `the plugin units were not brought up to date: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
      if (done.started.length) ok(`running: ${done.started.join(", ")}`);
      for (const failure of done.failures) bad(failure);
    }

    /**
     * Вопрос доверия при `add`. Печатаются команды, а ответ по умолчанию — «нет»:
     * не-TTY (скрипт, ansible) без `--trust` доверия не получает, потому что никто
     * не ответил.
     *
     * Вопрос задаётся ровно про процессы (`stdio`-серверы и сервисы). У плагина, чей
     * `mcp.json` весь удалённый, процессов нет — там доверие даёт только `--trust`
     * или отдельная команда потом: спрашивать про «запускать процессы» было бы
     * неправдой, а решать за владельца, чей токен уйдёт на чужой сервер, — тем более.
     */
    async function askTrust(report: PluginReport): Promise<boolean> {
      const lines = processCommands(report);
      const anything = lines.length > 0 || Object.keys(report.mcp).length > 0;
      if (!anything) return false;
      if (lines.length > 0) {
        log(
          translate(
            "  This plugin wants to run processes on this machine:",
            "  Этот плагин хочет запускать процессы на этой машине:",
          ),
        );
        for (const line of lines) log(`    ${line}`);
      }
      if (trustAsked) return true;
      if (lines.length === 0) return false;
      return confirm(
        translate(
          "Start these processes on this machine?",
          "Запускать эти процессы на этой машине?",
        ),
        false,
      );
    }

    async function setTrusted(trusted: boolean): Promise<void> {
      const data = dataDirAbs();
      const { entry, report, changed } = await locked(data, async () => {
        const state = await readPluginsState(data);
        const found = mustFind(state, args[0]);
        const read = await readPlugin(pluginRoot(data, found.name));
        if (!read.manifest && trusted)
          throw new Error(
            `${found.name} is not readable: ${read.diagnostics.at(-1) ?? "no reason given"}`,
          );
        if (found.trusted === trusted) {
          // Состояние уже такое: юниты всё равно сверяем — их могли снести руками.
          await reconcileUnits(data, state);
          return { entry: found, report: read, changed: false };
        }
        let next = upsertPlugin(state, { ...found, trusted });
        if (trusted) next = grantPorts(data, next, found.name, read);
        await writePluginsState(data, next);
        await reconcileUnits(data, next);
        return {
          entry: findPlugin(next, found.name) ?? found,
          report: read,
          changed: true,
        };
      });
      if (!changed) {
        ok(`${entry.name} is already ${trusted ? "trusted" : "untrusted"}`);
        return;
      }
      // Connection-файлы живут в версии, поэтому смена доверия у плагина с MCP — это
      // сборка и рестарт. Доверие, которое не собралось, снимается обратно: иначе
      // владелец остался бы с записью «доверен» и без тулов в работающей версии.
      if (Object.keys(report.mcp).length && entry.enabled) {
        const failure = await buildCode(entry.name, trusted);
        if (failure !== null) {
          if (trusted) {
            await locked(data, async () => {
              const state = await readPluginsState(data);
              const back = upsertPlugin(state, { ...entry, trusted: false });
              await writePluginsState(data, back);
              await reconcileUnits(data, back);
            });
            throw new Error(`${entry.name} stays untrusted: ${failure}`);
          }
          warn(failure);
        }
      }
      const running = processCommands(report).length;
      ok(
        trusted
          ? translate(
              `${entry.name} trusted${running ? ` — ${running} process(es) run as systemd units` : ""}`,
              `${entry.name} доверен${running ? ` — процессов под systemd: ${running}` : ""}`,
            )
          : translate(
              `${entry.name} untrusted — its processes are stopped and its units removed`,
              `${entry.name} больше не доверен — процессы погашены, юниты сняты`,
            ),
      );
    }

    async function add(): Promise<void> {
      const raw = args[0];
      if (!raw)
        throw new Error(
          "iva plugin add <name|source> — a name from a Marketplace, a folder, owner/repo[/subdir][@ref], https://… or git@…",
        );
      // Голое имя — запрос к Marketplace; всё остальное разбирается как источник
      // здесь же, до лока: неизвестная форма не должна занимать лок апдейта.
      const request = parseMarketplaceRequest(raw);
      const typed = request ? null : parsePluginSource(raw);
      const data = dataDirAbs();

      /** Имя → источник и провенанс: списки лежат в том же состоянии, что плагины. */
      async function throughMarketplace(
        state: PluginsState,
        wanted: { readonly name: string; readonly marketplace: string | null },
      ): Promise<{
        readonly source: PluginSource;
        readonly provenance: Provenance;
      }> {
        const all = await loadMarketplaces(git, data, state.marketplaces, true);
        for (const one of all) reportMarketplace(one, false);
        const hit = resolveMarketplacePlugin(all, wanted, translate);
        return {
          source: hit.source,
          provenance: { marketplace: hit.marketplace, expect: hit.name },
        };
      }

      // Состояние читается и пишется ВНУТРИ лока: прочитать до лока значило бы
      // записать поверх чужого `disable`, который случился, пока шла установка.
      const { entry, report, undo } = await locked(data, async () => {
        const state = await readPluginsState(data);
        if (!state.riskNoticeShownAt) {
          warn(translate(RISK_EN, RISK_RU));
          log();
        }
        const { source, provenance } = request
          ? await throughMarketplace(state, request)
          : { source: typed as PluginSource, provenance: null };
        step(
          provenance
            ? `Installing ${provenance.expect} from ${provenance.marketplace} (${formatPluginSource(source)})`
            : `Installing ${formatPluginSource(source)}`,
        );
        const installed = await install(data, state, source, null, provenance);
        // Вопрос доверия — здесь, до сборки версии: connection-файлы плагина зависят
        // от ответа, и спросить после сборки значило бы собирать версию дважды.
        const trusted = await askTrust(installed.report);
        let next = upsertPlugin(state, { ...installed.entry, trusted });
        if (trusted)
          next = grantPorts(data, next, installed.entry.name, installed.report);
        await writePluginsState(data, {
          ...next,
          riskNoticeShownAt: state.riskNoticeShownAt ?? now().toISOString(),
        });
        return {
          ...installed,
          entry: findPlugin(next, installed.entry.name) ?? installed.entry,
        };
      });

      // Код плагина и его connection-файлы живут в версии, поэтому установка
      // заканчивается сборкой и рестартом. Сборка не прошла — установки не было: стор и
      // plugins.json возвращаются как были, работающая версия не тронута (ADR-0003).
      if (entry.enabled && inVersion(report, entry.trusted)) {
        const failure = await buildCode(entry.name, true);
        if (failure !== null) {
          await undoInstalls(data, [undo]);
          throw new Error(`${entry.name} was not installed: ${failure}`);
        }
      }
      dropDisplaced(undo);
      // Юниты — после сборки: прокси запускается из версии, которая уже собрана.
      if (entry.trusted)
        await locked(data, async () =>
          reconcileUnits(data, await readPluginsState(data)),
        );

      ok(`${entry.name} installed`);
      if (report.skills.length)
        ok(
          translate(
            "skills work from the next turn: no build, no restart",
            "скиллы работают со следующего хода: без сборки и рестарта",
          ),
        );
      if (report.code && entry.enabled)
        ok(
          translate(
            `code is built into the version that runs; its tools are prefixed ${pluginNamespace(entry.name)}__`,
            `код собран в работающую версию; тулы идут с префиксом ${pluginNamespace(entry.name)}__`,
          ),
        );
      const wants =
        processCommands(report).length > 0 ||
        Object.keys(report.mcp).length > 0;
      if (wants && !entry.trusted)
        warn(
          translate(
            `${entry.name} is not trusted: its MCP servers and services stay off — allow them with: iva plugin trust ${entry.name}`,
            `${entry.name} не доверен: его MCP-серверы и сервисы не работают — разрешить: iva plugin trust ${entry.name}`,
          ),
        );
      if (Object.keys(report.mcp).length && entry.trusted)
        ok(
          translate(
            "its MCP tools reach the agent from the next turn",
            "тулы его MCP-серверов доступны агенту со следующего хода",
          ),
        );
    }

    /** Что предлагают Marketplace: имя, описание, чей список, стоит ли уже. */
    async function available(data: string, state: PluginsState): Promise<void> {
      const all = await loadMarketplaces(git, data, state.marketplaces, true);
      const installed = new Set(state.plugins.map((entry) => entry.name));
      const rows: string[][] = [];
      for (const one of all) {
        reportMarketplace(one);
        for (const entry of one.market.entries)
          rows.push([
            entry.name,
            entry.description.length > 60
              ? `${entry.description.slice(0, 59)}…`
              : entry.description || "-",
            one.label,
            installed.has(entry.name) ? "installed" : "available",
          ]);
      }
      if (rows.length === 0) {
        log(
          translate(
            "Nothing on offer. Add a marketplace: iva plugin marketplace add <source>",
            "Предлагать нечего. Добавить маркетплейс: iva plugin marketplace add <источник>",
          ),
        );
        return;
      }
      const header = ["NAME", "DESCRIPTION", "MARKETPLACE", ""];
      const width = (column: number): number =>
        Math.max(...[header, ...rows].map((row) => row[column].length));
      const line = (row: readonly string[]): string =>
        `${row[0].padEnd(width(0))}  ${row[1].padEnd(width(1))}  ${row[2].padEnd(width(2))}  ${row[3]}`;
      log(`${C.d}${line(header)}${C.x}`);
      for (const row of rows)
        log(row[3] === "installed" ? `${C.d}${line(row)}${C.x}` : line(row));
    }

    async function list(): Promise<void> {
      const data = dataDirAbs();
      const state = await readPluginsState(data);
      if (argv.includes("--available")) return available(data, state);
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
        // Отслеживаемый ref дописывается только когда его не видно в самой строке
        // источника: у запиненной записи Marketplace это был бы тот же sha дважды.
        const tracked =
          entry.ref && !entry.source.endsWith(`@${entry.ref}`)
            ? ` @${entry.ref}`
            : "";
        log(
          `  ${C.d}${entry.source || translate("no source recorded", "источник не записан")}${tracked}${entry.marketplace ? ` · via ${entry.marketplace}` : ""}${C.x}`,
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
      const { entry, code } = await locked(data, async () => {
        const state = await readPluginsState(data);
        const found = mustFind(state, args[0]);
        let next = state;
        if (found.enabled !== enabled) {
          next = upsertPlugin(state, { ...found, enabled });
          await writePluginsState(data, next);
        }
        const report = await readPlugin(pluginRoot(data, found.name));
        // Выключенный плагин ничего не запускает: `enabled` гасит и юниты тоже.
        await reconcileUnits(data, next);
        return { entry: found, code: inVersion(report, found.trusted) };
      });
      if (entry.enabled === enabled) {
        ok(`${entry.name} is already ${enabled ? "enabled" : "disabled"}`);
        return;
      }
      // Тумблер у плагина с кодом — это состав версии, значит сборка и рестарт.
      // Включение, которое не собралось, возвращается в выключенное: иначе владелец
      // остался бы с записью «включён» и без кода в работающей версии.
      if (code) {
        const failure = await buildCode(entry.name, enabled);
        if (failure !== null) {
          if (enabled) {
            await locked(data, async () => {
              const state = await readPluginsState(data);
              await writePluginsState(
                data,
                upsertPlugin(state, { ...entry, enabled: false }),
              );
            });
            throw new Error(`${entry.name} stays disabled: ${failure}`);
          }
          warn(failure);
        }
      }
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
      const { entry, code } = await locked(data, async () => {
        const state = await readPluginsState(data);
        const found = mustFind(state, args[0]);
        // Код читается ДО удаления папки: после него узнать, был ли он, неоткуда.
        const report = await readPlugin(pluginRoot(data, found.name));
        rmSync(pluginRoot(data, found.name), { recursive: true, force: true });
        const next = removePlugin(state, found.name);
        await writePluginsState(data, next);
        // Юниты снятого плагина уходят вместе с записью, до сборки версии: они держат
        // порты и процессы, и ждать сборки им незачем.
        await reconcileUnits(data, next);
        return {
          entry: found,
          code: inVersion(report, found.trusted) && found.enabled,
        };
      });
      // Плагин удалён, а его код всё ещё в работающей версии: убирает его сборка.
      if (code) {
        const failure = await buildCode(entry.name, false);
        if (failure !== null) warn(failure);
      }
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
    ): Promise<{
      readonly kind: "edited" | "unreadable";
      readonly why: string;
    } | null> {
      if (!entry.digest || !existsSync(root)) return null;
      try {
        const current = await pluginTreeDigest(root);
        return current === entry.digest ? null : { kind: "edited", why: root };
      } catch (error) {
        return { kind: "unreadable", why: (error as Error).message };
      }
    }

    type Updated = {
      readonly state: PluginsState;
      /** Чем откатить установку, если версия с новым кодом не соберётся. */
      readonly undo: Undo | null;
      readonly code: boolean;
    };

    async function updateOne(
      data: string,
      state: PluginsState,
      entry: PluginEntry,
    ): Promise<Updated> {
      const untouched: Updated = { state, undo: null, code: false };
      if (!entry.source) {
        warn(
          `${entry.name} has no source recorded — reinstall it: iva plugin add <source>`,
        );
        return untouched;
      }
      const source = parsePluginSource(entry.source);
      const root = pluginRoot(data, entry.name);
      const changed = force ? null : await editedInPlace(root, entry);
      if (changed) {
        warn(
          changed.kind === "edited"
            ? translate(
                `${entry.name}: the folder was edited in place (${changed.why}) — not touching it; add --force to replace it`,
                `${entry.name}: папку правили руками (${changed.why}) — не трогаю; заменить принудительно: --force`,
              )
            : translate(
                `${entry.name}: the folder cannot be read (${changed.why}) — not touching it; add --force to replace it`,
                `${entry.name}: папка не читается (${changed.why}) — не трогаю; заменить принудительно: --force`,
              ),
        );
        return untouched;
      }
      if (source.kind === "git") {
        const { sha } = resolveRemoteSha(git, source.url, source.ref);
        if (sha === entry.sha && existsSync(root) && !force) {
          ok(`${entry.name} is already at ${sha.slice(0, 12)}`);
          // Запись Marketplace могла запинить коммит: тогда `update` двигать нечего,
          // и владелец должен узнать, чем с пина сходят, а не решать, что команда врёт.
          if (entry.marketplace && entry.ref === entry.sha)
            ok(
              translate(
                `${entry.name} is pinned by ${entry.marketplace} — to move it: iva plugin remove ${entry.name} && iva plugin add ${entry.name}`,
                `${entry.name} запинен маркетплейсом ${entry.marketplace} — сойти с пина: iva plugin remove ${entry.name} && iva plugin add ${entry.name}`,
              ),
            );
          return untouched;
        }
      }
      const {
        entry: installed,
        report,
        undo,
      } = await install(data, state, source, entry);
      ok(
        entry.sha && installed.sha
          ? `${entry.name}: ${entry.sha.slice(0, 12)} → ${installed.sha.slice(0, 12)}`
          : `${entry.name} reinstalled from ${installed.source}`,
      );
      return {
        state: upsertPlugin(state, installed),
        undo,
        // Доверенный плагин с MCP пересобирается и без кода: его connection-файлы
        // описывают тот `mcp.json`, который только что приехал.
        code: inVersion(report, installed.trusted) && installed.enabled,
      };
    }

    async function update(): Promise<void> {
      const data = dataDirAbs();
      const failed: string[] = [];
      const undone: Undo[] = [];
      const rebuilt: string[] = [];
      await locked(data, async () => {
        const state = await readPluginsState(data);
        const targets = args[0]
          ? [mustFind(state, args[0])]
          : [...state.plugins];
        if (targets.length === 0) {
          ok("no plugins to update");
          return;
        }
        let next = state;
        for (const entry of targets) {
          try {
            const done = await updateOne(data, next, entry);
            next = done.state;
            if (done.undo) undone.push(done.undo);
            if (done.code) rebuilt.push(entry.name);
          } catch (error) {
            failed.push(entry.name);
            bad(`${entry.name}: ${(error as Error).message}`);
          }
        }
        // Обновление могло привезти новый MCP-сервер или сервис: доверенному плагину
        // они получают порт и токен здесь, иначе версия собралась бы с connection без
        // порта, а юнита у сервера не было бы вовсе.
        for (const entry of next.plugins) {
          if (!entry.trusted) continue;
          const report = await readPlugin(pluginRoot(data, entry.name));
          if (report.manifest)
            next = grantPorts(data, next, entry.name, report);
        }
        await writePluginsState(data, next);
        await reconcileUnits(data, next);
      });
      // Одна сборка на весь прогон: версия собирается со всеми плагинами сразу, и
      // отдельная сборка на каждый стоила бы столько же рестартов, сколько плагинов.
      if (rebuilt.length) {
        const failure = await buildCode(rebuilt.join(", "), true);
        if (failure !== null) {
          await undoInstalls(data, undone);
          throw new Error(`nothing was updated: ${failure}`);
        }
      }
      for (const undo of undone) dropDisplaced(undo);
      if (failed.length)
        throw new Error(`could not update: ${failed.join(", ")}`);
    }

    /**
     * Повреждённый файл сначала уезжает в бэкап и только потом переписывается.
     * Порядок именно такой: `sync` восстанавливает состояние по папкам, а имена
     * папок не помнят ни источник, ни sha, ни доверие — стереть единственную копию
     * этих полей и отчитаться зелёной галочкой было бы худшим исходом из всех.
     */
    function backUpDamaged(data: string): string {
      const file = pluginsStateFile(data);
      const stamp = now().toISOString().replace(/[:.]/gu, "-");
      const backup = `${file}.corrupt-${stamp}`;
      renameSync(file, backup);
      return backup;
    }

    /** Что удалось спасти из повреждённого plugins.json и прежних его копий. */
    async function salvageState(data: string): Promise<PluginsState> {
      const file = pluginsStateFile(data);
      const directory = dirname(file);
      const backups = existsSync(directory)
        ? readdirSync(directory)
            .filter((name) => name.startsWith(`${basename(file)}.corrupt-`))
            .sort()
            .reverse()
        : [];
      for (const backup of backups) {
        const salvaged = await salvagePluginsStateFile(join(directory, backup));
        if (salvaged?.plugins.length) {
          ok(
            `recovered ${salvaged.plugins.length} plugin(s) and ${salvaged.marketplaces.length} marketplace(s) from ${backup}`,
          );
          return salvaged;
        }
      }
      warn(
        "nothing could be read out of the damaged file — rebuilding from data/custom/plugins/, so sources, refs and trust flags are lost",
      );
      return { marketplaces: [], plugins: [] };
    }

    async function sync(): Promise<void> {
      const data = dataDirAbs();
      await locked(data, async () => {
        const read = await readPluginsStateSafe(data);
        let next = read.state;
        if (read.damaged) {
          warn(read.damaged.message);
          const backup = backUpDamaged(data);
          warn(`kept the damaged file as ${basename(backup)}`);
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
            ok(`${entry.name} restored`);
            // `sync` доставляет папки, а не собирает версии: код плагина попадёт в
            // работающую версию только следующей сборкой, и молчать об этом нельзя.
            if (report.code && installed.enabled)
              warn(
                translate(
                  `${entry.name}: code is not built into the current version — run: iva update`,
                  `${entry.name}: кода нет в работающей версии — запусти: iva update`,
                ),
              );
          } catch (error) {
            failed.push(entry.name);
            bad(`${entry.name}: ${(error as Error).message}`);
          }
        }

        // Плагин уже стоит — значит предупреждение о риске владелец видел; после
        // починки показывать его снова незачем.
        if (!next.riskNoticeShownAt && next.plugins.length)
          next = { ...next, riskNoticeShownAt: now().toISOString() };
        // Доверенный плагин мог приехать без портов и токенов: `sync` — это починка,
        // и она доделывает то, что делает `trust`, прежде чем сверять юниты.
        for (const entry of next.plugins) {
          if (!entry.trusted) continue;
          const report = await readPlugin(pluginRoot(data, entry.name));
          if (report.manifest)
            next = grantPorts(data, next, entry.name, report);
        }
        await writePluginsState(data, next);
        await reconcileUnits(data, next);
        const sourceless = next.plugins.filter((entry) => !entry.source);
        if (sourceless.length)
          warn(
            `no source recorded for ${sourceless.map((entry) => entry.name).join(", ")} — reinstall each with: iva plugin add <source>`,
          );
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

    /**
     * `marketplace add`: клонируем один раз, чтобы прочитать файл, и только потом
     * записываем строку источника. Репозиторий без `marketplace.json` — не
     * Marketplace, и узнать это лучше сразу, а не при первом `add <имя>`.
     */
    async function marketplaceAdd(data: string): Promise<void> {
      const raw = args[1];
      if (!raw)
        throw new Error(
          "iva plugin marketplace add <source> — owner/repo[@ref], https://…, git@… or a local git repository",
        );
      const recorded = formatPluginSource(absolute(parsePluginSource(raw)));
      await locked(data, async () => {
        const state = await readPluginsState(data);
        if (marketplaceSources(state.marketplaces).includes(recorded)) {
          ok(
            translate(
              `${recorded} is already on the list`,
              `${recorded} в списке уже есть`,
            ),
          );
          return;
        }
        step(`Reading ${recorded}`);
        const one = await loadMarketplace(git, data, recorded, true);
        try {
          if (one.problem && !one.repo)
            throw new Error(
              translate(
                `${recorded} could not be read: ${one.problem}`,
                `${recorded} не читается: ${one.problem}`,
              ),
            );
          reportMarketplace(one);
          if (!one.market.name)
            throw new Error(
              translate(
                `${recorded} has no usable ${MARKETPLACE_FILE} — that file is what makes a repository a Marketplace`,
                `у ${recorded} нет пригодного ${MARKETPLACE_FILE} — именно этот файл делает репозиторий маркетплейсом`,
              ),
            );
          // Одно имя на два списка сделало бы `add <имя>@<marketplace>` невыразимым.
          const taken = (
            await loadMarketplaces(git, data, state.marketplaces, false)
          ).find((other) => other.market.name === one.market.name);
          if (taken)
            throw new Error(
              translate(
                `a marketplace named ${JSON.stringify(one.market.name)} is already on the list (${taken.recorded})`,
                `маркетплейс с именем ${JSON.stringify(one.market.name)} в списке уже есть (${taken.recorded})`,
              ),
            );
        } catch (error) {
          // Список не принят — его выкачанная копия в data/ тоже не нужна.
          rmSync(marketplaceCachePath(data, recorded), {
            recursive: true,
            force: true,
          });
          throw error;
        }
        // Первый свой список материализует и дефолт, первым: иначе «добавил свой»
        // молча отключало бы встроенный, и снять дефолт было бы нечем.
        await writePluginsState(data, {
          ...state,
          marketplaces: state.marketplaces.length
            ? [...state.marketplaces, recorded]
            : [DEFAULT_MARKETPLACE, recorded],
        });
        ok(
          translate(
            `${one.market.name} added — ${one.market.entries.length} plugin(s) on offer`,
            `${one.market.name} добавлен — плагинов на выбор: ${one.market.entries.length}`,
          ),
        );
      });
    }

    /** Запись списка по строке источника или по имени из файла. */
    async function findMarketplace(
      data: string,
      state: PluginsState,
      wanted: string,
    ): Promise<string> {
      let formatted: string | null = null;
      try {
        formatted = formatPluginSource(absolute(parsePluginSource(wanted)));
      } catch {
        // Не источник — значит имя из файла, его ищем ниже.
      }
      const bySource = state.marketplaces.find(
        (item) => item === wanted || item === formatted,
      );
      if (bySource) return bySource;
      for (const recorded of state.marketplaces) {
        const one = await loadMarketplace(git, data, recorded, false);
        if (one.market.name === wanted) return recorded;
      }
      throw new Error(
        translate(
          `${wanted} is not on the list — iva plugin marketplace list`,
          `${wanted} в списке нет — iva plugin marketplace list`,
        ),
      );
    }

    async function marketplaceRemove(data: string): Promise<void> {
      const wanted = args[1];
      if (!wanted)
        throw new Error(
          "iva plugin marketplace remove <name|source> — iva plugin marketplace list",
        );
      await locked(data, async () => {
        const state = await readPluginsState(data);
        if (state.marketplaces.length === 0) {
          const fallback = await loadMarketplace(
            git,
            data,
            DEFAULT_MARKETPLACE,
            false,
          );
          throw new Error(
            wanted === DEFAULT_MARKETPLACE || fallback.market.name === wanted
              ? translate(
                  `${DEFAULT_MARKETPLACE} is the built-in default, not a list entry — add your own marketplace first, then remove this one`,
                  `${DEFAULT_MARKETPLACE} — встроенный список по умолчанию, а не запись: сначала добавь свой маркетплейс, потом снимай этот`,
                )
              : translate(
                  `${wanted} is not on the list — iva plugin marketplace list`,
                  `${wanted} в списке нет — iva plugin marketplace list`,
                ),
          );
        }
        const target = await findMarketplace(data, state, wanted);
        await writePluginsState(data, {
          ...state,
          marketplaces: state.marketplaces.filter((item) => item !== target),
        });
        // Кэш наш и лежит в data/: снимаем его вместе с записью.
        rmSync(marketplaceCachePath(data, target), {
          recursive: true,
          force: true,
        });
        ok(translate(`${target} removed`, `${target} снят`));
      });
    }

    async function marketplaceList(data: string): Promise<void> {
      const state = await readPluginsState(data);
      const implicit = state.marketplaces.length === 0;
      for (const recorded of marketplaceSources(state.marketplaces)) {
        const one = await loadMarketplace(git, data, recorded, false);
        const mark = implicit ? `  ${C.d}(default)${C.x}` : "";
        if (one.problem) {
          bad(`${recorded}${mark}  ${one.problem}`);
          continue;
        }
        if (!one.repo) {
          log(
            `${C.b}${recorded}${C.x}${mark}  ${translate(
              "not read yet — run: iva plugin list --available",
              "ещё не читали — запусти: iva plugin list --available",
            )}`,
          );
          continue;
        }
        log(
          `${C.b}${one.label}${C.x}${mark}  ${recorded}  ${one.market.entries.length} plugin(s)  ${one.repo.sha.slice(0, 12)}`,
        );
        for (const line of one.market.diagnostics) warn(`  ${line}`);
      }
    }

    function marketplaceCommand(): Promise<void> {
      const data = dataDirAbs();
      switch (args[0] ?? "list") {
        case "add":
          return marketplaceAdd(data);
        case "remove":
          return marketplaceRemove(data);
        case "list":
          return marketplaceList(data);
        default:
          throw new Error(
            `unknown: iva plugin marketplace ${args[0]} — add, remove, list`,
          );
      }
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
      case "trust":
        return setTrusted(true);
      case "untrust":
        return setTrusted(false);
      case "update":
        return update();
      case "sync":
        return sync();
      case "marketplace":
        return marketplaceCommand();
      default:
        throw new Error(
          `unknown: iva plugin ${sub} — add, list, update, enable, disable, trust, untrust, remove, sync, marketplace`,
        );
    }
  }

  async function cmdPlugin(args: readonly string[]): Promise<void> {
    const [sub, ...rest] = args;
    await resolveTranslate();
    if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h")
      return help();
    const core = await tryLoadPluginCore();
    if (!core)
      throw new Error(
        "plugins are not available: the agent tree is missing — run: iva update",
      );
    return run(core, sub, rest);
  }

  return { cmdPlugin };
}
