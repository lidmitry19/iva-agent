// Настоящий процесс ночи (scripts/memory/night.ts) против двойника модели: локальный
// OpenAI-совместимый сервер отвечает потоком текста и считает запросы. Vault
// под git во временной папке. Утверждаются файлы vault, история git, stderr и код выхода.
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import "../lib/ts-esm-hooks.ts";

const cs = await import("../../agent/lib/card-store.ts");

const ROOT = resolve(import.meta.dirname, "../..");
const NIGHT = join(ROOT, "scripts/memory/night.ts");
const HOOKS = join(ROOT, "scripts/lib/ts-esm-hooks.ts");
const DATE = "2026-09-26";
// Часы ночи закреплены: неделя DATE ещё не закончилась, поэтому ночь не собирает сводку
// недели, и число вызовов модели не зависит от дня запуска тестов.
const NOW = "2026-09-27T12:00:00Z";
const TODAY = NOW.slice(0, 10);
const CLOCK = join(ROOT, "scripts/fixtures/shifted-clock.ts");

class ModelDouble {
  readonly prompts: string[] = [];
  replies: unknown[] = [];
  private readonly held = new Map<
    number,
    { entered: () => void; gate: Promise<void> }
  >();
  readonly server = createServer(
    (request, response) => void this.handle(request, response),
  );

  hold(call: number) {
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((accept) => (entered = accept));
    const gate = new Promise<void>((accept) => (release = accept));
    this.held.set(call, { entered, gate });
    return { reached, release };
  }

  async start(t: TestContext): Promise<string> {
    await new Promise<void>((accept) =>
      this.server.listen(0, "127.0.0.1", accept),
    );
    t.after(async () => {
      this.server.closeAllConnections();
      await new Promise((accept) => this.server.close(accept));
    });
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1`;
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const params = JSON.parse(body) as {
      messages: Array<{ content: unknown }>;
      stream: boolean;
    };
    assert.equal(params.stream, true);
    const messages = params.messages;
    this.prompts.push(JSON.stringify(messages.at(-1)?.content));
    const held = this.held.get(this.prompts.length);
    if (held) {
      held.entered();
      await held.gate;
    }
    // Сценарий ответа: { status } — ошибка HTTP, { text } — текст без JSON,
    // { usage, value } — свой расход (null — без usage), иначе — сам JSON ответа.
    const reply = this.replies.shift() as Record<string, unknown> | undefined;
    const send = (status: number, value: unknown) =>
      response
        .writeHead(status, { "content-type": "application/json" })
        .end(JSON.stringify(value));
    if (reply === undefined)
      return send(500, { error: { message: "unexpected model call" } });
    if (typeof reply.status === "number")
      return send(reply.status, {
        error: { message: `double ${reply.status}` },
      });
    const own = "usage" in reply;
    const usage = own ? (reply.usage as number | null) : 100;
    const value = own ? reply.value : reply;
    const text = typeof reply.text === "string" ? reply.text : null;
    // Модель отвечает текстом: JSON в markdown-ограде, как делают настоящие модели.
    const content =
      text ?? `Ответ:\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
    response.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta: unknown, finish: string | null, usage?: unknown) =>
      response.write(
        `data: ${JSON.stringify({
          id: "x",
          object: "chat.completion.chunk",
          created: 1,
          model: "double",
          choices: [{ index: 0, delta, finish_reason: finish }],
          ...(usage ? { usage } : {}),
        })}\n\n`,
      );
    chunk({ role: "assistant", content }, null);
    chunk(
      {},
      "stop",
      usage === null
        ? undefined
        : {
            prompt_tokens: usage,
            completion_tokens: 10,
            total_tokens: usage + 10,
          },
    );
    response.end("data: [DONE]\n\n");
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

interface Fixture {
  readonly vault: string;
  readonly data: string;
  readonly model: ModelDouble;
  baseUrl: string;
}

async function fixture(t: TestContext, core = true): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "iva-night-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const vault = join(root, "vault");
  const data = join(root, "data");
  mkdirSync(join(vault, "daily"), { recursive: true });
  mkdirSync(data);
  writeFileSync(join(data, "settings.json"), "{}\n");
  if (core)
    writeFileSync(
      join(vault, "CORE.md"),
      "# CORE\n\n## Пользователь\n\n## Предпочтения\n\n## Активные цели\n",
    );
  writeFileSync(
    join(vault, "schema.json"),
    JSON.stringify({ node_types: { project: { status: ["active", "done"] } } }),
  );
  git(vault, "init", "-q");
  git(vault, "config", "user.email", "night@example.invalid");
  git(vault, "config", "user.name", "Night");
  commit(vault, "initial");
  const model = new ModelDouble();
  return { vault, data, model, baseUrl: await model.start(t) };
}

function commit(vault: string, message = "fixture"): void {
  git(vault, "add", "-A");
  git(vault, "commit", "-qm", message, "--allow-empty");
}

