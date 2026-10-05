import { defineTool } from "eve/tools";
import { z } from "zod";
import { readFile, stat } from "node:fs/promises";
import { relative, sep } from "node:path";
import {
  globToRegExp,
  eachFile,
  resolveVaultToolRoot,
  WALK_HINT,
  walkBound,
  type WalkBound,
} from "../lib/vault-file-search.ts";

// Host-native grep. Переопределяет встроенный grep eve: regex-поиск по содержимому
// реальных файлов на ФС VPS (node:fs + RegExp). Обход и резолв корня общие с glob.

interface Match {
  file: string;
  line: number;
  text: string;
}

const MAX_MATCHES = 1000;

async function* filesAt(
  root: string,
  bound: WalkBound,
): AsyncGenerator<string> {
  if ((await stat(root)).isFile()) yield root;
  else yield* eachFile(root, bound);
}

async function readLines(file: string): Promise<string[] | null> {
  try {
    return (await readFile(file, "utf8")).split("\n");
  } catch {
    return null;
  }
}

async function matchesInFile(
  file: string,
  expression: RegExp,
): Promise<Match[]> {
  const lines = await readLines(file);
  if (lines === null) return [];
  const matches: Match[] = [];
  for (let index = 0; index < lines.length; index++) {
    expression.lastIndex = 0;
    if (!expression.test(lines[index])) continue;
    const text =
      lines[index].length > 300
        ? `${lines[index].slice(0, 300)}…`
        : lines[index];
    matches.push({ file, line: index + 1, text });
  }
  return matches;
}

function result(matches: Match[], full: boolean, bound: WalkBound) {
  const truncated = full || bound.truncated;
  const hint = bound.truncated ? { hint: WALK_HINT } : {};
  return { count: matches.length, truncated, ...hint, matches };
}

async function findMatches(
  root: string,
  expression: RegExp,
  globExpression: RegExp | null,
  bound: WalkBound,
): Promise<ReturnType<typeof result>> {
  const matches: Match[] = [];
  for await (const file of filesAt(root, bound)) {
    const relativePath = relative(root, file).split(sep).join("/");
    if (globExpression !== null && !globExpression.test(relativePath)) continue;
    const remaining = MAX_MATCHES - matches.length;
    const additions = await matchesInFile(file, expression);
    matches.push(...additions.slice(0, remaining));
    if (additions.length >= remaining) return result(matches, true, bound);
  }
  return result(matches, false, bound);
}

export default defineTool({
  description:
    "Regex-поиск по файлам хоста. path — абсолютный или от корня vault файл либо " +
    "директория (по умолчанию корень vault, рекурсивно); glob фильтрует по пути; " +
    "flags — RegExp-флаги ('i', 'm'). " +
    "Возвращает { file, line, text }, до 1000; бинарные пропускаются.",
  inputSchema: z.object({
    pattern: z.string().min(1).describe("Регулярное выражение"),
    path: z.string().optional().describe("Абсолютный или от корня vault путь"),
    glob: z.string().optional().describe("Glob-фильтр, напр. **/*.ts"),
    flags: z.string().optional().describe("Напр. 'i' или 'm'"),
  }),
  async execute({ pattern, path, glob, flags }, { abortSignal }) {
    const root = resolveVaultToolRoot(path);
    const bound = walkBound(abortSignal);
    return findMatches(
      root,
      new RegExp(pattern, flags ?? ""),
      glob ? globToRegExp(glob) : null,
      bound,
    );
  },
});
