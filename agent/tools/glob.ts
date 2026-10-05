import { defineTool } from "eve/tools";
import { z } from "zod";
import { relative, sep } from "node:path";
import {
  globToRegExp,
  resolveVaultToolRoot,
  WALK_HINT,
  walkBound,
  walkFiles,
} from "../lib/vault-file-search.ts";

// Host-native glob. Переопределяет встроенный glob eve: ищет файлы на реальной ФС VPS.
// fast-glob в node_modules отсутствует, поэтому реализовано через рекурсивный обход fs
// и собственный матчер glob-паттернов. Корень резолвится так же, как у read_file.

// Потолок ответа: на c1 `**/*` от ~/iva вернул 43584 пути (6.6 млн знаков) в контекст.
const MAX_PATHS = 1000;

export default defineTool({
  description:
    "Glob-поиск файлов: **, * и ?. По умолчанию ищет от корня vault; cwd — " +
    "абсолютный или от корня vault. .git/node_modules/dist пропускаются. " +
    "Не больше 1000 путей.",
  inputSchema: z.object({
    pattern: z
      .string()
      .min(1)
      .describe("Glob-паттерн, напр. **/*.ts или daily/*.md"),
    cwd: z.string().optional().describe("Абсолютный или от корня vault путь"),
  }),
  async execute({ pattern, cwd }, { abortSignal }) {
    const root = resolveVaultToolRoot(cwd);
    const bound = walkBound(abortSignal);
    const all = (await walkFiles(root, bound)).map((file) =>
      relative(root, file).split(sep).join("/"),
    );
    const re = globToRegExp(pattern);
    const matches = all.filter((p) => re.test(p)).sort();
    const hint = bound.truncated ? [`… ${WALK_HINT}`] : [];
    if (matches.length <= MAX_PATHS) return [...matches, ...hint];
    const rest = matches.length - MAX_PATHS;
    return [
      ...matches.slice(0, MAX_PATHS),
      `… ещё ${rest} путей из ${matches.length}: сузь pattern или cwd`,
      ...hint,
    ];
  },
});