function spawnNight(
  fx: Fixture,
  date: string | null = DATE,
  env: Record<string, string> = {},
) {
  const args = [
    "--import",
    HOOKS,
    "--import",
    CLOCK,
    NIGHT,
    ...(date ? [date] : []),
  ];
  const child: ChildProcess = spawn(process.execPath, args, {
    cwd: ROOT,
    env: {
      ...process.env,
      ASSISTANT_VAULT_DIR: fx.vault,
      ASSISTANT_DATA_DIR: fx.data,
      ASSISTANT_TIMEZONE: "UTC",
      MODEL_PROVIDER: "custom",
      CUSTOM_BASE_URL: fx.baseUrl,
      CUSTOM_API_KEY: "test",
      CUSTOM_MODEL: "double",
      IVA_JOB_STOP_AT: String(Date.now() + 60_000),
      TELEGRAM_BOT_TOKEN: "",
      TELEGRAM_DIGEST_CHAT_ID: "",
      TELEGRAM_ALLOWED_USER_IDS: "",
      IVA_MEMORY_LOCK_HELD: "1",
      IVA_TEST_NOW: NOW,
      ...env,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child
    .stderr!.setEncoding("utf8")
    .on("data", (chunk: string) => (stderr += chunk));
  const result = new Promise<{ code: number | null; stderr: string }>(
    (accept) => child.once("close", (code) => accept({ code, stderr })),
  );
  return { child, result };
}

const night = (
  fx: Fixture,
  date?: string | null,
  env?: Record<string, string>,
) => spawnNight(fx, date, env).result;

function A(parts: Record<string, unknown> = {}) {
  return {
    gist: "Запущен проект Аврора",
    topics: ["проекты"],
    points: [{ text: "Старт Авроры", src: "e1" }],
    new_cards: [],
    facts: [],
    aliases: [],
    links: [],
    core: [],
    ...parts,
  };
}
const newAurora = {
  name: "Аврора",
  type: "project",
  description: "Новый проект",
};
const B = (...cards: Array<Record<string, unknown>>) => ({
  cards: cards.map((card) => ({
    truth: null,
    description: null,
    status: null,
    ...card,
  })),
});

function day(fx: Fixture, text: string, date = DATE): string {
  const file = join(fx.vault, "daily", `${date}.md`);
  writeFileSync(file, text);
  commit(fx.vault, `day ${date}`);
  return file;
}

function card(fx: Fixture, path: string, lines: string[]): string {
  const file = join(fx.vault, `${path}.md`);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, lines.join("\n"));
  commit(fx.vault, `card ${path}`);
  return file;
}

const read = (file: string) => readFileSync(file, "utf8");
const summary = (fx: Fixture, date = DATE) =>
  join(fx.vault, "summaries/daily", `${date}.md`);
const logRows = (text: string) =>
  text.split("\n").filter((line) => /^- \d{4}-\d{2}-\d{2}: /u.test(line));
const aurora = [
  "---",
  'type: "project"',
  'description: "Проект"',
  'status: "active"',
  "---",
  "# Аврора",
  "",
  "Первая строка правды",
  "Вторая строка правды",
  "Третья строка правды",
  "",
  "## Log",
  "",
  "## Related",
  "",
  "## History",
  "",
];

void test("обычный день: A и B, Card, выжимка, отметка, коммиты; повтор ночи ничего не зовёт и не меняет", async (t) => {
  const fx = await fixture(t);
  const raw =
    "## 10:00 [text]\nЗапустил проект Аврора\n\n## 10:05 [iva]\nОтличный старт\n";
  const file = day(fx, raw);
  fx.model.replies = [
    A({
      new_cards: [newAurora],
      facts: [
        {
          card: "Аврора",
          text: "Проект запущен",
          src: "e1",
          quote: "Запустил",
        },
      ],
    }),
    B({ card: "cards/projects/аврора", truth: "Проект запуска" }),
  ];
  const first = await night(fx);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(fx.model.prompts.length, 2);
  assert.equal(
    read(file),
    `${raw}\n<!-- processed: memory-night ${DATE} -->\n`,
  );
  const text = read(join(fx.vault, "cards/projects/аврора.md"));
  assert.deepEqual(logRows(text), [
    `- ${DATE}: Проект запущен · [[daily/${DATE}]] 10:00`,
  ]);
  assert.match(text, /# Аврора\n\nПроект запуска\n\n## Log/u);
  assert.match(
    read(summary(fx)),
    /source: "night"[\s\S]*body_hash: "[0-9a-f]{64}"/u,
  );
  assert.match(read(summary(fx)), /- \[\[cards\/projects\/аврора\]\]/u);
  assert.equal(git(fx.vault, "status", "--porcelain"), "");
  const head = git(fx.vault, "rev-parse", "HEAD");
  const again = await night(fx, null);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(fx.model.prompts.length, 2);
  assert.equal(git(fx.vault, "rev-parse", "HEAD"), head);
});

for (const tracked of [false, true]) {
  void test(`ignore daily и summaries не останавливает ночь; raw ${tracked ? "tracked" : "untracked"} (#257)`, async (t) => {
    const fx = await fixture(t);
    const raw = "## 10:00 [text]\nЗапустил проект Аврора\n";
    const file = join(fx.vault, "daily", `${DATE}.md`);
    if (tracked) day(fx, raw);
    writeFileSync(join(fx.vault, ".gitignore"), "daily/\nsummaries/\n");
    commit(fx.vault, "ignore memory");
    if (!tracked) writeFileSync(file, raw);
    fx.model.replies = [A()];
    const first = await night(fx);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(fx.model.prompts.length, 1);
    assert.match(read(file), /processed: memory-night/u);
    assert.match(read(summary(fx)), /Аврора/u);
    assert.match(first.stderr, /вне git-бэкапа по ignore.*summaries\/daily/u);
    assert.equal(git(fx.vault, "ls-files", `summaries/daily/${DATE}.md`), "");
    const cache = JSON.parse(
      read(join(fx.data, "memory/night", `${DATE}.json`)),
    ) as { completedAt?: string };
    assert.ok(cache.completedAt);
    if (tracked)
      assert.match(
        git(fx.vault, "show", `HEAD:daily/${DATE}.md`),
        /processed: memory-night/u,
      );
    else {
      assert.equal(git(fx.vault, "ls-files", `daily/${DATE}.md`), "");
      assert.match(
        first.stderr,
        /вне git-бэкапа по ignore.*daily\/2026-09-26/u,
      );
    }
    const head = git(fx.vault, "rev-parse", "HEAD");
    const again = await night(fx, null);
    assert.equal(again.code, 0, again.stderr);
    assert.equal(fx.model.prompts.length, 1);
    assert.equal(git(fx.vault, "rev-parse", "HEAD"), head);
  });
}

void test("B заменяет правду целиком: сменённая средняя строка уходит в History, порядок цел (ДЕФ-1, ДЕФ-18)", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nВторую строку меняю\n");
  const file = card(fx, "cards/projects/аврора", aurora);
  fx.model.replies = [
    A({
      facts: [
        {
          card: "cards/projects/аврора",
          text: "Строка меняется",
          src: "e1",
          quote: "Вторую строку меняю",
        },
      ],
    }),
    B({
      card: "cards/projects/аврора",
      truth: "Первая строка правды\nНовая вторая\nТретья строка правды",
    }),
  ];
  assert.equal((await night(fx)).code, 0);
  const text = read(file);
  assert.match(
    text,
    /# Аврора\n\nПервая строка правды\nНовая вторая\nТретья строка правды\n\n## Log/u,
  );
  assert.match(
    text,
    new RegExp(
      `## History\\n\\n- ${DATE}: Вторая строка правды \\(сменено: \\[\\[daily/${DATE}\\]\\]\\)`,
      "u",
    ),
  );
  assert.match(text, new RegExp(`truth_date: "${DATE}"`, "u"));
});

void test("B повторяет ответ с H1/H2 или незакрытым fence и не ломает Card", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nАврора сменила курс\n");
  const file = card(fx, "cards/projects/аврора", aurora);
  fx.model.replies = [
    A({
      facts: [
        {
          card: "cards/projects/аврора",
          text: "Курс сменён",
          src: "e1",
          quote: "сменила курс",
        },
      ],
    }),
    B({ card: "cards/projects/аврора", truth: "# Подмена\n\n## Log\n\n```" }),
    B({ card: "cards/projects/аврора", truth: "Безопасная правда" }),
  ];
  const result = await night(fx);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fx.model.prompts.length, 3);
  const text = read(file);
  assert.match(text, /# Аврора\n\nБезопасная правда\n\n## Log/u);
  assert.equal((text.match(/^## Log$/gmu) ?? []).length, 1);
  assert.doesNotMatch(text, /Подмена/u);
});

void test("поздний хвост: A только по новым репликам, Log без повторов, дубля Card нет (M2, ДЕФ-2)", async (t) => {
  const fx = await fixture(t);
  const file = day(fx, "## 10:00 [text]\nЗапустил проект Аврора\n");
  fx.model.replies = [
    A({
      new_cards: [newAurora],
      facts: [
        {
          card: "Аврора",
          text: "Проект запущен",
          src: "e1",
          quote: "Запустил",
        },
      ],
    }),
    B({ card: "cards/projects/аврора" }),
  ];
  assert.equal((await night(fx)).code, 0);
  appendFileSync(file, "\n## 11:00 [text]\nСрок Авроры пятница\n");
  commit(fx.vault);
  fx.model.replies = [
    A({
      gist: "Аврора и срок",
      facts: [
        {
          card: "cards/projects/аврора",
          text: "Срок пятница",
          src: ["e2"],
          quote: "Срок Авроры пятница",
        },
        {
          card: "cards/projects/аврора",
          text: "Проект запущен",
          src: "e2",
          quote: "Срок Авроры",
        },
      ],
    }),
    B({ card: "cards/projects/аврора" }),
  ];
  const tail = await night(fx);
  assert.equal(tail.code, 0, tail.stderr);
  assert.equal(fx.model.prompts.length, 4);
  assert.doesNotMatch(fx.model.prompts[2], /Запустил проект/u);
  assert.match(fx.model.prompts[2], /Запущен проект Аврора/u);
  assert.match(fx.model.prompts[2], /cards\/projects\/аврора/u);
  const text = read(join(fx.vault, "cards/projects/аврора.md"));
  assert.equal(logRows(text).length, 2);
  assert.deepEqual(
    execFileSync("ls", [join(fx.vault, "cards/projects")], {
      encoding: "utf8",
    }).trim(),
    "аврора.md",
  );
  assert.match(read(summary(fx)), /description: "Аврора и срок"/u);
  assert.equal(read(file).match(/processed: memory-night/gu)?.length, 2);
  const unchanged = git(fx.vault, "rev-parse", "HEAD");
  writeFileSync(file, read(file).replace("Запустил", "Начал"));
  commit(fx.vault);
  const edited = await night(fx, null);
  assert.equal(fx.model.prompts.length, 4);
  assert.match(edited.stderr, /изменён после разбора/u);
  assert.notEqual(unchanged, "");
});

void test("выключатель: ничего не читается и не зовётся", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nФакт\n");
  writeFileSync(
    join(fx.data, "settings.json"),
    JSON.stringify({ memory: { night: "off" } }),
  );
  chmodSync(fx.vault, 0o000);
  const result = await night(fx);
  chmodSync(fx.vault, 0o755);
  assert.equal(result.code, 0);
  assert.match(result.stderr, /выключено/u);
  assert.equal(fx.model.prompts.length, 0);
});

void test("ответ не по форме: один повтор с текстом ошибки, потом no-report; ответ без submit тоже повторяется", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nФакт\n");
  fx.model.replies = [
    { text: "Не понял задачу" },
    { text: "Вот ответ словами" },
  ];
  const result = await night(fx);
  assert.equal(result.code, 1);
  assert.equal(fx.model.prompts.length, 2);
  assert.match(fx.model.prompts[1], /Ошибка прошлого ответа/u);
  assert.equal(existsSync(summary(fx)), false);
  assert.match(read(join(fx.data, "rollup-attempts.json")), /no-report/u);
  fx.model.replies = [{ text: "без инструмента" }, A(), B()];
  const retried = await night(fx);
  assert.equal(retried.code, 0, retried.stderr);
  assert.equal(existsSync(summary(fx)), true);
});

void test("негодный факт отбрасывается со строкой в Job, остальной ответ применяется", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nЗапустил Аврору\n");
  fx.model.replies = [
    A({
      new_cards: [newAurora],
      facts: [
        {
          card: "Аврора",
          text: "Проект запущен",
          src: "e1",
          quote: "Запустил",
        },
        {
          card: "Несуществующая",
          text: "Лишнее",
          src: "e1",
          quote: "Запустил",
        },
        { card: "Аврора", text: "Из воздуха", src: "e9", quote: "Запустил" },
        { card: "Аврора", text: "Выдумка", src: "e1", quote: "этого не было" },
      ],
    }),
    B({ card: "cards/projects/аврора" }),
  ];
  const result = await night(fx);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /отброшено.*Несуществующая/u);
  assert.match(result.stderr, /отброшено.*e9/u);
  assert.match(result.stderr, /отброшено.*этого не было/u);
  assert.deepEqual(
    logRows(read(join(fx.vault, "cards/projects/аврора.md"))).length,
    1,
  );
});

