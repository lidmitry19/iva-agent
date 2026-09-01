import { existsSync, readFileSync, readdirSync, statfsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
// CLI обязан грузиться без authored tree и без "#lib"-маппинга
// (scripts/cli/entrypoints.test.ts), поэтому run-status и telegram-queue
// подгружаются динамически в самой проверке, а здесь — только типы.
import type { listChatStatuses } from "../../agent/lib/run-status.ts";
import type { TelegramQueueDocument } from "../lib/telegram-queue.ts";
import { pluginDirectory, pluginMount } from "../lib/plugin-build.ts";
import { tryLoadPluginCore } from "../lib/plugin-core.ts";
import { leftoverPluginDirs, pluginReadProblem } from "./plugin-cli-context.ts";
import {
  installedPluginUnits,
  mcpUnitName,
  serviceUnitName,
} from "../lib/plugin-units.ts";
import { LEGACY_BRAIN_UNITS } from "../lib/legacy-memory-units.ts";
import { classifyAgentListeners } from "../lib/listener-security.ts";
import { readMemoryMaintenanceReport } from "../lib/memory-maintenance.ts";
import {
  CATALOG,
  catalogProvider,
  providerEnvKeys,
} from "../lib/model-catalog.ts";
import { classifyRoot } from "../lib/version-layout.ts";
import {
  acquireUpdateLock,
  createVersionStore,
  KEEP,
} from "../lib/version-store.ts";
import { hasEmbeddingSource } from "../lib/memory-mode.ts";
import type { createCliRuntime } from "./runtime.ts";
import type { createCliSystemd } from "./systemd.ts";

type CliRuntime = ReturnType<typeof createCliRuntime>;
type SystemdLifecycle = ReturnType<typeof createCliSystemd>;

type DoctorDependencies = {
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly exit?: (code: number) => unknown;
  readonly log?: (...args: unknown[]) => void;
  readonly nodeVersion?: string;
  readonly telegramInboxFile?: string;
  readonly telegramQueueFile?: string;
  readonly listChatStatusesImpl?: typeof listChatStatuses;
};

type RollupEntry = {
  readonly lastSuccessAt?: unknown;
  readonly lastExitCode?: unknown;
};

type RollupStatus = Record<string, RollupEntry | null | undefined>;

/** Сколько ждём `/health` прокси: он на loopback, и медленный ответ — уже симптом. */
const HEALTH_TIMEOUT_MS = 1500;

/** Free bytes in the short units used by the installation report. */
function formatFreeSpace(bytes: number): string {
  const mb = 1024 ** 2;
  const gb = 1024 ** 3;
  return bytes >= gb
    ? `${(bytes / gb).toFixed(1)} GB`
    : `${Math.round(bytes / mb)} MB`;
}

export function createDoctorCommand(
  runtime: CliRuntime,
  systemdLifecycle: SystemdLifecycle,
  dependencies: DoctorDependencies = {},
) {
  const {
    ROOT,
    ENV_PATH,
    UNIT_DIR,
    NPM,
    SERVICES,
    BRAIN_SERVICE,
    BRAIN_TIMER,
    TIMERS,
    DEFAULT_PORT,
    C,
    ok,
    warn,
    bad,
    run,
    cap,
    hasSystemd,
    systemd,
    readEnv,
    dataDirAbs,
  } = runtime;
  const { ensureAssistantBearer, writeUnits, activateUnits, migrateEnv } =
    systemdLifecycle;
  const now = dependencies.now ?? Date.now;
  const sleep =
    dependencies.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const exit = dependencies.exit ?? ((code: number) => process.exit(code));
  const log =
    dependencies.log ?? ((...args: unknown[]) => console.log(...args));
  const nodeVersion = dependencies.nodeVersion ?? process.versions.node;
  const listStatusesOverride = dependencies.listChatStatusesImpl;

  return async function cmdDoctor(): Promise<void> {
    let okN = 0;
    let warnN = 0;
    let fixN = 0;
    let badN = 0;
    const bearerChanged = ensureAssistantBearer();
    if (bearerChanged) fixN++;
    const env = readEnv();
    // Одна выкладка данных на весь прогон: каталог не меняется под ногами, а
    // каждый лишний вызов — это ещё одно чтение .env ради того же ответа.
    const dataDirectory = dataDirAbs(env);
    const telegramInboxFile =
      dependencies.telegramInboxFile ??
      join(dataDirectory, "telegram-inbox.json");
    const telegramQueueFile =
      dependencies.telegramQueueFile ??
      join(dataDirectory, "telegram-queue.json");

    // 1. Node ≥24
    const major = parseInt(nodeVersion.split(".")[0], 10);
    if (major >= 24) {
      ok(`Node ${nodeVersion}`);
      okN++;
    } else {
      bad(`Node ${nodeVersion} < 24 — upgrade: nvm install 24`);
      badN++;
    }

    // 2. .env + required keys (the same REQUIRED logic as in scripts/setup/main.ts)
    if (!existsSync(ENV_PATH)) {
      bad(".env missing — run: iva config");
      badN++;
    } else {
      // Имя провайдера и его обязательные ключи — из того же каталога, что кнопки /model
      // и мастер: доктор не может принять имя, которого не примет рантайм (перечень имён
      // сверяет scripts/lib/model-catalog.test.ts с копией в agent/lib/model-provider.ts).
      // Неизвестное значение — отказ, а не диагностика ollama: рантайм на нём не стартует.
      const rawProvider = env.MODEL_PROVIDER ?? "ollama";
      const provider = catalogProvider(rawProvider);
      if (!provider) {
        bad(
          `Invalid MODEL_PROVIDER ${JSON.stringify(rawProvider)}; expected one of: ${Object.keys(CATALOG).join(", ")} — run: iva config`,
        );
        badN++;
      } else {
        // codex — доступ по OAuth-токену (data/codex-auth.json), у остальных — ключ в .env.
        const required = [
          ...providerEnvKeys(provider),
          "DEEPGRAM_API_KEY",
          "TELEGRAM_BOT_TOKEN",
          "TELEGRAM_ALLOWED_USER_IDS",
          "ASSISTANT_BEARER",
        ];
        const missing = required.filter((key) => !(env[key] || "").trim());
        if (
          provider.auth === "oauth" &&
          !existsSync(join(dataDirectory, "codex-auth.json"))
        )
          missing.push("OpenAI sign-in (iva login)");
        if (!missing.length) {
          ok(`.env filled in (provider: ${rawProvider})`);
          okN++;
        } else {
          bad(
            `.env incomplete, missing: ${missing.join(", ")} — run: iva config`,
          );
          badN++;
        }
      }
      // old .env without IVA_PORT (or with :3000) — migrate right here
      if (migrateEnv()) fixN++;
      // web search is optional; check the key of the SELECTED provider (SEARCH_PROVIDER)
      const searchKey: Record<string, string> = {
        tavily: "TAVILY_API_KEY",
        brave: "BRAVE_API_KEY",
        exa: "EXA_API_KEY",
        parallel: "PARALLEL_API_KEY",
      };
      const searchProvider = (env.SEARCH_PROVIDER || "tavily")
        .trim()
        .toLowerCase();
      const selectedSearchKey = searchKey[searchProvider] || searchKey.tavily;
      if (!(env[selectedSearchKey] || "").trim()) {
        warn(
          `web_search: SEARCH_PROVIDER=${searchProvider}, but ${selectedSearchKey} is not set — search won't work (iva config)`,
        );
        warnN++;
      } else {
        ok(`web_search: ${searchProvider}`);
        okN++;
      }
      // memory_search: hybrid mode needs one embedding key; base (grep) needs nothing.
      const memoryMode = (env.MEMORY_SEARCH_MODE || "grep")
        .trim()
        .toLowerCase();
      if (memoryMode === "hybrid" && !hasEmbeddingSource(env)) {
        warn(
          "memory_search: MEMORY_SEARCH_MODE=hybrid but no JINA_API_KEY/DEEPINFRA_API_KEY/MEMORY_EMBED_URL — falls back to BM25",
        );
        warnN++;
      } else {
        ok(`memory_search: ${memoryMode}`);
        okN++;
      }
    }

    // 3. Build
    if (existsSync(join(ROOT, ".output/server/index.mjs"))) {
      ok("Build in place (.output)");
      okN++;
    } else {
      warn(".output missing — building…");
      if (run(NPM, ["run", "build"]).status === 0) {
        ok("Built");
        fixN++;
      } else {
        bad("Build failed");
        badN++;
      }
    }

    // An update whose flip landed but whose restart or migrations did not: the
    // daily check cannot see it, because upstream and the active version agree.
    const install = classifyRoot(ROOT);
    const store = createVersionStore(install.home);
    const active = store.currentName();
    if (active) {
      try {
        if (store.settled() !== active) {
          warn(`update to ${active} never finished — run: iva update`);
          warnN++;
        }
      } catch {
        // Corrupt state is reported by the version cleanup below, which reads
        // the same file first and deletes nothing when it cannot be trusted.
      }
    }

    if (install.kind === "version" && active) {
      const lock = acquireUpdateLock(store.layout.data);
      if (!lock) {
        warn("update in progress — version cleanup skipped");
        warnN++;
      } else {
        try {
          const leftovers = store.sweep();
          const removed = store.gc(KEEP);
          const gone = [...leftovers, ...removed];
          if (gone.length > 0) {
            ok(`removed ${gone.join(", ")}`);
            fixN++;
          }
          const free = statfsSync(store.layout.versions);
          const freeBytes = free.bavail * free.bsize;
          ok(
            `versions on disk: ${store.list().length} (current ${active}, rollback ${store.previousName() ?? "none"}) — ${formatFreeSpace(freeBytes)} free`,
          );
          okN++;
        } catch (error) {
          bad(`version cleanup failed: ${String(error)}`);
          badN++;
        } finally {
          lock.release();
        }
      }
    }

    if (!hasSystemd()) {
      warn(
        "systemd unavailable (not Linux) — skipping service and timer checks",
      );
      return finish();
    }

    // 4. Units installed
    const present =
      existsSync(UNIT_DIR) &&
      readdirSync(UNIT_DIR).some((file) =>
        /^iva.*\.(service|timer)$/.test(file),
      );
    if (!present) {
      warn("systemd units not installed — installing…");
      try {
        writeUnits();
        activateUnits();
        ok("Units installed, enabled and active");
        fixN++;
      } catch (error) {
        bad((error as { message: string }).message);
        badN++;
      }
    } else {
      try {
        writeUnits(); // refresh: Environment=PORT syncs with the current IVA_PORT (eliminates drift)
        ok("systemd units installed (refreshed)");
        okN++;
      } catch (error) {
        bad((error as { message: string }).message);
        badN++;
      }
    }

    // 5. Services active
    for (const service of SERVICES) {
      if (systemd.isEnabled(service) && systemd.isActive(service)) {
        ok(`${service} enabled and active`);
        okN++;
      } else {
        warn(`${service} disabled or inactive — activating…`);
        try {
          systemd.resetFailed([service]);
          systemd.activate([service]);
          ok(`${service} enabled and active`);
          fixN++;
        } catch (error) {
          bad((error as { message: string }).message);
          badN++;
        }
      }
    }
    // A newly generated bearer is read only at process start. Without this restart,
    // doctor would fix the file while leaving the live Eve process unable to accept it.
    if (bearerChanged) {
      warn("iva.service needs one restart to load the new internal bearer");
      try {
        systemd.restart(["iva.service"]);
        ok("iva.service loaded the internal bearer");
        fixN++;
      } catch (error) {
        bad((error as { message: string }).message);
        badN++;
      }
    }
    // A refreshed unit does not move an already-running old process off 0.0.0.0.
    // Detect the actual socket and restart once so doctor repairs that upgrade state too.
    const port = Number((readEnv().IVA_PORT || DEFAULT_PORT).trim());
    const inspectListener = () => {
      const result = cap("ss", ["-H", "-ltn", "sport", "=", `:${port}`]);
      return result.code === 0
        ? classifyAgentListeners(result.out, port)
        : "unknown";
    };
    let listener = inspectListener();
    if (listener === "exposed") {
      warn(
        `iva.service is exposed beyond loopback on port ${port} - restarting securely`,
      );
      try {
        systemd.restart(["iva.service"]);
        for (let attempt = 0; attempt < 30; attempt++) {
          await sleep(500);
          listener = inspectListener();
          if (listener === "loopback") break;
        }
        if (listener === "loopback") {
          ok(`iva.service bound to loopback:${port}`);
          fixN++;
        } else {
          bad(`iva.service still exposed on port ${port}`);
          badN++;
        }
      } catch (error) {
        bad((error as { message: string }).message);
        badN++;
      }
    } else if (listener === "loopback") {
      ok(`iva.service bound to loopback:${port}`);
      okN++;
    } else if (listener === "absent") {
      warn(`no listener found on port ${port}`);
      warnN++;
    } else {
      warn("could not inspect listener addresses (ss unavailable)");
      warnN++;
    }

    // Background timers enabled
    let timerFailed = false;
    for (const timer of TIMERS) {
      if (systemd.isEnabled(timer) && systemd.isActive(timer)) okN++;
      else {
        warn(`${timer} disabled or inactive — enabling…`);
        try {
          systemd.activate([timer]);
          fixN++;
        } catch (error) {
          timerFailed = true;
          bad((error as { message: string }).message);
          badN++;
        }
      }
    }
    if (!timerFailed)
      ok(
        `Background timers enabled and active (${TIMERS.length}: brain + update check)`,
      );

    // A oneshot service can be inactive and still healthy; its persistent failed state is the
    // signal that the last nightly run broke. Query each one only if it is installed here.
    // The legacy pre-rename service counts too: a migration that had to keep it (see
    // removeLegacyBrainUnits) leaves it carrying the nightly vault care, and a failure there
    // costs exactly the same night as a failure of the new one.
    const nightlyServices = [
      BRAIN_SERVICE,
      ...LEGACY_BRAIN_UNITS.filter((unit) => unit.endsWith(".service")),
    ].filter((unit) => existsSync(join(UNIT_DIR, unit)));
    for (const service of nightlyServices) {
      const state = systemd.query("is-failed", service);
      if (state.code === 0 && state.out === "failed") {
        bad(
          `${service} failed — check: journalctl --user -u ${service} -n 100 --no-pager`,
        );
        badN++;
      } else {
        ok(`${service} has no failed state`);
        okN++;
      }
    }

    // daily/weekly/monthly/yearly now run as in-process eve schedules (no systemd unit of
    // their own to query for a failed state, unlike doctor above) — data/rollup-status.json
    // (scripts/lib/schedule-runner.ts) is the only record of whether they're actually firing.
    // Threshold gives each cadence a full extra cycle of slack before doctor complains:
    // 26h for the 04:00 daily slot, 8d/32d/370d for weekly/monthly/yearly respectively.
    let rollupStatus: unknown = null;
    try {
      rollupStatus = JSON.parse(
        readFileSync(join(dataDirectory, "rollup-status.json"), "utf8"),
      );
    } catch {
      // No rollup-status.json yet (fresh install, or nothing has fired yet) — not an error.
    }
    if (rollupStatus) {
      const staleAfterHours = {
        daily: 26,
        weekly: 8 * 24,
        monthly: 32 * 24,
        yearly: 370 * 24,
      };
      for (const period of ["daily", "weekly", "monthly", "yearly"] as const) {
        // "memory-<period>" — the `name` each agent/schedules/memory-*.ts passes to
        // runScheduledJob, not the bare period (see scripts/lib/schedule-runner.ts).
        const entry = (rollupStatus as RollupStatus)[`memory-${period}`];
        if (!entry) continue; // hasn't fired yet on this install (e.g. yearly, on most installs)
        if (typeof entry.lastSuccessAt === "number") {
          const ageHours = (now() - entry.lastSuccessAt) / (60 * 60 * 1000);
          const thresholdHours = staleAfterHours[period];
          if (ageHours > thresholdHours) {
            warn(
              `memory-${period} schedule hasn't succeeded in ${Math.round(ageHours)}h (> ${thresholdHours}h) — check: journalctl --user -u iva.service | grep schedule-runner`,
            );
            warnN++;
          } else {
            ok(
              `memory-${period} schedule last succeeded ${Math.round(ageHours)}h ago`,
            );
            okN++;
          }
        } else {
          warn(
            `memory-${period} schedule has never succeeded — check: journalctl --user -u iva.service | grep schedule-runner`,
          );
          warnN++;
        }
        // A recent success doesn't mean the MOST RECENT attempt was clean — e.g. it
        // succeeded, then a later catch-up retry failed and hasn't run again since.
        // Surface that even when the staleness check above is satisfied.
        if (
          typeof entry.lastExitCode === "number" &&
          entry.lastExitCode !== 0
        ) {
          warn(
            `memory-${period} schedule's last run exited ${entry.lastExitCode} — check: journalctl --user -u iva.service | grep schedule-runner`,
          );
          warnN++;
        }
      }
    }

    // The queue loader normally repairs pending/corrupt files. Doctor only observes them,
    // so its injected file operations suppress recovery and quarantine writes.
    let queueModule: typeof import("../lib/telegram-queue.ts") | null = null;
    try {
      queueModule = await import("../lib/telegram-queue.ts");
    } catch {
      // Без "#lib"-маппинга (урезанная установка) модуль очередей недоступен —
      // проверка затора моста в этой среде честно пропускается.
    }
    const bridgeDocuments: TelegramQueueDocument[] = [];
    let bridgeUnreadable = false;
    if (queueModule !== null) {
      const { loadQueueFile, TELEGRAM_QUEUE_ACK_PENDING_SUFFIX } = queueModule;
      const loadBridgeQueue = async (file: string) => {
        const raw = await readFile(file, "utf8");
        if (raw.length === 0) return null;
        return (
          await loadQueueFile(file, {
            strict: true,
            readFileImpl: async (candidate, encoding) => {
              if (candidate.endsWith(TELEGRAM_QUEUE_ACK_PENDING_SUFFIX)) {
                throw Object.assign(
                  new Error("pending recovery is read-only"),
                  { code: "ENOENT" },
                );
              }
              if (candidate === file) return raw;
              return readFile(candidate, encoding);
            },
            renameImpl: () => Promise.resolve(),
          })
        ).document;
      };
      for (const file of [telegramInboxFile, telegramQueueFile]) {
        try {
          const document = await loadBridgeQueue(file);
          if (document) bridgeDocuments.push(document);
        } catch (error) {
          if (
            (error as NodeJS.ErrnoException | null | undefined)?.code ===
            "ENOENT"
          ) {
            continue;
          }
          warn(
            `bridge backlog: ${file} unreadable — check: journalctl --user -u iva-telegram-poll`,
          );
          warnN++;
          bridgeUnreadable = true;
        }
      }
    }
    let statuses: ReturnType<typeof listChatStatuses> = [];
    let staleRunMs: number | null = null;
    try {
      const runStatus = await import("../../agent/lib/run-status.ts");
      statuses = (listStatusesOverride ?? runStatus.listChatStatuses)();
      staleRunMs = runStatus.RUN_STALE_MS;
    } catch {
      // Authored tree или run-status каталог недоступны (CLI обязан грузиться
      // и без них) — протухшие чаты в этой среде проверить нечем.
    }
    const checkedAt = now();
    const stuckChats =
      staleRunMs === null
        ? 0
        : statuses.filter(
            ({ status }) =>
              status.status === "running" &&
              (typeof status.updatedAt !== "number" ||
                checkedAt - status.updatedAt > staleRunMs),
          ).length;
    let itemCount = 0;
    let oldestEnqueuedAt: number | null = null;
    for (const document of bridgeDocuments) {
      if (queueModule === null) break;
      for (const key of queueModule.queueKeys(document)) {
        for (const item of document.queues[key]) {
          itemCount++;
          if (
            typeof item.enqueuedAt === "number" &&
            Number.isFinite(item.enqueuedAt) &&
            (oldestEnqueuedAt === null || item.enqueuedAt < oldestEnqueuedAt)
          ) {
            oldestEnqueuedAt = item.enqueuedAt;
          }
        }
      }
    }
    const oldestAgeMs =
      itemCount > 0 && oldestEnqueuedAt !== null
        ? checkedAt - oldestEnqueuedAt
        : 0;
    if (stuckChats > 0 || oldestAgeMs > 600_000) {
      const details = [
        ...(stuckChats > 0 ? [`${stuckChats} stuck chat(s)`] : []),
        ...(oldestAgeMs > 600_000
          ? [`oldest item ${Math.round(oldestAgeMs / 60_000)}m old`]
          : []),
      ].join(", ");
      warn(
        `bridge backlog: ${details} — check: journalctl --user -u iva-telegram-poll; use /stop or iva restart`,
      );
      warnN++;
    } else if (!bridgeUnreadable) {
      ok("bridge backlog: clear");
      okN++;
    }

    // 6. Vault + git origin (report only — we don't initiate git operations)
    const vaultRel = env.ASSISTANT_VAULT_DIR || "vault";
    const vaultPath = vaultRel.startsWith("/")
      ? vaultRel
      : join(ROOT, vaultRel);
    if (!existsSync(vaultPath)) {
      warn(
        `vault not found (${vaultPath}) — created on first memory or: npm run init-vault`,
      );
      warnN++;
    } else if (
      cap("git", ["-C", vaultPath, "remote", "get-url", "origin"]).out
    ) {
      ok("vault + git origin");
      okN++;
    } else {
      warn(
        `vault without git origin — memory backup not configured:\n    gh repo create <user>/iva-vault --private --source="${vaultPath}" --remote=origin --push`,
      );
      warnN++;
    }

    // enforce-report.json is produced by iva-brain.service, so only complain about
    // missing/stale output when that timer is enabled. A fresh report is still useful either way.
    const maintenanceTimerEnabled = systemd.isEnabled(BRAIN_TIMER);
    const maintenanceReport = readMemoryMaintenanceReport(
      join(vaultPath, ".graph/enforce-report.json"),
    );
    if (maintenanceReport.status === "fresh") {
      if (maintenanceReport.problems.length) {
        warn(
          `ночной maintenance сообщает о проблемах: ${maintenanceReport.problems
            .map(({ key, count }) => `${key}=${count}`)
            .join(", ")}`,
        );
        warnN++;
      } else {
        ok("Ночной maintenance-отчёт свежий, проблем нет");
        okN++;
      }
    } else if (maintenanceTimerEnabled) {
      if (maintenanceReport.status === "invalid")
        warn("ночной maintenance оставил нечитаемый отчёт");
      else warn("ночной maintenance давно не отчитывался");
      warnN++;
    }

    return finish();

    /**
     * Есть ли код плагина в версии, которая работает. `null` — версий тут нет вовсе
     * (development checkout): сборка плагинов там не при чём, и говорить не о чем.
     */
    function codeBuiltIntoVersion(name: string): boolean | null {
      if (install.kind !== "version") return null;
      const store = createVersionStore(install.home);
      const active = store.currentName();
      if (!active) return null;
      const dir = join(store.layout.versions, active);
      return (
        existsSync(join(dir, pluginMount(name))) &&
        existsSync(join(dir, pluginDirectory(name)))
      );
    }

    /**
     * Отвечает ли MCP proxy на `/health`. Юнит может быть active и при мёртвом
     * сервере за ним — прокси уходит вслед за ребёнком, но между падением и рестартом
     * есть окно, и «active» о нём не знает. Bearer здесь не нужен: `/health` отвечает
     * без него именно для этой проверки.
     */
    async function proxyHealthy(port: number): Promise<boolean> {
      try {
        const answer = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
        });
        if (!answer.ok) return false;
        const body: unknown = await answer.json();
        return (
          typeof body === "object" && body !== null && "ok" in body && !!body.ok
        );
      } catch {
        return false;
      }
    }

    async function checkPlugins(): Promise<void> {
      // Плагины читает authored tree, а доктор обязан работать и на установке, где
      // его нет (ADR-0003) — отсюда загрузка по требованию и честная строка вместо
      // падения, когда загружать нечего.
      const core = await tryLoadPluginCore();
      if (!core) {
        warn(
          "plugins not checked: the agent tree is missing — run: iva update",
        );
        warnN++;
        return;
      }
      const { readPlugin } = core.reader;
      const { pluginRoot, pluginsDir, readPluginsStateSafe } = core.store;
      const directory = pluginsDir(dataDirectory);
      const { state, damaged } = await readPluginsStateSafe(dataDirectory);
      if (damaged) {
        bad(`plugins.json is unusable: ${damaged.message}`);
        badN++;
        return;
      }
      const leftovers = new Set(leftoverPluginDirs(directory));
      const folders = existsSync(directory)
        ? readdirSync(directory, { withFileTypes: true })
            .filter(
              (entry) =>
                entry.isDirectory() &&
                !entry.name.startsWith(".") &&
                !leftovers.has(entry.name),
            )
            .map((entry) => entry.name)
        : [];
      // Юниты плагинов, которые сейчас на диске: их читаем до раннего выхода, иначе
      // юнит, оставшийся от снятого плагина, на пустой установке никто бы не назвал.
      const onDisk = hasSystemd() ? installedPluginUnits(UNIT_DIR) : [];
      // Плагинов нет вообще — доктору сказать нечего, и молчание здесь честнее
      // строки «0 плагинов» в отчёте установки, которая их никогда не видела.
      if (
        state.plugins.length === 0 &&
        folders.length === 0 &&
        leftovers.size === 0 &&
        onDisk.length === 0
      )
        return;

      /**
       * Юниты, которые ДОЛЖНЫ быть: пересечение выданных портов с тем, что плагин
       * объявляет СЕЙЧАС. Порт из `plugins.json` не отбирается никогда (он в юните и в
       * connection-файле), поэтому список только по нему обещал бы юнит серверу,
       * которого в `mcp.json` больше нет, — и `sync` не смог бы этого починить.
       */
      const expected = new Map<string, { plugin: string; port?: number }>();
      for (const entry of state.plugins) {
        const root = pluginRoot(dataDirectory, entry.name);
        if (!existsSync(root)) {
          bad(
            `plugin ${entry.name} is missing from data/custom/plugins/ — run: iva plugin sync`,
          );
          badN++;
          continue;
        }
        const report = await readPlugin(root);
        if (!report.manifest) {
          bad(
            `plugin ${entry.name} is unreadable: ${pluginReadProblem(report)}`,
          );
          badN++;
          continue;
        }
        for (const line of report.diagnostics) {
          warn(`plugin ${entry.name}: ${line}`);
          warnN++;
        }
        const parts = [`${report.skills.length} skills`];
        if (report.code) parts.push("code");
        const servers = Object.keys(report.mcp).length;
        if (servers) parts.push(`${servers} mcp`);
        ok(
          `plugin ${entry.name}${entry.enabled ? "" : " (disabled)"}: ${parts.join(", ")}`,
        );
        okN++;
        if (entry.enabled && entry.trusted) {
          for (const [server, ports] of Object.entries(entry.mcp ?? {})) {
            if (report.mcp[server]?.type !== "stdio") continue;
            expected.set(mcpUnitName(entry.name, server), {
              plugin: entry.name,
              port: ports.port,
            });
          }
          for (const service of Object.keys(entry.services ?? {})) {
            if (!report.services[service]) continue;
            expected.set(serviceUnitName(entry.name, service), {
              plugin: entry.name,
            });
          }
        }
        // Код плагина живёт в версии, а не в папке (ADR-0009): запись «включён» без
        // сборки в работающей версии значит, что тулов плагина у агента нет.
        if (report.code && entry.enabled) {
          const built = codeBuiltIntoVersion(entry.name);
          if (built === false) {
            warn(
              `plugin ${entry.name}: built into current version: no — run: iva update`,
            );
            warnN++;
          } else if (built === true) {
            ok(`plugin ${entry.name}: built into current version: yes`);
            okN++;
          }
        }
      }

      // Юниты плагинов: те, что должны быть (собраны выше, по отчёту плюс выданным
      // портам), и те, что лежат лишними.
      if (hasSystemd()) {
        for (const [unit, about] of [...expected].sort(([a], [b]) =>
          a < b ? -1 : 1,
        )) {
          if (!existsSync(join(UNIT_DIR, unit))) {
            warn(
              `plugin ${about.plugin}: ${unit} is missing — run: iva plugin sync`,
            );
            warnN++;
            continue;
          }
          if (!systemd.isActive(unit)) {
            bad(
              `plugin ${about.plugin}: ${unit} is not running — check: journalctl --user -u ${unit} -n 100 --no-pager`,
            );
            badN++;
            continue;
          }
          // Живой прокси обязан ещё и отвечать: юнит active говорит только о процессе.
          if (about.port !== undefined) {
            if (await proxyHealthy(about.port)) {
              ok(
                `plugin ${about.plugin}: ${unit} answers on 127.0.0.1:${about.port}`,
              );
              okN++;
            } else {
              warn(
                `plugin ${about.plugin}: ${unit} runs but does not answer on 127.0.0.1:${about.port} — check: journalctl --user -u ${unit} -n 100 --no-pager`,
              );
              warnN++;
            }
            continue;
          }
          ok(`plugin ${about.plugin}: ${unit} running`);
          okN++;
        }
        for (const unit of onDisk) {
          if (expected.has(unit)) continue;
          warn(
            `${unit} belongs to no enabled and trusted plugin — run: iva plugin sync`,
          );
          warnN++;
        }
      } else if (expected.size > 0) {
        warn(
          `${expected.size} plugin unit(s) are not checked: systemd is not available here`,
        );
        warnN++;
      }

      for (const name of folders) {
        if (state.plugins.some((entry) => entry.name === name)) continue;
        warn(
          `plugin folder ${name} is not in plugins.json — run: iva plugin sync`,
        );
        warnN++;
      }
      for (const name of leftovers) {
        warn(
          `plugin folder ${name} is a leftover of an interrupted install — run: iva plugin sync`,
        );
        warnN++;
      }
    }

    // Plugins (ADR-0009) идут последними и в обоих выходах доктора: манифесты,
    // plugins.json, сборка кода в работающей версии и юниты — MCP proxy с его
    // `/health` и сервисы плагина.
    async function finish(): Promise<void> {
      await checkPlugins();
      log();
      log(
        `${C.b}Summary:${C.x} ${C.g}${okN} ok${C.x} · ${C.y}${warnN} warn${C.x} · ${C.c}${fixN} fixed${C.x} · ${C.r}${badN} fail${C.x}`,
      );
      exit(badN > 0 ? 1 : 0);
    }
  };
}
