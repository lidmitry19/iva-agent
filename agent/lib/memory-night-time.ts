import { readFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_MEMORY_NIGHT_TIME = "04:00";
export const MEMORY_NIGHT_CONFIG_FILE = "iva-memory-night.json";
// Written only into the disposable build root. Runtime reads the promoted .output copy.
export const MEMORY_NIGHT_BUILD_FILE = ".iva-memory-night-build.json";
const SCHEMA = "iva-memory-night/v1";

export function resolveMemoryNightTime(raw: string | undefined): string {
  if (raw === undefined) return DEFAULT_MEMORY_NIGHT_TIME;
  if (/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(raw)) return raw;
  throw new Error("MEMORY_NIGHT_TIME must be HH:mm (00:00..23:59)");
}

export function memoryNightCron(time: string): string {
  const [hour, minute] = resolveMemoryNightTime(time).split(":").map(Number);
  return `${minute} ${hour} * * *`;
}

export function memoryNightBuildSettings(time: string): string {
  return `${JSON.stringify({ schema: SCHEMA, time: resolveMemoryNightTime(time) })}\n`;
}

function parseSettings(text: string): string {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("invalid night build settings");
  const settings = value as Record<string, unknown>;
  if (settings.schema !== SCHEMA || typeof settings.time !== "string")
    throw new Error("invalid night build settings");
  return resolveMemoryNightTime(settings.time);
}

/** The compiled clock is authoritative. Editing runtime env alone never moves it. */
export function activeMemoryNightTime(root = process.cwd()): string {
  for (const file of [
    join(root, MEMORY_NIGHT_BUILD_FILE),
    join(root, ".output", MEMORY_NIGHT_CONFIG_FILE),
  ]) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error(
        "Cannot read night build settings; rebuild with iva update --force",
        { cause: error },
      );
    }
    try {
      return parseSettings(text);
    } catch (error) {
      throw new Error(
        "Invalid night build settings; rebuild with iva update --force",
        { cause: error },
      );
    }
  }
  // Builds predating this setting always shipped 04:00. No runtime env fallback.
  return DEFAULT_MEMORY_NIGHT_TIME;
}

export function pendingMemoryNightTime(
  raw: string | undefined,
  active = activeMemoryNightTime(),
): string | null {
  const requested = resolveMemoryNightTime(raw);
  return requested === active ? null : requested;
}
