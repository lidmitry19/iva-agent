// Ядро middleware, который прикладывает картинку Vault к сообщению модели. Файлы сюда
// приходят инъекцией (readImage), поэтому тест идёт без файловой системы и без сети.
import test from "node:test";
import assert from "node:assert/strict";

process.env.MODEL_PROVIDER = "ollama";
const { attachImagesMiddleware, attachVaultImages } =
  await import("./provider.ts");
const { MAX_ATTACHED_IMAGES, MAX_IMAGE_BYTES } =
  await import("./lib/attachment-ref.ts");

type Prompt = Parameters<typeof attachVaultImages>[0];
type Message = Prompt[number];
type FilePart = {
  type: "file";
  mediaType: string;
  data: { type: "data"; data: Uint8Array };
};

const BYTES = new Uint8Array([1, 2, 3]);
const readImage = () => BYTES;
const REF = "attachments/2026-08-27/photo-082621.jpg";

function userText(...texts: string[]): Message {
  return {
    role: "user",
    content: texts.map((text) => ({ type: "text" as const, text })),
  };
}

function filesOf(message: Message): FilePart[] {
  const content = (message as { content: { type: string }[] }).content;
  assert.ok(Array.isArray(content));
  return content.filter((part) => part.type === "file") as FilePart[];
}

function muteErrors(t: { after: (fn: () => void) => void }): string[] {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  t.after(() => {
    console.error = original;
  });
  return lines;
}

await test("ссылка в user-сообщении превращается в file-part", () => {
  const [message] = attachVaultImages(
    [userText(`[photo] изображение (vault/${REF}) — приложено.`)],
    { readImage },
  );

  const files = filesOf(message);
  assert.equal(files.length, 1);
  assert.equal(files[0].mediaType, "image/jpeg");
  // filename провайдеры для картинок не читают — его в part нет.
  assert.equal("filename" in files[0], false);
  // Тегированная форма данных — то, что понимает спека провайдера v4.
  assert.deepEqual(files[0].data, { type: "data", data: BYTES });
  // Текст остаётся на месте и идёт ПЕРЕД картинкой.
  const content = (message as { content: { type: string }[] }).content;
  assert.equal(content[0].type, "text");
  assert.equal(content[1].type, "file");
});

await test("две одинаковые ссылки дают одну картинку, две разные — две", () => {
  const [same] = attachVaultImages(
    [userText(`vault/${REF}`, `снова vault/${REF}`)],
    { readImage },
  );
  assert.equal(filesOf(same).length, 1);

  const [both] = attachVaultImages(
    [userText(`vault/${REF} и vault/attachments/2026-08-27/scan.png`)],
    { readImage },
  );
  assert.deepEqual(
    filesOf(both).map((f) => f.mediaType),
    ["image/jpeg", "image/png"],
  );
});

await test("чужие роли не трогаем: ссылка в ответе модели остаётся текстом", () => {
  const assistant: Message = {
    role: "assistant",
    content: [{ type: "text", text: `я сохранил vault/${REF}` }],
  };
  const system: Message = { role: "system", content: `vault/${REF}` };

  const prompt = attachVaultImages([system, assistant], { readImage });

  assert.equal(prompt[0], system);
  assert.equal(prompt[1], assistant);
});

await test("нечитаемый файл: сообщение уходит как было, ход не падает", (t) => {
  const logs = muteErrors(t);
  const message = userText(`vault/${REF}`);

  const prompt = attachVaultImages([message], {
    readImage: () => {
      throw new Error("ENOENT");
    },
  });

  assert.equal(prompt[0], message);
  assert.ok(
    logs.some(
      (line) => line.includes(REF) && line.includes("из Vault не прочитал"),
    ),
  );
});

await test("мусорный промпт не роняет middleware", () => {
  const garbage = [
    { role: "user" },
    { role: "user", content: "строка вместо частей" },
    { role: "user", content: [null, { type: "text" }, { type: "file" }] },
    null,
    "не сообщение",
  ] as unknown as Prompt;

  assert.deepEqual(attachVaultImages([], { readImage }), []);
  assert.deepEqual(attachVaultImages(garbage, { readImage }), garbage);
  assert.equal(
    attachVaultImages(undefined as unknown as Prompt, { readImage }),
    undefined,
  );
});

// Альбом Telegram — до десяти кадров, и каждый lead приезжает своим user-сообщением.
// Счётчик ниже этого числа резал бы кадры ТЕКУЩЕГО хода: ни пикселей, ни описания.
await test("все кадры альбома одного хода едут целиком", () => {
  const refs = [1, 2, 3, 4, 5].map(
    (n) => `attachments/2026-08-27/photo-${n}.jpg`,
  );
  const prompt = attachVaultImages(
    refs.map((ref) => userText(`vault/${ref}`)),
    { readImage },
  );

  assert.deepEqual(
    prompt.map((message) => filesOf(message).length),
    [1, 1, 1, 1, 1],
  );
});

