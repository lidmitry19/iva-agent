/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Тесты чтения `Message.rich_message`. Якоря держат контракт по таблицам полей
// Bot API — по одному на каждый из 21 типа RichBlock и 27 типов RichText, — а
// генераторы перебирают валидные деревья и мусор.
//
// Политика листьев повторяет ту, что записана в telegram-rich-message.ts, и здесь
// она превращается в проверку: строка → сама строка, RichText с `text` → листья
// вложенного текста, custom_emoji → alternative_text, math → expression,
// mention → текст плюс @username, anchor и divider → текста нет,
// RichBlockCaption → text, затем credit. Отличие от прежней попытки: медиа в
// списке ожиданий не только фото, а любой файл на любой глубине.
//
// КАК ВОСПРОИЗВЕСТИ ПАДЕНИЕ: fast-check печатает строку вида
// `Property failed after N tests { seed: -1234567, path: "12:3:0", endOnFailure: true }`.
// Подставь её вторым аргументом — fc.assert(prop, { seed: -1234567, path: "12:3:0" }) —
// и прогон повторится байт в байт, включая shrink. Seed каждого прогона стоит в
// имени теста.
import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import {
  MAX_RICH_MESSAGE_CHARS,
  MAX_RICH_MESSAGE_DEPTH,
  MAX_RICH_MESSAGE_NODES,
  readRichMessage,
} from "./telegram-rich-message.ts";

const SEEDS = [1, 424242, 20260817];

// --- строгий сканер ссылок CommonMark ---------------------------------------
// Ищет каждую живую `[метка](адрес)`: экранированная скобка ссылку не открывает.
// Забор кода сканер проходит насквозь: в CommonMark код сильнее ссылки, поэтому
// содержимое забора ссылкой не становится ни у одного renderer. Выйти из забора
// содержимое не может — забор всегда длиннее любой цепочки кавычек внутри.
interface Link {
  readonly label: string;
  readonly dest: string;
}

/** Конец забора кода, начатого в позиции `at`, или -1, если забор не закрыт. */
function codeEnd(source: string, at: number): number {
  const opened = /^`+/u.exec(source.slice(at));
  if (opened === null) return -1;
  const bar = opened[0];
  for (let from = at + bar.length; from < source.length;) {
    const found = source.indexOf(bar, from);
    if (found === -1) return -1;
    if (source[found - 1] !== "`" && source[found + bar.length] !== "`") {
      return found + bar.length;
    }
    from = found + bar.length;
  }
  return -1;
}

function unescape(value: string): string {
  return value.replaceAll(/\\(.)/gu, "$1");
}

function scanLinks(source: string): Link[] {
  const found: Link[] = [];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === "\\") {
      i += 1;
      continue;
    }
    if (source[i] === "`") {
      const end = codeEnd(source, i);
      if (end !== -1) {
        i = end - 1;
        continue;
      }
    }
    if (source[i] !== "[") continue;
    let label = "";
    let closed = -1;
    let j = i + 1;
    for (; j < source.length; j += 1) {
      if (source[j] === "\\") {
        label += source[j] + (source[j + 1] ?? "");
        j += 1;
        continue;
      }
      if (source[j] === "`") {
        const end = codeEnd(source, j);
        if (end !== -1) {
          label += source.slice(j, end);
          j = end - 1;
          continue;
        }
      }
      if (source[j] === "]") {
        closed = j;
        break;
      }
      // Пустая строка закрывает абзац, ссылка через неё не собирается.
      if (source[j] === "\n" && source[j + 1] === "\n") {
        closed = -2;
        break;
      }
      label += source[j];
    }
    if (closed < 0 || source[closed + 1] !== "(") continue;
    let dest = "";
    let depth = 0;
    let complete = false;
    let k = closed + 2;
    for (; k < source.length; k += 1) {
      const char = source[k];
      if (char === "\\") {
        dest += char + (source[k + 1] ?? "");
        k += 1;
        continue;
      }
      if (char === "(") {
        depth += 1;
        dest += char;
        continue;
      }
      if (char === ")") {
        if (depth === 0) {
          complete = true;
          break;
        }
        depth -= 1;
        dest += char;
        continue;
      }
      if (/\s/u.test(char)) break;
      dest += char;
    }
    if (!complete) continue;
    found.push({ label: unescape(label), dest: unescape(dest) });
    i = k;
  }
  return found;
}

/** Каждый лист присутствует, и именно в исходном порядке. */
function missingLeaves(text: string, leaves: readonly string[]): string[] {
  const missing: string[] = [];
  let cursor = 0;
  for (const leaf of leaves) {
    const at = text.indexOf(leaf, cursor);
    if (at === -1) missing.push(leaf);
    else cursor = at + leaf.length;
  }
  return missing;
}

// --- генераторы валидных деревьев -------------------------------------------
interface Gen<T> {
  readonly value: T;
  readonly leaves: readonly string[];
  readonly mediaIds: readonly string[];
}

let counter = 0;
function token(): string {
  counter += 1;
  return `L${counter.toString(36)}Z`;
}

const leafString = fc.constant(null).map((): Gen<unknown> => {
  const value = token();
  return { value, leaves: [value], mediaIds: [] };
});

/** Подтипы RichText вида `{ type, text, ...extra }` по таблицам Bot API. */
const TEXT_WRAPPER_TYPES = [
  "bold",
  "italic",
  "underline",
  "strikethrough",
  "spoiler",
  "subscript",
  "superscript",
  "marked",
  "code",
  "date_time",
  "text_mention",
  "url",
  "email_address",
  "phone_number",
  "bank_card_number",
  "hashtag",
  "cashtag",
  "bot_command",
  "anchor_link",
  "reference",
  "reference_link",
] as const;

const EXTRA_FIELDS: Record<string, () => Record<string, unknown>> = {
  date_time: () => ({ unix_time: 1755000000, date_time_format: "d MMMM" }),
  text_mention: () => ({ user: { id: 1, is_bot: false, first_name: "U" } }),
  url: () => ({ url: "https://example.com/a" }),
  email_address: () => ({ email_address: "a@b.co" }),
  phone_number: () => ({ phone_number: "+15550001" }),
  bank_card_number: () => ({ bank_card_number: "4111111111111111" }),
  hashtag: () => ({ hashtag: "#tag" }),
  cashtag: () => ({ cashtag: "$USD" }),
  bot_command: () => ({ bot_command: "/start" }),
  anchor_link: () => ({ anchor_name: "sec" }),
  reference: () => ({ name: "ref1" }),
  reference_link: () => ({ reference_name: "ref1" }),
};

