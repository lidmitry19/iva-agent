import { spawnSync as nodeSpawnSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATALOG, catalogProvider } from "../lib/model-catalog.ts";
import { modelSummary } from "../lib/model-summary.ts";
import {
  createTerminalProgress,
  type TerminalProgress,
} from "../lib/progress.ts";
import {
  loadTelegramJob,
  removeTelegramJob,
  reporterFor,
} from "../lib/telegram-status.ts";
import { updaterCompat, updaterTooOldMessage } from "../lib/update-check.ts";
import {
  acquireUpdateLock,
  commitThenRunPostCommit,
  createUpdateLog,
  createUpdateTransaction,
  releaseUpdateLock,
  type RestoreReport,
} from "../lib/update-safety.ts";
import type { createCliRuntime } from "./runtime.ts";
import type { createCliSystemd } from "./systemd.ts";

type CliRuntime = ReturnType<typeof createCliRuntime>;
type CliSystemd = ReturnType<typeof createCliSystemd>;
type UpdatePhase = "protect" | "fetch" | "build";

export type UpdateCopy = Record<
  UpdatePhase,
  readonly [string, string, string]
> & {
  readonly timerFailure: string;
  readonly current: string;
  readonly busy: string;
  readonly badProvider: string;
  readonly failed: string;
  readonly stock: string;
};

type UpdateVersions = {
  readonly beforeHead?: string;
  readonly afterHead?: string;
  readonly beforeVersion: string;
  readonly afterVersion: string;
};

type CommandResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

type UpdateTransaction = {
  protect(): Promise<unknown>;
  resolveTarget(): Promise<{ changed: boolean; remote: string }>;
  restoreLocalChanges(): Promise<RestoreReport>;
  versions(): Promise<UpdateVersions>;
  buildCandidate(options: { npm: string }): Promise<object | null>;
  fetchAndIntegrate(): Promise<{ changed: boolean }>;
  promoteCandidate(): Promise<boolean>;
  git(...args: string[]): Promise<CommandResult>;
  run(command: string, args: string[]): Promise<CommandResult>;
  backupOutput(): void;
  adoptOutput(): void;
  rollback(): Promise<unknown>;
  commit(): Promise<void>;
  teardownCandidate(): Promise<unknown>;
  readonly hadLocalChanges: boolean;
  readonly outputTouched: boolean;
};

type TelegramReporter = {
  start(phase: UpdatePhase): Promise<void>;
  done(phase: UpdatePhase): Promise<void>;
  fail(
    phase: UpdatePhase,
    beforeVersion: string,
    detail?: string,
  ): Promise<void>;
  busy(): Promise<void>;
  badProvider(value: string, accepted: string): Promise<void>;
  updaterTooOld(version: string): Promise<void>;
  postCommitFailure(message: string): Promise<void>;
  complete(
    versions: UpdateVersions & {
      changedLocal?: boolean;
      restoreReport?: RestoreReport;
    },
  ): Promise<boolean>;
  dispose(): void;
};

type UpdateLock = ReturnType<typeof acquireUpdateLock>;
type TransactionOptions = Parameters<typeof createUpdateTransaction>[0];

type UpdateOperations = {
  createTerminalProgress(options: { verbose: boolean }): TerminalProgress;
  loadTelegramJob(
    dataDir: string,
    jobId: string,
  ): Promise<{ path: string; job: unknown } | null>;
  createTelegramUpdateReporter(options: {
    token?: string;
    job: unknown;
    env: Record<string, string | undefined>;
  }): TelegramReporter | null;
  removeTelegramJob(path: string | undefined): Promise<void>;
  acquireUpdateLock(dataDir: string, owner: string): UpdateLock;
  createUpdateLog(dataDir: string): string;
  createUpdateTransaction(options: TransactionOptions): UpdateTransaction;
  releaseUpdateLock(lock: UpdateLock): void;
  spawnSync(
    command: string,
    args: readonly string[],
    options: {
      cwd: string;
      encoding: "utf8";
      env: NodeJS.ProcessEnv;
    },
  ): { status: number | null; stdout: string };
  fetch(
    url: string,
    options: { signal: AbortSignal },
  ): Promise<{ ok: boolean }>;
  sleep(ms: number): Promise<void>;
};

