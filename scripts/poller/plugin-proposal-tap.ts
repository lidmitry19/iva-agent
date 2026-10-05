// Тап «Установить» на предложении плагина (ADR-0009): Bridge забирает копию предложения,
// сверяет её хеш дерева и запускает `iva plugin install-proposal` своим юнитом, тем же способом,
// что `/update`. Итог установки шлёт сам установщик: он переживает перезапуск моста, который
// устроит сборка. Отсюда владелец слышит только отказ до запуска.
//
// Кто тапнул и где — решает `control.ts` до вызова: сюда доходит только Allowlist в личном чате.
import { pluginTreeDigest } from "#lib/plugin-reader.ts";
import {
  notInstalledText,
  proposalsDir,
  returnProposal,
  staleReason,
  takeProposal,
} from "../lib/plugin-proposal.ts";
import { noticeTranslator } from "../lib/notice-policy.ts";
import { DATA_DIR, log } from "./config.ts";
import { reply } from "./transport.ts";
import { launchIvaCommand } from "./update-flow.ts";

export type PluginTap = { readonly digest12: string; readonly chatId: number };

export type PluginTapDeps = {
  readonly dataDir?: string;
  readonly now?: () => number;
  readonly digest?: (root: string) => Promise<string>;
  readonly launch?: typeof launchIvaCommand;
  readonly replyImpl?: (chatId: number, text: string) => Promise<unknown>;
  readonly translate?: (english: string, russian: string) => string;
};

export async function handlePluginProposalTap(
  { digest12, chatId }: PluginTap,
  deps: PluginTapDeps = {},
): Promise<void> {
  const io = {
    dataDir: DATA_DIR,
    now: Date.now,
    digest: pluginTreeDigest,
    launch: launchIvaCommand,
    replyImpl: (chat: number, text: string): Promise<unknown> =>
      reply(chat, text),
    ...deps,
  };
  const dir = proposalsDir(io.dataDir);
  const tr = io.translate ?? (await noticeTranslator());
  const say = io.replyImpl;
  const outcome = await takeProposal({
    dir,
    digest12,
    nowMs: io.now(),
    digest: io.digest,
  });
  if (outcome.status === "stale") {
    log("plugin proposal tap: stale", digest12);
    await say(
      chatId,
      notInstalledText(tr, outcome.name ?? digest12, staleReason(tr)),
    );
    return;
  }
  const launched = await io.launch("iva-plugin-install", [
    "plugin",
    "install-proposal",
    digest12,
  ]);
  if (launched.ok) {
    log("plugin proposal tap: installer started", outcome.name, digest12);
    return;
  }
  const returned = returnProposal(
    dir,
    outcome.name,
    digest12,
    outcome.proposedMs,
  );
  log(
    "plugin proposal tap: installer did not start",
    launched.msg,
    returned ? "proposal returned" : "proposal lost",
  );
  await say(
    chatId,
    notInstalledText(tr, outcome.name, launched.msg || "systemd-run failed"),
  );
}