void test("сеть 429: один вызов, без попытки дня, день в очереди", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nФакт\n");
  fx.model.replies = [{ status: 429 }];
  const result = await night(fx);
  assert.equal(result.code, 1);
  assert.equal(fx.model.prompts.length, 1);
  assert.equal(existsSync(join(fx.data, "rollup-attempts.json")), false);
  fx.model.replies = [A(), B()];
  assert.equal((await night(fx)).code, 0);
});

void test("kill -9 на B: повтор без второго A и без дубля Card, даже если отметка применения не успела", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nЗапустил Аврору\n");
  fx.model.replies = [
    A({
      new_cards: [newAurora],
      facts: [
        {
          card: "Аврора",
          text: "Проект запущен",
          src: "e1",
          quote: "Запустил",
        },
      ],
    }),
  ];
  const held = fx.model.hold(2);
  const run = spawnNight(fx);
  await held.reached;
  run.child.kill("SIGKILL");
  await run.result;
  held.release();
  await new Promise((accept) => setTimeout(accept, 100));
  const cache = join(fx.data, "memory/night", `${DATE}.json`);
  const state = JSON.parse(read(cache)) as { pass: Record<string, unknown> };
  delete state.pass.applied;
  delete state.pass.truth;
  writeFileSync(cache, JSON.stringify(state));
  fx.model.replies = [B({ card: "cards/projects/аврора" })];
  const again = await night(fx);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(fx.model.prompts.length, 3);
  assert.equal(
    execFileSync("ls", [join(fx.vault, "cards/projects")], {
      encoding: "utf8",
    }).trim(),
    "аврора.md",
  );
  assert.equal(
    logRows(read(join(fx.vault, "cards/projects/аврора.md"))).length,
    1,
  );
});

void test("правка человека во время B побеждает, день закрыт, B по Card следующей ночью (ДЕФ-3)", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nАврора сменила курс\n");
  const file = card(fx, "cards/projects/аврора", aurora);
  fx.model.replies = [
    A({
      facts: [
        {
          card: "cards/projects/аврора",
          text: "Курс сменён",
          src: "e1",
          quote: "Аврора сменила курс",
        },
      ],
    }),
    B({ card: "cards/projects/аврора", truth: "Ночная правда" }),
  ];
  const held = fx.model.hold(2);
  const run = spawnNight(fx);
  await held.reached;
  writeFileSync(
    file,
    read(file).replace("Первая строка правды", "Правда владельца"),
  );
  held.release();
  const first = await run.result;
  assert.equal(first.code, 0, first.stderr);
  assert.match(read(file), /Правда владельца/u);
  assert.doesNotMatch(read(file), /Ночная правда/u);
  assert.match(read(file), new RegExp(`truth_pending: "${DATE}"`, "u"));
  assert.match(first.stderr, /изменён человеком/u);
  assert.equal(existsSync(summary(fx)), true);
  day(fx, "## 09:00 [text]\nПросто день\n", "2026-09-27");
  fx.model.replies = [
    A({ facts: [] }),
    B({
      card: "cards/projects/аврора",
      truth: "Правда владельца\nКурс сменён",
    }),
  ];
  const second = await night(fx, "2026-09-27");
  assert.equal(second.code, 0, second.stderr);
  assert.match(fx.model.prompts[3], /Курс сменён/u);
  assert.doesNotMatch(read(file), /truth_pending/u);
});

void test("занятое имя новой Card: отдельная Card «Имя (D)» и Alert, исходная байт в байт", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nАврора\n");
  const file = card(fx, "cards/notes/аврора", [
    "---",
    'type: "note"',
    'aliases: ["Аврора"]',
    "---",
    "# Аврора",
    "",
    "## Log",
    "",
  ]);
  const before = read(file);
  fx.model.replies = [
    A({
      new_cards: [newAurora],
      facts: [
        { card: "Аврора", text: "Новый проект", src: "e1", quote: "Аврора" },
      ],
    }),
    B({ card: `cards/projects/аврора-${DATE}` }),
  ];
  const result = await night(fx);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(read(file), before);
  assert.match(
    read(join(fx.vault, `cards/projects/аврора-${DATE}.md`)),
    new RegExp(`# Аврора \\(${DATE}\\)`, "u"),
  );
  assert.match(result.stderr, /Похоже на дубль: Аврора/u);
});

void test("открытый фенс и чужой файл на месте новой Card: факты в pending, файлы целы; починка дописывает без модели (ДЕФ-4)", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nАврора и Борис\n");
  const fenced = card(fx, "cards/projects/аврора", [
    "---",
    'type: "project"',
    "---",
    "# Аврора",
    "",
    "## Log",
    "",
    "```",
    "открыто",
    "",
  ]);
  const foreign = card(fx, "cards/contacts/борис", [
    "---",
    'description: "битая кавычка',
    "---",
    "# Борис",
    "",
    "Текст владельца",
    "",
  ]);
  const [fencedBefore, foreignBefore] = [read(fenced), read(foreign)];
  fx.model.replies = [
    A({
      new_cards: [{ name: "Борис", type: "contact", description: "Коллега" }],
      facts: [
        {
          card: "cards/projects/аврора",
          text: "Аврора идёт",
          src: "e1",
          quote: "Аврора",
        },
        { card: "Борис", text: "Борис в команде", src: "e1", quote: "Борис" },
      ],
    }),
  ];
  const result = await night(fx);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(read(fenced), fencedBefore);
  assert.equal(read(foreign), foreignBefore);
  assert.match(result.stderr, /Поправь Card cards\/projects\/аврора/u);
  assert.match(result.stderr, /Поправь Card cards\/contacts\/борис/u);
  writeFileSync(fenced, fencedBefore.replace("открыто\n", "открыто\n```\n"));
  writeFileSync(
    foreign,
    foreignBefore
      .replace('"битая кавычка', '"починено"')
      .replace("Текст владельца\n", "Текст владельца\n\n## Log\n"),
  );
  commit(fx.vault);
  const fixed = await night(fx, null);
  assert.equal(fixed.code, 0, fixed.stderr);
  assert.equal(fx.model.prompts.length, 1);
  assert.equal(logRows(read(fenced)).length, 1);
  assert.deepEqual(logRows(read(foreign)), [
    `- ${DATE}: Борис в команде · [[daily/${DATE}]] 10:00`,
  ]);
});

void test("предел ночи: большой расход на A — B не начат, попытка cut, код 1; без usage следующий вызов закрыт", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nАврора\n");
  card(fx, "cards/projects/аврора", aurora);
  fx.model.replies = [
    {
      usage: 299_990,
      value: A({
        facts: [
          {
            card: "cards/projects/аврора",
            text: "Факт",
            src: "e1",
            quote: "Аврора",
          },
        ],
      }),
    },
  ];
  const cut = await night(fx);
  assert.equal(cut.code, 1);
  assert.equal(fx.model.prompts.length, 1);
  assert.match(cut.stderr, /обрез пределом ночи/u);
  assert.match(read(join(fx.data, "rollup-attempts.json")), /"cut"/u);
  assert.equal(existsSync(summary(fx)), false);
  fx.model.replies = [
    { usage: null, value: B({ card: "cards/projects/аврора" }) },
  ];
  const unknown = await night(fx);
  assert.equal(unknown.code, 0, unknown.stderr);
  assert.match(unknown.stderr, /usage unknown/u);
});

void test("отказ коммита: день не готов; следующая ночь коммитит без вызова модели", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nФакт\n");
  const hook = join(fx.vault, ".git/hooks/pre-commit");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n");
  chmodSync(hook, 0o755);
  fx.model.replies = [A(), B()];
  const failed = await night(fx);
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /не закоммичен/u);
  rmSync(hook);
  const resumed = await night(fx, null);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(fx.model.prompts.length, 1);
  assert.equal(git(fx.vault, "status", "--porcelain"), "");
  assert.equal(existsSync(summary(fx)), true);
});