function richText(depth: number): fc.Arbitrary<Gen<unknown>> {
  if (depth <= 0) return leafString;
  return fc.oneof(
    { depthSize: "small" },
    leafString,
    fc
      .array(richText(depth - 1), { minLength: 1, maxLength: 3 })
      .map((kids) => ({
        value: kids.map((kid) => kid.value),
        leaves: kids.flatMap((kid) => kid.leaves),
        mediaIds: [],
      })),
    fc
      .tuple(fc.constantFrom(...TEXT_WRAPPER_TYPES), richText(depth - 1))
      .map(([type, child]) => ({
        value: {
          type,
          text: child.value,
          ...(EXTRA_FIELDS[type]?.() ?? {}),
        },
        leaves: child.leaves,
        mediaIds: [],
      })),
    // mention: видимый текст плюс @username — оба обязаны дойти.
    richText(depth - 1).map((child) => ({
      value: { type: "mention", text: child.value, username: "durov" },
      leaves: [...child.leaves, "@durov"],
      mediaIds: [],
    })),
    fc.constant(null).map(() => {
      const value = token();
      return {
        value: {
          type: "custom_emoji",
          custom_emoji_id: "5368324170671202286",
          alternative_text: value,
        },
        leaves: [value],
        mediaIds: [],
      };
    }),
    fc.constant(null).map(() => {
      const value = token();
      return {
        value: { type: "mathematical_expression", expression: value },
        leaves: [value],
        mediaIds: [],
      };
    }),
    fc.constant({
      value: { type: "anchor", name: "top" },
      leaves: [] as readonly string[],
      mediaIds: [] as readonly string[],
    }),
  );
}

function caption(depth: number): fc.Arbitrary<Gen<unknown>> {
  return fc
    .tuple(richText(depth), fc.option(richText(depth), { nil: undefined }))
    .map(([text, credit]) => ({
      value: { text: text.value, ...(credit ? { credit: credit.value } : {}) },
      leaves: [...text.leaves, ...(credit?.leaves ?? [])],
      mediaIds: [],
    }));
}

function photoSizes(): { sizes: unknown[]; id: string } {
  counter += 1;
  const id = `PH${counter.toString(36)}`;
  return {
    sizes: [
      {
        file_id: `${id}_s`,
        file_unique_id: "u1",
        width: 90,
        height: 60,
        file_size: 1000,
      },
      {
        file_id: id,
        file_unique_id: "u2",
        width: 1280,
        height: 853,
        file_size: 90000,
      },
    ],
    id,
  };
}

function fileId(prefix: string): string {
  counter += 1;
  return `${prefix}${counter.toString(36)}`;
}

function richBlock(depth: number): fc.Arbitrary<Gen<unknown>> {
  const textDepth = Math.min(2, depth + 1);
  const simple = (type: string) =>
    richText(textDepth).map((body) => ({
      value: {
        type,
        text: body.value,
        ...(type === "heading" ? { size: 2 } : {}),
        ...(type === "pre" ? { language: "ts" } : {}),
      },
      leaves: body.leaves,
      mediaIds: [] as readonly string[],
    }));

  const mediaBlock = (
    type: string,
    key: string,
    prefix: string,
  ): fc.Arbitrary<Gen<unknown>> =>
    caption(textDepth).map((cap) => {
      const id = fileId(prefix);
      return {
        value: {
          type,
          [key]: { file_id: id, file_unique_id: "u", duration: 1 },
          caption: cap.value,
        },
        leaves: cap.leaves,
        mediaIds: [id],
      };
    });

  const options: Array<fc.Arbitrary<Gen<unknown>>> = [
    simple("paragraph"),
    simple("heading"),
    simple("pre"),
    simple("footer"),
    simple("thinking"),
    fc.constant({
      value: { type: "divider" },
      leaves: [] as readonly string[],
      mediaIds: [] as readonly string[],
    }),
    fc.constant(null).map(() => {
      const value = token();
      return {
        value: { type: "mathematical_expression", expression: value },
        leaves: [value],
        mediaIds: [],
      };
    }),
    fc.constant({
      value: { type: "anchor", name: "sec1" },
      leaves: [] as readonly string[],
      mediaIds: [] as readonly string[],
    }),
    fc
      .tuple(
        richText(textDepth),
        fc.option(richText(textDepth), { nil: undefined }),
      )
      .map(([body, credit]) => ({
        value: {
          type: "pullquote",
          text: body.value,
          ...(credit ? { credit: credit.value } : {}),
        },
        leaves: [...body.leaves, ...(credit?.leaves ?? [])],
        mediaIds: [],
      })),
    fc.constant(null).map(() => {
      const { sizes, id } = photoSizes();
      return {
        value: { type: "photo", photo: sizes },
        leaves: [],
        mediaIds: [id],
      };
    }),
    caption(textDepth).map((cap) => {
      const { sizes, id } = photoSizes();
      return {
        value: { type: "photo", photo: sizes, caption: cap.value },
        leaves: cap.leaves,
        mediaIds: [id],
      };
    }),
    mediaBlock("video", "video", "VID"),
    mediaBlock("audio", "audio", "AUD"),
    mediaBlock("voice_note", "voice_note", "VOI"),
    mediaBlock("animation", "animation", "ANI"),
    caption(textDepth).map((cap) => ({
      value: {
        type: "map",
        location: { latitude: 1, longitude: 2 },
        zoom: 15,
        width: 200,
        height: 200,
        caption: cap.value,
      },
      leaves: cap.leaves,
      mediaIds: [],
    })),
    fc
      .tuple(richText(textDepth), richText(textDepth), richText(textDepth))
      .map(([head, cell, cap]) => ({
        value: {
          type: "table",
          cells: [
            [
              {
                text: head.value,
                is_header: true,
                align: "left",
                valign: "top",
              },
            ],
            [{ text: cell.value }],
          ],
          is_bordered: true,
          caption: cap.value,
        },
        leaves: [...head.leaves, ...cell.leaves, ...cap.leaves],
        mediaIds: [],
      })),
  ];

  if (depth > 0) {
    const child = richBlock(depth - 1);
    options.push(
      fc
        .tuple(
          fc.array(child, { minLength: 1, maxLength: 2 }),
          fc.option(richText(textDepth), { nil: undefined }),
        )
        .map(([kids, credit]) => ({
          value: {
            type: "blockquote",
            blocks: kids.map((kid) => kid.value),
            ...(credit ? { credit: credit.value } : {}),
          },
          leaves: [
            ...kids.flatMap((kid) => kid.leaves),
            ...(credit?.leaves ?? []),
          ],
          mediaIds: kids.flatMap((kid) => kid.mediaIds),
        })),
      fc
        .array(fc.array(child, { minLength: 1, maxLength: 2 }), {
          minLength: 1,
          maxLength: 2,
        })
        .map((items) => {
          const built = items.map((kids) => ({ label: token(), kids }));
          return {
            value: {
              type: "list",
              items: built.map((item) => ({
                label: item.label,
                blocks: item.kids.map((kid) => kid.value),
              })),
            },
            leaves: built.flatMap((item) => [
              item.label,
              ...item.kids.flatMap((kid) => kid.leaves),
            ]),
            mediaIds: built.flatMap((item) =>
              item.kids.flatMap((kid) => kid.mediaIds),
            ),
          };
        }),
      fc
        .tuple(
          fc.array(child, { minLength: 1, maxLength: 3 }),
          caption(textDepth),
        )
        .map(([kids, cap]) => ({
          value: {
            type: "collage",
            blocks: kids.map((kid) => kid.value),
            caption: cap.value,
          },
          leaves: [...kids.flatMap((kid) => kid.leaves), ...cap.leaves],
          mediaIds: kids.flatMap((kid) => kid.mediaIds),
        })),
      fc
        .tuple(
          fc.array(child, { minLength: 1, maxLength: 3 }),
          caption(textDepth),
        )
        .map(([kids, cap]) => ({
          value: {
            type: "slideshow",
            blocks: kids.map((kid) => kid.value),
            caption: cap.value,
          },
          leaves: [...kids.flatMap((kid) => kid.leaves), ...cap.leaves],
          mediaIds: kids.flatMap((kid) => kid.mediaIds),
        })),
      fc
        .tuple(
          richText(textDepth),
          fc.array(child, { minLength: 1, maxLength: 2 }),
        )
        .map(([summary, kids]) => ({
          value: {
            type: "details",
            summary: summary.value,
            blocks: kids.map((kid) => kid.value),
            is_open: true,
          },
          leaves: [...summary.leaves, ...kids.flatMap((kid) => kid.leaves)],
          mediaIds: kids.flatMap((kid) => kid.mediaIds),
        })),
    );
  }

  return fc.oneof({ depthSize: "small" }, ...options);
}

