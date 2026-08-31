import { verifyTelegramRequest } from "eve/channels/telegram";
import type { ResetSessionResult } from "eve/channels";

// TODO(ticket-03): eve 0.47 removed the continuation-token `ResetFn` from
// RouteHandlerArgs; reset now lives on `from(address).reset({reason})`. This
// local type freezes the pre-migration call shape until ticket 03 rebuilds reset
// on session-id handles (attachSession), matching agent/lib/eve-cancel.ts.
export type ResetFn = (request: {
  continuationToken: string;
  reason?: string;
}) => Promise<ResetSessionResult>;

/**
 * Authenticated Telegram-owned session reset endpoint.
 * `reset` is the route helper Eve binds to the containing authored channel,
 * so the raw token resolves in the "telegram" namespace.
 */
export async function handleTelegramResetRequest(
  req: Request,
  reset: ResetFn,
  secretToken?: string,
): Promise<Response> {
  let raw;
  try {
    raw = await verifyTelegramRequest(req, { secretToken });
  } catch {
    return new Response("unauthorized", { status: 401 });
  }

  let continuationToken;
  try {
    continuationToken = (
      JSON.parse(raw) as { continuationToken?: unknown } | null
    )?.continuationToken;
  } catch {
    return new Response("invalid JSON", { status: 400 });
  }
  if (typeof continuationToken !== "string" || continuationToken.length === 0) {
    return new Response("continuationToken is required", { status: 400 });
  }

  const result = await reset({
    continuationToken,
    reason: "Telegram recovery command",
  });
  return Response.json({ ok: true, ...result });
}
