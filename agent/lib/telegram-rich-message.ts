// Чтение Telegram `Message.rich_message`: дерево RichBlock/RichText превращается в
// markdown-текст и список медиа. Схема взята из Bot API (таблицы полей RichBlock,
// RichText, RichBlockCaption, RichBlockListItem, RichBlockTableCell), а не из головы.
//
// Три обещания:
//  1. Ничего не теряем (ADR-0002): каждый видимый текстовый лист попадает в `text`
//     в исходном порядке, каждое медиа любой вложенности — в `media`.
//  2. Никогда не бросаем: любое значение годится на вход, включая мусор, циклы,
//     ловушки в геттерах и Proxy.
//  3. Ограничены: потолки на узлы, символы и глубину. Когда потолок сработал,
//     `text` и `media` держат уже прочитанное, а `truncated` становится true.
//     Пустой ответ из-за потолка — это и есть потеря данных, поэтому его не бывает.
//
// Обход итеративный: стек задач вместо рекурсии, поэтому вложенность в сто тысяч
// уровней не роняет стек вызовов. Вид у текста один — лёгкий markdown, который
// одинаково читается и в daily-файле Vault, и моделью.
//
// Политика листьев (написана явно, чтобы свойство было опровержимым):
//  - строка                       → сама строка, байт в байт;
//  - RichText с полем `text`      → листья вложенного `text`;
//  - custom_emoji                 → `alternative_text` (глиф, который видит человек);
//  - mathematical_expression      → `expression` (исходник LaTeX);
//  - mention                      → листья `text`, следом `@username`;
//  - anchor (и текст, и блок)     → ничего: это невидимая цель ссылки;
//  - divider                      → текста нет, рисуется как `---`;
//  - RichBlockCaption             → листья `text`, затем `credit`;
//  - map                          → только подпись: координаты не текст.
// Внутри метки ссылки листья экранируются (`\`, `[`, `]`): иначе метка закрывала бы
// ссылку и подставляла собственный адрес. Заголовки, ячейки таблицы и summary
// сводят перевод строки к пробелу — иначе разметка блока рвётся.
//
// Ссылкой становится только `http`/`https`. Любая другая схема (`tg:`, `javascript:`,
// `data:`, `file:`, `mailto:` и прочие) печатается текстом `метка (адрес)`: адрес
// сохранён, живой ссылки нет. Простой текст проходит насквозь без экранирования —
// если отправитель написал markdown руками, он таким и останется; безопасность
// входа держит inbound-Gate (ADR-0005), а не этот файл.
import { mediaFromRaw, type TelegramRawMedia } from "./telegram-parts.ts";

export interface RichMessageReading {
  /** Текст в исходном порядке. Пустая строка, когда текста в сообщении нет. */
  readonly text: string;
  /** Медиа любой вложенности в исходном порядке; фото — самый крупный размер. */
  readonly media: readonly TelegramRawMedia[];
  /** true, когда обход обрезан потолком; прочитанное при этом сохранено. */
  readonly truncated: boolean;
}

// Узлы ограничивают и работу, и память: задача попадает в стек, только пока есть
// запас. Символы считаются по листьям — это примерно сто длинных статей. Глубина
// ограничивает вложенность кадров, которые собирают текст целиком: без неё сто
// тысяч вложенных цитат стоили бы квадрат от длины текста.
export const MAX_RICH_MESSAGE_NODES = 50_000;
export const MAX_RICH_MESSAGE_CHARS = 400_000;
export const MAX_RICH_MESSAGE_DEPTH = 64;

const BLOCK_SEP = "\n\n";

/** Собирает содержимое кадра целиком: заголовок, отступ, забор, префикс цитаты. */
type Wrap = (inner: string) => string;

type Task =
  | { readonly kind: "block"; readonly node: unknown }
  | { readonly kind: "text"; readonly node: unknown; readonly label: boolean }
  | { readonly kind: "emit"; readonly value: string }
  | {
      readonly kind: "open";
      readonly sep: string;
      // wrap === null — дешёвый кадр: куски переезжают к родителю ссылками, без
      // склейки строк. Иначе кадр собирается целиком, и такие кадры считаются в
      // глубину; на потолке глубины кадр падает до prefix/suffix, чтобы данные
      // (адрес ссылки, @username) остались на месте.
      readonly wrap: Wrap | null;
      readonly prefix: string;
      readonly suffix: string;
    }
  | { readonly kind: "close" };