function richMessage(depth = 1): fc.Arbitrary<Gen<Record<string, unknown>>> {
  return fc
    .array(richBlock(depth), { minLength: 1, maxLength: 4 })
    .map((blocks) => ({
      value: { blocks: blocks.map((block) => block.value), is_rtl: false },
      leaves: blocks.flatMap((block) => block.leaves),
      mediaIds: blocks.flatMap((block) => block.mediaIds),
    }));
}

// --- якоря: покрытие схемы Bot API ------------------------------------------
const PHOTO = [
  { file_id: "PH_S", file_unique_id: "s", width: 90, height: 60, file_size: 1 },
  {
    file_id: "PH_L",
    file_unique_id: "l",
    width: 1280,
    height: 853,
    file_size: 9,
  },
];
const CAPTION = { text: "CAPLEAF", credit: "CREDITLEAF" };

interface BlockProbe {
  readonly name: string;
  readonly block: unknown;
  readonly leaves: readonly string[];
  readonly media: readonly string[];
}

const BLOCK_PROBES: readonly BlockProbe[] = [
  {
    name: "paragraph",
    block: { type: "paragraph", text: "TXT" },
    leaves: ["TXT"],
    media: [],
  },
  {
    name: "heading",
    block: { type: "heading", text: "TXT", size: 1 },
    leaves: ["TXT"],
    media: [],
  },
  {
    name: "pre",
    block: { type: "pre", text: "TXT", language: "ts" },
    leaves: ["TXT"],
    media: [],
  },
  {
    name: "footer",
    block: { type: "footer", text: "TXT" },
    leaves: ["TXT"],
    media: [],
  },
  { name: "divider", block: { type: "divider" }, leaves: [], media: [] },
  {
    name: "mathematical_expression",
    block: { type: "mathematical_expression", expression: "TXT" },
    leaves: ["TXT"],
    media: [],
  },
  {
    name: "anchor",
    block: { type: "anchor", name: "sec" },
    leaves: [],
    media: [],
  },
  {
    name: "list",
    block: {
      type: "list",
      items: [
        {
          label: "TXT",
          blocks: [
            { type: "paragraph", text: "TXT2" },
            { type: "photo", photo: PHOTO },
          ],
        },
      ],
    },
    leaves: ["TXT", "TXT2"],
    media: ["PH_L"],
  },
  {
    name: "blockquote",
    block: {
      type: "blockquote",
      blocks: [
        { type: "paragraph", text: "TXT" },
        { type: "photo", photo: PHOTO },
      ],
      credit: "CREDITLEAF",
    },
    leaves: ["TXT", "CREDITLEAF"],
    media: ["PH_L"],
  },
  {
    name: "pullquote",
    block: { type: "pullquote", text: "TXT", credit: "CREDITLEAF" },
    leaves: ["TXT", "CREDITLEAF"],
    media: [],
  },
  {
    name: "collage",
    block: {
      type: "collage",
      blocks: [{ type: "photo", photo: PHOTO }],
      caption: CAPTION,
    },
    leaves: ["CAPLEAF", "CREDITLEAF"],
    media: ["PH_L"],
  },
  {
    name: "slideshow",
    block: {
      type: "slideshow",
      blocks: [
        { type: "photo", photo: PHOTO },
        { type: "video", video: { file_id: "VID" } },
      ],
      caption: CAPTION,
    },
    leaves: ["CAPLEAF", "CREDITLEAF"],
    media: ["PH_L", "VID"],
  },
  {
    name: "table",
    block: {
      type: "table",
      cells: [[{ text: "TXT", is_header: true }], [{ text: "TXT2" }]],
      caption: "CAPLEAF",
    },
    leaves: ["TXT", "TXT2", "CAPLEAF"],
    media: [],
  },
  {
    name: "details",
    block: {
      type: "details",
      summary: "TXT",
      blocks: [
        { type: "paragraph", text: "TXT2" },
        { type: "photo", photo: PHOTO },
      ],
      is_open: true,
    },
    leaves: ["TXT", "TXT2"],
    media: ["PH_L"],
  },
  {
    name: "map",
    block: {
      type: "map",
      location: { latitude: 1, longitude: 1 },
      zoom: 15,
      width: 1,
      height: 1,
      caption: CAPTION,
    },
    leaves: ["CAPLEAF", "CREDITLEAF"],
    media: [],
  },
  {
    name: "animation",
    block: {
      type: "animation",
      animation: { file_id: "ANI" },
      caption: CAPTION,
    },
    leaves: ["CAPLEAF", "CREDITLEAF"],
    media: ["ANI"],
  },
  {
    name: "audio",
    block: { type: "audio", audio: { file_id: "AUD" }, caption: CAPTION },
    leaves: ["CAPLEAF", "CREDITLEAF"],
    media: ["AUD"],
  },
  {
    name: "photo",
    block: { type: "photo", photo: PHOTO, caption: CAPTION },
    leaves: ["CAPLEAF", "CREDITLEAF"],
    media: ["PH_L"],
  },
  {
    name: "video",
    block: { type: "video", video: { file_id: "VID" }, caption: CAPTION },
    leaves: ["CAPLEAF", "CREDITLEAF"],
    media: ["VID"],
  },
  {
    name: "voice_note",
    block: {
      type: "voice_note",
      voice_note: { file_id: "VOI" },
      caption: CAPTION,
    },
    leaves: ["CAPLEAF", "CREDITLEAF"],
    media: ["VOI"],
  },
  {
    name: "thinking",
    block: { type: "thinking", text: "TXT" },
    leaves: ["TXT"],
    media: [],
  },
];

