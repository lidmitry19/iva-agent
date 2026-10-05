import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { dirname } from "node:path";
import { parseEnvText, writeEnvAtomicSync } from "./env-file.ts";
import { validateModelSelection } from "./model-validation.ts";
import type { ProbeEveHealthOptions } from "#lib/eve-health.ts";

type Snapshot = {
  version: number;
  existed: boolean;
  oldText: string;
  sha256: string;
};
type WriteEnv = (path: string, text: string) => void;
type Restart = (services: readonly string[]) => unknown;
type Health = (url: string) => unknown;
type ConfigSelection = {
  provider: string;
  model: string | null | undefined;
  key?: string;
  dataDir?: string;
  // Адрес эндпоинта у провайдера, чей base задаёт владелец (custom).
  base?: string;
  opencodeProtocol?: string;
};
type ConfigTransactionTarget = {
  envPath: string;
  nextText: string;
  selection: ConfigSelection;
  healthUrl: string;
  services: readonly string[];
};
type RecoverOptions = {
  restart?: Restart;
  writeEnv?: WriteEnv;
  removeJournal?: (path: string) => void;
};
type ApplyOptions = RecoverOptions & {
  validate?: (selection: ConfigSelection) => unknown;
  health?: Health;
  writeJournal?: WriteEnv;
};

const JOURNAL_VERSION = 1;
const SECRET_KEY_RE = /(KEY|TOKEN|SECRET|BEARER|PASSWORD|HASH)$/;

export const pendingConfigPath = (envPath: string): string =>
  `${envPath}.iva-config-transaction`;

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
function secretValues(...texts: Array<string | null | undefined>): string[] {
  const values = new Set<string>();
  for (const text of texts) {
    for (const [key, value] of Object.entries(parseEnvText(text ?? ""))) {
      if (SECRET_KEY_RE.test(key) && value.length >= 4) values.add(value);
    }
  }
  return [...values].sort((a, b) => b.length - a.length);
}

function redact(message: unknown, secrets: readonly string[]): string {
  let safe =
    typeof message === "string" && message
      ? message
      : message instanceof Error && message.message
        ? message.message
        : "unknown failure";
  for (const secret of secrets) safe = safe.split(secret).join("[redacted]");
  return safe.replace(/\s+/g, " ").slice(0, 500);
}

function durableRemove(path: string): void {
  rmSync(path, { force: true });
  const fd = openSync(dirname(path), "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function snapshotOf(envPath: string): Snapshot {
  const existed = existsSync(envPath);
  const oldText = existed ? readFileSync(envPath, "utf8") : "";
  return {
    version: JOURNAL_VERSION,
    existed,
    oldText,
    sha256: digest(oldText),
  };
}

function parseSnapshot(raw: string): Snapshot {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (cause) {
    throw new Error("pending configuration snapshot is invalid JSON", {
      cause,
    });
  }
  if (
    !value ||
    typeof value !== "object" ||
    (value as Partial<Snapshot>).version !== JOURNAL_VERSION ||
    typeof (value as Partial<Snapshot>).existed !== "boolean" ||
    typeof (value as Partial<Snapshot>).oldText !== "string" ||
    typeof (value as Partial<Snapshot>).sha256 !== "string" ||
    (value as Snapshot).sha256 !== digest((value as Snapshot).oldText)
  ) {
    throw new Error("pending configuration snapshot is corrupt");
  }
  return value as Snapshot;
}

function restoreSnapshot(
  envPath: string,
  snapshot: Snapshot,
  writeEnv: WriteEnv,
): void {
  if (!snapshot.existed) {
    if (existsSync(envPath)) durableRemove(envPath);
    return;
  }
  const current = existsSync(envPath) ? readFileSync(envPath, "utf8") : null;
  if (current !== snapshot.oldText) writeEnv(envPath, snapshot.oldText);
}

async function checkedRestart(
  restart: Restart,
  services: readonly string[],
): Promise<void> {
  const result = await restart(services);
  if (result === false) throw new Error("systemd restart returned failure");
}

export class ConfigTransactionError extends Error {
  declare readonly phase?: string;
  declare readonly rollbackFailed: boolean;

  constructor(
    message: string,
    {
      phase,
      rollbackFailed = false,
      cause,
    }: { phase?: string; rollbackFailed?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause });
    this.name = "ConfigTransactionError";
    this.phase = phase;
    this.rollbackFailed = rollbackFailed;
  }
}

