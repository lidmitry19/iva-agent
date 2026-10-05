// Парсер/писатель YAML-frontmatter карточек vault'а. Порт правил из
// scripts/autograph/common.py (parse_frontmatter / write_frontmatter / format_field),
// чтобы тул и ночной пайплайн понимали ОДИН и тот же диалект:
//   • свёрнутые скаляры `description: >-` с продолжением на отступе (реальные карточки),
//   • литеральные блоки `|-`,
//   • блочные списки (`key:` + `- item`) и flow-списки `[a, b]`,
//   • перезапись ключа НЕ дублирует его старые continuation-строки (исторический баг
//     write_frontmatter, из-за которого description рос 2^N — не воспроизводить).
// Неизвестные ключи и их порядок сохраняются как есть: тул не знает про tier/relevance/
// last_accessed/phone/telegram и не имеет права их терять.

import { splitCard } from "./card-text.ts";

export type FmValue = string | string[];
export type FmFields = Record<string, FmValue>;

export interface ParsedFrontmatter {
  fields: FmFields | null;
  body: string;
  lines: string[];
  eol?: "\n" | "\r\n";
}

export class FrontmatterParseError extends Error {
  override readonly name = "FrontmatterParseError";
}

/**
 * Frontmatter карточки, которую мог испортить человек. Вольт — обычный git-репо,
 * владелец правит карточки руками, и одной незакрытой кавычки (`company: 'Sayyora's
 * Splendor'`) хватало, чтобы выключить ВСЮ память: каталог карточек обходят четыре
 * читателя, и каждый падал на первом же битом файле — ни поиска, ни записи, ни
 * ночного индекса, пока файл не найдут глазами.
 *
 * Разбор остаётся строгим; терпимость живёт здесь и только здесь. Битая карточка —
 * `null` и одна строка в журнал С ПУТЁМ: пропуск без имени файла стал бы новой
 * тишиной, а найти его иначе нечем. Любая другая ошибка — наружу: это уже не
 * карточка владельца, а наш дефект.
 */
export function parseFrontmatterOrSkip(
  content: string,
  path: string,
  log: (message: string) => void = console.error,
): ParsedFrontmatter | null {
  try {
    return parseFrontmatter(content);
  } catch (error) {
    if (!(error instanceof FrontmatterParseError)) throw error;
    log(`[frontmatter] ${path} пропущена: ${error.message}`);
    return null;
  }
}

type ParseState = {
  fields: Record<string, FmValue | null>;
  key: string | null;
  mode: "fold" | "literal" | "list" | "pending" | null;
  sep: string;
  blanks: number;
};

function appendMultiline(state: ParseState, text: string): void {
  const key = state.key!;
  if (state.mode === "pending") {
    state.mode = text.startsWith("- ") ? "list" : "fold";
    state.fields[key] = state.mode === "list" ? [] : "";
  }
  if (state.mode === "list") {
    appendList(state.fields[key] as string[], text);
  } else {
    const before = (state.fields[key] as string) || "";
    const separator = multilineSeparator(state);
    state.fields[key] = (before + separator + text).trim();
  }
  state.blanks = 0;
}

function appendList(items: string[], text: string): void {
  const item = text.startsWith("- ") ? text.slice(2).trim() : text;
  if (item) items.push(unquote(item));
}

function multilineSeparator(state: ParseState): string {
  if (!state.blanks) return state.sep;
  return "\n".repeat(state.blanks + (state.mode === "literal" ? 1 : 0));
}

function startMultiline(
  state: ParseState,
  key: string,
  value: string,
): boolean {
  const exact = {
    ">-": ["fold", " "],
    ">": ["fold", " "],
    "|-": ["literal", "\n"],
    "|": ["literal", "\n"],
  }[value] as [ParseState["mode"], string] | undefined;
  if (exact) {
    Object.assign(state, { key, mode: exact[0], sep: exact[1] });
    state.fields[key] = "";
    return true;
  }
  const marker = value[0];
  if (marker === ">" || marker === "|") {
    const literal = marker === "|";
    Object.assign(state, {
      key,
      mode: literal ? "literal" : "fold",
      sep: literal ? "\n" : " ",
    });
    state.fields[key] = value.slice(1).replace(/^-/, "").trim();
    return true;
  }
  if (value) return false;
  Object.assign(state, { key, mode: "pending", sep: " " });
  state.fields[key] = null;
  return true;
}

function startField(state: ParseState, key: string, value: string): void {
  if (startMultiline(state, key, value)) return;
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1);
    state.fields[key] = inner.trim()
      ? splitFlowItems(inner).map((item) => unquote(item.trim()))
      : [];
  } else state.fields[key] = unquote(value);
}

function continueField(state: ParseState, line: string, text: string): boolean {
  if (!state.key) return false;
  if (!text) {
    state.blanks++;
    return true;
  }
  if (/^[ \t]/u.test(line)) {
    appendMultiline(state, text);
    return true;
  }
  if (state.fields[state.key] == null) state.fields[state.key] = "";
  Object.assign(state, { key: null, mode: null, sep: " ", blanks: 0 });
  return false;
}

function parseLine(state: ParseState, line: string): void {
  const text = line.trim();
  if (continueField(state, line, text)) return;
  if (!text || text.startsWith("#")) return;
  const colon = text.indexOf(":");
  if (colon < 0) return;
  startField(state, text.slice(0, colon).trim(), text.slice(colon + 1).trim());
}

