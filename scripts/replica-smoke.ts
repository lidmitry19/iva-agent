// Replica-смоук: одноразовая полностью изолированная установка ивы + mock-провайдер.
// Проверяет то, что юнит-тесты не видят: прод-билд eve, старт сервера, первый реальный
// ответ через провайдера, restart/resume сессии и доставку напоминания в Telegram.
// Ни хостового .env, ни настоящего бота, ни живого vault — только временная директория,
// закрытый allowlist переменных окружения и локальные mock-серверы.
// Запуск: npm run replica (в CI — шаг после build). По мотивам stabilization-форка
// mamysh/iva (PR #7), переписано под upstream.
import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
  cp,
} from "node:fs/promises";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { startMockOpenAiServer } from "./lib/mock-openai-server.ts";
import { startMockTelegramServer } from "./fixtures/mock-telegram-server.ts";
import type { ClientSession, MessageResult } from "eve/client";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MARKER = "CEDAR-4729";
const RESET_MARKER = "CEDAR-5533";
const UPGRADE_MARKER = "CEDAR-8140";
// Ответ mock-провайдера, когда в транскрипте нет НИ ОДНОГО маркера CEDAR, то есть
// история сессии пуста (scripts/lib/mock-openai-server.ts).
const EMPTY_HISTORY_REPLY = "MISSING_MARKER";
// Версия, на которую подменяется eve в durable-логе канарейкой апгрейда.
const FORGED_EVE_VERSION = "0.0.0-forged";
// Проверка доставки напоминания: маркер уникален на прогон, бот и чат — выдуманные,
// сообщение уходит в локальный mock Bot API.
const NOTIFY_MARKER = `REPLICA-NOTIFY-${randomBytes(4).toString("hex")}`;
const NOTIFY_BOT_TOKEN = "424242:replica-smoke-fake-token";
const NOTIFY_CHAT_ID = "-1002222333444";
const HEALTH_TIMEOUT_MS = 90_000;
const TURN_TIMEOUT_MS = 120_000;

let phase = "prepare";
function setPhase(name: string): void {
  phase = name;
  note(`[smoke] ${new Date().toISOString()} phase: ${name}`);
}
const logs: string[] = [];

function note(line: string): void {
  logs.push(line);
  if (logs.length > 400) logs.shift();
}

async function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

function replicaEnv({
  sandbox,
  app,
  port,
  mockBaseUrl,
  bearer,
}: {
  sandbox: string;
  app: string;
  port: number;
  mockBaseUrl: string;
  bearer: string;
}): NodeJS.ProcessEnv {
  // Закрытый allowlist: process.env НЕ спредится — ни секретов хоста, ни его настроек.
  return {
    PATH: process.env.PATH,
    HOME: sandbox,
    NODE_ENV: "production",
    PORT: String(port),
    IVA_PORT: String(port),
    MODEL_PROVIDER: "ollama",
    OLLAMA_BASE_URL: mockBaseUrl,
    OLLAMA_API_KEY: "replica-key",
    OLLAMA_MODEL: "iva-replica",
    OLLAMA_CONTEXT_WINDOW: "131072",
    ASSISTANT_BEARER: bearer,
    ASSISTANT_DATA_DIR: join(app, "data"),
    ASSISTANT_VAULT_DIR: join(app, "vault"),
    ASSISTANT_TIMEZONE: "UTC",
    MEMORY_SEARCH_MODE: "bm25",
  };
}

