import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { disappearedLines, withCardLock } from "./card-store.ts";
import { CORE_CAP } from "./core-cap.ts";
import { LAST_DAY_LABEL } from "./core-clamp.ts";
import { writeFileAtomicSync } from "./fs-atomic.ts";
import { commitVaultWrite } from "./vault-commit.ts";

// Единственный писатель CORE днём и ночью: исчезнувшие строки дословно уходят в
// CORE.history.md, файл длиннее CORE_CAP не пишется (ночь может только сокращать уже
// раздутый), сверка хеша, запись и коммит — под замком дневных писателей Card.

export function textHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** expectedHash — хеш файла на диске при чтении (textHash("") — файла не было). */
export type WriteCoreOptions = {
  vault: string;
  next: string;
  reason: string;
  date: string;
  source?: string;
  expectedHash?: string;
  mode: "day" | "night";
};
export type WriteCoreResult = {
  ok: boolean;
  conflict?: boolean;
  error?: string;
};

/** Сколько знаков лишние: 0 — длина проходит. Ночь может только сокращать раздутый. */
export function coreExcess(
  before: string,
  next: string,
  mode: "day" | "night",
) {
  const limit = mode === "night" ? Math.max(CORE_CAP, before.length) : CORE_CAP;
  return Math.max(0, next.length - limit);
}

/** Исчезнувшие строки CORE дословно дописываются в CORE.history.md; false — нечего.
 * Указатель «Последний день» ведёт код, его смена — не история. */
function writeHistory(options: WriteCoreOptions, before: string): boolean {
  const pointer = options.source ? ` · ${options.source}` : "";
  const lines = disappearedLines(before, options.next);
  const rows = lines
    .filter((line) => !LAST_DAY_LABEL.test(line))
    .map((line) => `- ${options.date}: ${line} (${options.reason})${pointer}`);
  if (!rows.length) return false;
  const history = join(options.vault, "CORE.history.md");
  const old = existsSync(history) ? readFileSync(history, "utf8") : "";
  const head = old.trimEnd() || "# CORE History\n\n## History";
  writeFileAtomicSync(history, `${head}\n${rows.join("\n")}\n`);
  return true;
}

export async function writeCore(
  options: WriteCoreOptions,
): Promise<WriteCoreResult> {
  return await withCardLock(options.vault, () => writeCoreLocked(options));
}

async function writeCoreLocked(
  options: WriteCoreOptions,
): Promise<WriteCoreResult> {
  const { vault, next } = options;
  const path = join(vault, "CORE.md");
  const before = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (options.expectedHash && textHash(before) !== options.expectedHash)
    return { ok: false, conflict: true, error: "CORE changed after read" };
  const excess = coreExcess(before, next, options.mode);
  if (excess > 0)
    return {
      ok: false,
      error: `CORE длиннее ${CORE_CAP} знаков: освободи ${excess} знаков`,
    };
  if (before === next) return { ok: true };
  writeFileAtomicSync(path, next);
  const paths = writeHistory(options, before)
    ? [path, join(vault, "CORE.history.md")]
    : [path];
  const commit = await commitVaultWrite(
    `CORE: ${options.reason}`,
    paths,
    vault,
  );
  return commit.ok
    ? { ok: true }
    : { ok: false, error: commit.reason ?? "CORE не закоммичен" };
}