// Опрос локального /eve/v1/health живёт в authored tree (agent/lib/eve-health.ts): туда же
// на старте смотрит сам сервер. `iva config` обязан ГРУЗИТЬСЯ на инсталле, где каталога
// agent/ нет, поэтому модуль подтягивается в том единственном вызове, которому он нужен.
// Дерево без agent/ и так не поднимет сервис: провал импорта здесь ловит тот же catch, что
// и таймаут проверки, и приводит к тому же откату конфигурации.
export async function probeEveHealth(
  url: string,
  options?: ProbeEveHealthOptions,
): Promise<void> {
  const { probeEveHealth: probe } = await import("#lib/eve-health.ts");
  return probe(url, options);
}

export async function recoverConfigTransaction(
  { envPath, services }: { envPath: string; services: readonly string[] },
  {
    restart,
    writeEnv = writeEnvAtomicSync,
    removeJournal = durableRemove,
  }: RecoverOptions = {},
): Promise<boolean> {
  const journalPath = pendingConfigPath(envPath);
  if (!existsSync(journalPath)) return false;
  if (typeof restart !== "function")
    throw new TypeError("config recovery requires restart(services)");
  const snapshot = parseSnapshot(readFileSync(journalPath, "utf8"));
  const secrets = secretValues(snapshot.oldText);
  try {
    restoreSnapshot(envPath, snapshot, writeEnv);
    await checkedRestart(restart, services);
    removeJournal(journalPath);
    return true;
  } catch (cause) {
    throw new ConfigTransactionError(
      `Configuration recovery failed: ${redact((cause as { readonly message?: unknown } | null | undefined)?.message, secrets)}. Fix systemd, then run \`iva config --recover\`.`,
      { phase: "recovery", rollbackFailed: true, cause },
    );
  }
}

export async function applyConfigTransaction(
  {
    envPath,
    nextText,
    selection,
    healthUrl,
    services,
  }: ConfigTransactionTarget,
  {
    validate = validateModelSelection,
    restart,
    health = probeEveHealth,
    writeEnv = writeEnvAtomicSync,
    writeJournal = writeEnvAtomicSync,
    removeJournal = durableRemove,
  }: ApplyOptions = {},
): Promise<{ committed: true }> {
  if (typeof restart !== "function")
    throw new TypeError("config transaction requires restart(services)");
  if (!Array.isArray(services) || services.length === 0) {
    throw new TypeError("config transaction requires at least one service");
  }
  if (typeof nextText !== "string")
    throw new TypeError("config transaction requires nextText");

  await validate(selection);

  const snapshot = snapshotOf(envPath);
  const secrets = secretValues(snapshot.oldText, nextText);
  const journalPath = pendingConfigPath(envPath);
  writeJournal(journalPath, `${JSON.stringify(snapshot)}\n`);

  let phase = "write";
  try {
    writeEnv(envPath, nextText);
    phase = "restart";
    await checkedRestart(restart, services);
    phase = "health";
    await health(healthUrl);
    phase = "commit";
    removeJournal(journalPath);
    return { committed: true };
  } catch (cause) {
    let rollbackCause = null;
    try {
      restoreSnapshot(envPath, snapshot, writeEnv);
      await checkedRestart(restart, services);
      removeJournal(journalPath);
    } catch (error) {
      rollbackCause = error;
    }

    const reason = redact(
      (cause as { readonly message?: unknown } | null | undefined)?.message,
      secrets,
    );
    if (rollbackCause) {
      const rollbackReason = redact(
        (rollbackCause as { readonly message?: unknown } | null | undefined)
          ?.message,
        secrets,
      );
      throw new ConfigTransactionError(
        `Configuration apply failed during ${phase}: ${reason}. Rollback failed: ${rollbackReason}. The old snapshot is still pending; fix systemd, then run \`iva config --recover\`.`,
        { phase, rollbackFailed: true, cause },
      );
    }
    throw new ConfigTransactionError(
      `Configuration apply failed during ${phase}: ${reason}. Previous configuration restored.`,
      { phase, rollbackFailed: false, cause },
    );
  }
}
