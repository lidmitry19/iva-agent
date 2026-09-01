// Scheduled morning digest. A fluent answer from stale memory is worse than no plan.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "eve/client";
import { tr } from "#lib/i18n.ts";
import { writtenInLanguage } from "./lib/notice-policy.ts";
import { sendTelegramHtml } from "./lib/telegram-send.ts";
import { resolveDataDir } from "./lib/data-dir.ts";
import {
  markNightJob,
  nightManifestPath,
  nightTargetDate,
  notifyNightHealth,
  readNightHealth,
} from "./lib/night-health.ts";
import { writeFileAtomicSync } from "#lib/fs-atomic.ts";

const PORT = process.env.IVA_PORT ?? "8723";
const HOST = process.env.ASSISTANT_HOST ?? `http://127.0.0.1:${PORT}`;
const BOT = process.env.TELEGRAM_BOT_TOKEN;
const CHAT = process.env.TELEGRAM_DIGEST_CHAT_ID;
const BEARER = process.env.ASSISTANT_BEARER;
const DATA_DIR = resolveDataDir(process.cwd());
const TIME_ZONE = process.env.ASSISTANT_TIMEZONE ?? "Asia/Yekaterinburg";
const targetDate = nightTargetDate(TIME_ZONE);
const receiptPath = join(DATA_DIR, "night-health", `digest-${targetDate}.json`);

async function sendDiagnostic(text: string): Promise<void> {
  if (!BOT || !CHAT) return;
  await fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT, text }),
  }).catch(() => undefined);
}

async function main(): Promise<void> {
  if (!BOT || !CHAT)
    throw new Error(
      "TELEGRAM_BOT_TOKEN and TELEGRAM_DIGEST_CHAT_ID are required",
    );
  markNightJob(DATA_DIR, "digest", {
    targetDate,
    timeZone: TIME_ZONE,
    state: "running",
    artifacts: [receiptPath],
  });
  const night = readNightHealth(DATA_DIR, targetDate);
  if (night?.jobs.memoryRollup.state !== "success") {
    const reason = night
      ? `memoryRollup=${night.jobs.memoryRollup.state}${night.jobs.memoryRollup.error ? ` (${night.jobs.memoryRollup.error})` : ""}`
      : "night health manifest is missing or corrupt";
    const manifest = markNightJob(DATA_DIR, "digest", {
      targetDate,
      timeZone: TIME_ZONE,
      state: "failed",
      artifacts: [receiptPath],
      error: `ordinary digest blocked: ${reason}`,
    });
    await notifyNightHealth(DATA_DIR, manifest, "digest");
    await sendDiagnostic(
      `⚠️ IVA morning digest for ${targetDate} was not sent: ${reason}. Check /status and iva doctor.`,
    );
    process.exitCode = 1;
    return;
  }

  const bitrixAvailable = night.jobs.bitrixSync.state === "success";
  const client = new Client({
    host: HOST,
    ...(BEARER ? { auth: { bearer: () => Promise.resolve(BEARER) } } : {}),
  });
  const bitrixRule = bitrixAvailable
    ? "Bitrix sync for this run is healthy."
    : "IMPORTANT: Bitrix sync is unavailable for this run. Produce a limited digest from fresh memory only, begin with a clear Bitrix-unavailable warning, and DO NOT infer overdue tasks, deadlines, or task status from any Bitrix cache.";
  const { response, session } = await client.sessions.create({
    message:
      "Load the morning-digest skill and build the morning digest for my tasks. " +
      `This digest uses night run ${night.runId} for completed date ${targetDate}. ${bitrixRule} ` +
      `Return the digest ${writtenInLanguage(tr)}. ` +
      "Return the digest as the final text of this turn. Do not send it anywhere yourself: no rich messages, no digest chat, no Telegram tools. Only the finished digest text, no preamble.",
  });
  try {
    const result = await response.result();
    if (result.status === "failed" || !result.message)
      throw new Error(
        `agent did not return a digest (status=${result.status})`,
      );
    const delivered = await sendTelegramHtml(BOT, CHAT, result.message, {
      trace: { session: response.sessionId, source: "digest" },
    });
    if (delivered.fellBack) {
      try {
        await session.send(
          `The last digest failed Telegram parse_mode=HTML (${delivered.error}) and was sent as plain text — ` +
            "format more simply next time: **bold**, `code`, lists, no raw HTML.",
        );
      } catch (error) {
        console.error("digest: format feedback failed:", error);
      }
    }
    if (!delivered.ok)
      throw new Error(`Telegram send failed: ${delivered.error}`);
    mkdirSync(join(DATA_DIR, "night-health"), {
      recursive: true,
      mode: 0o700,
    });
    writeFileAtomicSync(
      receiptPath,
      `${JSON.stringify({
        targetDate,
        runId: night.runId,
        deliveredAt: new Date().toISOString(),
        mode: bitrixAvailable ? "full" : "limited",
      })}\n`,
    );
    const manifest = markNightJob(DATA_DIR, "digest", {
      targetDate,
      timeZone: TIME_ZONE,
      state: "success",
      artifacts: [receiptPath, nightManifestPath(DATA_DIR, targetDate)],
      mode: bitrixAvailable ? "full" : "limited",
    });
    await notifyNightHealth(DATA_DIR, manifest, "digest");
    console.log(
      `Digest sent to Telegram (runId=${night.runId}, targetDate=${targetDate}, mode=${bitrixAvailable ? "full" : "limited"}).`,
    );
  } finally {
    try {
      await session.reset({ reason: "Daily digest finished" });
    } catch (error) {
      console.error("digest: session reset failed:", error);
    }
  }
}

main().catch(async (error: unknown) => {
  const manifest = markNightJob(DATA_DIR, "digest", {
    targetDate,
    timeZone: TIME_ZONE,
    state: "failed",
    artifacts: [receiptPath],
    error,
  });
  await notifyNightHealth(DATA_DIR, manifest, "digest");
  console.error("digest:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