interface Frame {
  readonly parts: string[];
  readonly sep: string;
  readonly wrap: Wrap | null;
  readonly prefix: string;
  readonly suffix: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Чтение поля не имеет права уронить обход: геттер и Proxy вправе бросить.
function field(node: Record<string, unknown>, name: string): unknown {
  try {
    return node[name];
  } catch {
    return undefined;
  }
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? (value as readonly unknown[]) : [];
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function flatten(value: string): string {
  return value.replace(/[\r\n]+/gu, " ");
}

// В метке ссылки закрыть метку или открыть новый адрес умеют ровно три символа.
function escapeLabel(value: string): string {
  return value.replace(/[\\[\]]/gu, "\\$&");
}

// Адрес внутри `(...)`: скобки и обратный слэш экранируются, пробелы и управляющие
// символы кодируются процентами — иначе CommonMark обрывает адрес на первом пробеле.
function escapeUrl(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (char === "\\" || char === "(" || char === ")") {
      out += `\\${char}`;
    } else if (code < 0x20 || code === 0x7f || /\s/u.test(char)) {
      out += encodeURIComponent(char);
    } else {
      out += char;
    }
  }
  return out;
}

function isWebUrl(value: string): boolean {
  return /^https?:\/\//iu.test(value);
}

function longestBacktickRun(value: string): number {
  let best = 0;
  let run = 0;
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) === 96) {
      run += 1;
      if (run > best) best = run;
    } else {
      run = 0;
    }
  }
  return best;
}

// Ранг размера фото: сначала площадь, потом file_size. Нечисло и бесконечность
// становятся -1, поэтому мусорный размер никогда не выигрывает у настоящего.
function photoRank(size: Record<string, unknown>): readonly [number, number] {
  const width = field(size, "width");
  const height = field(size, "height");
  const area =
    typeof width === "number" && typeof height === "number"
      ? width * height
      : Number.NaN;
  const bytes = field(size, "file_size");
  return [
    Number.isFinite(area) ? area : -1,
    typeof bytes === "number" && Number.isFinite(bytes) ? bytes : -1,
  ];
}

// Самый крупный размер фото. Порядок полный — площадь, file_size, file_id, — поэтому
// выбор не зависит от того, в каком порядке Telegram прислал размеры.
function largestPhoto(value: unknown): TelegramRawMedia | null {
  if (!Array.isArray(value)) return null;
  let bestId = "";
  let bestUniqueId: unknown;
  let bestArea = -1;
  let bestBytes = -1;
  let found = false;
  for (const size of value as readonly unknown[]) {
    if (!isRecord(size)) continue;
    const fileId = field(size, "file_id");
    if (typeof fileId !== "string" || fileId === "") continue;
    const [area, bytes] = photoRank(size);
    const better =
      !found ||
      area > bestArea ||
      (area === bestArea &&
        (bytes > bestBytes || (bytes === bestBytes && fileId < bestId)));
    if (!better) continue;
    found = true;
    bestId = fileId;
    bestUniqueId = field(size, "file_unique_id");
    bestArea = area;
    bestBytes = bytes;
  }
  if (!found) return null;
  return {
    fileId: bestId,
    ...(typeof bestUniqueId === "string" ? { fileUniqueId: bestUniqueId } : {}),
    tag: "photo",
    transcribe: false,
  };
}

// Медиа ищется по полям, а не по типу блока: новый тип из будущей версии Bot API
// всё равно отдаст свой файл. Порядок такой же, как у обычного сообщения:
// фото, затем voice_note, затем остальные ключи из telegram-parts.
function blockMedia(node: Record<string, unknown>): TelegramRawMedia | null {
  const photo = largestPhoto(field(node, "photo"));
  if (photo !== null) return photo;
  const voice = field(node, "voice_note");
  if (isRecord(voice)) {
    const fileId = field(voice, "file_id");
    if (typeof fileId === "string" && fileId !== "") {
      const uniqueId = field(voice, "file_unique_id");
      const mimeType = field(voice, "mime_type");
      return {
        fileId,
        ...(typeof uniqueId === "string" ? { fileUniqueId: uniqueId } : {}),
        tag: "voice",
        transcribe: true,
        ...(typeof mimeType === "string" ? { mimeType } : {}),
      };
    }
  }
  try {
    return mediaFromRaw(node);
  } catch {
    return null;
  }
}

