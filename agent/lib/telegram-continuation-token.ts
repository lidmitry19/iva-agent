// Eve отдаёт continuationToken в двух видах, и различие ловится только на реальном
// сбросе. В data события session.waiting токен channel-local ("<chatId>:<thread>:<conv>"),
// а на `channel.continuationToken` в обработчиках событий — тот же токен С ИМЕНЕМ КАНАЛА
// впереди ("telegram:<chatId>:<thread>:<conv>"). Route-хелпер reset клеит имя канала сам,
// поэтому namespaced-токен, дошедший до /eve/v1/telegram/reset, превращается в
// "telegram:telegram:…", ничего не находит и возвращает идемпотентный no_active_session —
// сессия живёт дальше, а пользователю уже сказали «контекст очищен» (issue #110).
// Всё, что iva хранит в data/run-status.d и шлёт в reset, должно быть channel-local.

// Имя канала иве известно точно (agent/channels/telegram.ts), поэтому срезаем ровно его.
// Гадать по первому сегменту нельзя: у групп chatId отрицательный, а форма токена — это
// контракт eve, а не наша эвристика.
const NAMESPACE = "telegram:";

// Channel-local токен всегда начинается с chat id: целое, у групп со знаком минус, дальше
// либо конец строки, либо разделитель. Проверка не меняет поведение — она нужна, чтобы
// следующая смена формы токена (бамп eve, переименование канала) стала громкой строкой
// в journalctl, а не тихим повторением #110.
const CHANNEL_LOCAL_SHAPE = /^-?\d+(:|$)/;

/**
 * eve 0.47 moved the event-handler continuation token from `channel.continuationToken`
 * (a plain string) to `channel.continuation?.token`. The value and channel-local/namespaced
 * shape described above are unchanged — only where it lives moved, and it became
 * optional in eve's type (`ChannelContinuationOps` is shared by contexts that don't
 * always carry one). For a bound event handler like Telegram's it is always present
 * per eve's docs (`docs/channels/custom.mdx`: "channel.continuation.token is always
 * the channel-local address"); fail fast instead of silently swallowing a missing one.
 */
export function requireContinuationToken(channel: {
  readonly continuation?: { readonly token: string };
}): string {
  const token = channel.continuation?.token;
  if (token === undefined) {
    throw new Error(
      "[telegram] event channel is missing its continuation token",
    );
  }
  return token;
}

/**
 * Приводит continuationToken к channel-local виду: срезает префикс канала, если он есть.
 * Идемпотентна — на уже локальном токене ("123::", "-1001:7:42") это no-op.
 */
export function toChannelLocalToken(
  token: string,
  { warn = console.error }: { warn?: (message: string) => void } = {},
): string {
  if (typeof token !== "string" || token.length === 0) return token;
  const local = token.startsWith(NAMESPACE)
    ? token.slice(NAMESPACE.length)
    : token;
  if (!CHANNEL_LOCAL_SHAPE.test(local)) {
    warn(
      `[telegram] continuation token has an unexpected shape: ${JSON.stringify(token)}`,
    );
  }
  return local;
}
