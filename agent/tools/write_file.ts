import { defineTool } from "eve/tools";
import { z } from "zod";
import { existsSync, realpathSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { resolveVaultDir } from "@iva/vault-dir";
import { writeFileAtomic } from "../lib/fs-atomic.js";
import { parseFrontmatterOrSkip } from "../lib/frontmatter.ts";
import { writeCore } from "../lib/core-write.ts";
import { commitVaultWrite } from "../lib/vault-commit.ts";
import { localStamp } from "../lib/vault-daily.ts";
import { vaultDirErrorText } from "../lib/vault-error.ts";
import { brokenLinksIn } from "../lib/vault-links.ts";

// Память пишет её код; write_file оставляет внешние файлы и library/.
const MEMORY = /^(?:daily|summaries|weekly|monthly|yearly|cards)(?:\/|$)/u;

/** Реальный путь файла, которого может ещё не быть: симлинк не обходит запрет. */
function realTarget(abs: string): string {
  const rest: string[] = [];
  for (let current = abs; ; current = dirname(current)) {
    try {
      return join(realpathSync(current), ...rest.reverse());
    } catch {
      if (dirname(current) === current) return abs;
      rest.push(basename(current));
    }
  }
}

/** Перезапись существующего файла, когда vault или его cards/ не видно: проверить,
 * не Card ли это, нельзя — отказ, а не тихое разрешение. cards/ ещё нет — защищать нечего. */
function unverifiable(vault: string, path: string): string | null {
  if (!existsSync(path)) return null;
  for (const dir of [vault, join(vault, "cards")])
    try {
      realpathSync(dir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (dir !== vault && code === "ENOENT") continue;
      const why = code === "ENOENT" ? "каталога vault нет" : String(error);
      return `не могу проверить ${dir}: ${why}`;
    }
  return null;
}

function brokenMarkdown(
  vault: string,
  rel: string,
  path: string,
  content: string,
) {
  if (!rel.endsWith(".md")) return null;
  const body = parseFrontmatterOrSkip(content, path, () => {})?.body ?? content;
  return brokenLinksIn(body, { vaultDir: vault, source: rel.slice(0, -3) });
}

async function writeVaultFile(
  vault: string,
  rel: string,
  path: string,
  content: string,
) {
  const bytes = Buffer.byteLength(content, "utf8");
  if (MEMORY.test(rel))
    return {
      ok: false,
      path,
      error:
        "write_file не пишет память: сырой день и выжимки ведёт ночь, Card меняет write_card.",
    };
  const broken = brokenMarkdown(vault, rel, path, content);
  if (broken) return { ok: false, path, error: broken };
  if (rel === "CORE.md") {
    const result = await writeCore({
      vault,
      next: content,
      reason: "day write_file",
      date: localStamp().date,
      mode: "day",
    });
    return result.ok
      ? { ok: true, path, bytes }
      : { ok: false, path, error: result.error ?? "CORE не записан" };
  }
  await writeFileAtomic(path, content);
  await commitVaultWrite(`file ${rel}: write`, [path], vault);
  return { ok: true, path, bytes };
}

export default defineTool({
  description:
    "Записать UTF-8 файл, директории создаются. В vault: CORE.md через общий писатель CORE (лимит, History); daily/, summaries/, weekly/, monthly/, yearly/ и cards/ закрыты (Card меняет write_card); остальное, например library/, пишется и коммитится.",
  inputSchema: z.object({
    path: z.string().min(1).describe("Абсолютный путь"),
    content: z.string().describe("Содержимое UTF-8"),
  }),
  async execute({ path, content }) {
    const bytes = Buffer.byteLength(content, "utf8");
    try {
      const vault = resolveVaultDir(process.cwd());
      const blocked = unverifiable(vault, resolve(path));
      if (blocked) {
        console.error(`[write_file] ${blocked}`);
        return { ok: false, path, error: blocked };
      }
      const rel = relative(realTarget(vault), realTarget(resolve(path)))
        .split(sep)
        .join("/");
      if (rel.startsWith("..") || isAbsolute(rel)) {
        await writeFileAtomic(path, content);
        return { ok: true, path, bytes };
      }
      return await writeVaultFile(vault, rel, path, content);
    } catch (error) {
      const text = vaultDirErrorText(error);
      if (text !== null) return { ok: false, path, error: text };
      throw error;
    }
  },
});