void test("первая ночь без CORE: C зовётся, CORE создан, строка сразу под заголовком раздела (ДЕФ-6, ДЕФ-8)", async (t) => {
  const fx = await fixture(t, false);
  day(fx, "## 10:00 [text]\nКофе после четырёх не пью\n");
  fx.model.replies = [
    A({ core: [{ text: "Не пьёт кофе после 16:00", src: "e1" }] }),
    {
      sections: [
        { section: "Предпочтения", text: "- Не пьёт кофе после 16:00" },
      ],
    },
  ];
  const result = await night(fx);
  assert.equal(result.code, 0, result.stderr);
  assert.match(
    read(join(fx.vault, "CORE.md")),
    /## Предпочтения\n\n- Не пьёт кофе после 16:00\n\n## Активные цели/u,
  );
  assert.match(
    read(join(fx.vault, "CORE.md")),
    new RegExp(`Последний день: summaries/daily/${DATE}`, "u"),
  );
});

void test("CORE над лимитом: повтор с «освободи», отказ — кандидат ждёт следующей ночи, не exit 1 (ДЕФ-7)", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nЛюблю чай\n");
  const long = `- ${"x".repeat(4000)}`;
  fx.model.replies = [
    A({ core: [{ text: "Любит чай", src: "e1" }] }),
    { sections: [{ section: "Предпочтения", text: long }] },
    { sections: [{ section: "Предпочтения", text: long }] },
  ];
  const first = await night(fx);
  assert.equal(first.code, 0, first.stderr);
  assert.match(fx.model.prompts[2], /освободи \d+ знаков/u);
  assert.match(first.stderr, /кандидаты ждут/u);
  assert.doesNotMatch(read(join(fx.vault, "CORE.md")), /xxxx/u);
  fx.model.replies = [
    { sections: [{ section: "Предпочтения", text: "- Любит чай" }] },
  ];
  assert.equal((await night(fx, null)).code, 0);
  assert.match(fx.model.prompts[3], /Любит чай/u);
  assert.match(read(join(fx.vault, "CORE.md")), /- Любит чай/u);
});

void test("догон: из четырёх дней ночь берёт три старых по порядку", async (t) => {
  const fx = await fixture(t);
  const dates = ["2020-01-01", "2020-01-02", "2020-01-03", "2020-01-04"];
  for (const date of dates) day(fx, `## 10:00 [text]\nФакт ${date}\n`, date);
  fx.model.replies = dates.slice(0, 3).flatMap((date) => [A({ gist: date })]);
  const result = await night(fx, null);
  assert.equal(result.code, 0, result.stderr);
  dates
    .slice(0, 3)
    .forEach((date, index) =>
      assert.match(fx.model.prompts[index], new RegExp(date, "u")),
    );
  assert.equal(existsSync(summary(fx, dates[3])), false);
});

void test("день по частям: A на каждую часть, вторая видит выжимку первой, одна выжимка дня", async (t) => {
  const fx = await fixture(t);
  day(
    fx,
    `## 10:00 [text]\n${"а".repeat(30_000)}\n\n## 11:00 [text]\n${"б".repeat(30_000)}\n`,
  );
  fx.model.replies = [
    A({ gist: "первая часть" }),
    A({ gist: "весь день", points: [{ text: "вторая", src: "e2" }] }),
  ];
  const result = await night(fx);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fx.model.prompts.length, 2);
  assert.match(fx.model.prompts[1], /первая часть/u);
  assert.match(
    read(summary(fx)),
    /description: "весь день"[\s\S]*- вторая · \[\[daily\/2026-09-26\]\] 11:00/u,
  );
});

void test("граница перехода и ручная правка: старая выжимка без body_hash и правленая выжимка не трогаются (ДЕФ-5, ДЕФ-12)", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nСтарый день\n", "2020-02-10");
  day(
    fx,
    "## 10:00 [text]\nЕщё день\n\n## 11:00 [text]\nХвост после правки\n",
    "2020-02-11",
  );
  mkdirSync(join(fx.vault, "summaries/daily"), { recursive: true });
  const legacy =
    '---\ntype: "daily-summary"\ndescription: "старая ночь"\n---\n# 2020-02-10\n';
  writeFileSync(summary(fx, "2020-02-10"), legacy);
  writeFileSync(
    summary(fx, "2020-02-11"),
    `---\nbody_hash: "${"0".repeat(64)}"\n---\n# Правка владельца\n`,
  );
  commit(fx.vault);
  const result = await night(fx, null);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fx.model.prompts.length, 0);
  assert.equal(read(summary(fx, "2020-02-10")), legacy);
  assert.match(read(summary(fx, "2020-02-11")), /Правка владельца/u);
  assert.match(result.stderr, /выжимка 2020-02-11 изменена вручную/u);
});

void test("iva jobs skip закрывает день отметкой в сыром дне", async (t) => {
  const fx = await fixture(t);
  day(
    fx,
    "## 10:00 [text]\nФакт\n\n<!-- processed: skipped by owner 2026-09-27T00:00:00Z -->\n",
  );
  const result = await night(fx, null);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fx.model.prompts.length, 0);
});

void test("кэш не пишется: вызова нет, код 1 (ДЕФ-16)", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nФакт\n");
  mkdirSync(join(fx.data, "memory"), { recursive: true });
  writeFileSync(join(fx.data, "memory/night"), "not a directory");
  const result = await night(fx);
  assert.equal(result.code, 1);
  assert.equal(fx.model.prompts.length, 0);
});

void test("реплика, пришедшая во время ручной ночи, разбирается следующей ночью (ДЕФ-13)", async (t) => {
  const fx = await fixture(t);
  const file = day(fx, "## 10:00 [text]\nПервая\n");
  fx.model.replies = [A()];
  const held = fx.model.hold(1);
  const run = spawnNight(fx);
  await held.reached;
  appendFileSync(file, "\n## 10:30 [text]\nПришла во время ночи\n");
  held.release();
  assert.equal((await run.result).code, 0);
  fx.model.replies = [A({ points: [{ text: "поздняя", src: "e2" }] })];
  const next = await night(fx, null);
  assert.equal(next.code, 0, next.stderr);
  assert.match(fx.model.prompts[1], /Пришла во время ночи/u);
});

void test("CLI отвергает несуществующую дату (ДЕФ-19)", async (t) => {
  const fx = await fixture(t);
  const result = await night(fx, "2026-02-30");
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Usage/u);
});

