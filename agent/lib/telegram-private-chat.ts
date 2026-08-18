type TelegramChatLike = { readonly type?: unknown } | null | undefined;

export function isPrivateTelegramChat(chat: TelegramChatLike): boolean {
  return chat?.type === "private";
}

// То же решение по хендлу чата у канала. Тип чата eve знает из входящего апдейта, но у
// проактивного хода (Notice, Reminder) апдейта не было и chatType пуст — тогда судим по
// id: Bot API даёт личному чату положительный, а группе, супергруппе и каналу
// отрицательный. Не знаем ничего — считаем чат не личным.
export function isPrivateTelegramChatHandle(handle: {
  readonly chatId?: unknown;
  readonly chatType?: unknown;
}): boolean {
  if (typeof handle.chatType === "string")
    return isPrivateTelegramChat({ type: handle.chatType });
  const chatId = Number(handle.chatId);
  return Number.isInteger(chatId) && chatId > 0;
}
