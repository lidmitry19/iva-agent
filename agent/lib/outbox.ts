// Outbox — единственный шов наружу. Всё, что агент говорит в Telegram, проходит
// здесь: ответ модели из Channel (agent/channels/telegram.ts) и ночные отчёты
// cron-скриптов (scripts/lib/telegram-send.ts). Внутри шва живут outbound-Gate,
// маршрутизация в rich-сообщение, нарезка на HTML-чанки и plain-фолбэк — снаружи
// остаётся только транспорт Bot API, свой у каждого пути. Новый путь наружу
// пишется как OutboxTransport, и обойти гейт по дороге больше нечем.
//
// Служебные реплики самого harness (статус «Работаю…», ack на кнопку, уведомление
// о падении хода, экраны /menu, экран обновления) идут мимо шва: это не текст модели,
// а UI канала. Но мимо шва — не мимо гейта. Правило одно на весь репо:
//   • реплика из одних статических строк (лейблы фаз, кнопки, «Работаю…») гейт не
//     проходит — редактить в ней нечего;
//   • реплика, в которую подставлен runtime-контент (текст ошибки, вывод команды,
//     содержимое файла), проходит гейт ДО отправки — иначе секрет уезжает в чат в
//     обход Outbox;
//   • гейт стоит на вызове Bot API, а не во вьюхе над ним: у канала это noticeSender
//     ниже, у моста — tg() в scripts/poller/transport.ts, у апдейтера — call() в
//     scripts/lib/telegram-status.ts, у Brain — своя отправка. Один вызов гейтит
//     тикер, сводку, «уже идёт» и перерисовку разом, и следующий экран гейт забыть
//     не сможет;
//   • отдельный гейт на СБОРКЕ текста остаётся ровно там, где текст потом режут
//     (гист в error-humanizer, деталь ошибки в telegram-media): обрезанный ключ гейт
//     уже не узнаёт, и его голова уехала бы в чат целой.
// Речь только о том, что видит чат: вывод в терминал и journal (апдейтер печатает
// туда ход сборки) гейт не проходит — там и так лежит полный лог.
// Скрипты, которым авторское дерево недоступно на загрузке (CLI, апдейтер), берут
// то же самое через scripts/lib/notice.ts.
//
// Импорты с расширением .ts намеренно: модуль грузится не только из eve-бандла, но
// и голым node (cron → scripts/lib/telegram-send.ts), где «./x.js» → «./x.ts» никто
// не переписывает.
import { scanOutbound } from "./security-gate.ts";
import { traceOutboundGate, traceOutboxResult } from "./trace.ts";
import {
  htmlToPlain,
  needsRichMessage,
  toTelegramHtmlChunks,
} from "./telegram-format.ts";

// Ответ транспорта на одну попытку доставки.
//   retryPlain=true — Telegram не принял разметку (400 по сущностям), тот же кусок
//     имеет смысл повторить без тегов;
//   stop=true — отказ накрывает не один кусок, а всю отправку (flood control, 5xx,
//     бот заблокирован): шов бросает хвост, не добивая Bot API оставшимися чанками.
// Без stop шов идёт к следующему куску: потерять кусок ответа лучше, чем весь хвост.
export type OutboxAck =
  | { ok: true }
  | { ok: false; error: string; retryPlain: boolean; stop?: boolean };

export type OutboxTransport = {
  sendHtml: (html: string) => Promise<OutboxAck>;
  sendPlain: (text: string) => Promise<OutboxAck>;
  // Только там, где Bot API это умеет (sendRichMessage): таблицы, таск-листы,
  // <details>, блочные формулы. Без него шов сразу идёт HTML-путём.
  sendRich?: (markdown: string) => Promise<OutboxAck>;
};

export type OutboxResult = {
  ok: boolean; // всё, что шов начал отправлять, доставлено
  delivered: number; // сколько сообщений реально ушло в чат
  fellBack: boolean; // хотя бы один кусок ушёл без разметки
  error: string; // первый отказ доставки
};