const OPEN_LINE: Task = {
  kind: "open",
  sep: "",
  wrap: null,
  prefix: "",
  suffix: "",
};
const CLOSE: Task = { kind: "close" };

function markWrap(marker: string): Task {
  return { kind: "open", sep: "", wrap: null, prefix: marker, suffix: marker };
}

function group(wrap: Wrap, sep: string, suffix = ""): Task {
  return { kind: "open", sep, wrap, prefix: "", suffix };
}

const plainWrap: Wrap = (inner) => inner;

const quoteWrap: Wrap = (inner) =>
  inner === ""
    ? ""
    : inner
        .split("\n")
        .map((line) => (line === "" ? ">" : `> ${line}`))
        .join("\n");

const summaryWrap: Wrap = (inner) =>
  inner === "" ? "" : `**${flatten(inner)}**`;

const rowWrap: Wrap = (inner) => (inner === "" ? "" : `| ${inner} |`);

// Пустая ячейка обязана занять место, иначе колонки съезжают.
const cellWrap: Wrap = (inner) => {
  const value = flatten(inner).replaceAll("|", "\\|");
  return value === "" ? " " : value;
};

const codeWrap: Wrap = (inner) => {
  if (inner === "") return "";
  if (inner.includes("\n")) return inner;
  const fence = "`".repeat(longestBacktickRun(inner) + 1);
  const pad =
    inner.startsWith("`") ||
    inner.endsWith("`") ||
    inner.startsWith(" ") ||
    inner.endsWith(" ")
      ? " "
      : "";
  return `${fence}${pad}${inner}${pad}${fence}`;
};

// H1 и H2 в daily-файл не идут: там свой заголовок. Ниже третьего уровня разметка
// сохраняет относительный размер из поля `size` (1 — самый крупный, 6 — самый мелкий).
function headingWrap(size: unknown): Wrap {
  const level =
    typeof size === "number" && size >= 4 ? Math.min(6, Math.trunc(size)) : 3;
  const hashes = "#".repeat(level);
  return (inner) => (inner === "" ? "" : `${hashes} ${flatten(inner)}`);
}

