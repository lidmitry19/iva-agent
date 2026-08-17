const UNIT_RE = /^[A-Za-z0-9_.@:-]+$/;

/**
 * One `ExecStart=` argument, quoted the way systemd reads it. `$` and `%` are doubled
 * because systemd expands both before the process ever starts, and a path with a NUL or
 * a newline in it is refused: the unit file is line-based, and a value that breaks the
 * line writes a directive nobody authored.
 */
export function systemdExecArgument(value: string): string {
  if (/[\0\r\n]/u.test(value))
    throw new Error("systemd argument contains NUL or a newline");
  let escaped = "";
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (character === "\\") escaped += "\\\\";
    else if (character === '"') escaped += '\\"';
    else if (character === "$") escaped += "$$";
    else if (character === "%") escaped += "%%";
    else if (code < 0x20 || code === 0x7f)
      escaped += `\\x${code.toString(16).padStart(2, "0")}`;
    else escaped += character;
  }
  return `"${escaped}"`;
}

interface CommandResult {
  readonly code?: number | null;
  readonly status?: number | null;
  readonly out?: string | Buffer;
  readonly stdout?: string | Buffer;
}

interface NormalizedResult {
  readonly code: number;
  readonly out: string;
}

interface SystemdControlOptions {
  readonly run: (args: readonly string[]) => CommandResult;
}

interface CleanupOptions {
  readonly units: readonly string[];
  readonly disable: (unit: string) => unknown;
  readonly remove: (unit: string) => unknown;
  readonly reload: () => unknown;
  readonly reset: () => unknown;
}

function errorMessage(error: unknown): string {
  const message = (error as { readonly message?: unknown } | null | undefined)
    ?.message;
  return String(message || error);
}

function safeUnit(unit: string): string {
  if (!UNIT_RE.test(unit)) throw new Error(`invalid systemd unit: ${unit}`);
  return unit;
}

function resultOf(result: CommandResult | undefined): NormalizedResult {
  return {
    code: result?.code ?? result?.status ?? 1,
    out: String(result?.out ?? result?.stdout ?? "").trim(),
  };
}

function journalHint(unit: string): string {
  return `journalctl --user -u ${safeUnit(unit)} -n 100 --no-pager`;
}

export class SystemdControlError extends Error {
  declare readonly unit: string | undefined;
  declare readonly code: number | undefined;

  constructor(
    message: string,
    { unit, code }: { unit?: string; code?: number } = {},
  ) {
    const suffix = unit ? ` Check: ${journalHint(unit)}` : "";
    super(`${message}${code === undefined ? "" : ` (exit ${code})`}.${suffix}`);
    this.name = "SystemdControlError";
    this.unit = unit;
    this.code = code;
  }
}

export function cleanupSystemdUnits({
  units,
  disable,
  remove,
  reload,
  reset,
}: CleanupOptions): string[] {
  const errors: Error[] = [];
  const attempt = (label: string, action: () => unknown): void => {
    try {
      action();
    } catch (cause) {
      errors.push(new Error(`${label}: ${errorMessage(cause)}`, { cause }));
    }
  };

  const checkedUnits = units.map(safeUnit);
  for (const unit of checkedUnits)
    attempt(`disable ${unit}`, () => disable(unit));
  for (const unit of checkedUnits)
    attempt(`remove ${unit}`, () => remove(unit));
  attempt("daemon-reload", reload);
  attempt("reset-failed", reset);

  if (errors.length > 0) {
    const shown = errors
      .slice(0, 8)
      .map((error) => error.message.replace(/\s+/g, " ").slice(0, 240));
    const omitted = errors.length - shown.length;
    const detail = `${shown.join("; ")}${omitted > 0 ? `; ${omitted} more failure(s)` : ""}`;
    throw new AggregateError(errors, `systemd unit cleanup failed: ${detail}`);
  }
  return checkedUnits;
}

export function createSystemdControl({ run }: SystemdControlOptions) {
  if (typeof run !== "function")
    throw new TypeError("systemd control requires run(args)");

  const query = (...args: string[]): NormalizedResult => resultOf(run(args));

  function mutate(args: string[], unit?: string): NormalizedResult {
    const result = query(...args);
    if (result.code !== 0) {
      throw new SystemdControlError(
        `systemctl --user ${args.join(" ")} failed`,
        {
          unit,
          code: result.code,
        },
      );
    }
    return result;
  }

  function isEnabled(unit: string): boolean {
    safeUnit(unit);
    const result = query("is-enabled", unit);
    return result.code === 0 && result.out === "enabled";
  }

  function isActive(unit: string): boolean {
    safeUnit(unit);
    const result = query("is-active", unit);
    return result.code === 0 && result.out === "active";
  }

  function requireEnabledActive(unit: string): void {
    safeUnit(unit);
    if (!isEnabled(unit)) {
      throw new SystemdControlError(`${unit} did not become enabled`, { unit });
    }
    if (!isActive(unit)) {
      throw new SystemdControlError(`${unit} did not become active`, { unit });
    }
  }

  return {
    query,
    isEnabled,
    isActive,
    activate(units: readonly string[]): void {
      for (const unit of units) {
        safeUnit(unit);
        mutate(["enable", "--now", unit], unit);
        requireEnabledActive(unit);
      }
    },
    restart(units: readonly string[]): void {
      for (const unit of units) {
        safeUnit(unit);
        mutate(["restart", unit], unit);
        if (!isActive(unit)) {
          throw new SystemdControlError(
            `${unit} did not become active after restart`,
            { unit },
          );
        }
      }
    },
    stop(units: readonly string[]): void {
      for (const unit of units) {
        safeUnit(unit);
        mutate(["stop", unit], unit);
      }
    },
    disableNow(units: readonly string[]): void {
      for (const unit of units) {
        safeUnit(unit);
        mutate(["disable", "--now", unit], unit);
      }
    },
    resetFailed(units: readonly string[] = []): NormalizedResult | void {
      if (units.length === 0) return mutate(["reset-failed"]);
      for (const unit of units) {
        safeUnit(unit);
        mutate(["reset-failed", unit], unit);
      }
    },
    daemonReload() {
      return mutate(["daemon-reload"]);
    },
  };
}