void test("нет сырого дня за вчера при ходах в usage.jsonl — Alert о сбое транскрипта (ДЕФ-17)", async (t) => {
  const fx = await fixture(t);
  const yesterday = new Date(Date.parse(`${TODAY}T00:00:00Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10);
  writeFileSync(
    join(fx.data, "usage.jsonl"),
    `${JSON.stringify({ ts: `${yesterday}T10:00:00.000Z`, source: "chat" })}\n`,
  );
  const result = await night(fx, null);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /memory-night alert night-transcript/u);
});

void test("неделя из готовых дней собирается одним вызовом; неготовый день держит период; сбой P — выжимка без модели", async (t) => {
  const fx = await fixture(t);
  const monday = new Date(Date.parse(`${TODAY}T00:00:00Z`));
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7) - 7);
  const days = Array.from({ length: 7 }, (_, index) =>
    new Date(monday.getTime() + index * 86_400_000).toISOString().slice(0, 10),
  );
  mkdirSync(join(fx.vault, "summaries/daily"), { recursive: true });
  for (const date of days.slice(0, 6))
    writeFileSync(
      summary(fx, date),
      `---\ndescription: "день ${date}"\n---\n# ${date}\n`,
    );
  day(fx, "## 10:00 [text]\nПоследний день недели\n", days[6]);
  fx.model.replies = [
    A({ gist: "последний" }),
    { text: "неделя" },
    { text: "неделя" },
  ];
  const result = await night(fx, null);
  assert.equal(result.code, 0, result.stderr);
  assert.match(fx.model.prompts[0], /Последний день недели/u);
  const weekly = execFileSync("ls", [join(fx.vault, "weekly")], {
    encoding: "utf8",
  }).trim();
  assert.match(
    read(join(fx.vault, "weekly", weekly)),
    /mode: "fallback"[\s\S]*\[\[summaries\/daily\//u,
  );
  assert.match(result.stderr, /night-fallback/u);
});

// День, закрытый iva jobs skip или вставший на паузу после трёх попыток, выжимки не
// получит никогда: неделя собирается без него («нет данных»), а не ждёт вечно.
for (const closed of ["skip", "pause"] as const)
  void test(`неделя с днём без выжимки (${closed}) собирается, день — «нет данных»`, async (t) => {
    const fx = await fixture(t);
    const monday = new Date(Date.parse(`${TODAY}T00:00:00Z`));
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7) - 7);
    const days = Array.from({ length: 7 }, (_, index) =>
      new Date(monday.getTime() + index * 86_400_000)
        .toISOString()
        .slice(0, 10),
    );
    mkdirSync(join(fx.vault, "summaries/daily"), { recursive: true });
    for (const date of days.slice(0, 6))
      writeFileSync(
        summary(fx, date),
        `---\ndescription: "день ${date}"\n---\n# ${date}\n`,
      );
    const marker =
      "\n<!-- processed: skipped by owner 2026-09-20T00:00:00.000Z -->\n";
    day(
      fx,
      `## 10:00 [text]\nтяжёлый день\n${closed === "skip" ? marker : ""}`,
      days[6],
    );
    if (closed === "pause") {
      const at = "2026-09-20T00:00:00.000Z";
      const tries = Array.from({ length: 3 }, () => ({ at, reason: "cut" }));
      writeFileSync(
        join(fx.data, "rollup-attempts.json"),
        JSON.stringify({ [days[6]]: tries }),
      );
    }
    fx.model.replies = [{ text: JSON.stringify({ gist: "неделя" }) }];
    const result = await night(fx, null);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(fx.model.prompts.length, 1, result.stderr);
    assert.doesNotMatch(fx.model.prompts[0], /тяжёлый день/u);
    const weekly = execFileSync("ls", [join(fx.vault, "weekly")], {
      encoding: "utf8",
    }).trim();
    assert.match(weekly, /^\d{4}-W\d{2}\.md$/u);
    const alerts = result.stderr.match(
      /memory-night alert rollup-day-paused/gu,
    );
    assert.equal(
      alerts?.length ?? 0,
      closed === "pause" ? 1 : 0,
      result.stderr,
    );
  });

/** Выжимки дней с description; день — строка YYYY-MM-DD. */
function daySummaries(fx: Fixture, days: readonly string[], hash = "") {
  mkdirSync(join(fx.vault, "summaries/daily"), { recursive: true });
  for (const date of days)
    writeFileSync(
      summary(fx, date),
      `---\ndescription: "день ${date}"\n${hash ? `input_hash: "${hash}"\n` : ""}---\n# ${date}\n`,
    );
}
const periodReply = (gist: string) => ({ gist, topics: [], points: [] });
const pinned = (now: string) => ({
  IVA_TEST_NOW: now,
  IVA_JOB_STOP_AT: String(Date.parse(now) + 60_000),
});

// Ремонт (Sol P1): закрытый день недели, которая целиком старше окна 35 дней, а её месяц
// в окне. Неделю собирает та же ночь, за ней месяц; вечной блокировки нет.
void test("неделя вне окна 35 дней, которой ждёт месяц в окне, собирается, за ней месяц", async (t) => {
  const fx = await fixture(t);
  const week = ["17", "18", "19", "20", "21", "22", "23"].map(
    (d) => `2026-08-${d}`,
  );
  daySummaries(
    fx,
    week.filter((date) => date !== "2026-08-20"),
  );
  day(
    fx,
    "## 10:00 [text]\nзакрыт\n\n<!-- processed: skipped by owner -->\n",
    "2026-08-20",
  );
  fx.model.replies = [periodReply("неделя 34"), periodReply("август")];
  const result = await night(fx, null, pinned("2026-09-28T12:00:00.000Z"));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fx.model.prompts.length, 2, result.stderr);
  assert.ok(existsSync(join(fx.vault, "weekly/2026-W34.md")));
  assert.ok(existsSync(join(fx.vault, "monthly/2026-08.md")));
});

// Ремонт (Sol P1): поздняя выжимка дня пересобирает неделю, а за ней месяц и год, даже
// когда модель вернула неделе прежний gist: в хеш родителя входит вход ребёнка.
void test("поздняя выжимка дня пересобирает неделю, месяц и год при прежнем description недели", async (t) => {
  const fx = await fixture(t);
  const now = pinned("2027-01-06T12:00:00.000Z");
  const week = ["14", "15", "16", "17", "18", "19", "20"].map(
    (d) => `2026-12-${d}`,
  );
  daySummaries(fx, week.slice(0, 6), "h1");
  day(fx, "## 10:00 [text]\nпоздний\n", week[6]);
  const at = "2026-12-21T00:00:00.000Z";
  writeFileSync(
    join(fx.data, "rollup-attempts.json"),
    JSON.stringify({ [week[6]]: Array(3).fill({ at, reason: "cut" }) }),
  );
  fx.model.replies = [
    periodReply("неделя"),
    periodReply("декабрь"),
    periodReply("год"),
  ];
  const first = await night(fx, null, now);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(fx.model.prompts.length, 3, first.stderr);
  daySummaries(fx, [week[6]], "late");
  rmSync(join(fx.data, "rollup-attempts.json"));
  commit(fx.vault, "late day");
  fx.model.replies = [
    periodReply("неделя"),
    periodReply("декабрь"),
    periodReply("год"),
  ];
  const second = await night(fx, null, now);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(fx.model.prompts.length, 6, second.stderr);
});

// Ремонт (Sol r2b P1): неделя старше окна уже собрана без дня на паузе, месяц тоже; день
// получил выжимку позже. Зависимый обход берёт и существующих детей, due() по хешу решает:
// пересобраны неделя и месяц.
void test("существующая неделя вне окна пересобирается после поздней выжимки дня, за ней месяц", async (t) => {
  const fx = await fixture(t);
  const now = pinned("2026-09-28T12:00:00.000Z");
  const week = ["17", "18", "19", "20", "21", "22", "23"].map(
    (d) => `2026-08-${d}`,
  );
  daySummaries(
    fx,
    week.filter((date) => date !== "2026-08-20"),
    "h1",
  );
  day(fx, "## 10:00 [text]\nпоздний\n", "2026-08-20");
  const at = "2026-08-21T00:00:00.000Z";
  writeFileSync(
    join(fx.data, "rollup-attempts.json"),
    JSON.stringify({ "2026-08-20": Array(3).fill({ at, reason: "cut" }) }),
  );
  fx.model.replies = [periodReply("неделя 34"), periodReply("август")];
  const first = await night(fx, null, now);
  assert.equal(first.code, 0, first.stderr);
  assert.ok(existsSync(join(fx.vault, "weekly/2026-W34.md")));
  assert.ok(existsSync(join(fx.vault, "monthly/2026-08.md")));
  daySummaries(fx, ["2026-08-20"], "late");
  rmSync(join(fx.data, "rollup-attempts.json"));
  commit(fx.vault, "late day");
  fx.model.replies = [periodReply("неделя 34"), periodReply("август")];
  const second = await night(fx, null, now);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(fx.model.prompts.length, 4, second.stderr);
  assert.match(fx.model.prompts[2], /2026-W34/u);
  assert.match(fx.model.prompts[3], /2026-08/u);
});

