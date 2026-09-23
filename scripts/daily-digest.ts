import { buildMorningDigest } from "../agent/lib/digest.ts";
import { dataDir } from "../agent/lib/data-dir.ts";
import { saveJsonAtomic } from "../agent/lib/json-store.ts";
import { sendTelegramHtml } from "./lib/telegram-send.ts";

type DigestResult = Awaited<ReturnType<typeof buildMorningDigest>>;
type DigestDependencies = {
  build?: () => Promise<DigestResult>;
  send?: typeof sendTelegramHtml;
  save?: typeof saveJsonAtomic;
  directory?: () => string;
  now?: () => Date;
};

export async function runDigest(
  bot: string,
  chat: string,
  { build = buildMorningDigest, send = sendTelegramHtml, save = saveJsonAtomic, directory = dataDir, now = () => new Date() }: DigestDependencies = {},
): Promise<number> {
  const result = await build();
  const status = (delivery: "pending" | "sent" | "failed") => ({ at: now().toISOString(), freshness: { verified: result.verified, excluded: result.excluded, unchecked: result.unchecked }, delivery });
  await save(`${directory()}/digest-status.json`, status("pending"));
  const sent = await send(bot, chat, result.message, { trace: { source: "digest" } });
  await save(`${directory()}/digest-status.json`, status(sent.ok ? "sent" : "failed"));
  if (!sent.ok) { console.error("digest: Telegram send failed:", sent.error); return 1; }
  console.log("Digest sent to Telegram."); return 0;
}

if (import.meta.main) {
  const bot = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_DIGEST_CHAT_ID;
  if (!bot || !chat) { console.error("TELEGRAM_BOT_TOKEN and TELEGRAM_DIGEST_CHAT_ID are required"); process.exitCode = 1; }
  else process.exitCode = await runDigest(bot, chat);
}