// Потолок реплея: запрос идёт на каждом шаге tool-loop, и без потолка история картинок
// переполняет окно. Едут последние MAX_ATTACHED_IMAGES, отрезанные называют себя.
await test("из истории длиннее потолка едут последние картинки", (t) => {
  const logs = muteErrors(t);
  const refs = Array.from(
    { length: MAX_ATTACHED_IMAGES + 2 },
    (_, n) => `attachments/2026-08-27/photo-${n}.jpg`,
  );
  const prompt = attachVaultImages(
    refs.map((ref) => userText(`vault/${ref}`)),
    { readImage },
  );

  const attached = prompt.flatMap((message, index) =>
    filesOf(message).map(() => refs[index]),
  );
  assert.equal(attached.length, MAX_ATTACHED_IMAGES);
  assert.deepEqual(attached, refs.slice(-MAX_ATTACHED_IMAGES));
  for (const cut of refs.slice(0, 2))
    assert.ok(
      logs.some((line) => line.includes(cut) && line.includes("больше")),
      `отрезанная ${cut} не названа`,
    );
});

await test("повторная ссылка считается свежей, а не первой", () => {
  const old = "attachments/2026-08-21/old.jpg";
  const prompt = attachVaultImages(
    [
      userText(`vault/${old}`),
      userText("attachments/2026-08-22/b.jpg"),
      userText("attachments/2026-08-23/c.jpg"),
      userText("attachments/2026-08-24/d.jpg"),
      userText(`снова vault/${old}`),
    ],
    { readImage },
  );

  assert.equal(filesOf(prompt[0]).length, 0, "старое упоминание не приложено");
  assert.equal(filesOf(prompt[4]).length, 1, "последнее упоминание приложено");
});

await test("картинка сверх потолка не едет, соседняя едет", (t) => {
  const logs = muteErrors(t);
  const huge = "attachments/2026-08-27/huge.png";
  const prompt = attachVaultImages(
    [userText(`vault/${REF}`), userText(`vault/${huge}`)],
    {
      readImage: (path) =>
        path === huge ? new Uint8Array(MAX_IMAGE_BYTES + 1) : BYTES,
    },
  );

  assert.equal(filesOf(prompt[1]).length, 0);
  assert.equal(filesOf(prompt[0]).length, 1);
  assert.ok(logs.some((line) => line.includes("больше потолка")));
});

// Бюджет режет ХВОСТ, а не отдельные картинки: иначе выбор зависел бы от того, чей
// размер удачно совпал с остатком, и «средняя выпала, старая пролезла» никто не объяснит.
await test("на исчерпанном бюджете обрывается весь хвост, а не одна картинка", (t) => {
  const logs = muteErrors(t);
  const big = new Uint8Array(MAX_IMAGE_BYTES);
  const refs = ["a", "b", "c"].map((n) => `attachments/2026-08-27/${n}.jpg`);
  const prompt = attachVaultImages(
    refs.map((ref) => userText(`vault/${ref}`)),
    {
      // Мелкая старая картинка формально влезла бы в остаток — и всё равно не едет.
      readImage: (rel) => (rel === refs[0] ? BYTES : big),
    },
  );

  assert.equal(filesOf(prompt[2]).length, 1, "свежая картинка проходит");
  assert.equal(filesOf(prompt[1]).length, 0, "на вторую бюджета уже нет");
  assert.equal(filesOf(prompt[0]).length, 0, "и всё, что старше, тоже не едет");
  for (const cut of refs.slice(0, 2))
    assert.ok(
      logs.some(
        (line) =>
          line.includes(cut) && line.includes("бюджет картинок исчерпан"),
      ),
      `пропуск ${cut} не назван`,
    );
});

// Ход без картинок не должен будить пробник: он ходит в сеть.
await test("промпт без ссылок уходит нетронутым и без похода в сеть", async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("middleware не должен спрашивать провайдера");
  };
  t.after(() => {
    globalThis.fetch = original;
  });

  const params = {
    prompt: [userText("привет, что там по задачам?")],
  } as unknown as Parameters<
    NonNullable<typeof attachImagesMiddleware.transformParams>
  >[0]["params"];

  const result = await attachImagesMiddleware.transformParams?.({
    type: "generate",
    params,
    model: {} as never,
  });

  assert.equal(result, params);
});