interface TextProbe {
  readonly name: string;
  readonly node: unknown;
  readonly leaves: readonly string[];
}

const TEXT_PROBES: readonly TextProbe[] = [
  { name: "String", node: "TXT", leaves: ["TXT"] },
  {
    name: "Array of RichText",
    node: ["TXT", ["TXT2"]],
    leaves: ["TXT", "TXT2"],
  },
  { name: "bold", node: { type: "bold", text: "TXT" }, leaves: ["TXT"] },
  { name: "italic", node: { type: "italic", text: "TXT" }, leaves: ["TXT"] },
  {
    name: "underline",
    node: { type: "underline", text: "TXT" },
    leaves: ["TXT"],
  },
  {
    name: "strikethrough",
    node: { type: "strikethrough", text: "TXT" },
    leaves: ["TXT"],
  },
  { name: "spoiler", node: { type: "spoiler", text: "TXT" }, leaves: ["TXT"] },
  {
    name: "date_time",
    node: {
      type: "date_time",
      text: "TXT",
      unix_time: 1,
      date_time_format: "d",
    },
    leaves: ["TXT"],
  },
  {
    name: "text_mention",
    node: { type: "text_mention", text: "TXT", user: { id: 1 } },
    leaves: ["TXT"],
  },
  {
    name: "subscript",
    node: { type: "subscript", text: "TXT" },
    leaves: ["TXT"],
  },
  {
    name: "superscript",
    node: { type: "superscript", text: "TXT" },
    leaves: ["TXT"],
  },
  { name: "marked", node: { type: "marked", text: "TXT" }, leaves: ["TXT"] },
  { name: "code", node: { type: "code", text: "TXT" }, leaves: ["TXT"] },
  {
    name: "custom_emoji",
    node: {
      type: "custom_emoji",
      custom_emoji_id: "1",
      alternative_text: "TXT",
    },
    leaves: ["TXT"],
  },
  {
    name: "mathematical_expression",
    node: { type: "mathematical_expression", expression: "TXT" },
    leaves: ["TXT"],
  },
  {
    name: "url",
    node: { type: "url", text: "TXT", url: "https://e.com/" },
    leaves: ["TXT", "https://e.com/"],
  },
  {
    name: "email_address",
    node: { type: "email_address", text: "TXT", email_address: "a@b.co" },
    leaves: ["TXT"],
  },
  {
    name: "phone_number",
    node: { type: "phone_number", text: "TXT", phone_number: "+1" },
    leaves: ["TXT"],
  },
  {
    name: "bank_card_number",
    node: { type: "bank_card_number", text: "TXT", bank_card_number: "4111" },
    leaves: ["TXT"],
  },
  {
    name: "mention",
    node: { type: "mention", text: "TXT", username: "durov" },
    leaves: ["TXT", "@durov"],
  },
  {
    name: "hashtag",
    node: { type: "hashtag", text: "TXT", hashtag: "#t" },
    leaves: ["TXT"],
  },
  {
    name: "cashtag",
    node: { type: "cashtag", text: "TXT", cashtag: "$T" },
    leaves: ["TXT"],
  },
  {
    name: "bot_command",
    node: { type: "bot_command", text: "TXT", bot_command: "/s" },
    leaves: ["TXT"],
  },
  { name: "anchor", node: { type: "anchor", name: "sec" }, leaves: [] },
  {
    name: "anchor_link",
    node: { type: "anchor_link", text: "TXT", anchor_name: "sec" },
    leaves: ["TXT"],
  },
  {
    name: "reference",
    node: { type: "reference", text: "TXT", name: "r" },
    leaves: ["TXT"],
  },
  {
    name: "reference_link",
    node: { type: "reference_link", text: "TXT", reference_name: "r" },
    leaves: ["TXT"],
  },
];

describe("every documented RichBlock type keeps its text and its media", () => {
  for (const probe of BLOCK_PROBES) {
    it(`${probe.name} loses nothing`, () => {
      const reading = readRichMessage({ blocks: [probe.block] });
      assert.deepEqual(
        missingLeaves(reading.text, probe.leaves),
        [],
        `text=${JSON.stringify(reading.text)}`,
      );
      assert.deepEqual(
        reading.media.map((item) => item.fileId),
        [...probe.media],
      );
      assert.equal(reading.truncated, false);
    });
  }
});

describe("every documented RichText type keeps its text", () => {
  for (const probe of TEXT_PROBES) {
    it(`${probe.name} loses nothing`, () => {
      const reading = readRichMessage({
        blocks: [{ type: "paragraph", text: probe.node }],
      });
      assert.deepEqual(
        missingLeaves(reading.text, probe.leaves),
        [],
        `text=${JSON.stringify(reading.text)}`,
      );
      assert.equal(reading.truncated, false);
    });
  }
});

// --- якоря: как выглядит разметка -------------------------------------------
test("markdown shape: headings stop at the third level", () => {
  const sizes = [1, 2, 3, 4, 5, 6].map(
    (size) =>
      readRichMessage({ blocks: [{ type: "heading", text: "H", size }] }).text,
  );
  assert.deepEqual(sizes, [
    "### H",
    "### H",
    "### H",
    "#### H",
    "##### H",
    "###### H",
  ]);
});

test("markdown shape: list, quote, table and code", () => {
  assert.equal(
    readRichMessage({
      blocks: [
        {
          type: "list",
          items: [
            { label: "1.", blocks: [{ type: "paragraph", text: "one" }] },
            {
              label: "",
              has_checkbox: true,
              is_checked: true,
              blocks: [{ type: "paragraph", text: "two" }],
            },
          ],
        },
      ],
    }).text,
    "1. one\n- [x] two",
  );
  assert.equal(
    readRichMessage({
      blocks: [
        {
          type: "blockquote",
          blocks: [{ type: "paragraph", text: "line one\nline two" }],
        },
      ],
    }).text,
    "> line one\n> line two",
  );
  assert.equal(
    readRichMessage({
      blocks: [
        {
          type: "table",
          cells: [
            [{ text: "a", is_header: true }, { text: "b|c" }],
            [{ text: "d" }, {}],
          ],
        },
      ],
    }).text,
    "| a | b\\|c |\n| --- | --- |\n| d |   |",
  );
  assert.equal(
    readRichMessage({
      blocks: [{ type: "pre", text: "let a = 1;", language: "ts" }],
    }).text,
    "```ts\nlet a = 1;\n```",
  );
  assert.equal(
    readRichMessage({
      blocks: [{ type: "paragraph", text: { type: "code", text: "a `b` c" } }],
    }).text,
    "``a `b` c``",
  );
});