export function parseFrontmatter(content: string): ParsedFrontmatter {
  const { frontmatter, body } = splitCard(content);
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  if (frontmatter === null) return { fields: null, body, lines: [], eol };
  const lines = frontmatter.split("\n");
  const state: ParseState = {
    fields: {},
    key: null,
    mode: null,
    sep: " ",
    blanks: 0,
  };
  for (const line of lines) parseLine(state, line);
  if (state.key && state.fields[state.key] == null)
    state.fields[state.key] = "";
  const fields: FmFields = {};
  for (const [key, value] of Object.entries(state.fields))
    fields[key] = value ?? "";
  return { fields, body, lines, eol };
}

/** Элементы flow-списка `[...]` с учётом кавычек и экранированных `\"`. */
function splitFlowItems(inner: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      cur += ch;
      if (ch === "\\" && quote === '"' && i + 1 < inner.length) {
        cur += inner[++i]; // экранированный символ внутри двойных кавычек
      } else if (ch === "'" && quote === "'" && inner[i + 1] === "'") {
        cur += inner[++i]; // YAML single quote escapes an apostrophe by doubling it
      } else if (ch === quote) {
        quote = null;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (quote) {
    throw new FrontmatterParseError(
      "unterminated quote in frontmatter flow list",
    );
  }
  if (cur.trim().length || out.length) out.push(cur);
  return out;
}

function unquote(s: string): string {
  if (s.startsWith('"')) {
    if (s.length < 2 || !s.endsWith('"')) {
      throw new FrontmatterParseError(
        "unterminated double-quoted frontmatter scalar",
      );
    }
    try {
      const parsed: unknown = JSON.parse(s);
      if (typeof parsed === "string") return parsed;
    } catch (error) {
      throw new FrontmatterParseError(
        `invalid JSON-quoted frontmatter scalar: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    throw new FrontmatterParseError(
      "JSON-quoted frontmatter scalar is not a string",
    );
  }
  if (s.startsWith("'")) {
    if (s.length < 2 || !s.endsWith("'")) {
      throw new FrontmatterParseError(
        "unterminated single-quoted frontmatter scalar",
      );
    }
    const inner = s.slice(1, -1);
    let decoded = "";
    for (let index = 0; index < inner.length; index++) {
      if (inner[index] !== "'") {
        decoded += inner[index];
        continue;
      }
      if (inner[index + 1] !== "'") {
        throw new FrontmatterParseError(
          "single quote inside frontmatter scalar must be doubled",
        );
      }
      decoded += "'";
      index++;
    }
    return decoded;
  }
  return s;
}

export function formatItem(v: string): string {
  return JSON.stringify(String(v));
}

export function formatField(key: string, val: FmValue): string {
  if (Array.isArray(val)) {
    return `${key}: ${JSON.stringify(val.map((item) => String(item)))}`;
  }
  return `${key}: ${formatItem(String(val))}`;
}

function valuesEqual(left: FmValue | undefined, right: FmValue): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => value === right[index])
    );
  }
  return left === right;
}

type WriteState = {
  out: string[];
  written: Set<string>;
  skip: boolean;
  fields: FmFields;
  original: FmFields | null;
  removed: readonly string[];
};
const CONTINUED = new Set([">-", ">", "|-", "|", ""]);

function keepRawLine(state: WriteState, line: string, text: string): boolean {
  if (state.skip && /^[ \t]/u.test(line)) return true;
  if (text && !text.startsWith("#") && text.includes(":")) return false;
  if (!state.skip) state.out.push(line);
  return true;
}

function rewriteField(state: WriteState, line: string, text: string): void {
  state.skip = false;
  const colon = text.indexOf(":");
  const key = text.slice(0, colon).trim();
  const value = text.slice(colon + 1).trim();
  state.written.add(key);
  if (state.removed.includes(key)) {
    state.skip = CONTINUED.has(value);
  } else if (Object.prototype.hasOwnProperty.call(state.fields, key)) {
    const unchanged = valuesEqual(state.original?.[key], state.fields[key]);
    state.out.push(unchanged ? line : formatField(key, state.fields[key]));
    state.skip = !unchanged && CONTINUED.has(value);
  } else state.out.push(line);
}

export function writeFrontmatter(
  fields: FmFields,
  originalLines: string[],
  removed: readonly string[] = [],
): string {
  const originalFields = originalLines.length
    ? parseFrontmatter(`---\n${originalLines.join("\n")}\n---\n`).fields
    : null;
  const state: WriteState = {
    out: [],
    written: new Set(),
    skip: false,
    fields,
    original: originalFields,
    removed,
  };
  for (const line of originalLines) {
    const text = line.trim();
    if (!keepRawLine(state, line, text)) rewriteField(state, line, text);
  }
  for (const [key, val] of Object.entries(fields)) {
    if (!state.written.has(key)) state.out.push(formatField(key, val));
  }
  return state.out.join("\n");
}

export function renderCardDocument(
  parsed: ParsedFrontmatter,
  fields: FmFields,
  body: string,
  removed: readonly string[] = [],
): string {
  const text = `---\n${writeFrontmatter(fields, parsed.lines, removed)}\n---\n${body.trim()}\n`;
  return parsed.eol === "\r\n" ? text.replace(/\n/gu, "\r\n") : text;
}
