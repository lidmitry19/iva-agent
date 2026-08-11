// Mock Telegram Bot API для replica-смоука (scripts/replica-smoke.ts).
// Поднимает локальный http-сервер, принимает POST /bot<token>/sendMessage, записывает
// тело и отвечает как настоящий Bot API: {"ok":true,"result":{}}. Смоук подставляет его
// адрес через TELEGRAM_API_BASE (scripts/lib/telegram-send.ts), поэтому проверка доставки
// напоминания не выходит в сеть и не требует живого бота.
import { createServer, type IncomingMessage } from "node:http";
import { text as consumeText } from "node:stream/consumers";

export type SentMessage = {
  /** Токен бота из пути запроса — им проверяется, что взят токен из .env. */
  token: string;
  body: Record<string, unknown>;
};

export type MockTelegramServer = {
  baseUrl: string;
  /** Принятые sendMessage, в порядке поступления. */
  sent: SentMessage[];
  /** Запросы, не попавшие ни в один роут: лишняя активность не должна теряться. */
  rejected: string[];
  close(): Promise<void>;
};

const SEND_MESSAGE_RE = /^\/bot(?<token>[^/]+)\/sendMessage$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBody(req: IncomingMessage): Promise<string> {
  return consumeText(req);
}

/** Стартует mock Bot API на 127.0.0.1:0; handle: { baseUrl, sent, rejected, close }. */
export async function startMockTelegramServer(): Promise<MockTelegramServer> {
  const sent: SentMessage[] = [];
  const rejected: string[] = [];
  // Node не потребляет промис обработчика: ответ закрывается внутри него.
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  const server = createServer(async (req, res) => {
    const token = SEND_MESSAGE_RE.exec(req.url ?? "")?.groups?.token;
    if (req.method !== "POST" || token === undefined) {
      rejected.push(`${req.method ?? "?"} ${req.url ?? "?"}`);
      res.writeHead(404, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: false,
          error_code: 404,
          description: "Not Found",
        }),
      );
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req)) as unknown;
    } catch {
      rejected.push(`POST ${req.url ?? "?"} (invalid JSON)`);
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: false,
          error_code: 400,
          description: "Bad Request: invalid JSON",
        }),
      );
      return;
    }
    sent.push({ token, body: isRecord(body) ? body : { raw: body } });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, result: {} }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Mock Telegram server did not bind to a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    sent,
    rejected,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
