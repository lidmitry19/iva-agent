import { createHash } from "node:crypto";
import { z } from "zod";
import { parseFrontmatter, writeFrontmatter } from "#lib/frontmatter.ts";

// Чистая половина ночи: разбор сырого дня, сверка цитат, отпечатки и текст выжимки.

export interface DayEntry {
  readonly id: string;
  readonly time: string;
  readonly type: string;
  readonly text: string;
  readonly origin: "owner" | "forwarded" | "iva";
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

export function canonicalHash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

const HEADER = /^## ((?:[01]\d|2[0-3]):[0-5]\d)\s+(.+)$/u;
const MARKER = /^<!-- processed: .*-->$/u;

// Своё: [text], [queued] и медиа владельца; не своё — ответы Ивы и пересланное.
const originOf = (type: string, text: string): DayEntry["origin"] =>
  /iva/iu.test(type)
    ? "iva"
    : /^\s*\[forwarded\b/iu.test(text)
      ? "forwarded"
      : "owner";

/** Реплики `## HH:MM type` по порядку, e1…eN; отметки конца дня — не реплики. */
export function parseDay(raw: string): DayEntry[] {
  const entries: DayEntry[] = [];
  let current: { time: string; type: string; lines: string[] } | null = null;
  const flush = () => {
    if (!current) return;
    const text = current.lines.join("\n").replace(/^\n+|\n+$/gu, "");
    const { time, type } = current;
    const id = `e${entries.length + 1}`;
    entries.push({ id, time, type, text, origin: originOf(type, text) });
  };
  for (const line of raw.replace(/\r\n?/gu, "\n").split("\n")) {
    if (MARKER.test(line)) continue;
    const match = HEADER.exec(line);
    if (match) {
      flush();
      current = { time: match[1], type: match[2].trim(), lines: [] };
    } else current?.lines.push(line);
  }
  flush();
  return entries;
}

// Служебный хвост дня: отметка конца, пустые строки и блок итога старой ночи.
const SERVICE_LINE =
  /^(?:|<!-- processed[:-].*-->|---|(?:processed|cards|summary|thoughts|tasks): .*)$/u;

/** День закрыт отметкой в хвосте: её пишет ночь (совместимо со старой) и `iva jobs skip`. */
export function markedDone(raw: string): boolean {
  const lines = raw.split(/\r?\n/u).map((line) => line.trimEnd());
  for (
    let index = lines.length - 1;
    index >= 0 && SERVICE_LINE.test(lines[index]);
    index--
  )
    if (
      MARKER.test(lines[index]) ||
      /^processed: \d{4}-\d{2}-\d{2}T/u.test(lines[index])
    )
      return true;
  return false;
}

/** Слова без пунктуации: регистр, ё, кавычки, тире и знаки не различаются. */
function words(value: string): string {
  const plain = value.normalize("NFKC").toLowerCase().replace(/ё/gu, "е");
  return plain.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** Цитата — те же слова в том же порядке, что в собственной реплике владельца. */
export function quoteBelongsTo(entry: DayEntry, quote: string): boolean {
  const needle = words(quote);
  return (
    entry.origin === "owner" &&
    needle.length > 0 &&
    ` ${words(entry.text)} `.includes(` ${needle} `)
  );
}

/** Отпечаток шага: вход, модель и текст инструкции (promptVersion). */
export function stepHash(
  step: string,
  model: string,
  skill: string,
  inputs: unknown,
): string {
  const promptVersion = canonicalHash(skill);
  return canonicalHash({ v: 1, step, model, promptVersion, inputs });
}

export function prefixHash(
  entries: readonly DayEntry[],
  through: number,
): string {
  return canonicalHash(entries.slice(0, through));
}

/** Части дня по границам реплик, не больше maxCharacters каждая. */
export function splitEntries(
  entries: readonly DayEntry[],
  maxCharacters: number,
): DayEntry[][] {
  const parts: DayEntry[][] = [];
  let size = Infinity;
  for (const entry of entries) {
    const entrySize = entry.text.length + entry.type.length + 32;
    if (size + entrySize > maxCharacters) {
      parts.push([]);
      size = 0;
    }
    parts[parts.length - 1].push(entry);
    size += entrySize;
  }
  return parts;
}

function bodyHash(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

/** Выжимка: frontmatter с body_hash и тело. */
export function summaryText(
  fields: Record<string, string | string[]>,
  body: string,
): string {
  return `---\n${writeFrontmatter({ ...fields, body_hash: bodyHash(body) }, [])}\n---\n${body}`;
}

/** Правили руками: body_hash есть и не сходится. Выжимка без body_hash (старая ночь) цела. */
export function summaryEdited(text: string): boolean {
  try {
    const parsed = parseFrontmatter(text);
    const hash = parsed.fields?.body_hash;
    return typeof hash === "string" && hash !== bodyHash(parsed.body);
  } catch {
    return true;
  }
}

/** Мягкий разбор: сначала JSON в markdown-ограде, затем первый объект в тексте. */
export function parseJson(answer: string): unknown {
  const text = answer.trim();
  const fence = /```(?:json)?\s*/iu.exec(text);
  const fenced = fence ? text.indexOf("{", fence.index + fence[0].length) : -1;
  const start = fenced >= 0 ? fenced : text.indexOf("{");
  if (start < 0) throw new Error("в ответе нет JSON-объекта");
  for (
    let end = text.indexOf("}", start);
    end >= 0;
    end = text.indexOf("}", end + 1)
  ) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  throw new Error("в ответе нет JSON-объекта");
}

/** src — всегда список номеров; одна строка тоже принимается (терпимая форма ответа). */
export const srcList = z.preprocess(
  (value) => (typeof value === "string" ? [value] : value),
  z.array(z.string()),
);

/** Empty imported daily templates contain metadata only, never conversation text. */
export function emptyImportedDay(raw: string): boolean {
  const match =
    /^<!-- imported_from: second-brain\/daily\/(\d{4}-\d{2}-\d{2})\.md; imported_at: \d{4}-\d{2}-\d{2} -->\s*---\n([\s\S]*?)\n---\s*(?:# \1\s*)?$/u.exec(
      raw.replace(/\r\n?/gu, "\n"),
    );
  if (!match) return false;
  const lines = match[2].split("\n");
  return lines.every((line) =>
    /^(?:type: note|last_accessed: \d{4}-\d{2}-\d{2}|relevance: [\d.]+|tier: (?:archive|cold|warm|hot|active))$/u.test(
      line,
    ),
  );
}

/** Keep current conversations moving while reserving one slot for historical debt. */
export function selectNightDays(
  dates: readonly string[],
  today: string,
  limit: number,
): string[] {
  if (limit < 1) return [];
  const cutoff = new Date(Date.parse(`${today}T12:00:00Z`) - 7 * 86400000)
    .toISOString()
    .slice(0, 10);
  const sorted = [...new Set(dates)].filter((date) => date < today).sort();
  const recent = sorted.filter((date) => date >= cutoff);
  const old = sorted.filter((date) => date < cutoff);
  const fresh = recent.slice(0, old.length && limit > 1 ? limit - 1 : limit);
  return [...fresh, ...old.slice(0, limit - fresh.length)];
}
