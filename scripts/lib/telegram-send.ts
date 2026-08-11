// Единая сетевая отправка форматированного сообщения в Telegram. Используется обоими
// cron-скриптами (rollup, daily-digest), чтобы конвертация + self-heal жили в одном месте.
//
// Контракт sendTelegramHtml:
//   • model-markdown → валидный Telegram-HTML через общий конвертер, режется на чанки ≤4096;
//   • каждый чанк шлётся с parse_mode=HTML;
//   • если Telegram вернул 400 (не распарсил сущности) — ОДНА повторная попытка тем же
//     чанком, но без тегов и без parse_mode (так 400 по сущностям невозможен), fellBack=true;
//   • НИКОГДА не бросает — на любую ошибку возвращает { ok:false, error }.
//   • адрес Bot API берётся из telegramApiBase() — по умолчанию api.telegram.org.
// Возвращает { ok, fellBack, error } — вызывающий cron-скрипт по fellBack даёт агенту
// обратную связь в ту же сессию, чтобы он переформатировал следующий отчёт.
// htmlToPlain (HTML→plain с декодом сущностей) живёт в общем модуле — тот же
// фолбэк-декодер использует и Telegram-канал (agent/channels/telegram.ts).
import { toTelegramHtmlChunks, htmlToPlain } from "./telegram-format.ts";
import { scanOutbound } from "./security-gate.ts";

type TelegramRequest = Record<string, unknown>;

type TelegramResponse = {
  ok: boolean;
  status: number;
  text: string;
};

const DEFAULT_API_BASE = "https://api.telegram.org";

/**
 * База Bot API. По умолчанию боевая; TELEGRAM_API_BASE подменяет её на локальный mock —
 * этим replica-смоук проверяет доставку напоминания, не выходя в сеть.
 * Мусор в переменной (пустая строка, не-URL, схема не http/https) НЕ ломает отправку:
 * берётся боевая база, а промах виден в stderr — тихо отправить «в никуда» хуже, чем
 * отправить туда, куда просили изначально.
 */
export function telegramApiBase(
  env: Record<string, string | undefined> = process.env,
): string {
  const raw = String(env.TELEGRAM_API_BASE ?? "").trim();
  if (!raw) return DEFAULT_API_BASE;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    console.error(`[telegram] TELEGRAM_API_BASE is not a URL: ${raw}`);
    return DEFAULT_API_BASE;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    console.error(`[telegram] TELEGRAM_API_BASE is not http(s): ${raw}`);
    return DEFAULT_API_BASE;
  }
  // Хвостовые слэши срезаются: путь метода добавляется как "/bot<token>/sendMessage".
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

async function post(
  bot: string,
  body: TelegramRequest,
): Promise<TelegramResponse> {
  const res = await fetch(`${telegramApiBase()}/bot${bot}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    ok: res.ok,
    status: res.status,
    text: res.ok ? "" : await res.text(),
  };
}

export async function sendTelegramHtml(
  bot: string,
  chat: string,
  md: unknown,
  { caption = false }: { caption?: boolean } = {},
): Promise<{ ok: boolean; fellBack: boolean; error: string }> {
  let fellBack = false;
  // Outbound security-гейт: редактим утёкшие секреты и в ночных отчётах (fail-open + лог).
  const guard = scanOutbound(md as string);
  if (!guard.clean) {
    console.error(
      "[security] outbound report leak redacted:",
      guard.findings.map((f) => `${f.type}:${f.name}`).join(", "),
    );
  }
  const guardedMarkdown = guard.text;
  try {
    for (const chunk of toTelegramHtmlChunks(
      guardedMarkdown,
      caption ? 1024 : 4096,
    )) {
      const r = await post(bot, {
        chat_id: chat,
        text: chunk,
        parse_mode: "HTML",
      });
      if (r.ok) continue;
      // 400 = Telegram не распарсил HTML. Одна повторная попытка без тегов/parse_mode.
      if (r.status === 400) {
        fellBack = true;
        const plain = await post(bot, {
          chat_id: chat,
          text: htmlToPlain(chunk),
        });
        if (!plain.ok)
          return {
            ok: false,
            fellBack,
            error: `plain retry ${plain.status}: ${plain.text}`,
          };
        continue;
      }
      return { ok: false, fellBack, error: `${r.status}: ${r.text}` };
    }
    return { ok: true, fellBack, error: "" };
  } catch (e) {
    const message =
      e !== null &&
      (typeof e === "object" || typeof e === "function") &&
      "message" in e
        ? (e.message ?? e)
        : e;
    return { ok: false, fellBack, error: String(message) };
  }
}
