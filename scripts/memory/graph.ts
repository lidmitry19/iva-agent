import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { parseFrontmatterOrSkip } from "#lib/frontmatter.ts";
import { writeFileAtomicSync } from "#lib/fs-atomic.ts";
import { markdownFiles } from "../lib/vault-cleanup.ts";

// Граф ссылок vault для memory_search: узлы с входящими и исходящими [[ссылками]] и
// список битых. Brain пересобирает его ночью.

const LINK = /!?\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/gu;
const normalized = (value: string) =>
  value.normalize("NFKC").trim().toLocaleLowerCase("ru-RU");

type GraphNode = { incoming: string[]; outgoing: string[] };
export interface VaultGraph {
  readonly version: 1;
  readonly nodes: Record<string, GraphNode>;
  readonly broken: Array<{ source: string; target: string }>;
}

/** Тела файлов и цель ссылки по пути, имени файла или единственному H1. */
function indexVault(root: string) {
  const paths = new Map<string, string>();
  const titles = new Map<string, string[]>();
  const bodies = new Map<string, string>();
  for (const file of markdownFiles(root)) {
    const id = relative(root, file).split(sep).join("/").replace(/\.md$/u, "");
    paths.set(normalized(id), id).set(normalized(basename(id)), id);
    const text = existsSync(file) ? readFileSync(file, "utf8") : "";
    const body = parseFrontmatterOrSkip(text, file)?.body ?? text;
    bodies.set(id, body);
    const title = normalized(/^ {0,3}#\s+(.+)$/mu.exec(body)?.[1] ?? "");
    if (title) titles.set(title, [...(titles.get(title) ?? []), id]);
  }
  const target = (raw: string) => {
    const byTitle = titles.get(normalized(raw)) ?? [];
    return (
      paths.get(normalized(raw)) ??
      (byTitle.length === 1 ? byTitle[0] : undefined)
    );
  };
  return { bodies, target };
}

export function buildVaultGraph(root: string): VaultGraph {
  const { bodies, target } = indexVault(root);
  const nodes: Record<string, GraphNode> = {};
  const broken: VaultGraph["broken"] = [];
  for (const [source, body] of bodies) {
    const outgoing = new Set<string>();
    for (const match of body.matchAll(LINK)) {
      const raw = match[1].trim().replace(/\.md$/u, "");
      const found = target(raw);
      const attachment =
        raw.startsWith("attachments/") && existsSync(join(root, raw));
      if (found) outgoing.add(found);
      else if (!attachment) broken.push({ source, target: raw });
    }
    nodes[source] = { incoming: [], outgoing: [...outgoing] };
  }
  for (const [source, node] of Object.entries(nodes))
    for (const to of node.outgoing) nodes[to]?.incoming.push(source);
  return { version: 1, nodes, broken };
}

export function writeVaultGraph(root: string): string {
  const file = join(root, ".graph", "vault-graph.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileAtomicSync(
    file,
    `${JSON.stringify(buildVaultGraph(root), null, 2)}\n`,
  );
  return file;
}