type RestartUserbotOptions = {
  readonly quiet?: boolean;
  readonly knownActive?: boolean;
  readonly requirementsPath?: string | null;
  readonly requireHashes?: boolean;
};

type CreateUpdateCommandOptions = {
  readonly runtime: CliRuntime;
  readonly systemdLifecycle: Pick<CliSystemd, "writeUnits" | "migrateEnv">;
  readonly showTree: () => Promise<void>;
  readonly restartUserbotIfActive: (options?: RestartUserbotOptions) => unknown;
  readonly operations?: Partial<UpdateOperations>;
};

/** The words both updaters speak: one scenario, one vocabulary. */
export const COPY: Record<"en" | "ru", UpdateCopy> = {
  ru: {
    protect: [
      "Сохраняю ваши изменения",
      "Изменения сохранены",
      "Не удалось сохранить изменения",
    ],
    fetch: [
      "Получаю обновление",
      "Обновление получено",
      "Не удалось получить обновление",
    ],
    build: ["Собираю Iva", "Iva собрана", "Не удалось собрать Iva"],
    timerFailure:
      "Iva готова, но таймер автоматических обновлений не удалось активировать",
    current: "Iva уже обновлена",
    busy: "Обновление уже идёт",
    badProvider:
      "Сначала почини MODEL_PROVIDER в .env (iva config) — на этом значении Iva не стартует",
    failed: "Не удалось завершить обновление",
    stock: "ваша доработка в data/custom не входит в эту версию",
  },
  en: {
    protect: [
      "Saving your changes",
      "Changes saved",
      "Couldn't save your changes",
    ],
    fetch: ["Getting the update", "Update received", "Couldn't get the update"],
    build: ["Building Iva", "Iva built", "Couldn't build Iva"],
    timerFailure:
      "Iva is ready, but the automatic update timer could not be activated",
    current: "Iva is already up to date",
    busy: "An update is already running",
    badProvider:
      "Fix MODEL_PROVIDER in .env first (iva config) — Iva won't start on this value",
    failed: "Couldn't complete the update",
    stock: "your customization in data/custom is not in this version",
  },
};

/** Имена, которые примет рантайм, — для сообщения об отказе на обоих путях апдейта. */
export const ACCEPTED_PROVIDERS = Object.keys(CATALOG).join(", ");

/**
 * Отказ апдейта на невалидном MODEL_PROVIDER — один текст на legacy- и managed-путь.
 * В терминал он идёт на языке CLI (AGENT_LANGUAGE), в чат — из copy репортера (job.locale).
 */
export function invalidProviderRefusal(
  text: UpdateCopy,
  value: string,
): string {
  return `${text.badProvider}: ${JSON.stringify(value)} (${ACCEPTED_PROVIDERS})`;
}

