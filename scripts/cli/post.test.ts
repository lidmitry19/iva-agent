// Тесты `iva post` — порт интеграционных тестов прежнего python-отправщика, только без
// subprocess: офлайновый dry-run, гейт --allow-upload, media-гейт (только настоящие
// картинки/видео из разрешённых корней), allowlist получателей, отсутствие --token.
// Сеть не трогается вообще: отправка, загрузка и чтение .env подставляются зависимостями.
//
// Провал property-теста печатает seed:
// `Property failed after N tests { seed: -1234567, path: "12:3:0", endOnFailure: true }`.
// Подставь его вторым аргументом — fc.assert(prop, { seed: -1234567, path: "12:3:0" }) —
// и провал воспроизводится ровно.
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import fc from "fast-check";
import {
  allowedChats,
  countMedia,
  createPostCommand,
  imageRoots,
  localImageReferences,
  type PostDependencies,
} from "./post.ts";
import { createCliRuntime } from "./runtime.ts";

const PNG_HEADER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const JPEG_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);

type SendResult = { ok: boolean; fellBack: boolean; error: string };

type PostContext = {
  cmdPost: (args?: readonly string[]) => Promise<void>;
  dir: string;
  sent: { chat: string; markdown: string; options: unknown; token: string }[];
  uploaded: string[];
  printed: string[];
  notes: string[];
  messages: string[];
};

