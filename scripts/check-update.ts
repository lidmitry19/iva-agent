import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isEntrypoint, upstreamQuery } from "./lib/version-layout.ts";
import { noticeLang } from "./lib/notice-policy.ts";
import { acquireUpdateLock } from "./lib/version-store.ts";
import { resolveDataDir } from "./lib/data-dir.ts";
import {
  gitAt,
  inspectUpstream,
  markVersionNotified,
  notificationChat,
  readNotifiedVersion,
  sendUpdateOffer,
  updateOffer,
  type GitCommand,
} from "./lib/update-check.ts";
import {
  formatWhatsNew,
  parseWhatsNew,
  RELEASE_NOTES_URL,
  whatsNewBetween,
} from "./lib/whats-new.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

type UpdateEnvironment = Record<string, string | undefined>;
type UpdateInfo = Awaited<ReturnType<typeof inspectUpstream>>;
type SendUpdateRequest = {
  token: string;
  chatId: string;
  offer: ReturnType<typeof updateOffer>;
};
type DailyUpdateOptions = {
  root?: string;
  env?: UpdateEnvironment;
  inspectImpl?: (options: {
    root: string;
    head?: string;
  }) => Promise<UpdateInfo>;
  sendImpl?: (request: SendUpdateRequest) => Promise<unknown>;
  readStateImpl?: typeof readNotifiedVersion;
  writeStateImpl?: typeof markVersionNotified;
  gitImpl?: GitCommand;
};

function dataDir(root: string, env: UpdateEnvironment): string {
  return resolveDataDir(root, env.ASSISTANT_DATA_DIR);
}

/**
 * What the offered release brings, from the README at the very commit this check already
 * fetched — no call over the network beyond the ones it made. The README is the one whose
 * language the Notice speaks (ADR-0007).
 *
 * The block is garnish and the Notice is the product: a README that will not read or parse
 * costs the block, never the message. Hence one line in the journal and an empty string out.
 */
async function whatsNewBlock({
  root,
  ref,
  locale,
  installedVersion,
  remoteVersion,
  gitImpl,
}: {
  root: string;
  ref: string | undefined;
  locale: string;
  installedVersion: string | null | undefined;
  remoteVersion: string;
  gitImpl: GitCommand;
}): Promise<string> {
  if (!ref) return "";
  const file = locale === "ru" ? "README.ru.md" : "README.md";
  try {
    const shown = await gitImpl(root, ["show", `${ref}:${file}`]);
    if (typeof shown !== "string" && shown.code !== 0)
      throw new Error(shown.stderr || `could not read ${file} at ${ref}`);
    const text = typeof shown === "string" ? shown : (shown.stdout ?? "");
    const selection = whatsNewBetween(
      parseWhatsNew(text),
      installedVersion,
      remoteVersion,
    );
    return formatWhatsNew(selection, locale, RELEASE_NOTES_URL);
  } catch (error) {
    console.error(
      `Update notice without What's New: ${error instanceof Error ? error.message : String(error)}`,
    );
    return "";
  }
}

export async function runDailyUpdateCheck({
  root = ROOT,
  env = process.env,
  inspectImpl = inspectUpstream,
  sendImpl = sendUpdateOffer,
  readStateImpl = readNotifiedVersion,
  writeStateImpl = markVersionNotified,
  gitImpl = gitAt,
}: DailyUpdateOptions = {}) {
  const token = String(env.TELEGRAM_BOT_TOKEN ?? "").trim();
  const chatId = notificationChat(env);
  if (!token || !chatId) return { status: "not-configured" as const };

  const storage = dataDir(root, env);
  // The same lock the updater itself takes, with the same rules about when a
  // holder counts as gone: two answers to that question on one file is how a
  // crashed update ends up blocking the daily check for hours.
  const lock = acquireUpdateLock(storage);
  if (!lock) return { status: "update-running" as const };
  try {
    // One answer to «which repository», for the inspection and for the README it reads:
    // on the versioned layout that is the mirror, never the install root.
    const upstream = upstreamQuery(root);
    const info = await inspectImpl(upstream);
    if (!info.hasVersionUpdate) return { status: "current" as const, info };
    if ((await readStateImpl(storage)) === info.remoteVersion) {
      return { status: "already-notified" as const, info };
    }

    // The update prompt is an Alert (ADR-0007) and speaks the one language the owner picked:
    // settings.language first, AGENT_LANGUAGE after it — the same resolver the chat uses.
    const locale = await noticeLang(env);
    const offer = updateOffer(
      info.localVersion,
      info.remoteVersion,
      locale,
      info.updaterTooOld,
    );
    // An Alert that only names two numbers leaves the owner to guess what the update
    // brings; the What's New of the offered release says it, in their language.
    const whatsNew = await whatsNewBlock({
      root: upstream.root,
      ref: info.remote,
      locale,
      installedVersion: info.localVersion,
      remoteVersion: info.remoteVersion,
      gitImpl,
    });
    const text = whatsNew ? `${offer.text}\n\n${whatsNew}` : offer.text;
    await sendImpl({ token, chatId, offer: { ...offer, text } });
    await writeStateImpl(storage, info.remoteVersion);
    return { status: "notified" as const, info };
  } finally {
    lock.release();
  }
}

export async function main(entryUrl = import.meta.url): Promise<void> {
  if (!isEntrypoint(entryUrl)) return;
  try {
    const result = await runDailyUpdateCheck();
    if (result.status === "notified") {
      console.log(`Update notification sent: v${result.info.remoteVersion}`);
    }
  } catch (error) {
    // Preserve the former JavaScript entrypoint's unchecked property access and
    // template coercion exactly; this boundary must not normalize thrown values.
    console.error(
      `Update check failed: ${(error as { message: string }).message}`,
    );
    process.exitCode = 1;
  }
}
