// Чтение Telegram `Message.rich_message`: дерево RichBlock/RichText превращается в
// markdown-текст и список медиа. Схема взята из таблиц полей Bot API (RichBlock,
// RichText, RichBlockCaption, RichBlockListItem, RichBlockTableCell), а не из головы.
//
// Три обещания:
//  1. Ничего не теряем (ADR-0002): каждый видимый лист попадает в `text` в исходном
//     порядке, каждое медиа любой вложенности — в `media`.
//  2. Никогда не бросаем: годится любое значение — мусор, циклы, дыры в массивах,
//     ловушки в геттерах, Proxy. Обход итеративный, стек вызовов не переполняется.
//  3. Ограничены: потолки на узлы, символы и глубину. Потолок сработал — `text` и
//     `media` держат прочитанное, `truncated` становится true. Пустой ответ из-за
//     потолка сам по себе потеря данных, поэтому его не бывает.
//
// Политика листьев (написана явно, чтобы свойство было опровержимым): строка → сама
// строка; RichText с полем `text` → листья вложенного `text`; custom_emoji →
// `alternative_text`; mathematical_expression → `expression`; mention → листья `text`
// и следом `@username`; anchor → ничего, это невидимая цель ссылки; divider → текста
// нет, рисуется как `---`; RichBlockCaption → листья `text`, затем `credit`; map →
// только подпись, координаты не текст.
//
// Разметка одна — лёгкий markdown, который читается и в daily-файле, и моделью. Живой
// ссылкой становится только `http`/`https`; любая другая схема (`tg:`, `javascript:`,
// `data:`, `file:`, `mailto:`) печатается текстом `метка (адрес)`: адрес сохранён,
// живой ссылки нет. Чтобы чужой текст не подделал ссылку, в каждом листе экранируются
// `\`, `[`, `]`, `` ` `` и `<`: без скобок метка не открывается, без кавычки чужой
// текст не сцепится с нашим забором кода, без `<` не собирается автоссылка и не
// проходит сырой HTML. Экранирование снимается удалением `\`, поэтому данные целы. Внутри забора кода байты не трогаются — там markdown не разбирается.
// Заголовки, ячейки таблицы и summary сводят перевод строки к пробелу: иначе разметка
// блока рвётся.
import { mediaFromRaw, type TelegramRawMedia } from "./telegram-parts.ts";

export interface RichMessageReading {
  /** Markdown в исходном порядке; пустая строка, когда текста в сообщении нет.
   *  Листья экранированы (`\`, `[`, `]`, `` ` ``, `<`), обратно — удалением `\`. */
  readonly text: string;
  /** Медиа любой вложенности в исходном порядке; фото — самый крупный размер. */
  readonly media: readonly TelegramRawMedia[];
  /** true, когда потолок узлов или символов обрезал обход; прочитанное сохранено. */
  readonly truncated: boolean;
}

// Узлы ограничивают и работу, и память: список детей режется до постановки в стек.
// Символы считаются по листьям — это примерно сто длинных статей. Глубина ограничивает
// кадры, которые собирают текст целиком: без неё сто тысяч вложенных цитат стоили бы
// квадрат от длины текста. За потолком глубины теряется оформление, но не данные,
// поэтому `truncated` он не поднимает.
export const MAX_RICH_MESSAGE_NODES = 50_000;
export const MAX_RICH_MESSAGE_CHARS = 400_000;
export const MAX_RICH_MESSAGE_DEPTH = 64;

const BLOCK_SEP = "\n\n";

/** Собирает содержимое кадра целиком: заголовок, отступ, забор, префикс цитаты. */
type Wrap = (inner: string) => string;

/** `text` — обычный markdown, `label` — метка ссылки (вложенная ссылка не оживает),
 *  `code` — содержимое забора, где байты не трогаются. */
type Mode = "text" | "label" | "code";

type Task =
  | { readonly kind: "block"; readonly node: unknown }
  | { readonly kind: "text"; readonly node: unknown; readonly mode: Mode }
  | { readonly kind: "emit"; readonly value: string }
  | { readonly kind: "open"; readonly sep: string; readonly wrap: Wrap }
  | { readonly kind: "close" };

