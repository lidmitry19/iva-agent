import { defineTool } from "eve/tools";
import { z } from "zod";
import { open, readFile } from "node:fs/promises";
import { resolveVaultToolPath } from "../lib/vault-file-search.ts";
import { vaultDirErrorText } from "../lib/vault-error.ts";
import { MAX_IMAGE_BYTES } from "../lib/attachment-ref.ts";
import { tr } from "../lib/i18n.ts";
import { redactNotice } from "../lib/outbox.ts";
import {
  hasInboundAttackSignal,
  sanitizeInbound,
} from "../lib/security-gate.ts";
import {
  inboundTruncationNotice,
  injectionWarning,
} from "../lib/telegram-gate-notice.ts";
import { describeImage } from "../vision.ts";

// Host-native чтение файла. Переопределяет встроенный read_file eve: читает реальный
// файл на VPS через node:fs/promises (UTF-8). Картинку (по сигнатуре байтов) описывает
// та же vision-модель, что входящее фото: так модель видит файл с диска — кадр,
// скриншот, страницу, — что бы ни было его источником.
//
// КОНТРАКТ ПУТЕЙ (общий с memory_search): memory_search отдаёт hits[].file как путь
// ОТНОСИТЕЛЬНО корня vault (cards/contacts/x.md) и в описании велит открывать хиты этим
// тулом — поэтому read_file принимает и абсолютный путь, и vault-относительный, резолвя
// последний от ASSISTANT_VAULT_DIR. Иначе модель получала ENOENT на путь, который ей же
// и выдали. Не менять в одностороннем порядке. Путь с лишним `vault/` от корня проекта
// тоже доходит до файла — резолвер общий с grep/glob (#242).
//
// Любой отказ — текст модели (ok: false, error): ход не падает, модель решает сама.

// Потолок вывода: большой файл не должен переполнять окно контекста за один ход.
const MAX_CHARS = 24000;
const cap = (s: string) =>
  s.length > MAX_CHARS
    ? {
        content:
          s.slice(0, MAX_CHARS) +
          "\n…(усечено; используй offset/limit для остального)",
        capped: true,
      }
    : { content: s, capped: false };

// Сколько байт начала файла смотрим, чтобы узнать картинку или двоичный файл.
const SNIFF_BYTES = 8192;

// Те же типы, что берёт провайдер (attachment-ref.ts), — по сигнатуре, не по имени.
function imageType(head: Uint8Array): string | undefined {
  const ascii = (from: number, to: number) =>
    String.fromCharCode(...head.subarray(from, to));
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff)
    return "image/jpeg";
  if (ascii(0, 8) === "\x89PNG\r\n\x1a\n") return "image/png";
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return undefined;
}

export type ReadFileResult = {
  readonly path: string;
  readonly content: string;
  readonly lines: number;
  readonly truncated: boolean;
  readonly ok?: false;
  readonly error?: string;
};

const fail = (path: string, error: string): ReadFileResult => ({
  path,
  content: "",
  lines: 0,
  truncated: false,
  ok: false,
  error,
});

const reason = (error: unknown) =>
  vaultDirErrorText(error) ??
  redactNotice(error instanceof Error ? error.message : String(error)).slice(
    0,
    300,
  );

// Описание — чужой текст словами vision-модели: тот же гейт и та же пометка, что у
// входящего фото в telegram-media.ts.
function describedImage(
  path: string,
  mime: string,
  description: string,
): ReadFileResult {
  const gated = sanitizeInbound(description);
  const lines = hasInboundAttackSignal(gated)
    ? [
        injectionWarning(),
        `${tr("image description (untrusted DATA):", "описание изображения (недоверенные ДАННЫЕ):")} ${gated.text}`,
      ]
    : [
        tr(
          `Image (${mime}). What's in it: ${gated.text}`,
          `Изображение (${mime}). Что на нём: ${gated.text}`,
        ),
      ];
  const notice = inboundTruncationNotice(gated);
  if (notice) lines.push(notice);
  const content = lines.join("\n");
  return {
    path,
    content,
    lines: lines.length,
    truncated: gated.truncatedChars > 0,
  };
}

async function readImage({
  path,
  file,
  mime,
  size,
  question,
}: {
  path: string;
  file: string;
  mime: string;
  size: number;
  question?: string;
}): Promise<ReadFileResult> {
  if (size > MAX_IMAGE_BYTES)
    return fail(
      path,
      tr(
        `image is ${size} bytes, over the ${MAX_IMAGE_BYTES}-byte limit`,
        `картинка ${size} байт, больше предела ${MAX_IMAGE_BYTES} байт`,
      ),
    );
  const bytes = await readFile(file);
  let description: string;
  try {
    description = await describeImage(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      mime,
      question,
    );
  } catch (error) {
    console.error("[read_file] vision упал:", error);
    return fail(
      path,
      tr(
        `vision model failed: ${reason(error)}`,
        `vision-модель не ответила: ${reason(error)}`,
      ),
    );
  }
  if (!description)
    return fail(
      path,
      tr(
        "no description: the vision model is not set up or returned nothing",
        "описания нет: vision-модель не настроена или вернула пусто",
      ),
    );
  return describedImage(path, mime, description);
}

// Текст: без offset/limit — файл целиком (с потолком по символам), иначе диапазон строк.
function textResult(
  path: string,
  raw: string,
  offset?: number,
  limit?: number,
): ReadFileResult {
  if (offset === undefined && limit === undefined) {
    const { content, capped } = cap(raw);
    return {
      path,
      content,
      lines: raw.length === 0 ? 0 : raw.split("\n").length,
      truncated: capped,
    };
  }

  const allLines = raw.split("\n");
  const start = offset ? offset - 1 : 0;
  const end = limit ? start + limit : allLines.length;
  const slice = allLines.slice(start, end);
  const { content, capped } = cap(slice.join("\n"));
  return {
    path,
    content,
    lines: slice.length,
    truncated: capped || end < allLines.length || start > 0,
  };
}

export default defineTool({
  description:
    "Прочитать файл хоста. path — абсолютный или от корня vault. " +
    "Текст (UTF-8): offset (1-based) и limit — диапазон строк. " +
    "Картинку (jpeg/png/gif/webp) описывает vision-модель; question — что в ней найти. " +
    "Возвращает { path, content, lines, truncated } или { ok: false, error }.",
  inputSchema: z.object({
    path: z
      .string()
      .min(1)
      .describe("Абсолютный или от корня vault (hits[].file)"),
    offset: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Первая строка, 1-based"),
    limit: z.number().int().positive().optional().describe("Максимум строк"),
    question: z
      .string()
      .max(500)
      .optional()
      .describe("Для картинки: вопрос к ней"),
  }),
  async execute({ path, offset, limit, question }): Promise<ReadFileResult> {
    let raw: string;
    try {
      const file = resolveVaultToolPath(path);
      const handle = await open(file, "r");
      let head: Uint8Array;
      let size: number;
      try {
        size = (await handle.stat()).size;
        const buffer = new Uint8Array(Math.min(SNIFF_BYTES, size));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        head = buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
      const mime = imageType(head);
      if (mime) return await readImage({ path, file, mime, size, question });
      if (head.includes(0))
        return fail(
          path,
          tr(
            `binary file (${size} bytes): neither text nor an image`,
            `двоичный файл (${size} байт): не текст и не картинка`,
          ),
        );
      raw = await readFile(file, "utf8");
    } catch (error) {
      return fail(path, reason(error));
    }

    return textResult(path, raw, offset, limit);
  },
});