void test("связь пишется в Related обеих Card; связь с неизвестной Card отброшена", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nАнна и Борис взяли Аврору\n");
  const contact = (name: string) => [
    "---",
    'type: "contact"',
    "---",
    `# ${name}`,
    "",
    "## Log",
    "",
    "## Related",
    "",
  ];
  const anna = card(fx, "cards/contacts/анна", contact("Анна"));
  const boris = card(fx, "cards/contacts/борис", contact("Борис"));
  const quote = "Анна и Борис взяли Аврору";
  fx.model.replies = [
    A({
      facts: [
        {
          card: "cards/contacts/анна",
          text: "Анна в Авроре",
          src: "e1",
          quote,
        },
        {
          card: "cards/contacts/борис",
          text: "Борис в Авроре",
          src: "e1",
          quote,
        },
      ],
      links: [
        { a: "cards/contacts/анна", b: "cards/contacts/борис", src: "e1" },
        { a: "cards/contacts/анна", b: "Никто", src: "e1" },
      ],
    }),
    B({ card: "cards/contacts/анна" }, { card: "cards/contacts/борис" }),
  ];
  const result = await night(fx);
  assert.equal(result.code, 0, result.stderr);
  assert.match(read(anna), /## Related\n\n- \[\[cards\/contacts\/борис\]\]/u);
  assert.match(read(boris), /## Related\n\n- \[\[cards\/contacts\/анна\]\]/u);
  assert.match(result.stderr, /отброшено: .*Никто/u);
  assert.equal(git(fx.vault, "status", "--porcelain"), "");
});

// ── Круг 2: ответы формы настоящих моделей (real2) и находки ревью ─────────────────
const REAL_DAY = [
  "## 09:10 [text]",
  "Утром созвонился с Анной. Она переехала в Ташкент, теперь живёт там.",
  "",
  "## 09:15 [text]",
  "Анна ушла из Яндекса, теперь работает в Uzum.",
  "",
  "## 11:00 [text]",
  "Запустили проект Альфа вместе с Анной, первый клиент — Сбер.",
  "",
  "## 18:20 [text]",
  "Встреча с Борисом из Uzum по интеграции платежей, он пришлёт договор до пятницы.",
  "",
].join("\n");
const ls = (dir: string) =>
  existsSync(dir) ? readdirSync(dir).sort().join("\n") : "";

void test("real2: связь двух новых Card пишется, имя-путь — это Card, цитата с другой пунктуацией принята, выдумка отброшена", async (t) => {
  const fx = await fixture(t);
  day(fx, REAL_DAY);
  const contact = (name: string) => ({ name, type: "contact" });
  fx.model.replies = [
    A({
      new_cards: [
        contact("Анна"),
        { name: "Альфа", type: "project" },
        contact("Сбер"),
        contact("cards/contacts/борис"),
        { name: "Uzum", type: "project" },
        contact("Яндекс"),
      ],
      facts: [
        {
          card: "cards/contacts/анна",
          text: "Анна ведёт проект Альфа",
          src: ["e3"],
          quote: "Запустили проект Альфа вместе с Анной.",
        },
        {
          card: "cards/contacts/анна",
          text: "Живёт в Ташкенте",
          src: ["e1"],
          quote: "живёт в Ташкенте",
        },
        {
          card: "cards/contacts/борис",
          text: "Борис из Uzum",
          src: "e4",
          quote: "Встреча с Борисом из Uzum",
        },
      ],
      links: [
        { a: "Альфа", b: "Сбер", src: ["e3"] },
        { a: "Uzum", b: "Борис", src: ["e4"] },
        { a: "Яндекс", b: "Никто", src: ["e2"] },
      ],
    }),
    B({ card: "cards/contacts/анна" }, { card: "cards/contacts/борис" }),
  ];
  const result = await night(fx);
  assert.equal(result.code, 0, result.stderr);
  const path = (card: string) => join(fx.vault, `${card}.md`);
  assert.equal(
    ls(join(fx.vault, "cards/contacts")),
    "анна.md\nборис.md\nсбер.md",
  );
  const anna = read(path("cards/contacts/анна"));
  assert.deepEqual(logRows(anna), [
    `- ${DATE}: Анна ведёт проект Альфа · [[daily/${DATE}]] 11:00`,
  ]);
  assert.match(result.stderr, /отброшено: .*живёт в Ташкенте/u);
  assert.match(
    logRows(read(path("cards/contacts/борис")))[0],
    /Борис из Uzum/u,
  );
  const related = (card: string) => cs.sectionRows(read(path(card)), "Related");
  assert.deepEqual(related("cards/projects/альфа"), [
    "- [[cards/contacts/сбер]]",
  ]);
  assert.deepEqual(related("cards/contacts/сбер"), [
    "- [[cards/projects/альфа]]",
  ]);
  assert.deepEqual(related("cards/projects/uzum"), [
    "- [[cards/contacts/борис]]",
  ]);
  assert.deepEqual(related("cards/contacts/борис"), [
    "- [[cards/projects/uzum]]",
  ]);
  assert.doesNotMatch(ls(join(fx.vault, "cards/contacts")), /яндекс/u);
  assert.equal(git(fx.vault, "status", "--porcelain"), "");
});

void test("Card с truth_date позже разбираемого дня: факт только в Log, B не зовётся, truth_pending нет (#2)", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nАврора сменила курс\n");
  const file = card(fx, "cards/projects/аврора", [
    ...aurora.slice(0, 4),
    'truth_date: "2026-09-27"',
    ...aurora.slice(4),
  ]);
  fx.model.replies = [
    A({
      facts: [
        {
          card: "cards/projects/аврора",
          text: "Курс сменён",
          src: "e1",
          quote: "Аврора сменила курс",
        },
      ],
    }),
  ];
  const result = await night(fx);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fx.model.prompts.length, 1);
  assert.equal(logRows(read(file)).length, 1);
  assert.match(read(file), /truth_date: "2026-09-27"/u);
  assert.doesNotMatch(read(file), /truth_pending/u);
});

void test("время строки Log — от той реплики из src, где стоит цитата (#3)", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 09:00 [text]\nУтро\n\n## 15:30 [text]\nАврора сменила курс\n");
  const file = card(fx, "cards/projects/аврора", aurora);
  fx.model.replies = [
    A({
      facts: [
        {
          card: "cards/projects/аврора",
          text: "Курс сменён",
          src: ["e1", "e2"],
          quote: "Аврора сменила курс",
        },
      ],
    }),
    B({ card: "cards/projects/аврора" }),
  ];
  assert.equal((await night(fx)).code, 0);
  assert.deepEqual(logRows(read(file)), [
    `- ${DATE}: Курс сменён · [[daily/${DATE}]] 15:30`,
  ]);
});

void test("битый кэш дня с отложенными фактами не считается отсутствующим: код 1, строка Job, кэш цел (#4)", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nФакт\n");
  mkdirSync(join(fx.data, "memory/night"), { recursive: true });
  const cache = join(fx.data, "memory/night", `${DATE}.json`);
  const broken =
    '{"v":1,"date":"2026-09-26","pending":{"cards/projects/аврора":["- факт';
  writeFileSync(cache, broken);
  const result = await night(fx, null);
  assert.equal(result.code, 1);
  assert.equal(fx.model.prompts.length, 0);
  assert.match(result.stderr, new RegExp(`кэш ${DATE}.*не читается`, "u"));
  assert.equal(read(cache), broken);
});

void test("одна нечитаемая Card не останавливает скан: строка Job, остальные идут (#5)", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nАврора сменила курс\n");
  const file = card(fx, "cards/projects/аврора", aurora);
  // Файл вне git (ignored): sweep его не читает, читает только скан Card.
  writeFileSync(join(fx.vault, ".gitignore"), "cards/notes/закрытая.md\n");
  commit(fx.vault);
  const locked = card(fx, "cards/notes/закрытая", ["# Закрытая", ""]);
  chmodSync(locked, 0o000);
  fx.model.replies = [
    A({
      facts: [
        {
          card: "cards/projects/аврора",
          text: "Курс сменён",
          src: "e1",
          quote: "Аврора сменила курс",
        },
      ],
    }),
    B({ card: "cards/projects/аврора" }),
  ];
  const result = await night(fx);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(logRows(read(file)).length, 1);
  assert.match(result.stderr, /cards\/notes\/закрытая.*не читается/u);
});

void test("truth_pending: B каждой ночью и без нового дня; Alert, когда правда ждёт дольше трёх ночей (#7)", async (t) => {
  const fx = await fixture(t);
  const file = card(fx, "cards/projects/аврора", [
    ...aurora.slice(0, 4),
    'truth_pending: "2020-01-01"',
    ...aurora.slice(4, 12),
    "- 2020-01-01: Курс сменён · [[daily/2020-01-01]] 10:00",
    ...aurora.slice(12),
  ]);
  fx.model.replies = [{ text: "не понял" }, { text: "опять не понял" }];
  const failed = await night(fx, null);
  assert.equal(failed.code, 0, failed.stderr);
  assert.equal(fx.model.prompts.length, 2);
  assert.match(fx.model.prompts[0], /Курс сменён/u);
  assert.match(read(file), /truth_pending: "2020-01-01"/u);
  assert.match(
    failed.stderr,
    /alert night-pending.*аврора.*ждёт с 2020-01-01/u,
  );
  fx.model.replies = [
    B({ card: "cards/projects/аврора", truth: "Курс сменён" }),
  ];
  const fixed = await night(fx, null);
  assert.equal(fixed.code, 0, fixed.stderr);
  assert.match(read(file), /# Аврора\n\nКурс сменён\n\n## Log/u);
  assert.doesNotMatch(read(file), /truth_pending/u);
});

void test("периоды: все пропущенные недели за 35 дней, старшие первыми; fallback пересобирается; правленый не трогается, изменённый вход пересобирает (#10–#12)", async (t) => {
  const fx = await fixture(t);
  const monday = new Date(Date.parse(`${TODAY}T00:00:00Z`));
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7) - 14);
  const days = Array.from({ length: 14 }, (_, index) =>
    new Date(monday.getTime() + index * 86_400_000).toISOString().slice(0, 10),
  );
  mkdirSync(join(fx.vault, "summaries/daily"), { recursive: true });
  for (const date of days)
    writeFileSync(
      summary(fx, date),
      `---\ndescription: "день ${date}"\n---\n# ${date}\n`,
    );
  commit(fx.vault);
  const P = (gist: string) => ({ gist, topics: [], points: [] });
  fx.model.replies = [
    { text: "неделя" },
    { text: "неделя" },
    ...Array.from({ length: 8 }, () => P("модель")),
  ];
  const first = await night(fx, null);
  assert.equal(first.code, 0, first.stderr);
  const weeks = ls(join(fx.vault, "weekly")).split("\n");
  assert.equal(weeks.length, 2, first.stderr);
  const [older, newer] = weeks.map((name) => name.replace(/\.md$/u, ""));
  const at = (id: string) => fx.model.prompts.findIndex((p) => p.includes(id));
  assert.ok(
    at(older) >= 0 && at(older) < at(newer),
    fx.model.prompts.join("\n"),
  );
  const weekly = (id: string) => join(fx.vault, "weekly", `${id}.md`);
  assert.match(read(weekly(older)), /mode: "fallback"/u);
  fx.model.replies = Array.from({ length: 8 }, () => P("пересобрано"));
  const second = await night(fx, null);
  assert.equal(second.code, 0, second.stderr);
  assert.doesNotMatch(read(weekly(older)), /mode: "fallback"/u);
  assert.match(read(weekly(older)), /description: "пересобрано"/u);
  const calls = fx.model.prompts.length;
  const third = await night(fx, null);
  assert.equal(third.code, 0, third.stderr);
  assert.equal(fx.model.prompts.length, calls, "неизменный вход — без вызова");
  writeFileSync(weekly(newer), `${read(weekly(newer))}\nправка владельца\n`);
  writeFileSync(
    summary(fx, days[0]),
    `---\ndescription: "день поздний"\n---\n# ${days[0]}\n`,
  );
  commit(fx.vault);
  const edited = read(weekly(newer));
  fx.model.replies = Array.from({ length: 8 }, () => P("вход изменился"));
  const fourth = await night(fx, null);
  assert.equal(fourth.code, 0, fourth.stderr);
  assert.equal(read(weekly(newer)), edited);
  assert.match(
    fourth.stderr,
    new RegExp(`weekly ${newer}.*изменён вручную`, "u"),
  );
  assert.match(read(weekly(older)), /description: "вход изменился"/u);
});

