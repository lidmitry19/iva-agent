#!/usr/bin/env node
import "./lib/ts-esm-hooks.ts";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { resolveDataDir } from "./lib/data-dir.ts";
import {
  markNightJob,
  nightTargetDate,
  notifyNightHealth,
} from "./lib/night-health.ts";
import { writeFileAtomicSync } from "#lib/fs-atomic.ts";
import { isEntrypoint } from "./lib/version-layout.ts";

type BitrixMetadata = {
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastError?: string | null;
};

type BitrixFailure = { taskId: string; code: string };

/** Keep alerts actionable without exposing task titles or any Bitrix payload. */
export function bitrixFailureMessage(failed: readonly BitrixFailure[]): string {
  const shown = failed
    .slice(0, 5)
    .map(({ taskId, code }) => `${taskId}:${code}`)
    .join(", ");
  const remaining = failed.length > 5 ? `, +${failed.length - 5} more` : "";
  return `daily sync has ${failed.length} failed task(s): ${shown}${remaining}`;
}

function metadataPath(dataDir: string): string {
  return join(dataDir, "bitrix-sync", "health.json");
}

function readMetadata(path: string): BitrixMetadata {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
  } catch {
    return {};
  }
}

function writeMetadata(path: string, patch: BitrixMetadata): void {
  writeFileAtomicSync(
    path,
    `${JSON.stringify({ ...readMetadata(path), ...patch }, null, 2)}\n`,
  );
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

/** Package-level runner. The systemd unit invokes this through `iva bitrix`, never this .ts file. */
export async function runBitrixSync(args: readonly string[]): Promise<void> {
  const dataDir = resolveDataDir(process.cwd());
  const timeZone = process.env.ASSISTANT_TIMEZONE ?? "Asia/Yekaterinburg";
  const targetDate = nightTargetDate(timeZone);
  const cacheHealth = metadataPath(dataDir);
  const nightly = args.includes("--daily");
  if (nightly)
    markNightJob(dataDir, "bitrixSync", {
      targetDate,
      timeZone,
      state: "running",
      artifacts: [cacheHealth],
    });
  try {
    writeMetadata(cacheHealth, {
      lastAttemptAt: new Date().toISOString(),
      lastError: null,
    });
    const { BitrixTaskService } = await import("../agent/bitrix/service.ts");
    const service = new BitrixTaskService();
    if (args.includes("--health")) {
      console.log(
        JSON.stringify({ operation: "health", ...(await service.health()) }),
      );
      return;
    }
    const taskId = valueAfter(args, "--task");
    if (taskId) {
      const result = await service.syncTask(taskId);
      writeMetadata(cacheHealth, {
        lastSuccessAt: new Date().toISOString(),
        lastError: null,
      });
      console.log(
        JSON.stringify({
          operation: "sync_task",
          taskId: result.taskId,
          result: result.outcome,
          syncedAt: result.syncedAt,
        }),
      );
      return;
    }
    if (!nightly)
      throw new Error("Usage: bitrix sync --health | --task <id> | --daily");
    const result = await service.syncDaily(3);
    console.log(JSON.stringify({ operation: "daily_sync", ...result }));
    if (result.failed.length)
      throw new Error(bitrixFailureMessage(result.failed));
    writeMetadata(cacheHealth, {
      lastSuccessAt: new Date().toISOString(),
      lastError: null,
    });
    const manifest = markNightJob(dataDir, "bitrixSync", {
      targetDate,
      timeZone,
      state: "success",
      artifacts: [cacheHealth],
    });
    await notifyNightHealth(dataDir, manifest, "bitrixSync");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    writeMetadata(cacheHealth, {
      lastAttemptAt: new Date().toISOString(),
      lastError: detail,
    });
    if (nightly) {
      const manifest = markNightJob(dataDir, "bitrixSync", {
        targetDate,
        timeZone,
        state: "failed",
        artifacts: [cacheHealth],
        error,
      });
      await notifyNightHealth(dataDir, manifest, "bitrixSync");
    }
    throw error;
  }
}

if (isEntrypoint(import.meta.url)) {
  runBitrixSync(process.argv.slice(2)).catch((error: unknown) => {
    console.error(
      JSON.stringify({
        operation: "bitrix_sync",
        result: "failed",
        code: "unexpected_error",
      }),
    );
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