test("markdown shape: a fenced block cannot be escaped by its own content", () => {
  const reading = readRichMessage({
    blocks: [{ type: "pre", text: "```\nnested\n```", language: "js" }],
  });
  assert.equal(reading.text, "````js\n```\nnested\n```\n````");
  assert.ok(reading.text.includes("nested"));
});

test("blocks are separated by a blank line and empty ones leave no gap", () => {
  assert.equal(
    readRichMessage({
      blocks: [
        { type: "paragraph", text: "one" },
        { type: "anchor", name: "invisible" },
        { type: "paragraph", text: "two" },
      ],
    }).text,
    "one\n\ntwo",
  );
});

// --- якоря: ссылки ----------------------------------------------------------
test("only http and https become a live link", () => {
  const cases: Array<[string, string]> = [
    ["https://ok.example/x", "[click](https://ok.example/x)"],
    ["http://ok.example/x", "[click](http://ok.example/x)"],
    [
      "tg://resolve?domain=evil_bot&start=x",
      "click (tg://resolve?domain=evil_bot&start=x)",
    ],
    ["javascript:alert(1)", "click (javascript:alert(1))"],
    ["JaVaScRiPt:alert(1)", "click (JaVaScRiPt:alert(1))"],
    [
      "data:text/html;base64,PHNjcmlwdD4=",
      "click (data:text/html;base64,PHNjcmlwdD4=)",
    ],
    ["file:///etc/passwd", "click (file:///etc/passwd)"],
    ["mailto:a@b.co", "click (mailto:a@b.co)"],
    [" javascript:alert(1)", "click ( javascript:alert(1))"],
    ["java\nscript:alert(1)", "click (java\nscript:alert(1))"],
    ["\u0001javascript:alert(1)", "click (\u0001javascript:alert(1))"],
    ["ｊａｖａｓｃｒｉｐｔ:alert(1)", "click (ｊａｖａｓｃｒｉｐｔ:alert(1))"],
    ["http\u200b://ok.example", "click (http\u200b://ok.example)"],
  ];
  for (const [url, expected] of cases) {
    const reading = readRichMessage({
      blocks: [
        { type: "paragraph", text: { type: "url", text: "click", url } },
      ],
    });
    assert.equal(reading.text, expected, `url=${JSON.stringify(url)}`);
    for (const link of scanLinks(reading.text)) {
      assert.match(link.dest, /^https?:\/\//u, `live link for ${url}`);
    }
    assert.ok(reading.text.includes("click"));
  }
});

test("a parenthesised address survives as one link", () => {
  const url = "https://en.wikipedia.org/wiki/Mercury_(planet)";
  const reading = readRichMessage({
    blocks: [
      { type: "paragraph", text: { type: "url", text: "Mercury", url } },
    ],
  });
  assert.equal(
    reading.text,
    "[Mercury](https://en.wikipedia.org/wiki/Mercury_\\(planet\\))",
  );
  assert.deepEqual(scanLinks(reading.text), [{ label: "Mercury", dest: url }]);
});

test("a hostile label cannot close the link or add a destination", () => {
  const cases: unknown[] = [
    {
      type: "url",
      url: "https://ok.example",
      text: "a](javascript:alert(1))[b",
    },
    {
      type: "url",
      url: "https://ok.example",
      text: ["a](", "javascript:x", ")"],
    },
    {
      type: "url",
      url: "https://ok.example",
      text: [{ type: "mention", username: "](javascript:alert(1))[x" }],
    },
    {
      type: "url",
      url: "https://ok.example",
      text: [{ type: "bold", text: "](data:text/html,x)" }],
    },
    ["see [here", { type: "mention", username: "](javascript:alert(1))" }],
    {
      type: "url",
      url: "https://ok.example",
      text: { type: "url", url: "javascript:alert(1)", text: "inner" },
    },
  ];
  for (const node of cases) {
    const reading = readRichMessage({
      blocks: [{ type: "paragraph", text: node }],
    });
    for (const link of scanLinks(reading.text)) {
      assert.match(
        link.dest,
        /^https?:\/\//u,
        `forged ${JSON.stringify(reading.text)}`,
      );
    }
  }
});

// Забор кода внутри метки — единственное место, где код экранируется: иначе чужая
// скобка закрыла бы метку, и адрес зависел бы от старшинства разметки у renderer.
test("code inside a label cannot close the label", () => {
  const reading = readRichMessage({
    blocks: [
      {
        type: "paragraph",
        text: {
          type: "url",
          url: "https://ok.example",
          text: [{ type: "code", text: "](javascript:evil)" }],
        },
      },
    ],
  });
  assert.ok(
    reading.text.includes("\\](javascript:evil)"),
    `скобка кода не экранирована: ${reading.text}`,
  );
  assert.deepEqual(
    scanLinks(reading.text).map((link) => link.dest),
    ["https://ok.example"],
    reading.text,
  );
});

test("a blank line inside a label degrades to plain text, never to a broken link", () => {
  const reading = readRichMessage({
    blocks: [
      {
        type: "paragraph",
        text: { type: "url", text: "line1\n\nline2", url: "https://e.co/x" },
      },
    ],
  });
  assert.equal(reading.text, "line1\n\nline2 (https://e.co/x)");
  assert.deepEqual(scanLinks(reading.text), []);
  assert.ok(reading.text.includes("line1") && reading.text.includes("line2"));
});

test("a mention keeps the text the user sees and adds the username", () => {
  assert.equal(
    readRichMessage({
      blocks: [
        {
          type: "paragraph",
          text: { type: "mention", text: "Pavel Durov", username: "durov" },
        },
      ],
    }).text,
    "Pavel Durov (@durov)",
  );
  assert.equal(
    readRichMessage({
      blocks: [
        { type: "paragraph", text: { type: "mention", username: "@durov" } },
      ],
    }).text,
    "@durov",
  );
});

// Написанный руками markdown не имеет права стать ссылкой: лист экранируется, а
// байты возвращаются снятием `\`. Раньше такой текст проходил насквозь и подделывал
// адрес на чужой схеме.
test("a plain-text leaf cannot forge a link and unescapes back to itself", () => {
  const written =
    "see [Anthropic docs](javascript:alert(1)) and \\ [ ] <b> <javascript:x>";
  const reading = readRichMessage({
    blocks: [{ type: "paragraph", text: written }],
  });
  assert.deepEqual(scanLinks(reading.text), [], reading.text);
  assert.equal(unescape(reading.text), written);
});

// --- якоря: неизвестные типы ------------------------------------------------
test("an unknown block type keeps whatever text it carries", () => {
  const reading = readRichMessage({
    blocks: [
      {
        type: "quantum_block",
        text: "BODY",
        summary: "SUMMARY",
        expression: "EXPR",
        blocks: [{ type: "paragraph", text: "NESTED" }],
        credit: "CREDIT",
        caption: { text: "CAP" },
        photo: PHOTO,
      },
    ],
  });
  assert.deepEqual(
    missingLeaves(reading.text, [
      "BODY",
      "SUMMARY",
      "EXPR",
      "NESTED",
      "CREDIT",
      "CAP",
    ]),
    [],
    reading.text,
  );
  assert.deepEqual(
    reading.media.map((item) => item.fileId),
    ["PH_L"],
  );
});

test("an unknown text type keeps whatever text it carries", () => {
  const cases: ReadonlyArray<readonly [unknown, string]> = [
    [{ type: "quantum_text", text: "TXT" }, "TXT"],
    [{ type: "quantum_text", alternative_text: "TXT" }, "TXT"],
    // Формула идёт кодом: LaTeX остаётся байт в байт и markdown внутри не живёт.
    [{ type: "quantum_text", expression: "TXT" }, "`TXT`"],
  ];
  for (const [node, expected] of cases) {
    const reading = readRichMessage({
      blocks: [{ type: "paragraph", text: node }],
    });
    assert.equal(reading.text, expected);
  }
});

// --- свойства ---------------------------------------------------------------
describe("PROPERTY: no leaf and no media is lost", () => {
  for (const seed of SEEDS) {
    it(`text keeps every leaf in document order (seed=${seed})`, () => {
      fc.assert(
        fc.property(richMessage(2), (generated) => {
          const reading = readRichMessage(generated.value);
          const missing = missingLeaves(reading.text, generated.leaves);
          assert.deepEqual(
            missing,
            [],
            `lost ${JSON.stringify(missing)}\npayload=${JSON.stringify(generated.value)}\ngot=${JSON.stringify(reading.text)}`,
          );
          assert.equal(reading.truncated, false);
        }),
        { seed, numRuns: 1000 },
      );
    });

    it(`media at any depth is collected in document order (seed=${seed})`, () => {
      fc.assert(
        fc.property(richMessage(2), (generated) => {
          const reading = readRichMessage(generated.value);
          assert.deepEqual(
            reading.media.map((item) => item.fileId),
            [...generated.mediaIds],
            `payload=${JSON.stringify(generated.value)}`,
          );
        }),
        { seed, numRuns: 1000 },
      );
    });
  }
});

describe("PROPERTY: garbage never throws", () => {
  for (const seed of SEEDS) {
    it(`fc.anything() is read, never thrown on (seed=${seed})`, () => {
      fc.assert(
        fc.property(
          fc.anything({
            withBigInt: true,
            withDate: true,
            withMap: true,
            withSet: true,
            withObjectString: true,
            withNullPrototype: true,
            maxDepth: 4,
          }),
          (value) => {
            const reading = readRichMessage(value);
            assert.equal(typeof reading.text, "string");
            assert.ok(Array.isArray(reading.media));
            assert.equal(typeof reading.truncated, "boolean");
          },
        ),
        { seed, numRuns: 2000 },
      );
    });

    it(`arbitrary blocks arrays are read, never thrown on (seed=${seed})`, () => {
      fc.assert(
        fc.property(
          fc.array(fc.anything({ maxDepth: 4 }), { maxLength: 12 }),
          (blocks) => {
            const reading = readRichMessage({ blocks });
            assert.equal(typeof reading.text, "string");
            assert.ok(Array.isArray(reading.media));
          },
        ),
        { seed, numRuns: 2000 },
      );
    });
  }
});

test("hostile shapes are read without a throw and without losing the siblings", () => {
  const boom = {
    get text(): never {
      throw new Error("boom");
    },
  };
  const proxy = new Proxy(
    {},
    {
      get(): never {
        throw new Error("proxy");
      },
      has(): never {
        throw new Error("proxy");
      },
      ownKeys(): never {
        throw new Error("proxy");
      },
    },
  );
  const cyclic: Record<string, unknown> = { type: "bold" };
  cyclic.text = [cyclic];
  const sparse: unknown[] = ["a"];
  sparse[5] = "b";

  assert.equal(
    readRichMessage({
      blocks: [boom, { type: "paragraph", text: "AFTER_BOOM" }],
    }).text,
    "AFTER_BOOM",
  );
  assert.equal(
    readRichMessage({
      blocks: [proxy, { type: "paragraph", text: "AFTER_PROXY" }],
    }).text,
    "AFTER_PROXY",
  );
  assert.equal(
    readRichMessage({
      get blocks(): never {
        throw new Error("blocks");
      },
    }).text,
    "",
  );
  assert.equal(
    readRichMessage({
      blocks: [
        {
          type: "photo",
          get photo(): never {
            throw new Error("photo");
          },
        },
      ],
    }).media.length,
    0,
  );
  assert.equal(readRichMessage({ blocks: [cyclic] }).truncated, true);
  assert.equal(
    readRichMessage({ blocks: [{ type: "paragraph", text: sparse }] }).text,
    "ab",
  );

  const polluted: unknown = JSON.parse(
    '{"blocks":[{"type":"paragraph","text":"x","__proto__":{"polluted":"yes"}}]}',
  );
  readRichMessage(polluted);
  assert.equal(
    (Object.prototype as unknown as Record<string, unknown>).polluted,
    undefined,
  );
});

// Дыра в массиве — это дыра, а не конец обхода: `map` сохранял бы её и клал в стек
// `undefined`, после которого остаток сообщения пропадал молча.
test("a hole in an array never ends the walk", () => {
  const blocks: unknown[] = [];
  blocks[0] = { type: "paragraph", text: "FIRST" };
  blocks[2] = { type: "paragraph", text: "SECOND" };
  blocks[3] = { type: "photo", photo: PHOTO };
  const reading = readRichMessage({ blocks });
  assert.deepEqual(
    missingLeaves(reading.text, ["FIRST", "SECOND"]),
    [],
    reading.text,
  );
  assert.deepEqual(
    reading.media.map((item) => item.fileId),
    ["PH_L"],
  );
  assert.equal(reading.truncated, false);

  const leading: unknown[] = new Array(3);
  leading[1] = { type: "paragraph", text: "ONLY" };
  assert.equal(readRichMessage({ blocks: leading }).text, "ONLY");

  const nested: unknown[] = new Array(2);
  nested[1] = { type: "paragraph", text: "NESTED" };
  assert.equal(
    readRichMessage({ blocks: [{ type: "collage", blocks: nested }] }).text,
    "NESTED",
  );

  const holes: unknown[] = ["a"];
  holes[3] = "b";
  assert.equal(
    readRichMessage({ blocks: [{ type: "paragraph", text: holes }] }).text,
    "ab",
  );
});

// Вход опаснее середины: до раунда 2 верхний уровень читался вне try, и Proxy на
// корне выходил наружу исключением.
test("a hostile array at the entrance is caught, not thrown", () => {
  const boom = new Proxy([] as unknown[], {
    get(): never {
      throw new Error("boom");
    },
  });
  for (const value of [boom, { blocks: boom }]) {
    const reading = readRichMessage(value);
    assert.equal(reading.text, "");
    assert.equal(reading.truncated, true);
  }

  const lengthOnly = new Proxy([] as unknown[], {
    get(target, prop, receiver): unknown {
      if (prop === "length") throw new Error("length");
      return Reflect.get(target, prop, receiver);
    },
  });
  assert.equal(readRichMessage(lengthOnly).truncated, true);

  const trap: unknown[] = [];
  Object.defineProperty(trap, "0", {
    get(): never {
      throw new Error("index");
    },
    enumerable: true,
    configurable: true,
  });
  Object.defineProperty(trap, "length", { value: 1, writable: true });
  const trapped = readRichMessage(trap);
  assert.equal(trapped.text, "");
  assert.equal(trapped.truncated, true);
});

// Одинокий блок и голая строка вместо `{ blocks }` — тоже сообщение, терять его не за что.
test("a message that is not a blocks array is still read", () => {
  assert.equal(readRichMessage("BARE").text, "BARE");
  assert.equal(
    readRichMessage({ type: "paragraph", text: "LONE" }).text,
    "LONE",
  );
  assert.equal(
    readRichMessage({ blocks: { type: "paragraph", text: "ONE" } }).text,
    "ONE",
  );
  assert.equal(
    readRichMessage([{ type: "paragraph", text: "TOP" }]).text,
    "TOP",
  );
});

// Потолок глубины стоит ради цены склейки, а не ради безопасности: за ним беднеет
// оформление, но адрес ссылки, @username и метка пункта остаются в тексте.
test("past the depth ceiling the wrapper is gone and the data is not", () => {
  const quoted = (depth: number, leaf: unknown): unknown => {
    let node: unknown = { type: "paragraph", text: leaf };
    for (let i = 0; i < depth; i += 1) {
      node = { type: "blockquote", blocks: [node] };
    }
    return node;
  };
  for (const depth of [2, MAX_RICH_MESSAGE_DEPTH + 2, 1_000]) {
    const link = readRichMessage({
      blocks: [
        quoted(depth, { type: "url", text: "", url: "https://kept.example" }),
      ],
    });
    assert.ok(
      link.text.includes("https://kept.example"),
      `depth=${depth} text=${JSON.stringify(link.text)}`,
    );
    const mention = readRichMessage({
      blocks: [quoted(depth, { type: "mention", text: "", username: "durov" })],
    });
    assert.ok(
      mention.text.includes("@durov"),
      `depth=${depth} text=${JSON.stringify(mention.text)}`,
    );
  }

  let list: unknown = {
    type: "list",
    items: [{ label: "1.", blocks: [{ type: "paragraph", text: "ITEM" }] }],
  };
  for (let i = 0; i < MAX_RICH_MESSAGE_DEPTH + 2; i += 1) {
    list = { type: "blockquote", blocks: [list] };
  }
  assert.deepEqual(
    missingLeaves(readRichMessage({ blocks: [list] }).text, ["1.", "ITEM"]),
    [],
    "метка пункта потерялась или встала после своего текста",
  );
});

test("deep and wide shapes finish without a stack overflow", () => {
  let deepText: unknown = "DEEP_LEAF";
  for (let i = 0; i < 100_000; i += 1)
    deepText = { type: "bold", text: deepText };
  assert.doesNotThrow(() =>
    readRichMessage({ blocks: [{ type: "paragraph", text: deepText }] }),
  );

  let deepArray: unknown = ["DEEP_LEAF"];
  for (let i = 0; i < 100_000; i += 1) deepArray = [deepArray];
  assert.doesNotThrow(() =>
    readRichMessage({ blocks: [{ type: "paragraph", text: deepArray }] }),
  );

  // Шестьдесят четыре уровня цитаты — потолок глубины: текст цел, обёртка беднее.
  let nested: unknown = { type: "paragraph", text: "INNERMOST" };
  for (let i = 0; i < 5_000; i += 1) {
    nested = { type: "blockquote", blocks: [nested] };
  }
  const quoted = readRichMessage({ blocks: [nested] });
  assert.ok(quoted.text.includes("INNERMOST"));

  const wide = readRichMessage({
    blocks: [
      {
        type: "paragraph",
        text: Array.from({ length: 200_000 }, (_, i) => `w${i}`),
      },
    ],
  });
  assert.ok(wide.text.startsWith("w0w1w2"));
  assert.equal(wide.truncated, true);
});

test("budget: a message over the node ceiling keeps its beginning", () => {
  const count = MAX_RICH_MESSAGE_NODES + 10;
  const reading = readRichMessage({
    blocks: Array.from({ length: count }, (_, i) => ({
      type: "paragraph",
      text: `p${i}|`,
    })),
  });
  assert.equal(reading.truncated, true);
  assert.notEqual(reading.text, "");
  assert.ok(reading.text.startsWith("p0|\n\np1|\n\np2|"));
  assert.deepEqual(
    missingLeaves(
      reading.text,
      Array.from({ length: 1000 }, (_, i) => `p${i}|`),
    ),
    [],
  );
});

test("budget: a message over the character ceiling keeps its beginning", () => {
  const chunk = "Z".repeat(50_000);
  const blocks = Array.from({ length: 40 }, (_, i) => ({
    type: "paragraph",
    text: `head${i}|${chunk}`,
  }));
  const reading = readRichMessage({ blocks });
  assert.equal(reading.truncated, true);
  assert.ok(reading.text.startsWith("head0|"));
  assert.ok(reading.text.length >= MAX_RICH_MESSAGE_CHARS);
});

test("budget: media read before the ceiling survives the cut", () => {
  const blocks: unknown[] = [
    { type: "photo", photo: PHOTO },
    ...Array.from({ length: MAX_RICH_MESSAGE_NODES + 10 }, (_, i) => ({
      type: "paragraph",
      text: `p${i}`,
    })),
  ];
  const reading = readRichMessage({ blocks });
  assert.equal(reading.truncated, true);
  assert.deepEqual(
    reading.media.map((item) => item.fileId),
    ["PH_L"],
  );
});

test("budget: a message just under the node ceiling is not truncated", () => {
  const reading = readRichMessage({
    blocks: Array.from({ length: 1000 }, (_, i) => ({
      type: "paragraph",
      text: `p${i}|`,
    })),
  });
  assert.equal(reading.truncated, false);
  assert.ok(reading.text.endsWith("p999|"));
});

// Флаг обязан быть честным в обе стороны: один лист длиннее потолка дочитан до
// конца, обрезать было нечего, а сосед за ним уже теряется — и это видно.
test("budget: truncated tells the truth at the character ceiling", () => {
  const oversized = "A".repeat(MAX_RICH_MESSAGE_CHARS + 10);
  const alone = readRichMessage({
    blocks: [{ type: "paragraph", text: oversized }],
  });
  assert.equal(alone.truncated, false);
  assert.equal(alone.text.length, oversized.length);

  const withSibling = readRichMessage({
    blocks: [
      { type: "paragraph", text: oversized },
      { type: "paragraph", text: "SECOND" },
    ],
  });
  assert.equal(withSibling.truncated, true);
  assert.ok(withSibling.text.startsWith("AAA"));
});

const photoSize = fc.record(
  {
    file_id: fc.string({ minLength: 1, maxLength: 6 }),
    file_unique_id: fc.string({ maxLength: 4 }),
    width: fc.oneof(
      fc.integer({ min: -10, max: 4000 }),
      fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, 1e308, -0),
      fc.string({ maxLength: 3 }),
      fc.constant(null),
    ),
    height: fc.oneof(
      fc.integer({ min: -10, max: 4000 }),
      fc.constantFrom(Number.NaN, Number.NEGATIVE_INFINITY, 1e308),
      fc.constant(undefined),
    ),
    file_size: fc.oneof(
      fc.integer({ min: 0, max: 1_000_000 }),
      fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY),
      fc.constant(undefined),
    ),
  },
  { requiredKeys: ["file_id"] },
);