/** Build the update command around one shared CLI runtime and systemd lifecycle. */
export function createUpdateCommand({
  runtime,
  systemdLifecycle,
  showTree,
  restartUserbotIfActive,
  operations,
}: CreateUpdateCommandOptions) {
  const defaultOperations: UpdateOperations = {
    createTerminalProgress,
    loadTelegramJob,
    createTelegramUpdateReporter: ({ token, job, env }) =>
      reporterFor(job, token, env),
    removeTelegramJob,
    acquireUpdateLock,
    createUpdateLog,
    createUpdateTransaction,
    releaseUpdateLock,
    spawnSync: (command, args, options) => {
      const result = nodeSpawnSync(command, args, options);
      return {
        status: result.status,
        stdout: typeof result.stdout === "string" ? result.stdout : "",
      };
    },
    fetch: (url, options) => fetch(url, options),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
  const ops: UpdateOperations = { ...defaultOperations, ...operations };
  const {
    ROOT,
    ENV_PATH,
    NPM,
    childEnv,
    SERVICES,
    UPDATE_TIMER,
    SVC_USERBOT,
    USERBOT_DIR,
    VENV_PY,
    DEFAULT_PORT,
    cap,
    hasSystemd,
    systemd,
    readEnv,
    dataDirAbs,
  } = runtime;
  const { writeUnits, migrateEnv } = systemdLifecycle;

  return async function cmdUpdate(args: readonly string[]): Promise<void> {
    const force = args.includes("--force");
    const verbose = args.includes("--verbose");
    const telegramJobAt = args.indexOf("--telegram-job");
    const telegramJobId =
      telegramJobAt >= 0 ? args[telegramJobAt + 1] || "" : "";
    const locale =
      (readEnv().AGENT_LANGUAGE || process.env.AGENT_LANGUAGE) === "ru"
        ? "ru"
        : "en";
    const text = COPY[locale];

    await showTree();
    const env = readEnv();
    const dataDir = dataDirAbs(env);
    const loadedJob = await ops.loadTelegramJob(dataDir, telegramJobId);
    const reporter = loadedJob
      ? ops.createTelegramUpdateReporter({
          token: env.TELEGRAM_BOT_TOKEN,
          job: loadedJob.job,
          env,
        })
      : null;
    const terminal = ops.createTerminalProgress({ verbose });

    // Обновление не чинит .env, а на неизвестном MODEL_PROVIDER новая версия не поднимется:
    // без этой проверки апдейт прошёл бы целиком, упёрся в health-check, откатился — и ни разу
    // не назвал причину. Отказ ДО замка и до первой записи, чтобы установка осталась нетронутой
    // (ADR-0003: путь обновления обязан объяснять, что чинить).
    const configuredProvider = env.MODEL_PROVIDER ?? "ollama";
    if (!catalogProvider(configuredProvider)) {
      terminal.fail(invalidProviderRefusal(text, configuredProvider));
      await reporter?.badProvider(configuredProvider, ACCEPTED_PROVIDERS);
      reporter?.dispose();
      await ops.removeTelegramJob(loadedJob?.path);
      process.exitCode = 1;
      return;
    }

    const owner = telegramJobId || `cli-${process.pid}-${Date.now()}`;
    const lock = ops.acquireUpdateLock(dataDir, owner);
    if (!lock.ok) {
      terminal.fail(text.busy);
      // Or the Telegram message stays on the phase it never got past.
      await reporter?.busy();
      reporter?.dispose();
      await ops.removeTelegramJob(loadedJob?.path);
      process.exitCode = 1;
      return;
    }

    const logFile = ops.createUpdateLog(dataDir);
    const tx = ops.createUpdateTransaction({
      root: ROOT,
      dataDir,
      envPath: ENV_PATH,
      verbose,
      logFile,
      env: childEnv,
    });
    const state: { phase: UpdatePhase } = { phase: "protect" };
    let userbotUpdateAttempted = false;
    let userbotRollbackSnapshot: string | null = null;
    let versions: UpdateVersions = {
      beforeVersion: "the previous version",
      afterVersion: "the new version",
    };
    let restoreReport: RestoreReport;
    const phaseStart = async (name: UpdatePhase): Promise<void> => {
      state.phase = name;
      terminal.start(text[name][0]);
      await reporter?.start(name);
    };
    const phaseDone = async (name: UpdatePhase): Promise<void> => {
      terminal.done(text[name][1]);
      await reporter?.done(name);
    };
    // eslint-disable-next-line @typescript-eslint/require-await -- preserve the existing async post-commit callback boundary
    const ensureUpdateTimer = async (): Promise<void> => {
      if (!hasSystemd()) return;
      writeUnits();
      systemd.activate([UPDATE_TIMER]);
    };
    const finalizeUpdate = async (): Promise<boolean> => {
      const finalized = await commitThenRunPostCommit({
        commit: () => tx.commit(),
        postCommit: ensureUpdateTimer,
      });
      if (finalized.ok) return true;

      const withMessage = finalized.error as
        { readonly message?: unknown } | null | undefined;
      const detail = withMessage?.message || String(finalized.error);
      terminal.fail(text.timerFailure);
      terminal.info(detail as string);
      await reporter?.postCommitFailure(detail as string);
      process.exitCode = 1;
      return false;
    };

    try {
      await phaseStart("protect");
      await tx.protect();
      await phaseDone("protect");

      await phaseStart("fetch");
      // Только fetch + классификация, HEAD не двигается: живая установка меняется лишь после
      // успешной сборки кандидата в worktree (см. buildCandidate в update-safety.ts).
      const update = await tx.resolveTarget();
      if (!update.changed && !force) {
        restoreReport = await tx.restoreLocalChanges();
        versions = await tx.versions();
        await phaseDone("fetch");
        if (!(await finalizeUpdate())) return;
        terminal.info(`✅ ${text.current} (${versions.afterVersion})`);
        await reporter?.complete({
          ...versions,
          changedLocal: tx.hadLocalChanges,
          restoreReport,
        });
        return;
      }
      // Живая установка ещё не тронута: HEAD на месте, юниты старые. Дальше их пишет ЭТОТ
      // CLI по шаблонам новой версии — токен, которого он не знает, уезжает в юнит как есть
      // (#191). Поэтому дерево само называет самый старый апдейтер, способный его поставить,
      // а тот, что старше, останавливается здесь и говорит, чем ставить (ADR-0003).
      const compat = update.changed
        ? await updaterCompat(
            (...args: string[]) => tx.git(...args),
            update.remote,
          )
        : ({ status: "ok" } as const);
      if (compat.status === "too-old") {
        // Тот же выход, что у «уже обновлена»: изменения возвращаются, защита снимается.
        await tx.restoreLocalChanges();
        await finalizeUpdate();
        terminal.fail(updaterTooOldMessage(compat.own, locale));
        await reporter?.updaterTooOld(compat.own);
        process.exitCode = 1;
        return;
      }
      await phaseDone("fetch");

      await phaseStart("build");
      const candidate = await tx.buildCandidate({ npm: NPM });
      const integrated = await tx.fetchAndIntegrate();
      restoreReport = await tx.restoreLocalChanges();
      versions = await tx.versions();
      migrateEnv({ quiet: true });
      // The streaming cleaner repairs cards the old frontmatter writer bloated to GBs (those
      // OOM-kill the agent and the nightly brain, so waiting for the brain is not an option).
      // The script comes from the freshly updated repo, so it is always the current version —
      // best-effort: it never fails an update.
      try {
        const vaultRel = readEnv().ASSISTANT_VAULT_DIR || "vault";
        const vaultDir = vaultRel.startsWith("/")
          ? vaultRel
          : join(ROOT, vaultRel);
        const cleanupScript = join(ROOT, "scripts/autograph/cleanup.py");
        const cleaned = ops.spawnSync(
          "uv",
          ["run", cleanupScript, ".", "--apply"],
          { cwd: vaultDir, encoding: "utf8", env: childEnv },
        );
        if (cleaned.status === 0 && !cleaned.stdout.includes(" 0 file(s)"))
          terminal.info(`🧹 ${cleaned.stdout.trim().split("\n").pop()}`);
      } catch {
        // Vault cleanup is best-effort and must not fail an update.
      }
      const promoted = candidate ? await tx.promoteCandidate() : false;
      if (!promoted) {
        if (integrated.changed) {
          const diff = await tx.git(
            "diff",
            "--name-only",
            `${versions.beforeHead}..${versions.afterHead}`,
          );
          const files = diff.stdout.split("\n");
          if (
            files.includes("package.json") ||
            files.includes("package-lock.json")
          ) {
            const install = await tx.run(NPM, [
              existsSync(join(ROOT, "package-lock.json")) ? "ci" : "install",
            ]);
            if (install.code !== 0)
              throw new Error("dependency installation failed");
          }
        }
        tx.backupOutput();
        const build = await tx.run(NPM, ["run", "build"]);
        tx.adoptOutput();
        if (build.code !== 0) throw new Error("build failed");
      }

      // Best-effort helper for an integration that has no active local service.
      await tx.run(NPM, ["i", "-g", "@googleworkspace/cli@latest"]);

      if (hasSystemd()) {
        writeUnits();
        systemd.restart(SERVICES);
        let healthy = false;
        const port = (readEnv().IVA_PORT || DEFAULT_PORT).trim();
        for (let attempt = 0; attempt < 30; attempt++) {
          const active = SERVICES.every((service) => systemd.isActive(service));
          try {
            const response = await ops.fetch(`http://127.0.0.1:${port}/`, {
              signal: AbortSignal.timeout(2000),
            });
            if (active && response.ok) {
              healthy = true;
              break;
            }
          } catch {
            // Transient health-check failures are retried until the deadline.
          }
          await ops.sleep(1000);
        }
        if (!healthy) throw new Error("health check failed");
        if (systemd.isActive(SVC_USERBOT)) {
          const frozen = cap("uv", ["pip", "freeze", "--python", VENV_PY], {
            cwd: USERBOT_DIR,
          });
          if (frozen.code !== 0 || !frozen.out)
            throw new Error(
              "userbot: не удалось сохранить dependency snapshot перед обновлением",
            );
          userbotRollbackSnapshot = join(
            tmpdir(),
            `iva-userbot-before-update-${process.pid}-${Date.now()}.txt`,
          );
          writeFileSync(userbotRollbackSnapshot, `${frozen.out}\n`, {
            mode: 0o600,
          });
          userbotUpdateAttempted = true;
          restartUserbotIfActive({ quiet: true, knownActive: true });
        }
      }

      await phaseDone("build");
      if (!(await finalizeUpdate())) return;
      const model = modelSummary(readEnv());
      terminal.info(`✅ Iva ${locale === "ru" ? "обновлена" : "updated"}`);
      terminal.info(
        `${versions.beforeVersion} → ${versions.afterVersion} · ${model.provider}/${model.model}`,
      );
      await reporter?.complete({
        ...versions,
        changedLocal: tx.hadLocalChanges,
        restoreReport,
      });
    } catch (error) {
      terminal.fail(text[state.phase][2]);
      let rollbackOk = true;
      let codeRollbackOk = true;
      try {
        await tx.rollback();
      } catch {
        rollbackOk = false;
        codeRollbackOk = false;
      }
      // Пока живые .output/node_modules не тронуты (упал кандидат или интеграция),
      // здоровые сервисы не перезапускаем.
      if (state.phase === "build" && tx.outputTouched && hasSystemd()) {
        try {
          writeUnits();
          systemd.restart(SERVICES);
        } catch {
          rollbackOk = false;
        }
        if (userbotUpdateAttempted && codeRollbackOk) {
          try {
            restartUserbotIfActive({
              quiet: true,
              knownActive: true,
              requirementsPath: userbotRollbackSnapshot,
              requireHashes: false,
            });
          } catch {
            rollbackOk = false;
          }
        }
      }
      // Та же причина, что уходит в терминал ниже: чат без неё бесполезен. Читается
      // отдельно и безопасно: брошенный null разыменовывается строкой ниже, и падать он
      // обязан ПОСЛЕ того, как чат узнал об отказе, — иначе сообщение остаётся на фазе.
      const thrown = (
        error as { readonly message?: unknown } | null | undefined
      )?.message;
      await reporter?.fail(
        state.phase,
        versions.beforeVersion,
        typeof thrown === "string" ? thrown : undefined,
      );
      const message = (error as { readonly message: unknown }).message;
      terminal.info(
        `${message as string}. ${locale === "ru" ? "Откат" : "Rollback"}: ${rollbackOk ? "OK" : "FAILED"}. ${locale === "ru" ? "Лог" : "Log"}: ${logFile}`,
      );
      process.exitCode = 1;
    } finally {
      try {
        await tx.teardownCandidate();
      } catch {
        // Candidate teardown is best-effort during final cleanup.
      }
      terminal.dispose();
      reporter?.dispose();
      ops.releaseUpdateLock(lock);
      if (userbotRollbackSnapshot)
        rmSync(userbotRollbackSnapshot, { force: true });
      await ops.removeTelegramJob(loadedJob?.path);
    }
  };
}
