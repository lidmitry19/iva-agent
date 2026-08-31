import { randomBytes } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { telegramAddressFromChatKey } from "./telegram-reset.ts";

export const TELEGRAM_RESET_INTENT_VERSION = 1;
const RETIRED_ROUTING_FIELD = ["continuation", "Token"].join("");

export interface TelegramResetIntent {
  version: typeof TELEGRAM_RESET_INTENT_VERSION;
  chatKey: string;
  requestedAt: number;
}

interface TelegramResetIntentOptions {
  now?: () => number;
  nonce?: () => string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (error as { code?: unknown } | null | undefined)?.code === code;
}

function intentPath(directory: string, chatKey: string) {
  return join(
    directory,
    `${Buffer.from(chatKey, "utf8").toString("base64url")}.json`,
  );
}

function rollbackRoutingValue(chatKey: string): string {
  const address = telegramAddressFromChatKey(chatKey);
  if (address === null) {
    throw new Error(`invalid Telegram reset intent chat key: ${chatKey}`);
  }
  return `${address.chatId}:${address.messageThreadId ?? ""}:`;
}

function normalizeIntent(value: unknown, source: string): TelegramResetIntent {
  if (
    !isRecord(value) ||
    value.version !== TELEGRAM_RESET_INTENT_VERSION ||
    typeof value.chatKey !== "string" ||
    !value.chatKey ||
    !isSafeInteger(value.requestedAt) ||
    value.requestedAt < 0
  ) {
    throw new Error(`invalid Telegram reset intent in ${source}`);
  }
  return {
    version: TELEGRAM_RESET_INTENT_VERSION,
    chatKey: value.chatKey,
    requestedAt: value.requestedAt,
  };
}

async function syncDirectory(path: string) {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function ensureIntentDirectory(directory: string) {
  const parent = dirname(directory);
  await mkdir(parent, { recursive: true });
  await mkdir(directory, { recursive: true });
  await syncDirectory(parent);
}

export async function persistTelegramResetIntent(
  directory: string,
  chatKey: string,
  {
    now = Date.now,
    nonce = () => randomBytes(8).toString("hex"),
  }: TelegramResetIntentOptions = {},
) {
  const intent = normalizeIntent(
    {
      version: TELEGRAM_RESET_INTENT_VERSION,
      chatKey,
      requestedAt: now(),
    },
    "new reset request",
  );
  const diskIntent = {
    ...intent,
    // Older rollback code requires this inert field to parse the same v1 file.
    [RETIRED_ROUTING_FIELD]: rollbackRoutingValue(chatKey),
  };
  await ensureIntentDirectory(directory);
  const target = intentPath(directory, chatKey);
  const tmp = `${target}.tmp-${process.pid}-${nonce()}`;
  try {
    await writeFile(tmp, JSON.stringify(diskIntent), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    const staged = await open(tmp, "r+");
    try {
      await staged.sync();
    } finally {
      await staged.close();
    }
    await rename(tmp, target);
    await syncDirectory(directory);
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
  return intent;
}

export async function loadTelegramResetIntents(
  directory: string,
): Promise<TelegramResetIntent[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return [];
    throw error;
  }
  const intents: TelegramResetIntent[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(directory, entry.name);
    const intent = normalizeIntent(
      JSON.parse(await readFile(path, "utf8")),
      path,
    );
    if (intentPath(directory, intent.chatKey) !== path) {
      throw new Error(
        `Telegram reset intent filename does not match its chat key: ${path}`,
      );
    }
    intents.push(intent);
  }
  return intents.sort(
    (left, right) =>
      left.requestedAt - right.requestedAt ||
      left.chatKey.localeCompare(right.chatKey),
  );
}

export async function clearTelegramResetIntent(
  directory: string,
  chatKey: string,
) {
  try {
    await rm(intentPath(directory, chatKey));
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return;
    throw error;
  }
  await syncDirectory(directory);
}
