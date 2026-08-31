import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { VERSION_DIRECTORY_PATTERN } from "./data-dir.ts";

export const NIGHT_HEALTH_VERSION = 1;
export const NIGHT_JOBS = ["memoryRollup", "bitrixSync", "digest"] as const;
export type NightJobName = (typeof NIGHT_JOBS)[number];
export type NightJobState = "idle" | "running" | "success" | "failed";

export type NightJob = {
  state: NightJobState;
  startedAt?: string;
  finishedAt?: string;
  artifacts: string[];
  error?: string;
  mode?: "full" | "limited";
};

export type NightHealthManifest = {
  version: number;
  targetDate: string;
  runId: string;
  codeVersion: string;
  updatedAt: string;
  jobs: Record<NightJobName, NightJob>;
};

function iso(now = new Date()): string {
  return now.toISOString();
}

function dayIn(timeZone: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function previousDay(value: string): string {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day - 1));
  return date.toISOString().slice(0, 10);
}

/** The nightly run processes the completed local calendar day, never UTC "yesterday". */
export function nightTargetDate(
  timeZone = process.env.ASSISTANT_TIMEZONE || "Asia/Yekaterinburg",
  now = new Date(),
): string {
  return previousDay(dayIn(timeZone, now));
}

export function nightRunId(targetDate: string): string {
  return `night-${targetDate}`;
}

function healthDirectory(dataDir: string): string {
  return join(dataDir, "night-health");
}

export function nightManifestPath(dataDir: string, targetDate: string): string {
  return join(healthDirectory(dataDir), `${targetDate}.json`);
}

function emptyManifest(
  targetDate: string,
  codeVersion: string,
): NightHealthManifest {
  return {
    version: NIGHT_HEALTH_VERSION,
    targetDate,
    runId: nightRunId(targetDate),
    codeVersion,
    updatedAt: iso(),
    jobs: Object.fromEntries(
      NIGHT_JOBS.map((name) => [name, { state: "idle", artifacts: [] }]),
    ) as unknown as Record<NightJobName, NightJob>,
  };
}

/** Immutable installs carry the exact release+commit+overlay in their directory name. */
export function detectCodeVersion(root = process.cwd()): string {
  try {
    const release = basename(realpathSync(root));
    if (VERSION_DIRECTORY_PATTERN.test(release)) return release;
  } catch {
    // A checkout or damaged cwd can still report its package version below.
  }
  try {
    const value: unknown = JSON.parse(
      readFileSync(join(root, "package.json"), "utf8"),
    );
    const version = (value as { version?: unknown } | null)?.version;
    if (typeof version === "string" && version.trim()) return version.trim();
  } catch {
    // The explicit npm value is the final non-unknown fallback.
  }
  return process.env.npm_package_version?.trim() || "unknown";
}

function isManifest(value: unknown): value is NightHealthManifest {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<NightHealthManifest>;
  return (
    candidate.version === NIGHT_HEALTH_VERSION &&
    typeof candidate.targetDate === "string" &&
    typeof candidate.runId === "string" &&
    typeof candidate.codeVersion === "string" &&
    !!candidate.jobs &&
    NIGHT_JOBS.every((name) => {
      const job = candidate.jobs?.[name];
      return (
        !!job &&
        ["idle", "running", "success", "failed"].includes(job.state) &&
        Array.isArray(job.artifacts) &&
        job.artifacts.every((path) => typeof path === "string")
      );
    })
  );
}

function atomicJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function readNightHealth(
  dataDir: string,
  targetDate: string,
): NightHealthManifest | null {
  try {
    const value: unknown = JSON.parse(
      readFileSync(nightManifestPath(dataDir, targetDate), "utf8"),
    );
    return isManifest(value) && value.targetDate === targetDate ? value : null;
  } catch {
    return null;
  }
}

function saveNightHealth(dataDir: string, manifest: NightHealthManifest): void {
  const directory = healthDirectory(dataDir);
  atomicJson(nightManifestPath(dataDir, manifest.targetDate), manifest);
  atomicJson(join(directory, "latest.json"), manifest);
}

function cleanedError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/https?:\/\/[^\s]+/giu, "<url>")
    .replace(
      /(?:token|secret|password|authorization)\s*[=:]\s*\S+/giu,
      "$1=<redacted>",
    )
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 360);
}

export function verifyNightArtifacts(paths: readonly string[]): string | null {
  if (!paths.length) return "no result artifact was declared";
  for (const path of paths) {
    try {
      const stat = statSync(path);
      if (!stat.isFile() || stat.size === 0)
        return `artifact missing or empty: ${path}`;
      if (path.endsWith(".json")) JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return `artifact missing or corrupt: ${path}`;
    }
  }
  return null;
}