// Каталог теста служит и корнем установки, и каталогом данных: media-гейт пускает
// картинки только оттуда, а всё остальное дерево машины для него — «вне корней».
function postCommand(
  t: TestContext,
  env: NodeJS.ProcessEnv = {},
  {
    result = { ok: true, fellBack: false, error: "" },
    stdin = "",
  }: { result?: SendResult; stdin?: string } = {},
): PostContext {
  const dir = mkdtempSync(join(tmpdir(), "iva-post-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const context: PostContext = {
    cmdPost: () => Promise.reject(new Error("not built")),
    dir,
    sent: [],
    uploaded: [],
    printed: [],
    notes: [],
    messages: [],
  };
  const dependencies: PostDependencies = {
    readEnv: () =>
      Promise.resolve({
        ASSISTANT_DATA_DIR: dir,
        TELEGRAM_BOT_TOKEN: "123:FAKE",
        TELEGRAM_ALLOWED_USER_IDS: "111 222",
        TELEGRAM_DIGEST_CHAT_ID: "999",
        ...env,
      }),
    send: (token, chat, markdown, options) => {
      context.sent.push({
        token,
        chat,
        markdown: String(markdown),
        options,
      });
      return Promise.resolve(result);
    },
    upload: (path) => {
      context.uploaded.push(path);
      return Promise.resolve(`https://tmpfiles.org/dl/7/${basename(path)}`);
    },
    readStdin: () => Promise.resolve(stdin),
    print: (text) => context.printed.push(text),
  };
  const base = createCliRuntime(dir);
  context.cmdPost = createPostCommand(
    {
      ...base,
      ok: (message) => context.messages.push(message),
      warn: (message) => context.notes.push(message),
    },
    dependencies,
  );
  return context;
}

function writeMedia(dir: string, name: string, header = PNG_HEADER): string {
  const path = join(dir, name);
  writeFileSync(path, Buffer.concat([header, Buffer.from("x")]));
  return path;
}

void test("dry-run с локальной картинкой офлайнов: перечисляет, но не грузит", async (t) => {
  const post = postCommand(t);
  const image = writeMedia(post.dir, "cover.png");

  await post.cmdPost(["--md", `text ![](file:${image}) more`, "--dry-run"]);

  assert.deepEqual(post.notes, [
    `would upload (with --allow-upload): ${image}`,
  ]);
  assert.deepEqual(post.uploaded, [], "никаких реальных загрузок в dry-run");
  assert.deepEqual(post.sent, [], "dry-run ничего не отправляет");
  assert.deepEqual(
    post.printed,
    [`text ![](file:${image}) more`],
    "markdown печатается без подмены URL",
  );
});

void test("локальная картинка без --allow-upload и без dry-run — отказ с подсказкой", async (t) => {
  const post = postCommand(t);
  const image = writeMedia(post.dir, "cover.jpg", JPEG_HEADER);

  await assert.rejects(
    post.cmdPost(["--md", `![](file:${image})`, "--chat", "111"]),
    (error: Error) => {
      assert.match(error.message, /--allow-upload/u);
      // Пользователь должен видеть, КУДА уйдёт файл.
      assert.match(error.message, /tmpfiles\.org/iu);
      return true;
    },
  );

  assert.deepEqual(post.uploaded, []);
  assert.deepEqual(post.sent, []);
});

void test("не-media файл (например .env) не грузится даже из разрешённого корня", async (t) => {
  const post = postCommand(t);
  const secret = join(post.dir, ".env");
  writeFileSync(secret, "TELEGRAM_BOT_TOKEN=123:SECRET\n");

  await assert.rejects(
    post.cmdPost(["--md", `![](file:${secret})`, "--dry-run"]),
    {
      message: /non-media|dot-path/u,
    },
  );

  assert.deepEqual(post.uploaded, []);
  assert.deepEqual(post.printed, []);
});

void test("чужой --chat вне allowlist — отказ без отправки", async (t) => {
  const post = postCommand(t);

  await assert.rejects(post.cmdPost(["--md", "hello", "--chat", "555000"]), {
    message: /allowlist/u,
  });

  assert.deepEqual(post.sent, []);
});

void test("картинка вне разрешённых корней — отказ (анти-эксфильтрация)", async (t) => {
  const post = postCommand(t);
  const outside = mkdtempSync(join(tmpdir(), "iva-post-outside-"));
  t.after(() => {
    rmSync(outside, { recursive: true, force: true });
  });
  const image = writeMedia(outside, "x.jpg", JPEG_HEADER);

  await assert.rejects(
    post.cmdPost(["--md", `![](file:${image})`, "--dry-run"]),
    {
      message: /allowed roots/u,
    },
  );

  assert.deepEqual(post.uploaded, []);
});

void test("без токена — понятная ошибка ДО каких-либо загрузок (и никакого --token в CLI)", async (t) => {
  const post = postCommand(t, { TELEGRAM_BOT_TOKEN: "" });

  await assert.rejects(post.cmdPost(["--md", "hello", "--chat", "111"]), {
    message: "TELEGRAM_BOT_TOKEN is missing — run: iva config",
  });
  // Флага --token быть не должно — argv виден в ps.
  await assert.rejects(post.cmdPost(["--md", "hello", "--token", "123:FAKE"]), {
    message: /Unknown option: --token/u,
  });

  assert.deepEqual(post.sent, []);
});

void test("порядок: без токена даже --allow-upload не доходит до загрузки", async (t) => {
  const post = postCommand(t, { TELEGRAM_BOT_TOKEN: "" });
  const image = writeMedia(post.dir, "cover.png");

  await assert.rejects(
    post.cmdPost([
      "--md",
      `![](file:${image})`,
      "--chat",
      "111",
      "--allow-upload",
    ]),
    // Валидация конфига обязана идти раньше upload-ветки.
    { message: "TELEGRAM_BOT_TOKEN is missing — run: iva config" },
  );

  assert.deepEqual(
    post.uploaded,
    [],
    "ни одной загрузки при сломанном конфиге",
  );
  assert.deepEqual(post.sent, []);
});

void test("текстовый секрет, переименованный в .png, не проходит magic-гейт", async (t) => {
  const post = postCommand(t);
  const disguised = join(post.dir, "copied-secret.png");
  writeFileSync(disguised, "TELEGRAM_BOT_TOKEN=123:SECRET");

  // Расширение подделать тривиально — заголовок обязан проверяться.
  await assert.rejects(
    post.cmdPost(["--md", `![](file:${disguised})`, "--dry-run"]),
    { message: /magic bytes/u },
  );

  assert.deepEqual(post.uploaded, []);
});

void test("общий лимит 50 медиа считает и удалённые URL", async (t) => {
  const post = postCommand(t);
  const markdown = Array.from(
    { length: 51 },
    (_, index) => `![](https://example.com/${index}.jpg)`,
  ).join(" ");

  await assert.rejects(post.cmdPost(["--md", markdown, "--dry-run"]), {
    message: /too many media/u,
  });

  assert.equal(countMedia(markdown), 51);
});

void test("пост по умолчанию уходит в чат дайджеста через rich-отправку", async (t) => {
  const post = postCommand(t);

  await post.cmdPost(["--md", "# Заголовок\n\nтекст"]);

  assert.deepEqual(post.sent, [
    {
      token: "123:FAKE",
      chat: "999",
      markdown: "# Заголовок\n\nтекст",
      options: { silent: false },
    },
  ]);
  assert.deepEqual(post.messages, ["Rich post sent to 999"]);
});

void test("allowlist-получатель, --silent и --thread-id доходят до отправки", async (t) => {
  const post = postCommand(t, {}, { stdin: "из stdin" });

  await post.cmdPost([
    "--md-file",
    "-",
    "--chat",
    "222",
    "--silent",
    "--thread-id",
    "17",
  ]);

  assert.deepEqual(post.sent, [
    {
      token: "123:FAKE",
      chat: "222",
      markdown: "из stdin",
      options: { silent: true, threadId: "17" },
    },
  ]);
});

void test("с --allow-upload картинка грузится один раз и подменяется публичным URL", async (t) => {
  const post = postCommand(t);
  const image = writeMedia(post.dir, "cover.png");

  await post.cmdPost([
    "--md",
    `начало ![](file:${image} "подпись") конец`,
    "--allow-upload",
  ]);

  // Грузится РАЗРЕШЁННЫЙ реальный путь, а не то, что написано в посте:
  // подмена симлинка после проверки ничего не даёт.
  assert.deepEqual(post.uploaded, [realpathSync(image)]);
  assert.deepEqual(
    post.sent.map((call) => call.markdown),
    ['начало ![](https://tmpfiles.org/dl/7/cover.png "подпись") конец'],
  );
});

void test("отказ Telegram виден как ошибка команды, а не как успех", async (t) => {
  const post = postCommand(
    t,
    {},
    { result: { ok: false, fellBack: false, error: "403: bot was blocked" } },
  );

  await assert.rejects(post.cmdPost(["--md", "текст"]), {
    message: "Telegram send failed: 403: bot was blocked",
  });

  assert.deepEqual(post.messages, []);
});

void test("аргументы: ровно один источник markdown и понятный отказ на пустой флаг", async (t) => {
  const post = postCommand(t);

  for (const args of [
    [] as string[],
    ["--md", "a", "--md-file", "b"],
    ["--dry-run"],
  ])
    await assert.rejects(post.cmdPost(args), {
      message: /Give exactly one of --md or --md-file/u,
    });
  await assert.rejects(post.cmdPost(["--md"]), {
    message: /--md needs a value/u,
  });

  assert.deepEqual(post.sent, []);
});

void test("без чата дайджеста и без --chat отправлять некуда", async (t) => {
  const post = postCommand(t, { TELEGRAM_DIGEST_CHAT_ID: "  " });

  await assert.rejects(post.cmdPost(["--md", "текст"]), {
    message: /No target chat/u,
  });

  assert.deepEqual(post.sent, []);
});

void test("картинка из скрытого каталога — отказ, даже с медийным заголовком", async (t) => {
  const post = postCommand(t);
  mkdirSync(join(post.dir, ".cache"));
  const image = writeMedia(post.dir, ".cache/cover.png");

  await assert.rejects(
    post.cmdPost(["--md", `![](file:${image})`, "--dry-run"]),
    {
      message: /dot-path/u,
    },
  );

  assert.deepEqual(post.uploaded, []);
});

void test("--md-file читает файл, а пропавшая картинка называется по имени", async (t) => {
  const post = postCommand(t);
  const file = join(post.dir, "post.md");
  const missing = join(post.dir, "gone.png");
  writeFileSync(file, `# Пост\n\n![](file:${missing})\n`);

  await assert.rejects(post.cmdPost(["--md-file", file, "--dry-run"]), {
    message: `local image not found: ${missing}`,
  });

  writeFileSync(file, "# Пост\n\nбез картинок\n");
  await post.cmdPost(["--md-file", file]);

  assert.deepEqual(
    post.sent.map((call) => call.markdown),
    ["# Пост\n\nбез картинок\n"],
  );
});

void test("лимит 32768 символов держится и до подстановки URL, и после неё", async (t) => {
  const post = postCommand(t);

  await assert.rejects(
    post.cmdPost(["--md", "я".repeat(32_769), "--dry-run"]),
    {
      message: /rich message too long: 32769 > 32768/u,
    },
  );

  const long = postCommand(t);
  long.cmdPost = createPostCommand(
    {
      ...createCliRuntime(long.dir),
      ok: () => undefined,
      warn: () => undefined,
    },
    {
      readEnv: () =>
        Promise.resolve({
          ASSISTANT_DATA_DIR: long.dir,
          TELEGRAM_BOT_TOKEN: "123:FAKE",
          TELEGRAM_DIGEST_CHAT_ID: "999",
        }),
      send: () => Promise.resolve({ ok: true, fellBack: false, error: "" }),
      // Публичный URL длиннее локального пути — после подстановки пост перерастает лимит.
      upload: () =>
        Promise.resolve(`https://tmpfiles.org/dl/7/${"u".repeat(600)}.png`),
    },
  );
  const image = writeMedia(long.dir, "cover.png");
  const reference = `![](file:${image})`;
  const filler = "я".repeat(32_768 - [...reference].length);

  await assert.rejects(
    long.cmdPost(["--md", `${filler}${reference}`, "--allow-upload"]),
    { message: /rich message too long after image URL substitution/u },
  );
});

// ── property-тесты: пространство входов, а не список случаев ──────────────────

const pathSegment = fc
  .array(fc.constantFrom(..."abzABZ019_-"), { minLength: 1, maxLength: 6 })
  .map((chars) => chars.join(""));

const absolutePath = fc
  .array(pathSegment, { minLength: 1, maxLength: 4 })
  .map((parts) => `/${parts.join("/")}`);

const mediaName = fc
  .tuple(pathSegment, fc.constantFrom("png", "jpg", "mp4", "ogg"))
  .map(([stem, extension]) => `${stem}.${extension}`);

void test("PBT: разбор ссылок на картинки видит каждую локальную и считает все медиа", () => {
  fc.assert(
    fc.property(
      fc.array(fc.tuple(absolutePath, mediaName), { maxLength: 6 }),
      fc.array(fc.webUrl(), { maxLength: 6 }),
      fc.array(fc.constantFrom("", "\n\n", " текст ", "**жирный**"), {
        maxLength: 8,
      }),
      (locals, remotes, filler) => {
        const localPaths = locals.map(([directory, name]) =>
          `${directory}/${name}`.replaceAll("//", "/"),
        );
        const parts = [
          ...localPaths.map((path) => `![](file:${path} "cap")`),
          ...remotes.map((url) => `![](${url})`),
        ];
        const markdown = parts
          .map((part, index) => `${filler[index % filler.length] ?? ""}${part}`)
          .join("\n");

        assert.deepEqual(localImageReferences(markdown), localPaths);
        assert.equal(countMedia(markdown), localPaths.length + remotes.length);
      },
    ),
    { seed: 18_817, numRuns: 500 },
  );
});

void test("PBT: allowlist разбирается по любым разделителям и не пускает чужого", () => {
  const identifier = fc
    .array(fc.constantFrom(..."0123456789"), { minLength: 1, maxLength: 10 })
    .map((digits) => digits.join(""));
  fc.assert(
    fc.property(
      fc.array(identifier, { maxLength: 6 }),
      fc.array(fc.constantFrom(",", " ", "\t", ", ", "  ", ",,"), {
        minLength: 6,
        maxLength: 6,
      }),
      identifier,
      identifier,
      (ids, separators, digest, outsider) => {
        const raw = ids
          .map(
            (id, index) => `${index === 0 ? "" : separators[index % 6]}${id}`,
          )
          .join("");
        const allowed = allowedChats({
          TELEGRAM_ALLOWED_USER_IDS: raw,
          TELEGRAM_DIGEST_CHAT_ID: digest,
        });

        assert.deepEqual(
          [...allowed].sort(),
          [...new Set([...ids, digest])].sort(),
        );
        assert.equal(allowed.has(""), false, "пустая строка не получатель");
        assert.equal(
          allowed.has(outsider),
          ids.includes(outsider) || outsider === digest,
        );
      },
    ),
    { seed: 18_817, numRuns: 500 },
  );
});

void test("PBT: корни картинок всегда абсолютны и ведут через канонический резолвер", () => {
  fc.assert(
    // Корень заведомо несуществующий: физический путь тогда равен лексическому, и
    // свойство говорит про резолвер, а не про симлинки конкретной машины.
    fc.property(fc.string(), (configured) => {
      const root = "/iva-post-pbt/root";
      const roots = imageRoots(root, { ASSISTANT_DATA_DIR: configured });
      assert.equal(roots.length, 2);
      assert.equal(roots[0], root);
      assert.equal(
        roots[1],
        resolve(root, configured.trim() || "data"),
        "каталог данных резолвится ровно как у остальных процессов Ивы",
      );
    }),
    { seed: 18_817, numRuns: 300 },
  );
});