interface Frame {
  readonly parts: string[];
  readonly sep: string;
  readonly wrap: Wrap;
}

const CLOSE: Task = { kind: "close" };

function textTask(node: unknown, mode: Mode): Task {
  return { kind: "text", node, mode };
}

function blockTask(node: unknown): Task {
  return { kind: "block", node };
}

// `for..of`, а не `map`: `map` сохраняет дыры разреженного массива, и в стек попал бы
// `undefined` — обход принял бы его за конец работы и молча бросил остаток.
function tasks(
  items: readonly unknown[],
  make: (node: unknown) => Task,
): Task[] {
  const seq: Task[] = [];
  for (const item of items) seq.push(make(item));
  return seq;
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

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Лист в том виде, в каком он ложится в markdown: код — байт в байт, прочее — с экраном. */
function leafText(value: string, mode: Mode): string {
  return mode === "code" ? value : escapeLeaf(value);
}

function flatten(value: string): string {
  return value.replace(/[\r\n]+/gu, " ");
}

// Открыть ссылку, закрыть метку, открыть забор кода или пронести сырой HTML умеют
// ровно эти символы. Обратная кавычка в чужом тексте опаснее всего: она сцепилась бы
// с нашим забором и выпустила код наружу разметкой.
function escapeLeaf(value: string): string {
  return value.replace(/[\\[\]<`]/gu, "\\$&");
}

// Адрес внутри `(...)`: скобки и обратный слэш экранируются, пробелы, управляющие
// символы и обратная кавычка кодируются процентами — иначе CommonMark обрывает адрес
// на первом пробеле, а кавычка утаскивает половину абзаца в забор кода. Кодирование
// процентами адрес не меняет: `%60` и `` ` `` — один и тот же байт.
function escapeUrl(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    out +=
      char === "\\" || char === "(" || char === ")"
        ? `\\${char}`
        : code < 0x20 || code === 0x7f || char === "`" || /\s/u.test(char)
          ? encodeURIComponent(char)
          : char;
  }
  return out;
}

function isWebUrl(value: string): boolean {
  return /^https?:\/\//iu.test(value);
}

// Забор длиннее любой цепочки обратных кавычек внутри: содержимое из него не выйдет.
function backticks(value: string): number {
  let best = 0;
  for (const run of value.match(/`+/gu) ?? [])
    best = Math.max(best, run.length);
  return best;
}

function fenced(inner: string, tag: string): string {
  const bar = "`".repeat(Math.max(3, backticks(inner) + 1));
  return `${bar}${tag}\n${inner}\n${bar}`;
}

type PhotoRank = readonly [number, number, string];

// Порядок размеров фото полный — площадь, file_size, file_id, — поэтому выбор не
// зависит от того, в каком порядке Telegram прислал размеры, а нечисло и бесконечность
// становятся -1 и никогда не выигрывают у настоящего размера.
function photoRank(size: Record<string, unknown>, fileId: string): PhotoRank {
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
    fileId,
  ];
}

function outranks(a: PhotoRank, b: PhotoRank): boolean {
  if (a[0] !== b[0]) return a[0] > b[0];
  if (a[1] !== b[1]) return a[1] > b[1];
  return a[2] < b[2];
}

function largestPhoto(value: unknown): TelegramRawMedia | null {
  let best: PhotoRank | null = null;
  let uniqueId: unknown;
  for (const size of Array.isArray(value)
    ? (value as readonly unknown[])
    : []) {
    if (!isRecord(size)) continue;
    const fileId = field(size, "file_id");
    if (typeof fileId !== "string" || fileId === "") continue;
    const rank = photoRank(size, fileId);
    if (best !== null && !outranks(rank, best)) continue;
    best = rank;
    uniqueId = field(size, "file_unique_id");
  }
  if (best === null) return null;
  return {
    fileId: best[2],
    ...(typeof uniqueId === "string" ? { fileUniqueId: uniqueId } : {}),
    tag: "photo",
    transcribe: false,
  };
}

// Медиа ищется по полям, а не по типу блока: новый тип из будущей версии Bot API всё
// равно отдаст свой файл. Порядок такой же, как у обычного сообщения — фото, затем
// ключи из telegram-parts, куда voice_note подставляется под именем voice.
function blockMedia(node: Record<string, unknown>): TelegramRawMedia | null {
  try {
    const photo = largestPhoto(field(node, "photo"));
    if (photo !== null) return photo;
    const voice = field(node, "voice_note");
    return mediaFromRaw(isRecord(voice) ? { ...node, voice } : node);
  } catch {
    return null;
  }
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

// Перевод строки в короткий забор не поместится, поэтому берётся длинный.
const codeWrap: Wrap = (inner) => {
  if (inner === "") return "";
  if (inner.includes("\n")) return fenced(inner, "");
  const bar = "`".repeat(backticks(inner) + 1);
  const pad = /^[` ]|[` ]$/u.test(inner) ? " " : "";
  return `${bar}${pad}${inner}${pad}${bar}`;
};

function markWrap(mark: string): Wrap {
  return (inner) => (inner === "" ? "" : `${mark}${inner}${mark}`);
}

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
  return (inner) => (inner === "" ? "" : fenced(inner, tag));
}

// Своя метка пункта (`1.`, `a)`) заменяет дефис: два маркера подряд — уже не список.
function itemWrap(marker: string, label: string): Wrap {
  const head =
    label === ""
      ? marker
      : marker === "- "
        ? `${label} `
        : `${marker}${label} `;
  return (inner) => {
    if (inner === "") return label === "" ? "" : head.trimEnd();
    const lines = inner.split("\n");
    for (let i = 1; i < lines.length; i += 1) {
      if (lines[i] !== "") lines[i] = `  ${lines[i]}`;
    }
    return head + lines.join("\n");
  };
}

// url и mention устроены одинаково: хвост держит адрес или @username и виден даже
// тогда, когда метка пуста. Живой ссылкой хвост становится только у http/https и
// только когда метка не пуста и не разорвана пустой строкой: такую метку CommonMark
// обратно в ссылку не собирает.
function tailWrap(tail: string, live: string): Wrap {
  return (inner) =>
    live !== "" && inner !== "" && !/\n[ \t]*\n/u.test(inner)
      ? `[${inner}](${escapeUrl(live)})`
      : inner === ""
        ? tail
        : `${inner} (${tail})`;
}

// Разметка одного текста внутри строки. Остальные подтипы RichText аналога в markdown
// не имеют и печатаются как есть.
const INLINE_MARKS: Record<string, string> = {
  bold: "**",
  italic: "*",
  strikethrough: "~~",
};

export function readRichMessage(value: unknown): RichMessageReading {
  const media: TelegramRawMedia[] = [];
  const frames: Frame[] = [{ parts: [], sep: BLOCK_SEP, wrap: plainWrap }];
  const stack: Task[] = [];
  let nodes = 0;
  let chars = 0;
  let truncated = false;

  function append(value: string): void {
    if (value === "") return;
    const frame = frames[frames.length - 1];
    const last = frame.parts[frame.parts.length - 1];
    if (frame.parts.length > 0 && frame.sep !== "") {
      frame.parts.push(frame.sep);
    } else if (
      last !== undefined &&
      last.endsWith("`") &&
      value.startsWith("`")
    ) {
      // Два забора кода не имеют права слипнуться: цепочка кавычек на стыке закрыла
      // бы не тот забор, и содержимое вылезло бы наружу разметкой.
      frame.parts.push(" ");
    }
    frame.parts.push(value);
  }

  function emit(value: string): void {
    chars += value.length;
    append(value);
  }

  // Дети читаются один раз и с запасом по узлам: срез ограничивает и память, и работу,
  // а ловушка в Proxy или геттере стоит одного поля, а не всего обхода. Режется хвост,
  // поэтому начало текста сохраняется всегда.
  function take(value: unknown): readonly unknown[] {
    if (!Array.isArray(value)) return [];
    try {
      const limit = Math.max(0, MAX_RICH_MESSAGE_NODES - nodes);
      if (value.length > limit) truncated = true;
      return value.slice(0, limit);
    } catch {
      truncated = true;
      return [];
    }
  }

  function run(seq: readonly Task[]): void {
    for (let i = seq.length - 1; i >= 0; i -= 1) stack.push(seq[i]);
  }

  // Кадр с оформлением. За потолком глубины оформление уступает место запасному тексту
  // `head`/`tail`: адрес ссылки, @username и метка пункта остаются на своих местах, а
  // кадры не растут — иначе склейка стоила бы квадрат от длины текста.
  function framed(
    wrap: Wrap,
    sep: string,
    inner: Task[],
    head = "",
    tail = "",
  ): Task[] {
    if (frames.length <= MAX_RICH_MESSAGE_DEPTH) {
      return [{ kind: "open", sep, wrap }, ...inner, CLOSE];
    }
    const seq: Task[] =
      head === "" ? [...inner] : [{ kind: "emit", value: head }, ...inner];
    if (tail !== "") seq.push({ kind: "emit", value: tail });
    return seq;
  }

  /** Один текст как отдельный кусок блока. */
  function lineSeq(node: unknown, wrap: Wrap = plainWrap, mode: Mode = "text") {
    return framed(wrap, "", [textTask(node, mode)]);
  }

  // RichBlockCaption — это `{ text, credit }`, а не RichText: у RichText всегда есть
  // строковый `type`, у подписи его нет. Обе формы читаются одним местом.
  function captionSeq(value: unknown): Task[] {
    if (value === undefined || value === null) return [];
    if (!isRecord(value) || typeof field(value, "type") === "string") {
      return lineSeq(value);
    }
    const body = field(value, "text");
    const credit = field(value, "credit");
    return [
      ...(body === undefined ? [] : lineSeq(body)),
      ...(credit === undefined ? [] : lineSeq(credit)),
    ];
  }

  // Общая форма блока: текст, summary, формула, вложенные блоки, credit, подпись. Так
  // читаются и paragraph, footer, thinking, math, anchor, details, collage, slideshow,
  // map и все медиа-блоки, и любой тип, которого мы ещё не знаем: новый тип из будущей
  // версии Bot API теряет разметку, но не содержание.
  function blockSeq(node: Record<string, unknown>): Task[] {
    const seq: Task[] = [];
    const body = field(node, "text");
    if (body !== undefined) seq.push(...lineSeq(body));
    const summary = field(node, "summary");
    if (summary !== undefined) seq.push(...lineSeq(summary, summaryWrap));
    // Формула идёт как код: LaTeX остаётся байт в байт, markdown внутри не живёт.
    const expression = field(node, "expression");
    if (typeof expression === "string") {
      seq.push({ kind: "emit", value: codeWrap(expression) });
    }
    for (const child of take(field(node, "blocks"))) seq.push(blockTask(child));
    const credit = field(node, "credit");
    if (credit !== undefined) seq.push(...lineSeq(credit));
    seq.push(...captionSeq(field(node, "caption")));
    return seq;
  }

  function listSeq(node: Record<string, unknown>): Task[] {
    const items: Task[] = [];
    for (const item of take(field(node, "items"))) {
      const record = isRecord(item) ? item : null;
      const label = escapeLeaf(
        record === null ? "" : asText(field(record, "label")),
      );
      const marker =
        record !== null && field(record, "has_checkbox") === true
          ? field(record, "is_checked") === true
            ? "- [x] "
            : "- [ ] "
          : "- ";
      chars += label.length;
      const body =
        record === null
          ? [textTask(item, "text")]
          : tasks(take(field(record, "blocks")), blockTask);
      items.push(...framed(itemWrap(marker, label), BLOCK_SEP, body, label));
    }
    return framed(plainWrap, "\n", items);
  }

  function tableSeq(node: Record<string, unknown>): Task[] {
    const rows = take(field(node, "cells"));
    const body: Task[] = [];
    for (let i = 0; i < rows.length; i += 1) {
      const cells = take(rows[i]);
      const row: Task[] = [];
      for (const cell of cells) {
        const text = isRecord(cell) ? field(cell, "text") : cell;
        row.push(...lineSeq(text, cellWrap));
      }
      body.push(...framed(rowWrap, " | ", row));
      // Линейка после первой строки: без неё markdown не считает таблицу таблицей.
      if (i === 0 && cells.length > 0) {
        const ruler = new Array(cells.length).fill("---").join(" | ");
        body.push({ kind: "emit", value: `| ${ruler} |` });
      }
    }
    return [
      ...framed(plainWrap, "\n", body),
      ...captionSeq(field(node, "caption")),
    ];
  }

  function handleBlock(node: unknown): void {
    if (typeof node === "string") return run(lineSeq(node));
    if (!isRecord(node)) return;
    const found = blockMedia(node);
    if (found !== null) media.push(found);
    switch (field(node, "type")) {
      case "heading":
        return run(
          lineSeq(field(node, "text"), headingWrap(field(node, "size"))),
        );
      case "pre":
        return run(
          lineSeq(
            field(node, "text"),
            preWrap(field(node, "language")),
            "code",
          ),
        );
      case "divider":
        return emit("---");
      case "list":
        return run(listSeq(node));
      case "table":
        return run(tableSeq(node));
      case "blockquote":
      case "pullquote":
        return run(framed(quoteWrap, BLOCK_SEP, blockSeq(node)));
      default:
        return run(blockSeq(node));
    }
  }

  function handleText(node: unknown, mode: Mode): void {
    if (typeof node === "string") {
      return emit(leafText(node, mode));
    }
    if (Array.isArray(node)) {
      return run(tasks(take(node), (child) => textTask(child, mode)));
    }
    if (!isRecord(node)) return;
    const type = field(node, "type");
    if (type === "code") {
      return run(lineSeq(field(node, "text"), codeWrap, "code"));
    }
    const url = type === "url" ? asText(field(node, "url")) : "";
    const username = type === "mention" ? asText(field(node, "username")) : "";
    const tail =
      url !== ""
        ? escapeLeaf(url)
        : username === ""
          ? ""
          : escapeLeaf(username.startsWith("@") ? username : `@${username}`);
    if (tail !== "") {
      const live = mode === "text" && isWebUrl(url) ? url : "";
      chars += tail.length;
      return run(
        framed(
          tailWrap(tail, live),
          "",
          [textTask(field(node, "text"), live === "" ? mode : "label")],
          "",
          ` (${tail})`,
        ),
      );
    }
    const mark = typeof type === "string" ? INLINE_MARKS[type] : undefined;
    if (mark !== undefined) {
      return run(lineSeq(field(node, "text"), markWrap(mark), mode));
    }
    // Всё остальное, включая незнакомые типы: берём текст, каким бы полем он ни пришёл.
    // `text` у двадцати подтипов, `alternative_text` у custom_emoji, `expression` у
    // формулы; у anchor нет ничего, и это правильно.
    const body = field(node, "text");
    if (body !== undefined) return run([textTask(body, mode)]);
    const alternative = field(node, "alternative_text");
    if (typeof alternative === "string") {
      return emit(leafText(alternative, mode));
    }
    const expression = field(node, "expression");
    if (typeof expression === "string") {
      return emit(mode === "code" ? expression : codeWrap(expression));
    }
  }

  function closeFrame(): void {
    if (frames.length < 2) return;
    const frame = frames[frames.length - 1];
    frames.pop();
    append(frame.wrap(frame.parts.join("")));
  }

  try {
    // Верхний уровень читается так же осторожно, как всё остальное: сообщение — это
    // `{ blocks }`, но одинокий блок и голая строка тоже не теряются. Ловушка в Proxy
    // или геттере на входе не имеет права выйти наружу исключением.
    const inner = isRecord(value) ? field(value, "blocks") : undefined;
    const source = inner === undefined ? value : inner;
    const blocks = Array.isArray(source)
      ? take(source)
      : source === undefined || source === null
        ? []
        : [source];
    run(tasks(blocks, blockTask));

    while (stack.length > 0) {
      const task = stack.pop();
      if (task === undefined) continue;
      if (task.kind === "close") {
        closeFrame();
        continue;
      }
      if (task.kind === "open") {
        frames.push({ parts: [], sep: task.sep, wrap: task.wrap });
        continue;
      }
      // Потолки проверяются на задаче с содержимым, а не на закрытии кадра: иначе
      // truncated врал бы про сообщение, которое дочитано до конца.
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
      else handleText(task.node, task.mode);
    }
  } catch {
    // Ловушка последней надежды: прочитанное уже лежит в кадрах и в media.
    truncated = true;
  }

  while (frames.length > 1) closeFrame();
  return { text: frames[0].parts.join(""), media, truncated };
}