function preWrap(language: unknown): Wrap {
  const tag = asText(language).replace(/[^\w+#.-]/gu, "");
  return (inner) => {
    if (inner === "") return "";
    const fence = "`".repeat(Math.max(3, longestBacktickRun(inner) + 1));
    return `${fence}${tag}\n${inner}\n${fence}`;
  };
}

function itemWrap(marker: string, label: string): Wrap {
  return (inner) => {
    const body =
      label !== "" && inner !== ""
        ? `${label} ${inner}`
        : label !== ""
          ? label
          : inner;
    if (body === "") return "";
    const lines = body.split("\n");
    for (let i = 1; i < lines.length; i += 1) {
      if (lines[i] !== "") lines[i] = `  ${lines[i]}`;
    }
    return marker + lines.join("\n");
  };
}

// Живая ссылка получается только у http/https и только когда метка не пуста и не
// разорвана пустой строкой: такую метку CommonMark обратно в ссылку не собирает.
function linkWrap(url: string, live: boolean): Wrap {
  return (inner) => {
    if (live && inner !== "" && !/\n[ \t]*\n/u.test(inner)) {
      return `[${inner}](${escapeUrl(url)})`;
    }
    const shown = escapeLabel(url);
    return inner === "" ? shown : `${inner} (${shown})`;
  };
}

function mentionWrap(handle: string): Wrap {
  return (inner) => (inner === "" ? handle : `${inner} (${handle})`);
}

export function readRichMessage(value: unknown): RichMessageReading {
  const media: TelegramRawMedia[] = [];
  const frames: Frame[] = [
    { parts: [], sep: BLOCK_SEP, wrap: null, prefix: "", suffix: "" },
  ];
  const stack: Task[] = [];
  let nodes = 0;
  let chars = 0;
  let depth = 0;
  let truncated = false;

  function current(): Frame {
    return frames[frames.length - 1];
  }

  function append(value: string): void {
    if (value === "") return;
    const frame = current();
    if (frame.parts.length > 0 && frame.sep !== "") frame.parts.push(frame.sep);
    frame.parts.push(value);
  }

  function emit(value: string): void {
    if (value === "") return;
    chars += value.length;
    append(value);
  }

  function room(): number {
    return Math.max(0, MAX_RICH_MESSAGE_NODES - nodes);
  }

  // Список детей режется до постановки в стек: так потолок ограничивает и память,
  // а не только работу. Режется хвост, поэтому начало текста всегда сохраняется.
  function take(items: readonly unknown[]): readonly unknown[] {
    const limit = room();
    if (items.length <= limit) return items;
    truncated = true;
    return items.slice(0, limit);
  }

  function run(seq: readonly Task[]): void {
    for (let i = seq.length - 1; i >= 0; i -= 1) stack.push(seq[i]);
  }

  function blockTask(node: unknown): Task {
    return { kind: "block", node };
  }

  function textTask(node: unknown, label: boolean): Task {
    return { kind: "text", node, label };
  }

  function wrapped(open: Task, node: unknown, label: boolean): void {
    run([open, textTask(node, label), CLOSE]);
  }

  // RichBlockCaption — это `{ text, credit }`, а не RichText: у RichText всегда есть
  // строковый `type`, у подписи его нет. Обе формы читаются одним местом.
  function captionSeq(value: unknown): Task[] {
    if (value === undefined || value === null) return [];
    if (isRecord(value) && typeof field(value, "type") !== "string") {
      const seq: Task[] = [];
      const body = field(value, "text");
      if (body !== undefined) seq.push(OPEN_LINE, textTask(body, false), CLOSE);
      const credit = field(value, "credit");
      if (credit !== undefined) {
        seq.push(OPEN_LINE, textTask(credit, false), CLOSE);
      }
      return seq;
    }
    return [OPEN_LINE, textTask(value, false), CLOSE];
  }

  function listSeq(node: Record<string, unknown>): Task[] {
    const seq: Task[] = [group(plainWrap, "\n")];
    for (const item of take(asArray(field(node, "items")))) {
      const record = isRecord(item) ? item : null;
      const label = record === null ? "" : asText(field(record, "label"));
      const marker =
        record !== null && field(record, "has_checkbox") === true
          ? field(record, "is_checked") === true
            ? "- [x] "
            : "- [ ] "
          : "- ";
      chars += label.length;
      seq.push(group(itemWrap(marker, label), BLOCK_SEP));
      if (record === null) seq.push(textTask(item, false));
      else {
        for (const child of take(asArray(field(record, "blocks")))) {
          seq.push(blockTask(child));
        }
      }
      seq.push(CLOSE);
    }
    seq.push(CLOSE);
    return seq;
  }

  function tableSeq(node: Record<string, unknown>): Task[] {
    const rows = take(asArray(field(node, "cells")));
    const seq: Task[] = [group(plainWrap, "\n")];
    for (let i = 0; i < rows.length; i += 1) {
      const cells = take(asArray(rows[i]));
      seq.push(group(rowWrap, " | "));
      for (const cell of cells) {
        seq.push(group(cellWrap, ""));
        seq.push(textTask(isRecord(cell) ? field(cell, "text") : cell, false));
        seq.push(CLOSE);
      }
      seq.push(CLOSE);
      if (i === 0 && cells.length > 0) {
        const ruler = new Array(cells.length).fill("---").join(" | ");
        seq.push({ kind: "emit", value: `| ${ruler} |` });
      }
    }
    seq.push(CLOSE);
    seq.push(...captionSeq(field(node, "caption")));
    return seq;
  }

  // Незнакомый тип блока: забираем всё, что несёт текст, и вложенные блоки. Так
  // новый тип из будущей версии Bot API теряет разметку, но не содержание.
  function unknownBlockSeq(node: Record<string, unknown>): Task[] {
    const seq: Task[] = [];
    const body = field(node, "text");
    if (body !== undefined) seq.push(OPEN_LINE, textTask(body, false), CLOSE);
    const summary = field(node, "summary");
    if (summary !== undefined) {
      seq.push(OPEN_LINE, textTask(summary, false), CLOSE);
    }
    const expression = field(node, "expression");
    if (typeof expression === "string") {
      seq.push({ kind: "emit", value: expression });
    }
    for (const child of take(asArray(field(node, "blocks")))) {
      seq.push(blockTask(child));
    }
    const credit = field(node, "credit");
    if (credit !== undefined) {
      seq.push(OPEN_LINE, textTask(credit, false), CLOSE);
    }
    seq.push(...captionSeq(field(node, "caption")));
    return seq;
  }

  function handleBlock(node: unknown): void {
    if (typeof node === "string") {
      run([OPEN_LINE, textTask(node, false), CLOSE]);
      return;
    }
    if (!isRecord(node)) return;
    const found = blockMedia(node);
    if (found !== null) media.push(found);
    switch (field(node, "type")) {
      case "paragraph":
      case "footer":
      case "thinking":
        run([OPEN_LINE, textTask(field(node, "text"), false), CLOSE]);
        return;
      case "heading":
        wrapped(
          group(headingWrap(field(node, "size")), ""),
          field(node, "text"),
          false,
        );
        return;
      case "pre":
        wrapped(
          group(preWrap(field(node, "language")), ""),
          field(node, "text"),
          false,
        );
        return;
      case "divider":
        emit("---");
        return;
      case "mathematical_expression":
        emit(asText(field(node, "expression")));
        return;
      case "anchor":
        return;
      case "list":
        run(listSeq(node));
        return;
      case "blockquote": {
        const seq: Task[] = [group(quoteWrap, BLOCK_SEP)];
        for (const child of take(asArray(field(node, "blocks")))) {
          seq.push(blockTask(child));
        }
        const credit = field(node, "credit");
        if (credit !== undefined) {
          seq.push(OPEN_LINE, textTask(credit, false), CLOSE);
        }
        seq.push(CLOSE);
        run(seq);
        return;
      }
      case "pullquote": {
        const seq: Task[] = [
          group(quoteWrap, BLOCK_SEP),
          OPEN_LINE,
          textTask(field(node, "text"), false),
          CLOSE,
        ];
        const credit = field(node, "credit");
        if (credit !== undefined) {
          seq.push(OPEN_LINE, textTask(credit, false), CLOSE);
        }
        seq.push(CLOSE);
        run(seq);
        return;
      }
      case "collage":
      case "slideshow": {
        const seq: Task[] = [];
        for (const child of take(asArray(field(node, "blocks")))) {
          seq.push(blockTask(child));
        }
        seq.push(...captionSeq(field(node, "caption")));
        run(seq);
        return;
      }
      case "table":
        run(tableSeq(node));
        return;
      case "details": {
        const seq: Task[] = [
          group(summaryWrap, ""),
          textTask(field(node, "summary"), false),
          CLOSE,
        ];
        for (const child of take(asArray(field(node, "blocks")))) {
          seq.push(blockTask(child));
        }
        run(seq);
        return;
      }
      case "map":
      case "animation":
      case "audio":
      case "photo":
      case "video":
      case "voice_note":
        run(captionSeq(field(node, "caption")));
        return;
      default:
        run(unknownBlockSeq(node));
    }
  }

  function handleText(node: unknown, label: boolean): void {
    if (typeof node === "string") {
      emit(label ? escapeLabel(node) : node);
      return;
    }
    if (Array.isArray(node)) {
      const seq: Task[] = [];
      for (const child of take(node as readonly unknown[])) {
        seq.push(textTask(child, label));
      }
      run(seq);
      return;
    }
    if (!isRecord(node)) return;
    switch (field(node, "type")) {
      case "bold":
        wrapped(markWrap("**"), field(node, "text"), label);
        return;
      case "italic":
        wrapped(markWrap("*"), field(node, "text"), label);
        return;
      case "strikethrough":
        wrapped(markWrap("~~"), field(node, "text"), label);
        return;
      case "code":
        wrapped(group(codeWrap, ""), field(node, "text"), label);
        return;
      case "custom_emoji": {
        const alternative = field(node, "alternative_text");
        if (typeof alternative === "string") {
          emit(label ? escapeLabel(alternative) : alternative);
        }
        return;
      }
      case "mathematical_expression": {
        const expression = field(node, "expression");
        if (typeof expression === "string") {
          emit(label ? escapeLabel(expression) : expression);
        }
        return;
      }
      case "anchor":
        return;
      case "url": {
        const url = field(node, "url");
        if (typeof url !== "string" || url === "") {
          run([textTask(field(node, "text"), label)]);
          return;
        }
        const live = !label && isWebUrl(url);
        chars += url.length;
        wrapped(
          group(linkWrap(url, live), "", ` (${escapeLabel(url)})`),
          field(node, "text"),
          live || label,
        );
        return;
      }
      case "mention": {
        const username = asText(field(node, "username"));
        if (username === "") {
          run([textTask(field(node, "text"), label)]);
          return;
        }
        const handle = escapeLabel(
          username.startsWith("@") ? username : `@${username}`,
        );
        chars += handle.length;
        wrapped(
          group(mentionWrap(handle), "", ` (${handle})`),
          field(node, "text"),
          label,
        );
        return;
      }
      default: {
        const body = field(node, "text");
        if (body !== undefined) {
          run([textTask(body, label)]);
          return;
        }
        const alternative = field(node, "alternative_text");
        if (typeof alternative === "string") {
          emit(label ? escapeLabel(alternative) : alternative);
          return;
        }
        const expression = field(node, "expression");
        if (typeof expression === "string") {
          emit(label ? escapeLabel(expression) : expression);
        }
      }
    }
  }

  function closeFrame(): void {
    if (frames.length < 2) return;
    const frame = frames[frames.length - 1];
    frames.pop();
    if (frame.wrap !== null) {
      depth -= 1;
      append(frame.wrap(frame.parts.join("")));
      return;
    }
    if (frame.parts.length === 0) return;
    const parent = current();
    if (parent.parts.length > 0 && parent.sep !== "") {
      parent.parts.push(parent.sep);
    }
    if (frame.prefix !== "") parent.parts.push(frame.prefix);
    for (const part of frame.parts) parent.parts.push(part);
    if (frame.suffix !== "") parent.parts.push(frame.suffix);
  }

  const source = Array.isArray(value)
    ? (value as readonly unknown[])
    : isRecord(value)
      ? field(value, "blocks")
      : undefined;
  const blocks = Array.isArray(source)
    ? (source as readonly unknown[])
    : source === undefined || source === null
      ? []
      : [source];
  run(take(blocks).map((node) => blockTask(node)));

  try {
    while (stack.length > 0) {
      const task = stack.pop();
      if (task === undefined) break;
      if (task.kind === "close") {
        closeFrame();
        continue;
      }
      if (task.kind === "open") {
        const heavy = task.wrap !== null && depth < MAX_RICH_MESSAGE_DEPTH;
        if (heavy) depth += 1;
        frames.push({
          parts: [],
          sep: task.sep,
          wrap: heavy ? task.wrap : null,
          prefix: task.prefix,
          suffix: task.suffix,
        });
        continue;
      }
      // Потолки проверяются на задаче с содержимым, а не на закрытии кадра:
      // иначе truncated врал бы про сообщение, которое дочитано до конца.
      if (chars > MAX_RICH_MESSAGE_CHARS) {
        truncated = true;
        break;
      }
      if (task.kind === "emit") {
        emit(task.value);
        continue;
      }
      if (nodes >= MAX_RICH_MESSAGE_NODES) {
        truncated = true;
        break;
      }
      nodes += 1;
      if (task.kind === "block") handleBlock(task.node);
      else handleText(task.node, task.label);
    }
  } catch {
    // Ловушка последней надежды: прочитанное уже лежит в кадрах и в media.
    truncated = true;
  }

  while (frames.length > 1) closeFrame();
  return { text: frames[0].parts.join(""), media, truncated };
}