export function markNightJob(
  dataDir: string,
  job: NightJobName,
  input: {
    targetDate?: string;
    timeZone?: string;
    codeVersion?: string;
    state: "running" | "success" | "failed";
    artifacts?: readonly string[];
    error?: unknown;
    mode?: "full" | "limited";
    now?: Date;
  },
): NightHealthManifest {
  const targetDate = input.targetDate ?? nightTargetDate(input.timeZone);
  const codeVersion = input.codeVersion ?? detectCodeVersion();
  const manifest =
    readNightHealth(dataDir, targetDate) ??
    emptyManifest(targetDate, codeVersion);
  const now = iso(input.now);
  const prior = manifest.jobs[job];
  const artifacts = [...(input.artifacts ?? prior.artifacts)];
  let state: NightJobState = input.state;
  let error = input.error ? cleanedError(input.error) : undefined;
  if (state === "success") {
    const invalid = verifyNightArtifacts(artifacts);
    if (invalid) {
      state = "failed";
      error = invalid;
    }
  }
  manifest.jobs[job] = {
    state,
    startedAt: state === "running" ? now : (prior.startedAt ?? now),
    ...(state === "running" ? {} : { finishedAt: now }),
    artifacts,
    ...(error ? { error } : {}),
    ...(input.mode ? { mode: input.mode } : {}),
  };
  manifest.updatedAt = now;
  if (input.codeVersion || manifest.codeVersion === "unknown")
    manifest.codeVersion = codeVersion;
  saveNightHealth(dataDir, manifest);
  return manifest;
}

/** A watchdog must not erase the original job failure merely to report that it saw it. */
export function markNightWatchdogFailure(
  dataDir: string,
  job: NightJobName,
  input: {
    targetDate: string;
    timeZone?: string;
    artifacts?: readonly string[];
    reason: string;
    now?: Date;
  },
): NightHealthManifest {
  const existing = readNightHealth(dataDir, input.targetDate);
  if (existing?.jobs[job].state === "failed") return existing;
  return markNightJob(dataDir, job, {
    targetDate: input.targetDate,
    timeZone: input.timeZone,
    state: "failed",
    artifacts: input.artifacts ?? existing?.jobs[job].artifacts ?? [],
    error: `watchdog: ${input.reason}`,
    now: input.now,
  });
}

type NoticeEntry = {
  essence: string;
  sentAt: string;
  targetDate?: string;
  runId?: string;
};
type NoticeState = Record<string, NoticeEntry>;
function noticesPath(dataDir: string): string {
  return join(healthDirectory(dataDir), "notices.json");
}
function readNotices(dataDir: string): NoticeState {
  try {
    const value: unknown = JSON.parse(
      readFileSync(noticesPath(dataDir), "utf8"),
    );
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as NoticeState)
      : {};
  } catch {
    return {};
  }
}

function noticeEntriesForJob(
  state: NoticeState,
  job: NightJobName,
): Array<[string, NoticeEntry]> {
  return Object.entries(state).filter(
    ([key]) => key === job || key.endsWith(`:${job}`),
  );
}

function clearJobNotices(state: NoticeState, job: NightJobName): void {
  for (const [key] of noticeEntriesForJob(state, job)) delete state[key];
}

async function telegram(text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_DIGEST_CHAT_ID;
  if (!token || !chat) return false;
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chat, text }),
      },
    );
    return response.ok;
  } catch {
    return false;
  }
}

/** Failures are deduplicated by job+cleaned error; a later success emits one recovery. */
export async function notifyNightHealth(
  dataDir: string,
  manifest: NightHealthManifest,
  job: NightJobName,
  send: (text: string) => Promise<boolean> = telegram,
): Promise<void> {
  const state = readNotices(dataDir);
  const prior = noticeEntriesForJob(state, job).sort((left, right) =>
    right[1].sentAt.localeCompare(left[1].sentAt),
  )[0]?.[1];
  const current = manifest.jobs[job];
  if (current.state === "failed") {
    const essence = current.error ?? "unknown failure";
    if (prior?.essence === essence) return;
    if (
      await send(
        `⚠️ IVA night health: ${job} failed for ${manifest.targetDate} (${manifest.runId}). ${essence}`,
      )
    ) {
      clearJobNotices(state, job);
      state[job] = {
        essence,
        sentAt: iso(),
        targetDate: manifest.targetDate,
        runId: manifest.runId,
      };
      atomicJson(noticesPath(dataDir), state);
    }
    return;
  }
  if (current.state === "success" && prior) {
    if (
      await send(
        `✅ IVA night health: ${job} recovered for ${manifest.targetDate} (${manifest.runId}).`,
      )
    ) {
      clearJobNotices(state, job);
      atomicJson(noticesPath(dataDir), state);
    }
  }
}
