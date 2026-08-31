/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion -- conversion keeps the injectable fetch boundary source-compatible. */
// Клиент cancel-роута канала. Живёт в authored tree, потому что потребителей два и они
// по разные стороны шва: мост (scripts/poller/control.ts, long-poll) и сам канал
// (кнопка ⏹ Стоп в webhook-режиме, где моста нет). Третьей копии POST-а быть не должно.

type FetchResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};
type FetchImpl = (url: string, init: RequestInit) => Promise<FetchResponse>;

/**
 * Calls Iva's Telegram-owned cancel route (кнопка ⏹ Стоп и /stop). Both statuses
 * are success: `accepted` — отмена принята, `no_active_turn` — отменять уже нечего
 * (ход финишировал между чтением статуса и запросом).
 */
export async function requestTelegramCancel({
  url,
  secret,
  sessionId,
  turnId,
  fetchImpl = fetch as unknown as FetchImpl,
  timeoutMs = 15_000,
}: {
  url: string;
  secret: string;
  sessionId: string;
  turnId?: string;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
}) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": secret,
    },
    body: JSON.stringify({
      sessionId,
      ...(turnId === undefined ? {} : { turnId }),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok)
    throw new Error(`Eve cancel route returned HTTP ${response.status}`);

  const body = (await response.json()) as { ok?: unknown; status?: unknown };
  if (
    body?.ok !== true ||
    (body.status !== "accepted" && body.status !== "no_active_turn")
  ) {
    throw new Error("Eve cancel route returned an invalid response");
  }
  return body as { ok: true; status: "accepted" | "no_active_turn" };
}
