// Ссылка на картинку из Vault внутри текста хода. Её ставит медиа-шаг
// (`[photo] изображение (vault/attachments/2026-08-27/photo-082621.jpg)`),
// Obsidian-эмбед `![[…]]` в дневном файле или сам владелец, если написал путь руками.
// По ней middleware провайдера достаёт байты и прикладывает картинку к сообщению,
// когда модель чата картинки видит.
//
// Формат пути задаёт saveBlob (vault-daily.ts): `attachments/<YYYY-MM-DD>/<имя>.<ext>`,
// имя из `[a-z0-9._-]`. Префикс перед `attachments/` (`vault/`, свой
// ASSISTANT_VAULT_DIR, хоть абсолютный) в ответ не идёт — наружу отдаём только
// rel-путь, тот же, что лежит в кэше медиа.

const IMAGE_MEDIA_TYPES = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
} as const;

type ImageExtension = keyof typeof IMAGE_MEDIA_TYPES;

// Хвост пути обязан кончиться: `photo.jpg.txt` — текстовый файл, а не картинка, поэтому
// после суффикса имени файла не должно быть ни продолжения имени, ни второго суффикса.
// Точка в конце предложения (`…photo.jpg.`) под это правило не подпадает — за ней не буква.
const IMAGE_REF = new RegExp(
  `attachments/\\d{4}-\\d{2}-\\d{2}/[A-Za-z0-9._-]+\\.(?:${Object.keys(
    IMAGE_MEDIA_TYPES,
  ).join("|")})(?![A-Za-z0-9_-])(?!\\.[A-Za-z0-9])`,
  "giu",
);

// Ссылка обязана начинаться на границе слова: `myattachments/…` — чужое слово, не путь.
const REF_START_BOUNDARY = /[A-Za-z0-9_]/u;

/** Все rel-пути картинок Vault, упомянутые в тексте, в порядке появления и без повторов. */
export function imageRefsIn(text: string): string[] {
  if (typeof text !== "string" || text.length === 0) return [];
  const refs: string[] = [];
  for (const match of text.matchAll(IMAGE_REF)) {
    const index = match.index ?? 0;
    if (index > 0 && REF_START_BOUNDARY.test(text[index - 1])) continue;
    if (!refs.includes(match[0])) refs.push(match[0]);
  }
  return refs;
}

/** mediaType по суффиксу имени файла; суффикс не из списка — undefined, без подмен. */
export function imageMediaType(rel: string): string | undefined {
  const dot = rel.lastIndexOf(".");
  if (dot < 0) return undefined;
  const ext = rel.slice(dot + 1).toLowerCase();
  return IMAGE_MEDIA_TYPES[ext as ImageExtension];
}

// --- Потолок реплея -------------------------------------------------------------------------
// Вызов провайдера идёт на КАЖДОМ шаге tool-loop, а история хода реплеится целиком. Компакция
// eve считает текст: байты, которые дописывает middleware, она не видит и урезать не может.
// Без потолка окно переполняется картинками прошлых ходов, и каждый следующий запрос
// возвращается ошибкой. Поэтому прикладываем только последние картинки и только в пределах
// бюджета; остальные остаются в ходе путём, как было.
// Столько кадров держит альбом Telegram: меньше — значит молча отрезать кадры того же
// сообщения. Настоящий страж расхода — бюджет байтов ниже, а не этот счётчик.
export const MAX_ATTACHED_IMAGES = 10;
// Больше этого одна картинка не едет вовсе — ни в реплей, ни в первый ход.
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
// Суммарный бюджет на все приложенные картинки одного запроса.
export const MAX_ATTACHED_IMAGE_BYTES = 6 * 1024 * 1024;