describe("PROPERTY: the photo pick does not depend on the order of the sizes", () => {
  for (const seed of SEEDS) {
    it(`shuffling the sizes never changes the chosen file (seed=${seed})`, () => {
      fc.assert(
        fc.property(
          fc.array(photoSize, { minLength: 1, maxLength: 6 }),
          fc.integer({ min: 0, max: 719 }),
          (sizes, rotation) => {
            const shuffled = sizes.map(
              (_, index) => sizes[(index + rotation) % sizes.length],
            );
            const first = readRichMessage({
              blocks: [{ type: "photo", photo: sizes }],
            });
            const second = readRichMessage({
              blocks: [{ type: "photo", photo: shuffled }],
            });
            assert.deepEqual(
              second.media.map((item) => item.fileId),
              first.media.map((item) => item.fileId),
              `sizes=${JSON.stringify(sizes)}`,
            );
            assert.ok(first.media.length <= 1);
          },
        ),
        { seed, numRuns: 1000 },
      );
    });
  }
});

const benignLeaf = fc.stringMatching(/^[a-zA-Z0-9 .,!?-]*$/u);
const hostileUrl = fc.constantFrom(
  "javascript:alert(1)",
  "JAVASCRIPT:alert(1)",
  "data:text/html,x",
  "file:///etc/passwd",
  "vbscript:x",
  "tg://resolve?domain=x",
  "https://ok.example",
  "http://ok.example/a b",
  "[a](javascript:alert(1))",
  "[a](https://ok.example)",
  "",
);

