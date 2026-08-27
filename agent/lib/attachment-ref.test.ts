// Маркер картинки в тексте хода. Якоря ниже — реальные формы, в которых путь приезжает
// в промпт: lead медиа-шага, Obsidian-эмбед дневного файла и путь, написанный владельцем
// руками. Генератор перебирает то, что руками не перечислить: имена по правилам saveBlob
// и произвольные обёртки вокруг пути.
//
// КАК ВОСПРОИЗВЕСТИ ПАДЕНИЕ: при провале fast-check печатает строку вида
// `Property failed after N tests { seed: -1234567, path: "12:3:0", endOnFailure: true }`.
// Подставь её вторым аргументом — fc.assert(prop, { seed: -1234567, path: "12:3:0" }) —
// и прогон повторится байт в байт, включая shrink.
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { imageMediaType, imageRefsIn } from "./attachment-ref.ts";

const SEED = 20_260_827;
const RUNS = 400;

await test("lead медиа-шага отдаёт rel-путь без префикса vault", () => {
  assert.deepEqual(
    imageRefsIn(
      "[photo] изображение (vault/attachments/2026-08-27/photo-082621.jpg). Что на нём: доска.",
    ),
    ["attachments/2026-08-27/photo-082621.jpg"],
  );
});

await test("абсолютный ASSISTANT_VAULT_DIR тоже срезается", () => {
  assert.deepEqual(
    imageRefsIn("/srv/iva/vault/attachments/2026-01-02/photo-000001.png"),
    ["attachments/2026-01-02/photo-000001.png"],
  );
});

await test("Obsidian-эмбед и путь, написанный руками", () => {
  assert.deepEqual(imageRefsIn("![[attachments/2026-08-27/scan.webp]]"), [
    "attachments/2026-08-27/scan.webp",
  ]);
  assert.deepEqual(
    imageRefsIn("глянь attachments/2026-08-27/чек.gif, там сумма"),
    [],
    "кириллица в имени saveBlob не оставляет — и мы её не ищем",
  );
  assert.deepEqual(imageRefsIn("глянь attachments/2026-08-27/check.gif!"), [
    "attachments/2026-08-27/check.gif",
  ]);
});

await test("две одинаковые ссылки дают один путь, порядок сохраняется", () => {
  assert.deepEqual(
    imageRefsIn(
      "vault/attachments/2026-08-27/a.jpg и vault/attachments/2026-08-27/b.png и снова a: vault/attachments/2026-08-27/a.jpg",
    ),
    ["attachments/2026-08-27/a.jpg", "attachments/2026-08-27/b.png"],
  );
});

await test("не ссылка: чужое слово, не картинка, не дата", () => {
  assert.deepEqual(imageRefsIn("myattachments/2026-08-27/photo.jpg"), []);
  assert.deepEqual(imageRefsIn("attachments/2026-08-27/report.pdf"), []);
  assert.deepEqual(imageRefsIn("attachments/2026-08-27/clip.mp4"), []);
  assert.deepEqual(imageRefsIn("attachments/august/photo.jpg"), []);
  assert.deepEqual(imageRefsIn("attachments/2026-08-27/photo.jpg.txt"), []);
  assert.deepEqual(imageRefsIn(""), []);
});

await test("mediaType берётся из суффикса имени файла, чужой суффикс — undefined", () => {
  assert.equal(imageMediaType("attachments/2026-08-27/a.jpg"), "image/jpeg");
  assert.equal(imageMediaType("attachments/2026-08-27/a.jpeg"), "image/jpeg");
  assert.equal(imageMediaType("attachments/2026-08-27/a.PNG"), "image/png");
  assert.equal(imageMediaType("attachments/2026-08-27/a.webp"), "image/webp");
  assert.equal(imageMediaType("attachments/2026-08-27/a.gif"), "image/gif");
  assert.equal(imageMediaType("attachments/2026-08-27/a.pdf"), undefined);
  assert.equal(imageMediaType("noext"), undefined);
});

// --- Генераторы по правилам saveBlob (vault-daily.ts) ---------------------------------------
const two = (n: number) => String(n).padStart(2, "0");
const date = fc
  .tuple(
    fc.integer({ min: 1970, max: 2999 }),
    fc.integer({ min: 1, max: 12 }),
    fc.integer({ min: 1, max: 28 }),
  )
  .map(([y, m, d]) => `${y}-${two(m)}-${two(d)}`);
// Имя файла saveBlob: нижний регистр, [a-z0-9._-], без ведущих `-`/`.` и хвостовых `-`.
const stem = fc
  .string({
    unit: fc.constantFrom(..."abcxyz0189", ".", "_", "-"),
    minLength: 1,
    maxLength: 20,
  })
  .map((s) => `a${s}`.replace(/-+$/u, "a"));
const extension = fc.constantFrom("jpg", "jpeg", "png", "webp", "gif");
const rel = fc
  .tuple(date, stem, extension)
  .map(([d, name, ext]) => `attachments/${d}/${name}.${ext}`);

// Обёртка вокруг пути: слева всё, что кончается не буквой (префикс vault-каталога,
// скобка, двоеточие), справа — всё, что начинается с разделителя. Продолжение имени
// справа было бы уже другим путём, а не обёрткой.
const before = fc.constantFrom(
  "",
  "vault/",
  "/srv/iva/vault/",
  "[photo] изображение (",
  "смотри: ",
  "![[",
  "…/",
);
const after = fc.constantFrom(
  "",
  ")",
  "]]",
  ". Что на нём: доска.",
  " ",
  ",\n",
);

await test(`любая обёртка вокруг пути отдаёт этот же путь (seed ${SEED})`, () => {
  fc.assert(
    fc.property(rel, before, after, (path, head, tail) => {
      assert.deepEqual(imageRefsIn(`${head}${path}${tail}`), [path]);
    }),
    { seed: SEED, numRuns: RUNS },
  );
});

await test(`на мусоре не падает и не выдумывает путей (seed ${SEED})`, () => {
  fc.assert(
    fc.property(fc.string({ unit: "binary", maxLength: 200 }), (text) => {
      const refs = imageRefsIn(text);
      assert.ok(Array.isArray(refs));
      for (const ref of refs) {
        assert.ok(text.includes(ref), `путь не из текста: ${ref}`);
        assert.ok(imageMediaType(ref), `путь без mediaType: ${ref}`);
      }
    }),
    { seed: SEED, numRuns: RUNS },
  );
});

await test(`текст без ссылок даёт пустой список (seed ${SEED})`, () => {
  fc.assert(
    fc.property(
      fc
        .string({ unit: "binary", maxLength: 200 })
        .filter((text) => !/attachments\//iu.test(text)),
      (text) => {
        assert.deepEqual(imageRefsIn(text), []);
      },
    ),
    { seed: SEED, numRuns: RUNS },
  );
});