function run(
  cmd: string,
  args: string[],
  { cwd, env }: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const capture = (buf: Buffer) =>
      String(buf).split("\n").filter(Boolean).forEach(note);
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${cmd} ${args.join(" ")} exited with ${code}`)),
    );
  });
}

function startEve({
  app,
  env,
  port,
}: {
  app: string;
  env: NodeJS.ProcessEnv;
  port: number;
}) {
  const child = spawn(
    process.execPath,
    [
      join(app, "node_modules/eve/bin/eve.js"),
      "start",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    { cwd: app, env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  const capture = (buf: Buffer) =>
    String(buf).split("\n").filter(Boolean).forEach(note);
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  return child;
}

type EveProcess = ReturnType<typeof startEve>;

async function stopEve(child: EveProcess | null): Promise<void> {
  if (!child || child.exitCode !== null) return;
  const gone = new Promise<number | null>((resolve) =>
    child.once("exit", resolve),
  );
  try {
    process.kill(-(child.pid as number), "SIGTERM");
  } catch {
    return;
  }
  // Окно graceful stop у самого eve — 5с; даём заметно больше, чтобы SIGKILL
  // не обрубал запись состояния .workflow-data на полпути.
  const timer = new Promise<"timeout">((resolve) =>
    setTimeout(resolve, 15000, "timeout"),
  );
  if ((await Promise.race([gone, timer])) === "timeout") {
    try {
      process.kill(-(child.pid as number), "SIGKILL");
    } catch {
      /* уже умер */
    }
    await gone;
  }
}

async function waitForHealth(port: number, child: EveProcess): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(
        `eve exited with ${child.exitCode} before becoming healthy`,
      );
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) return;
    } catch {
      /* ещё не поднялся */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `eve did not become healthy within ${HEALTH_TIMEOUT_MS / 1000}s`,
  );
}

async function turn(
  session: ClientSession,
  prompt: string,
  timeoutMs = TURN_TIMEOUT_MS,
): Promise<string> {
  let timer: NodeJS.Timeout | undefined;
  let result: MessageResult;
  try {
    result = await Promise.race([
      session.send(prompt).then((r) => {
        note(
          `[smoke] send accepted (session ${session.state?.sessionId ?? "new"})`,
        );
        return r.result();
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          reject,
          timeoutMs,
          new Error(`turn timed out after ${timeoutMs / 1000}s`),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  note(`[smoke] turn done: ${JSON.stringify(result?.status)}`);
  if (result.status === "failed" || !result.message) {
    throw new Error(
      `turn failed: status=${result.status} message=${JSON.stringify(result.message ?? "")}`,
    );
  }
  return result.message.trim();
}

async function prepareReplica(sandbox: string): Promise<string> {
  const app = join(sandbox, "app");
  await mkdir(app, { recursive: true });
  // bin/ нужен проверке доставки: лаунчер ~/.local/bin/iva зовёт именно bin/iva.mjs.
  for (const dir of ["agent", "bin", "scripts", "patches", "vault-template"]) {
    await cp(join(ROOT, dir), join(app, dir), { recursive: true });
  }
  for (const file of ["package.json", "package-lock.json", "tsconfig.json"]) {
    await cp(join(ROOT, file), join(app, file));
  }
  // node_modules симлинком: npm ci уже проверяет разрешение зависимостей в соседнем CI-шаге,
  // а здесь он бы стоил минуты и сотни мегабайт на каждый прогон.
  await symlink(join(ROOT, "node_modules"), join(app, "node_modules"), "dir");
  await mkdir(join(app, "data"), { recursive: true });
  // Канал-фикстура живёт ТОЛЬКО в одноразовом приложении: он даёт смоуку тот же
  // send/reset, что зовёт telegram-мост. Пути роутов дублируются константами ниже —
  // разъехались, и смоук падает на 404, молча пройти не сможет.
  await cp(
    join(ROOT, "scripts/fixtures/reset-canary-channel.ts"),
    join(app, "agent/channels/reset-canary.ts"),
  );
  return app;
}

/**
 * Пишет `$HOME/.local/bin/iva` ровно так, как это делает install.sh (секция 8.5):
 * тот же резолв каталога версии (`current` → data/active.json → свежая запись в versions/)
 * и абсолютный путь до node — здесь process.execPath, у установщика `command -v node`.
 * ЗЕРКАЛО install.sh: правишь лаунчер там — правь и здесь, иначе проверка доставки
 * начнёт подтверждать несуществующую установку.
 */
async function writeIvaLauncher(home: string, root: string): Promise<string> {
  const path = join(home, ".local/bin/iva");
  await mkdir(dirname(path), { recursive: true });
  const script = [
    "#!/bin/sh",
    `IVA_ROOT="${root}"`,
    'if [ -f "$IVA_ROOT/current/bin/iva.mjs" ]; then',
    '  IVA_ROOT="$IVA_ROOT/current"',
    'elif [ ! -f "$IVA_ROOT/bin/iva.mjs" ]; then',
    '  settled=$(sed -n \'s/.*"version":"\\([^"]*\\)".*/\\1/p\' "$IVA_ROOT/data/active.json" 2>/dev/null)',
    '  if [ -n "$settled" ] && [ -f "$IVA_ROOT/versions/$settled/bin/iva.mjs" ]; then',
    '    IVA_ROOT="$IVA_ROOT/versions/$settled"',
    "  else",
    '    for candidate in $(ls -t "$IVA_ROOT/versions" 2>/dev/null); do',
    '      [ -f "$IVA_ROOT/versions/$candidate/bin/iva.mjs" ] || continue',
    '      IVA_ROOT="$IVA_ROOT/versions/$candidate"',
    "      break",
    "    done",
    "  fi",
    "fi",
    `exec "${process.execPath}" "$IVA_ROOT/bin/iva.mjs" "$@"`,
    "",
  ].join("\n");
  await writeFile(path, script, { mode: 0o755 });
  return path;
}

/** Запуск команды под /bin/sh с заданным окружением; ничего не бросает по коду выхода. */
function runShell(
  command: string,
  { cwd, env }: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", command], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (buf: Buffer) => {
      stdout += String(buf);
    });
    child.stderr.on("data", (buf: Buffer) => {
      stderr += String(buf);
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * Проверка доставки: напоминание, заведённое по канону (agent/instructions.md,
 * `$HOME/.local/bin/iva notify "<текст>"`), обязано дойти до Telegram.
 *
 * Запуск повторяет среду планировщика: `/bin/sh -c` с вычищенным окружением — PATH
 * без nvm, HOME песочницы, рабочий каталог вне репозитория, — ровно так стартуют
 * `systemd-run --user` и cron. Именно здесь отправка ломалась дважды (issue #130 и #182):
 * голый `node` в таком PATH — сборка дистрибутива, .ts она не грузит, напоминание молча
 * не приходит. Абсолютный путь до node внутри лаунчера — единственное, что это держит;
 * на macOS /usr/bin/node вообще нет, так что без лаунчера шаг упадёт сразу.
 *
 * Сеть не задействована: адрес Bot API подменяется на локальный mock через
 * TELEGRAM_API_BASE (scripts/lib/telegram-send.ts).
 */
async function checkNotifyDelivery(
  sandbox: string,
  app: string,
): Promise<void> {
  const telegram = await startMockTelegramServer();
  try {
    const launcher = await writeIvaLauncher(sandbox, app);
    const result = await runShell(
      `"$HOME/.local/bin/iva" notify "${NOTIFY_MARKER}"`,
      {
        cwd: sandbox,
        // Эквивалент `env -i`: process.env не спредится, nvm-каталогов в PATH нет.
        env: {
          PATH: "/usr/bin:/bin",
          HOME: sandbox,
          TELEGRAM_API_BASE: telegram.baseUrl,
        },
      },
    );
    for (const line of `${result.stdout}${result.stderr}`.split("\n"))
      if (line) note(`[notify] ${line}`);
    if (result.code !== 0)
      throw new Error(
        `${launcher} notify exited with ${result.code}; stderr: ${result.stderr.trim() || "(empty)"}`,
      );
    if (telegram.rejected.length)
      throw new Error(
        `mock Bot API refused a request: ${telegram.rejected.join(", ")}`,
      );
    if (telegram.sent.length !== 1)
      throw new Error(
        `expected exactly one sendMessage, got ${telegram.sent.length}`,
      );
    const [sent] = telegram.sent;
    if (sent.token !== NOTIFY_BOT_TOKEN)
      throw new Error(
        `sendMessage used a foreign bot token: ${JSON.stringify(sent.token)}`,
      );
    if (sent.body.chat_id !== NOTIFY_CHAT_ID)
      throw new Error(
        `sendMessage went to the wrong chat: ${JSON.stringify(sent.body.chat_id)}`,
      );
    const text = typeof sent.body.text === "string" ? sent.body.text : "";
    if (!text.includes(NOTIFY_MARKER))
      throw new Error(
        `sendMessage lost the marker ${NOTIFY_MARKER}: ${JSON.stringify(text)}`,
      );
    console.log(
      `replica smoke: the scheduled reminder reached Telegram under a scrubbed environment OK (chat ${NOTIFY_CHAT_ID})`,
    );
  } finally {
    await telegram.close();
  }
}

function errorDetail(error: unknown): unknown {
  return (error as { message?: unknown } | null | undefined)?.message ?? error;
}

// Роуты канала-фикстуры scripts/fixtures/reset-canary-channel.ts.
const CANARY_SEND_ROUTE = "/replica/canary/send";
const CANARY_RESET_ROUTE = "/replica/canary/reset";
const CANARY_REPLY_LOG = "replica-canary.jsonl";

async function canaryPost(
  { port, bearer }: { port: number; bearer: string },
  route: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok)
    throw new Error(
      `${route} returned HTTP ${res.status}: ${text.slice(0, 300)}`,
    );
  return JSON.parse(text) as Record<string, unknown>;
}

/**
 * Ждёт финальную реплику канала-фикстуры для sessionId, считая только записи ПОСЛЕ
 * `fromLine`: второй ход той же сессии иначе прочитал бы ответ первого и любая проверка
 * истории стала бы вакуумной. Возвращает курсор для следующего ожидания.
 */
async function canaryReply(
  logPath: string,
  sessionId: string,
  fromLine: number,
  timeoutMs = TURN_TIMEOUT_MS,
): Promise<{ message: string; line: number }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let lines: string[] = [];
    try {
      lines = (await readFile(logPath, "utf8")).split("\n").filter(Boolean);
    } catch {
      /* лог появляется вместе с первой завершённой репликой */
    }
    for (let i = fromLine; i < lines.length; i++) {
      const entry = JSON.parse(lines[i]) as {
        sessionId?: unknown;
        message?: unknown;
      };
      if (entry.sessionId === sessionId && typeof entry.message === "string")
        return { message: entry.message.trim(), line: i + 1 };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `canary turn for session ${sessionId} did not complete within ${timeoutMs / 1000}s`,
  );
}

/**
 * Симулирует смену версии eve на месте. Шаги воркфлоу записаны в durable-лог вместе с
 * версией пакета (`step//eve@0.30.8//createSessionStep`), и при replay id сверяется
 * строкой с текущим потребителем, — значит ЛЮБОЙ апгрейд eve роняет припаркованный run
 * с CORRUPTED_EVENT_LOG. Переписав версию в логе, смоук получает ровно ту же расходимость,
 * что и настоящая переустановка, но без второй копии eve в песочнице.
 * Возвращает число переписанных файлов событий.
 */
async function forgeEveStepVersion(app: string): Promise<number> {
  const versionedStepId = /step\/\/eve@[^/"]+\/\//g;
  let rewritten = 0;
  for (const dataDir of [
    ".eve/.workflow-data",
    ".output/.eve/.workflow-data",
  ]) {
    const events = join(app, dataDir, "events");
    let files: string[];
    try {
      files = await readdir(events);
    } catch {
      continue; // этой сборкой такой каталог состояния не используется
    }
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const path = join(events, file);
      const before = await readFile(path, "utf8");
      const after = before.replace(
        versionedStepId,
        `step//eve@${FORGED_EVE_VERSION}//`,
      );
      if (after === before) continue;
      await writeFile(path, after);
      rewritten++;
    }
  }
  return rewritten;
}

async function main(): Promise<void> {
  const sandbox = await mkdtemp(join(tmpdir(), "iva-replica-"));
  const mock = await startMockOpenAiServer();
  let eve: EveProcess | null = null;
  try {
    const app = await prepareReplica(sandbox);
    const port = await freePort();
    const bearer = randomBytes(24).toString("hex");
    const env = replicaEnv({
      sandbox,
      app,
      port,
      mockBaseUrl: mock.baseUrl,
      bearer,
    });
    // Telegram-ключи нужны проверке доставки ниже: `iva notify` берёт бот и чат только
    // из .env. Сервер eve их не видит — его окружение собирает закрытый allowlist.
    await writeFile(
      join(app, ".env"),
      [
        `ASSISTANT_BEARER=${bearer}`,
        `TELEGRAM_BOT_TOKEN=${NOTIFY_BOT_TOKEN}`,
        `TELEGRAM_DIGEST_CHAT_ID=${NOTIFY_CHAT_ID}`,
        "",
      ].join("\n"),
      { mode: 0o600 },
    );

    // Первым делом: шаг дешёвый, а ломается именно он — и ждать ради этого сборку незачем.
    setPhase("notify-delivery");
    await checkNotifyDelivery(sandbox, app);

    setPhase("vault");
    await run(process.execPath, [join(app, "scripts/init-vault.mjs")], {
      cwd: app,
      env,
    });

    setPhase("build");
    await run(
      process.execPath,
      [join(app, "node_modules/eve/bin/eve.js"), "build"],
      { cwd: app, env },
    );

    setPhase("start");
    eve = startEve({ app, env, port });
    await waitForHealth(port, eve);

    // Тот же экземпляр eve, что и у реплики: её node_modules — симлинк на ROOT/node_modules.
    const { Client } = await import("eve/client");
    const client = new Client({
      host: `http://127.0.0.1:${port}`,
      auth: {
        // eslint-disable-next-line @typescript-eslint/require-await -- preserve the original async callback.
        bearer: async () => bearer,
      },
    });

    setPhase("first-reply");
    const session = client.session();
    const first = await turn(session, "Reply with a status word.");
    if (first !== "REPLICA_OK")
      throw new Error(`unexpected first reply: ${JSON.stringify(first)}`);

    setPhase("seed-marker");
    const remembered = await turn(session, `Remember this code: ${MARKER}`);
    if (remembered !== "REMEMBERED")
      throw new Error(`unexpected seed reply: ${JSON.stringify(remembered)}`);
    const savedState = session.state;

    // Канарейка reset (issue #110): /new обязан реально чистить контекст на том токене,
    // который придёт от Telegram. Мост других токенов не присылает — он пересобирает свой
    // детерминированно из chat_id, — поэтому проверка идёт по пути канала: send() без
    // intent (то есть resume-or-start) и reset() на том же канале, ровно как в
    // agent/channels/telegram.ts. Маркер сеется ДО рестарта: тогда положительный контроль
    // ниже заодно жёстко проверяет, что durable-стейт .eve/.workflow-data пережил рестарт,
    // — по пути канала, в отличие от мягкого клиентского резюма.
    setPhase("canary-seed");
    const canaryLog = join(app, "data", CANARY_REPLY_LOG);
    const canaryToken = `replica-canary:${randomBytes(6).toString("hex")}`;
    const canaryHttp = { port, bearer };
    const recall =
      "What code did I ask you to remember? Reply with the code only.";
    let canaryLine = 0;
    const canaryTurn = async (
      token: string,
      message: string,
    ): Promise<{ sessionId: string; reply: string }> => {
      const from = canaryLine;
      const accepted = await canaryPost(canaryHttp, CANARY_SEND_ROUTE, {
        token,
        message,
      });
      const sessionId = accepted.sessionId;
      if (typeof sessionId !== "string" || !sessionId)
        throw new Error(
          `canary send returned no session id: ${JSON.stringify(accepted)}`,
        );
      const settled = await canaryReply(canaryLog, sessionId, from);
      canaryLine = settled.line;
      return { sessionId, reply: settled.message };
    };

    const seed = await canaryTurn(
      canaryToken,
      `Remember this code: ${RESET_MARKER}`,
    );
    if (seed.reply !== "REMEMBERED")
      throw new Error(
        `unexpected canary seed reply: ${JSON.stringify(seed.reply)}`,
      );

    setPhase("restart");
    await stopEve(eve);
    eve = startEve({ app, env, port });
    await waitForHealth(port, eve);

    setPhase("post-restart");
    const fresh = await turn(client.session(), "Reply with a status word.");
    if (fresh !== "REPLICA_OK")
      throw new Error(
        `unexpected post-restart reply: ${JSON.stringify(fresh)}`,
      );

    // Строгий резюм припаркованной сессии через рестарт: на eve 0.27.13 сервер принимает
    // continue-POST (200), но молча теряет сообщение — re-enqueued run не просыпается,
    // в .workflow-data не появляется ни одного нового события (session-resume wedge).
    // До фикса ассерт мягкий: падение резюма роняет смоук только под
    // REPLICA_STRICT_RESUME=1 — этим же флагом баг и воспроизводится.
    setPhase("resume");
    const strictResume = process.env.REPLICA_STRICT_RESUME === "1";
    try {
      const resumed = client.session(savedState);
      const echo = await turn(
        resumed,
        "What code did I ask you to remember? Reply with the code only.",
        strictResume ? TURN_TIMEOUT_MS : 45_000,
      );
      if (echo !== MARKER)
        throw new Error(`resume lost the marker: got ${JSON.stringify(echo)}`);
      console.log("replica smoke: session resume across restart OK");
    } catch (err) {
      if (strictResume) throw err;
      console.warn(
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions -- preserve the original template coercion.
        `replica smoke: KNOWN ISSUE — session resume across restart failed (${errorDetail(err)})`,
      );
    }

    // Положительный контроль канарейки: тот же токен обязан вернуться в СВОЮ сессию,
    // пережившую рестарт, и увидеть её историю. Без этого шага проверка после reset
    // ничего не доказывает — пустой ответ вернула бы и любая посторонняя сессия.
    setPhase("reset-canary");
    const before = await canaryTurn(canaryToken, recall);
    if (before.sessionId !== seed.sessionId)
      throw new Error(
        `canary token did not resume its own session: ${before.sessionId} != ${seed.sessionId}`,
      );
    if (before.reply !== RESET_MARKER)
      throw new Error(
        `canary token could not reach its history before reset: ${JSON.stringify(before.reply)}`,
      );

    const resetResult = await canaryPost(canaryHttp, CANARY_RESET_ROUTE, {
      token: canaryToken,
    });
    if (resetResult.status !== "reset")
      throw new Error(
        `unexpected reset status: ${JSON.stringify(resetResult)}`,
      );
    if (resetResult.activeSessionAfterReset !== null)
      throw new Error(
        `reset left the token owned: ${JSON.stringify(resetResult)}`,
      );

    const after = await canaryTurn(canaryToken, recall);
    if (after.sessionId === seed.sessionId)
      throw new Error(
        `reset did not retire the session: the token still resumes ${after.sessionId}`,
      );
    if (after.reply.includes(RESET_MARKER))
      throw new Error(
        `reset did not clear the context: history survived (${JSON.stringify(after.reply)})`,
      );
    console.log(
      `replica smoke: reset clears the context on the same token OK (before: ${before.reply}, after: ${after.reply})`,
    );

    // Канарейка апгрейда. Каталог .eve/.workflow-data — installation-level состояние
    // (scripts/lib/version-store.ts), он переживает `iva update` и достаётся новой версии
    // ивы вместе с припаркованными разговорами. Шаги в нём приколочены к версии eve, так
    // что смена версии гарантированно рушит replay припаркованного run.
    //
    // Исход апгрейда 0.29.5 → 0.30.8 подтверждён прогоном и прибит здесь намертво:
    // старый continuation-токен НЕ воскрешает свою сессию — на нём заводится свежая,
    // её история пуста (маркера нет), и ничего из старой истории не протекает. Любой
    // другой исход — регрессия, а не «тоже нормально».
    //
    // В настоящем апгрейде к смене версии шагов добавляется вторая причина: 0.30.5 увёл
    // session controls и follow-up-сообщения в единый durable command inbox. Ad-hoc
    // delivery-хук 0.29.5 (`src/execution/session-delivery-hook.js`) в 0.30.8 отсутствует,
    // токен инбокса теперь выводится из sessionId (`eve:session:<id>:inbox`,
    // `src/execution/session-command-token.js`). Смоук подделывает только версию шагов —
    // этого достаточно, чтобы получить ту же расходимость без второй копии eve.
    //
    // Итог: припаркованные диалоги после апгрейда начинаются заново. Это осознанный
    // размен, задокументирован в CHANGELOG 0.3.16.
    //
    // Ниже канарейка reset, потому что подмена версии убивает все припаркованные сессии.
    setPhase("upgrade-canary");
    const upgradeToken = `replica-upgrade:${randomBytes(6).toString("hex")}`;
    const upgradeSeed = await canaryTurn(
      upgradeToken,
      `Remember this code: ${UPGRADE_MARKER}`,
    );
    if (upgradeSeed.reply !== "REMEMBERED")
      throw new Error(
        `unexpected upgrade seed reply: ${JSON.stringify(upgradeSeed.reply)}`,
      );

    await stopEve(eve);
    const forged = await forgeEveStepVersion(app);
    if (forged === 0)
      throw new Error(
        "upgrade canary forged nothing: no versioned eve step ids in the durable log",
      );
    note(`[smoke] forged the eve version in ${forged} event files`);
    eve = startEve({ app, env, port });
    await waitForHealth(port, eve);

    const upgraded = await canaryTurn(upgradeToken, recall);
    if (upgraded.sessionId === upgradeSeed.sessionId)
      throw new Error(
        `token still resumes its pre-upgrade session after the version change: ${upgraded.sessionId}`,
      );
    if (upgraded.reply.includes(UPGRADE_MARKER))
      throw new Error(
        `fresh post-upgrade session leaked the retired history: ${JSON.stringify(upgraded.reply)}`,
      );
    if (upgraded.reply !== EMPTY_HISTORY_REPLY)
      throw new Error(
        `fresh post-upgrade session did not start empty: ${JSON.stringify(upgraded.reply)}`,
      );
    console.log(
      `replica smoke: eve version change starts a fresh session on the same token, with no history carried over OK (reply: ${upgraded.reply})`,
    );

    if (mock.requests.length < 3)
      throw new Error(
        `provider was barely exercised: ${mock.requests.length} requests`,
      );
    console.log(
      `replica smoke: OK (provider requests: ${mock.requests.length})`,
    );
  } catch (err) {
    console.error(
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions -- preserve the original template coercion.
      `replica smoke FAILED at phase "${phase}": ${errorDetail(err)}`,
    );
    console.error(`provider requests so far: ${mock.requests.length}`);
    console.error("--- last child output ---");
    for (const line of logs.slice(-120)) console.error(line);
    process.exitCode = 1;
  } finally {
    await stopEve(eve);
    await mock.close();
    if (process.env.REPLICA_KEEP === "1")
      console.error(`sandbox kept: ${sandbox}`);
    else await rm(sandbox, { recursive: true, force: true });
  }
}

await main();