void test("ответ-пустышка A при репликах владельца — не по форме: повтор с текстом ошибки, потом no-report, выжимки нет (ДЕФ-2)", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nЗапустил Аврору\n");
  fx.model.replies = [{ refusal: "не могу" }, {}];
  const result = await night(fx);
  assert.equal(result.code, 1);
  assert.equal(fx.model.prompts.length, 2);
  assert.match(fx.model.prompts[1], /Ошибка прошлого ответа: .*выжимк/u);
  assert.equal(existsSync(summary(fx)), false);
  assert.match(read(join(fx.data, "rollup-attempts.json")), /no-report/u);
});

void test("отказ общего коммита правок владельца перед ночью: Alert с причиной, ничего не пишется (Н-6)", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nФакт\n");
  writeFileSync(join(fx.vault, "заметка.md"), "правка владельца\n");
  const hook = join(fx.vault, ".git/hooks/pre-commit");
  writeFileSync(hook, "#!/bin/sh\necho причина-хука >&2\nexit 1\n");
  chmodSync(hook, 0o755);
  const head = git(fx.vault, "rev-parse", "HEAD");
  const result = await night(fx);
  assert.equal(result.code, 1);
  assert.equal(fx.model.prompts.length, 0);
  assert.match(result.stderr, /alert night-sweep: .*не закоммичен/u);
  assert.equal(git(fx.vault, "rev-parse", "HEAD"), head);
  assert.equal(existsSync(summary(fx)), false);
});

/** Report ночи без чата печатается в журнал после строки «Report: no chat configured». */
const reportOf = (stderr: string) =>
  /Report: no chat configured\n([\s\S]*?)(?:\nmemory-night: |$)/u.exec(
    stderr,
  )?.[1] ?? null;

function reportsOn(fx: Fixture, language: string) {
  writeFileSync(
    join(fx.data, "settings.json"),
    JSON.stringify({ language, memoryReports: { enabled: true } }),
  );
}

const auroraDay = () => [
  A({
    new_cards: [newAurora],
    facts: [
      { card: "Аврора", text: "Проект запущен", src: "e1", quote: "Запустил" },
    ],
  }),
  B({ card: "cards/projects/аврора", truth: "Проект запуска" }),
];

void test("Report ночи: дни с выжимкой уходят швом Notice; без чата текст отчёта — в журнал", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nЗапустил проект Аврора\n");
  writeFileSync(
    join(fx.data, "settings.json"),
    JSON.stringify({ memoryReports: { enabled: true } }),
  );
  fx.model.replies = [A()];
  const result = await night(fx);
  assert.equal(result.code, 0, result.stderr);
  assert.match(
    result.stderr,
    /Report: no chat configured\n[\s\S]*Запущен проект Аврора/u,
  );
});

void test("Report ночи по-русски: 3 строки человеческими словами, без служебных строк и дат ISO", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nЗапустил проект Аврора\n");
  reportsOn(fx, "ru");
  fx.model.replies = auroraDay();
  const result = await night(fx);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(
    reportOf(result.stderr),
    [
      "Ночью я разобрала 1 день памяти.",
      "Новых карточек: 1, дополнено: 0.",
      "26 сентября: Запущен проект Аврора",
    ].join("\n"),
    result.stderr,
  );
});

void test("Report ночи по-английски при language=en", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nЗапустил проект Аврора\n");
  reportsOn(fx, "en");
  fx.model.replies = auroraDay();
  const result = await night(fx);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(
    reportOf(result.stderr),
    [
      "Last night I went through 1 day of memory.",
      "New Cards: 1, updated: 0.",
      "September 26: Запущен проект Аврора",
    ].join("\n"),
    result.stderr,
  );
});

void test("Report ночи с провалом: одна человеческая строка, служебного текста нет", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nПервый день\n", "2026-09-25");
  day(fx, "## 10:00 [text]\nЗапустил проект Аврора\n");
  reportsOn(fx, "ru");
  fx.model.replies = [
    { text: "Не понял задачу" },
    { text: "Вот ответ словами" },
    A(),
  ];
  const result = await night(fx, null);
  assert.equal(result.code, 1, result.stderr);
  const report = reportOf(result.stderr) ?? "";
  assert.equal(
    report,
    [
      "Ночью я разобрала 1 день памяти.",
      "Новых фактов для карточек не было.",
      "26 сентября: Запущен проект Аврора",
      "Не всё получилось: 1 день не разобран, попробую следующей ночью.",
    ].join("\n"),
    result.stderr,
  );
  assert.doesNotMatch(report, /ответ A|не по форме|\d{4}-\d{2}-\d{2}/u);
});

void test("пустая ночь Report не шлёт", async (t) => {
  const fx = await fixture(t);
  reportsOn(fx, "ru");
  const result = await night(fx, null);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(reportOf(result.stderr), null, result.stderr);
  assert.equal(fx.model.prompts.length, 0);
});

void test("занятый дневной замок Card: ночь не пишет Card и ждёт; после освобождения доделывает без второго A (#1)", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nАврора сменила курс\n");
  const file = card(fx, "cards/projects/аврора", aurora);
  const before = read(file);
  fx.model.replies = [
    A({
      facts: [
        {
          card: "cards/projects/аврора",
          text: "Курс сменён",
          src: "e1",
          quote: "Аврора сменила курс",
        },
      ],
    }),
  ];
  // Замок берёт дневной write_card, пока ночь ждёт ответ A.
  const held = fx.model.hold(1);
  const run = spawnNight(fx);
  await held.reached;
  const release = await cs.acquireLock(join(fx.vault, "cards", ".write_card"));
  held.release();
  const busy = await run.result;
  release();
  assert.equal(busy.code, 1);
  assert.match(busy.stderr, /занята/u);
  assert.equal(read(file), before);
  fx.model.replies = [B({ card: "cards/projects/аврора" })];
  const resumed = await night(fx, null);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(fx.model.prompts.length, 2);
  assert.equal(logRows(read(file)).length, 1);
});

// ── Круг 3 ───────────────────────────────────────────────────────────────────────────
void test("пустышка A после отбрасывания: единственный пункт на неизвестную реплику — не выжимка, повтор и no-report", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nЗапустил Аврору\n");
  const empty = A({ gist: "", points: [{ text: "Выдумка", src: "e999" }] });
  fx.model.replies = [empty, empty];
  const result = await night(fx);
  assert.equal(result.code, 1);
  assert.equal(fx.model.prompts.length, 2);
  assert.match(fx.model.prompts[1], /Ошибка прошлого ответа: .*выжимк/u);
  assert.equal(existsSync(summary(fx)), false);
});

void test("коллизия слага с исправной чужой Card: занятое имя — `Имя (D)` и Alert, чужая Card байт в байт", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nВстреча с !!!\n");
  const foreign = card(fx, "cards/contacts/card", [
    "---",
    'type: "contact"',
    "---",
    "# Служебная",
    "",
    "## Log",
    "",
    "## Related",
    "",
  ]);
  const before = read(foreign);
  fx.model.replies = [
    A({
      new_cards: [{ name: "!!!", type: "contact" }],
      facts: [{ card: "!!!", text: "Встреча", src: "e1", quote: "Встреча" }],
    }),
    B(),
  ];
  const result = await night(fx);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(read(foreign), before);
  assert.match(result.stderr, /Похоже на дубль: !!!/u);
  const made = ls(join(fx.vault, "cards/contacts")).split("\n");
  assert.equal(made.length, 2, made.join(", "));
  const fresh = made.find((name) => name !== "card.md")!;
  assert.match(read(join(fx.vault, "cards/contacts", fresh)), /Встреча/u);
});