// Лист простого текста враждебен ровно так же, как поле `url`: markdown в нём написан
// руками отправителя.
const rawLeaf = fc.oneof(
  benignLeaf,
  fc.constantFrom(
    "[click](javascript:alert(1))",
    "](javascript:alert(1))",
    "<javascript:alert(1)>",
    "[a]: javascript:alert(1)",
    "\\](data:text/html,x)",
    "<script>alert(1)</script>",
  ),
);

const hostileText: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
  node: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    rawLeaf,
    fc.record({ type: fc.constant("bold"), text: tie("node") }),
    fc.record({ type: fc.constant("italic"), text: tie("node") }),
    fc.record({ type: fc.constant("code"), text: tie("node") }),
    fc.record({
      type: fc.constant("mention"),
      username: fc.constantFrom("bob", "](javascript:alert(1))[", "@a"),
      text: tie("node"),
    }),
    fc.record({ type: fc.constant("url"), url: hostileUrl, text: tie("node") }),
    fc.record({ type: fc.constant("weird"), text: tie("node") }),
    fc.array(tie("node"), { maxLength: 4 }),
  ),
})).node;

describe("PROPERTY: no disallowed scheme ever becomes a link", () => {
  for (const seed of SEEDS) {
    it(`every live destination is http or https (seed=${seed})`, () => {
      fc.assert(
        fc.property(hostileText, (node) => {
          const reading = readRichMessage({
            blocks: [{ type: "paragraph", text: node }],
          });
          for (const link of scanLinks(reading.text)) {
            assert.match(
              link.dest,
              /^https?:\/\//u,
              `payload=${JSON.stringify(node)} text=${JSON.stringify(reading.text)}`,
            );
          }
        }),
        { seed, numRuns: 2000 },
      );
    });
  }
});

