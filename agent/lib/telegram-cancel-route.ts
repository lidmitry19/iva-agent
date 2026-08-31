import { verifyTelegramRequest } from "eve/channels/telegram";
import { cancelEveTurn, type CancelFn } from "./eve-cancel.ts";

export const TELEGRAM_CANCEL_ROUTE = "/eve/v1/telegram/cancel";

/**
 * Собственный адрес cancel-роута для самовызова из канала (кнопка ⏹ Стоп в
 * webhook-режиме). Правило хоста — копия `scripts/poller/config.ts`: authored tree не
 * может импортировать из `scripts/`, поэтому копии пришпилены тестом
 * (`scripts/poller/config.test.ts`), как и остальные общие константы шва.
 */
export function localCancelUrl(env: NodeJS.ProcessEnv = process.env): string {
  const host = (
    env.ASSISTANT_HOST ?? `http://127.0.0.1:${env.IVA_PORT ?? "8723"}`
  ).replace(/\/$/, "");
  return `${host}${TELEGRAM_CANCEL_ROUTE}`;
}

/**
 * Authenticated Telegram-owned turn cancellation endpoint — путь кнопки ⏹ Стоп
 * и команды /stop. `cancel` — route helper, который eve привязывает к этому
 * authored-каналу, поэтому сырой токен резолвится в пространстве "telegram".
 *
 * Отмена живёт в роуте, а не в обработчике callback_query: публичный cancel eve
 * отдаётся только через RouteHandlerArgs. Мост зовёт роут напрямую, тем же
 * секретом вебхука, что и /eve/v1/telegram/reset.
 */
export async function handleTelegramCancelRequest(
  req: Request,
  cancel: CancelFn,
  secretToken?: string,
): Promise<Response> {
  let raw;
  try {
    raw = await verifyTelegramRequest(req, { secretToken });
  } catch {
    return new Response("unauthorized", { status: 401 });
  }

  let body;
  try {
    body = JSON.parse(raw) as {
      continuationToken?: unknown;
      turnId?: unknown;
    } | null;
  } catch {
    return new Response("invalid JSON", { status: 400 });
  }
  const continuationToken = body?.continuationToken;
  if (typeof continuationToken !== "string" || continuationToken.length === 0) {
    return new Response("continuationToken is required", { status: 400 });
  }
  const turnId = body?.turnId;
  if (
    turnId !== undefined &&
    (typeof turnId !== "string" || turnId.length === 0)
  ) {
    return new Response("turnId must be a non-empty string", { status: 400 });
  }

  const result = await cancelEveTurn(cancel, { continuationToken, turnId });
  return Response.json({ ok: true, ...result });
}