// Outbound-гейт: редактим утёкшие секреты и эксфил-URL ДО отправки. Fail-open —
// нашли что-то, шлём отредактированное и громко логируем (блокировать текст целиком
// хуже редкой утечки для единственного владельца инсталляции).
export function redactNotice(text: string): string {
  const guard = scanOutbound(text);
  if (!guard.clean)
    console.error(
      "[security] outbound leak redacted:",
      guard.findings.map((f) => `${f.type}:${f.name}`).join(", "),
    );
  // Trace: вердикт outbound-Gate. Стоит на самом вызове гейта, поэтому в журнал попадает
  // и ответ модели через шов, и служебная реплика канала через noticeSender. Превью
  // находки НЕ пишем: там кусок утёкшего секрета (ADR-0010).
  traceOutboundGate(guard.clean, guard.findings, text.length);
  return guard.text;
}

// Служебная реплика канала уходит одним сообщением, без нарезки и rich-пути, но не
// мимо гейта: обёртка клеит гейт к самому вызову Bot API — как tg() у моста. Бренд на
// типе делает шов обязательным, а не рекомендованным: NoticeSend собирается только
// здесь, а эффекты inbound-пайплайна и уведомление о сбое просят именно его, поэтому
// сырое замыкание над Bot API в них не подставить — tsgo отвергнет.
export type NoticeSend = ((text: string) => Promise<unknown>) & {
  readonly gated: "outbound";
};

export function noticeSender(
  send: (text: string) => Promise<unknown>,
): NoticeSend {
  return Object.assign((text: string) => send(redactNotice(text)), {
    gated: "outbound" as const,
  });
}

export async function sendThroughOutbox(
  message: string,
  transport: OutboxTransport,
  // turn/session нужны только журналу: шов — последнее звено цепочки хода, и без ключа
  // хода доставка повисла бы в журнале рядом, а не внутри своего хода (ADR-0010).
  {
    limit = 4096,
    turn = "",
    session = "",
  }: { limit?: number; turn?: string; session?: string } = {},
): Promise<OutboxResult> {
  const startedAt = Date.now();
  const text = redactNotice(message);

  const result: OutboxResult = {
    ok: true,
    delivered: 0,
    fellBack: false,
    error: "",
  };
  // Trace: один исход на одну отправку, каким бы путём она ни ушла.
  const done = (outcome: OutboxResult): OutboxResult => {
    traceOutboxResult(turn, session, text, outcome, Date.now() - startedAt);
    return outcome;
  };

  // Rich-путь рендерит нативно то, чего parse_mode=HTML не умеет. Любой отказ —
  // просто HTML-путь ниже, то есть худший случай равен обычному поведению.
  if (transport.sendRich && needsRichMessage(text)) {
    const rich = await transport.sendRich(text);
    if (rich.ok) {
      result.delivered = 1;
      return done(result);
    }
  }

  // Первую ошибку запоминаем, ok=false — этого хватает вызывающим (cron выходит
  // ненулевым кодом, канал не засчитывает латентность).
  const fail = (error: string) => {
    if (result.ok) result.error = error;
    result.ok = false;
  };

  // toTelegramHtmlChunks режет И конвертирует, гарантируя длину каждого чанка
  // ≤limit ПОСЛЕ конвертации. Пустые чанки не шлём: Telegram отвергает пустой текст.
  for (const html of toTelegramHtmlChunks(text, limit)) {
    if (!html) continue;
    const sent = await transport.sendHtml(html);
    if (sent.ok) {
      result.delivered++;
      continue;
    }
    if (!sent.retryPlain) {
      fail(sent.error);
      if (sent.stop) break;
      continue;
    }
    // Один повтор тем же куском, но без тегов и parse_mode — по сущностям 400
    // тогда невозможен. htmlToPlain декодирует сущности, иначе &amp; уйдёт литералом.
    result.fellBack = true;
    const plain = await transport.sendPlain(htmlToPlain(html));
    if (plain.ok) {
      result.delivered++;
      continue;
    }
    fail(`plain retry ${plain.error}`);
    if (plain.stop) break;
  }
  return done(result);
}