describe("PROPERTY: the emitted link round-trips to the intended address", () => {
  const webUrl = fc
    .webUrl({ withQueryParameters: true, withFragments: true })
    .filter((url) => url.startsWith("http"));
  const label = fc
    .stringMatching(/^[\][()\\*_`~#>!\ta-zA-Z0-9 -]{1,24}$/u)
    .filter((value) => value.trim() !== "");

  for (const seed of SEEDS) {
    it(`the scanner finds exactly one link with an unchanged address (seed=${seed})`, () => {
      fc.assert(
        fc.property(label, webUrl, (text, url) => {
          const reading = readRichMessage({
            blocks: [{ type: "paragraph", text: { type: "url", text, url } }],
          });
          const links = scanLinks(reading.text);
          assert.equal(
            links.length,
            1,
            `expected one link, got ${links.length}: ${JSON.stringify(reading.text)}`,
          );
          assert.equal(
            links[0].dest,
            url,
            `address changed: ${JSON.stringify(reading.text)}`,
          );
          assert.equal(
            links[0].label,
            text,
            `label changed: ${JSON.stringify(reading.text)}`,
          );
        }),
        { seed, numRuns: 2000 },
      );
    });

    it(`a hostile label never redirects the address (seed=${seed})`, () => {
      fc.assert(
        fc.property(fc.string({ maxLength: 40 }), (text) => {
          const url = "https://good.example/ok";
          const reading = readRichMessage({
            blocks: [{ type: "paragraph", text: { type: "url", text, url } }],
          });
          for (const link of scanLinks(reading.text)) {
            assert.equal(
              link.dest,
              url,
              `label ${JSON.stringify(text)} forged ${JSON.stringify(reading.text)}`,
            );
          }
        }),
        { seed, numRuns: 2000 },
      );
    });
  }
});

describe("PROPERTY: escaping a leaf is reversible", () => {
  for (const seed of SEEDS) {
    it(`unescape returns the original bytes and no link appears (seed=${seed})`, () => {
      fc.assert(
        fc.property(fc.string({ maxLength: 60 }), (leaf) => {
          const reading = readRichMessage({
            blocks: [{ type: "paragraph", text: leaf }],
          });
          assert.equal(unescape(reading.text), leaf);
          assert.deepEqual(scanLinks(reading.text), [], reading.text);
        }),
        { seed, numRuns: 2000 },
      );
    });
  }
});