void test("truth_pending: B этой ночью и при остатке дневной очереди (#r3-4)", async (t) => {
  const fx = await fixture(t);
  const dates = ["2020-01-01", "2020-01-02", "2020-01-03", "2020-01-04"];
  for (const date of dates) day(fx, `## 10:00 [text]\nДень ${date}\n`, date);
  const file = card(fx, "cards/projects/аврора", [
    ...aurora.slice(0, 4),
    'truth_pending: "2020-01-10"',
    ...aurora.slice(4, 12),
    "- 2020-01-10: Курс сменён · [[daily/2020-01-10]] 10:00",
    ...aurora.slice(12),
  ]);
  fx.model.replies = [
    ...dates.slice(0, 3).map((date) => A({ gist: date })),
    B({ card: "cards/projects/аврора", truth: "Курс сменён" }),
  ];
  const result = await night(fx, null);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fx.model.prompts.length, 4);
  assert.match(fx.model.prompts[3], /Курс сменён/u);
  assert.match(read(file), /# Аврора\n\nКурс сменён\n\n## Log/u);
  assert.doesNotMatch(read(file), /truth_pending/u);
  assert.equal(existsSync(summary(fx, dates[3])), false);
});

void test("отказ связи не оставляет новую Card, заведённую только ради неё (второй конец — битый файл)", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nАльфа и Борис\n");
  const broken = card(fx, "cards/contacts/борис", [
    "---",
    'description: "битая кавычка',
    "---",
    "# Борис",
    "",
  ]);
  const before = read(broken);
  fx.model.replies = [
    A({
      new_cards: [
        { name: "Альфа", type: "project" },
        { name: "Борис", type: "contact" },
      ],
      links: [{ a: "Альфа", b: "Борис", src: "e1" }],
    }),
  ];
  const result = await night(fx);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(existsSync(join(fx.vault, "cards/projects/альфа.md")), false);
  assert.equal(read(broken), before);
  assert.match(result.stderr, /связь Альфа ↔ Борис не записана/u);
});

// Alert ночи — на языке владельца (settings.language), как у Brain; дроссель Alert судит
// по сути, а не по тексту: смена языка ту же проблему новой не делает.
void test("Alert ночи на языке владельца, смена языка не повторяет его", async (t) => {
  const fx = await fixture(t);
  const sent = join(fx.data, "telegram-sent.log");
  const double = join(fx.data, "telegram-double.mjs");
  writeFileSync(
    double,
    `import { appendFileSync } from "node:fs";
const real = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (!String(url).includes("api.telegram.org")) return real(url, init);
  appendFileSync(${JSON.stringify(sent)}, String(init?.body ?? "") + "\\n");
  return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
};
`,
  );
  const yesterday = new Date(Date.parse(`${TODAY}T00:00:00Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10);
  writeFileSync(
    join(fx.data, "usage.jsonl"),
    `${JSON.stringify({ ts: `${yesterday}T10:00:00.000Z`, source: "chat" })}\n`,
  );
  const env = {
    TELEGRAM_BOT_TOKEN: "123:abc",
    TELEGRAM_DIGEST_CHAT_ID: "42",
    NODE_OPTIONS: `--import ${double}`,
  };
  const transcriptAlerts = () =>
    existsSync(sent)
      ? readFileSync(sent, "utf8")
          .split("\n")
          .filter((row) => /vault\/daily/u.test(row))
      : [];
  writeFileSync(join(fx.data, "settings.json"), '{"language":"en"}\n');
  const first = await night(fx, null, env);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(transcriptAlerts().length, 1, first.stderr);
  assert.match(transcriptAlerts()[0], /no raw day/u);
  assert.doesNotMatch(transcriptAlerts()[0], /нет сырого дня/u);
  writeFileSync(join(fx.data, "settings.json"), '{"language":"ru"}\n');
  // Тот же день часом позже: каждый процесс стартует с IVA_TEST_NOW, и без сдвига
  // вторая ночь оказалась бы раньше первой отправки.
  const later = new Date(Date.parse(NOW) + 3_600_000).toISOString();
  const second = await night(fx, null, { ...env, IVA_TEST_NOW: later });
  assert.equal(second.code, 0, second.stderr);
  assert.equal(transcriptAlerts().length, 1, "без повтора на другом языке");
});

// Статус, который днём поставил владелец (status_date), ночь этого дня не меняет; статус
// более раннего дня B менять вправе.
void test("B не затирает status, поставленный днём владельцем; ранний статус меняет", async (t) => {
  for (const [statusDate, expected] of [
    [DATE, "done"],
    ["2026-09-20", "active"],
  ] as const) {
    const fx = await fixture(t);
    day(fx, "## 10:00 [text]\nАврора снова в работе?\n");
    const file = card(fx, "cards/projects/аврора", [
      ...aurora.slice(0, 3),
      'status: "done"',
      `status_date: "${statusDate}"`,
      ...aurora.slice(4),
    ]);
    fx.model.replies = [
      A({
        facts: [
          {
            card: "cards/projects/аврора",
            text: "Вопрос о работе",
            src: "e1",
            quote: "Аврора снова в работе",
          },
        ],
      }),
      B({ card: "cards/projects/аврора", status: "active" }),
    ];
    const result = await night(fx);
    assert.equal(result.code, 0, result.stderr);
    assert.match(read(file), new RegExp(`status: "${expected}"`, "u"));
    assert.match(read(file), new RegExp(`status_date: "${statusDate}"`, "u"));
  }
});

// Статус от B сверяется со schema.json vault, как статус дня у write_card: статус вне
// допустимых для типа Card ночь не пишет, статус Card остаётся прежним.
void test("B не пишет статус вне schema.json: статус Card прежний, допустимый ставится", async (t) => {
  for (const [answer, expected] of [
    ["paused", "active"],
    ["выдумка", "active"],
    ["Done", "active"],
    ["done", "done"],
  ] as const) {
    const fx = await fixture(t);
    day(fx, "## 10:00 [text]\nАврора на паузе\n");
    const file = card(fx, "cards/projects/аврора", aurora);
    fx.model.replies = [
      A({
        facts: [
          {
            card: "cards/projects/аврора",
            text: "Проект на паузе",
            src: "e1",
            quote: "Аврора на паузе",
          },
        ],
      }),
      B({ card: "cards/projects/аврора", status: answer }),
    ];
    const result = await night(fx);
    assert.equal(result.code, 0, result.stderr);
    assert.match(read(file), new RegExp(`status: "${expected}"`, "u"), answer);
  }
});

// «Новых карточек» в Report — все Card, созданные за ночь, а не только те, куда лёг факт:
// Card ради связи тоже новая. Card, которая не записалась (связь отвергнута), не считается.
void test("Report ночи считает все созданные за ночь Card, включая Card ради связи", async (t) => {
  const fx = await fixture(t);
  day(fx, "## 10:00 [text]\nАльфа работает со Сбером\n");
  reportsOn(fx, "ru");
  fx.model.replies = [
    A({
      gist: "",
      new_cards: [
        { name: "Альфа", type: "project" },
        { name: "Сбер", type: "contact" },
        { name: "Яндекс", type: "contact" },
      ],
      links: [
        { a: "Альфа", b: "Сбер", src: "e1" },
        { a: "Яндекс", b: "Никто", src: "e1" },
      ],
    }),
  ];
  const result = await night(fx);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(
    ls(join(fx.vault, "cards/contacts")),
    "сбер.md",
    "Card ради отвергнутой связи не пишется",
  );
  assert.match(
    reportOf(result.stderr) ?? "",
    /^Новых карточек: 2, дополнено: 0\.$/mu,
    result.stderr,
  );
});

// Со схемой сверяется точный ответ B, как у write_card днём: " done " в схеме нет и не пишется,
// допустимый статус длиннее 40 символов пишется точно, без обрезки.
void test("B: статус сверяется со схемой точной строкой, длинный допустимый пишется целиком", async (t) => {
  const long = "waiting-for-external-approval-and-vendor-confirmation";
  for (const [answer, expected] of [
    [" done ", "active"],
    [long, long],
  ] as const) {
    const fx = await fixture(t);
    writeFileSync(
      join(fx.vault, "schema.json"),
      JSON.stringify({
        node_types: { project: { status: ["active", "done", long] } },
      }),
    );
    commit(fx.vault, "schema");
    day(fx, "## 10:00 [text]\nАврора ждёт подтверждения\n");
    const file = card(fx, "cards/projects/аврора", aurora);
    fx.model.replies = [
      A({
        facts: [
          {
            card: "cards/projects/аврора",
            text: "Проект ждёт подтверждения",
            src: "e1",
            quote: "Аврора ждёт подтверждения",
          },
        ],
      }),
      B({ card: "cards/projects/аврора", status: answer }),
    ];
    const result = await night(fx);
    assert.equal(result.code, 0, result.stderr);
    assert.match(
      read(file),
      new RegExp(`^status: "${expected}"$`, "mu"),
      JSON.stringify(answer),
    );
  }
});
