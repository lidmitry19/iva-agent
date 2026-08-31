// Канал-фикстура для replica-смоука (scripts/replica-smoke.ts): prepareReplica копирует
// этот файл в одноразовое приложение как agent/channels/reset-canary.ts. Он существует
// только ради канарейки issue #110 и нужен потому, что прод-путь /new проверить иначе
// нечем: реальный telegram-канал ходит в api.telegram.org (базу API eve переопределить
// не даёт), а клиент eve прислать свой continuationToken не может — POST /eve/v1/session
// чеканит новый токен сам, а POST /eve/v1/session/:sessionId шлёт intent "resume".
//
// Мост в Telegram зовёт send() БЕЗ intent (то есть "resume-or-start") с токеном, который
// пересобирает детерминированно из chat_id, и reset() с тем же токеном на своём канале.
// Роуты ниже повторяют ровно эту пару вызовов, поэтому смоук может прийти после reset
// тем же токеном — как придёт мост — и убедиться, что история не воскресла.
import { defineChannel, POST } from "eve/channels";
import { extractBearerToken } from "eve/channels/auth";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

function dataDir(): string {
  return process.env.ASSISTANT_DATA_DIR ?? "data";
}

function authorized(request: Request): boolean {
  const expected = process.env.ASSISTANT_BEARER;
  if (!expected) return false;
  return extractBearerToken(request.headers.get("authorization")) === expected;
}

async function readToken(
  request: Request,
): Promise<{ token: string; message?: string } | Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("invalid JSON", { status: 400 });
  }
  const parsed = body as { token?: unknown; message?: unknown } | null;
  const token = parsed?.token;
  if (typeof token !== "string" || token.length === 0)
    return new Response("token is required", { status: 400 });
  const message = parsed?.message;
  if (message !== undefined && typeof message !== "string")
    return new Response("message must be a string", { status: 400 });
  return message === undefined ? { token } : { token, message };
}

export default defineChannel({
  routes: [
    POST("/replica/canary/send", async (request, { from }) => {
      if (!authorized(request))
        return new Response("unauthorized", { status: 401 });
      const parsed = await readToken(request);
      if (parsed instanceof Response) return parsed;
      if (parsed.message === undefined)
        return new Response("message is required", { status: 400 });
      // Ни intent, ни sessionId: ровно тот вызов, который делает telegram-канал.
      // eve 0.47: continuationToken больше не поле опций send, а адрес from().
      const session = await from(parsed.token).send(parsed.message, {
        auth: null,
      });
      return Response.json({ sessionId: session.id });
    }),
    // TODO(ticket-03): eve 0.47 removed the continuation-token `reset`/
    // `resolveActiveSession` helpers from RouteHandlerArgs (reset now lives on
    // `from(address).reset()`, and there is no direct resolveActiveSession
    // replacement documented yet). Stub fails loudly instead of silently
    // no-oping; ticket 03 rebuilds this alongside agent/lib/eve-cancel.ts.
    POST("/replica/canary/reset", async (request) => {
      if (!authorized(request))
        return new Response("unauthorized", { status: 401 });
      const parsed = await readToken(request);
      if (parsed instanceof Response) return parsed;
      throw new Error(
        "replica canary reset not implemented after eve 0.47 bump (ticket 03)",
      );
    }),
  ],
  events: {
    // Доставки наружу у канала нет: финальные реплики пишутся в лог, который читает смоук.
    // finishReason "tool-calls" — промежуточный текст перед вызовом тулзы, как в transcript-хуке.
    "message.completed"(data, _channel, ctx) {
      if (data.finishReason === "tool-calls") return;
      const message = (data.message ?? "").trim();
      if (!message) return;
      const dir = dataDir();
      mkdirSync(dir, { recursive: true });
      appendFileSync(
        join(dir, "replica-canary.jsonl"),
        `${JSON.stringify({ sessionId: ctx.session.id, message })}\n`,
        "utf8",
      );
    },
  },
});
