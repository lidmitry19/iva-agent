/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registrations. */
// Разрешение идентичности карточки при промахе точного слага: имена каталога держатся в
// индексе, поэтому ночь с десятками НОВЫХ карточек не перечитывает каталог по разу на
// каждую. Индекс обязан ловить чужие правки — карточки пишет не только write_card, но и
// ночной Brain с git pull.

import "./lib/ts-esm-hooks.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { resolveCard, resolveStats } =
  await import("../agent/lib/card-store.ts");

function makeCard(dir: string, slug: string, h1: string): void {
  writeFileSync(
    join(dir, `${slug}.md`),
    `---\ntype: contact\nstatus: active\n---\n# ${h1}\n\nтело\n`,
  );
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cards-resolve-"));
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("промахи по слагу подряд читают каталог один раз, а не по разу на карточку", () => {
  const dir = tempDir();
  for (let i = 0; i < 5; i++) makeCard(dir, `person-${i}`, `Персона ${i}`);

  const before = resolveStats.fileReads;
  assert.equal(resolveCard(dir, "Новая Сущность").matchedBy, "new");
  assert.equal(
    resolveStats.fileReads - before,
    5,
    "первый промах читает каталог",
  );

  const after = resolveStats.fileReads;
  for (let i = 0; i < 10; i++)
    assert.equal(resolveCard(dir, `Ещё Одна ${i}`).matchedBy, "new");
  assert.equal(resolveStats.fileReads - after, 0, "дальше — из индекса");

  // Легаси-слаг всё так же находится по H1, и тоже без чтений.
  const hit = resolveCard(dir, "Персона 3");
  assert.equal(hit.matchedBy, "title");
  assert.ok(hit.file.endsWith("person-3.md"), hit.file);
});

test("правка карточки извне видна: перечитана только она", () => {
  const dir = tempDir();
  makeCard(dir, "yasmin", "Ясмин");
  makeCard(dir, "ivan", "Иван Петров");
  assert.equal(resolveCard(dir, "Ясмин").matchedBy, "title");

  const before = resolveStats.fileReads;
  makeCard(dir, "yasmin", "Ясмин (AI Content Creator)");
  const renamed = resolveCard(dir, "Ясмин (AI Content Creator)");
  assert.equal(resolveStats.fileReads - before, 1, "только изменённая");
  assert.equal(renamed.matchedBy, "title");
  assert.ok(renamed.file.endsWith("yasmin.md"), renamed.file);

  // Голое имя по-прежнему находит квалифицированную карточку — правило не изменилось.
  assert.equal(resolveCard(dir, "Ясмин").matchedBy, "title");
  // А чужой квалификатор — другая сущность.
  assert.equal(resolveCard(dir, "Ясмин (Editor)").matchedBy, "new");
});

// Переименование БЕЗ изменения длины файла: снимок обязан опираться и на mtime, иначе
// такая правка (а «Ясмин» → «Асель» — ровно она) остаётся невидимой, и карточка
// дублируется новым файлом. Отдельный кейс, потому что все остальные правки в этом
// файле меняют размер и сами по себе прошли бы и с проверкой по одному размеру.
test("правка карточки извне той же длины тоже видна", () => {
  const dir = tempDir();
  makeCard(dir, "person", "Ясмин");
  makeCard(dir, "other", "Иван Петров");
  assert.equal(resolveCard(dir, "Ясмин").matchedBy, "title");

  const personPath = join(dir, "person.md");
  const priorMtimeMs = statSync(personPath).mtimeMs;
  makeCard(dir, "person", "Асель"); // те же пять букв → байт в байт тот же размер
  // Некоторые production-файловые системы округляют timestamps до миллисекунды.
  // Явно сдвигаем mtime, чтобы тест проверял заявленный mtime+size контракт, а не
  // случайно требовал обнаружить две неразличимые для stat записи в одном тике.
  const changedAt = new Date(priorMtimeMs + 1_000);
  utimesSync(personPath, changedAt, changedAt);
  assert.equal(
    statSync(personPath).size,
    Buffer.byteLength(
      "---\ntype: contact\nstatus: active\n---\n# Ясмин\n\nтело\n",
    ),
    "фикстура обязана остаться той же длины, иначе кейс ничего не проверяет",
  );

  const found = resolveCard(dir, "Асель");
  assert.equal(found.matchedBy, "title", "новое имя обязано найтись");
  assert.ok(found.file.endsWith("person.md"), found.file);
  // Старого имени в карточке больше нет — иначе слаг-промах увёл бы в дубль.
  assert.equal(resolveCard(dir, "Ясмин").matchedBy, "new");
});

test("карточка, добавленная другим писателем, находится; удалённая — перестаёт", () => {
  const dir = tempDir();
  makeCard(dir, "ivan", "Иван Петров");
  assert.equal(resolveCard(dir, "Ольга Смирнова").matchedBy, "new");

  makeCard(dir, "olga-legacy", "Ольга Смирнова");
  const found = resolveCard(dir, "Ольга Смирнова");
  assert.equal(found.matchedBy, "title");
  assert.ok(found.file.endsWith("olga-legacy.md"), found.file);

  rmSync(join(dir, "olga-legacy.md"));
  assert.equal(resolveCard(dir, "Ольга Смирнова").matchedBy, "new");

  // Удалённая карточка не остаётся в индексе и не считается кандидатом.
  const before = resolveStats.fileReads;
  assert.equal(resolveCard(dir, "Ольга Смирнова").matchedBy, "new");
  assert.equal(resolveStats.fileReads - before, 0);
});

test("два кандидата на одно имя — по-прежнему отказ от записи", () => {
  const dir = tempDir();
  makeCard(dir, "alex-one", "Алекс");
  makeCard(dir, "alex-two", "Алекс");
  const ambiguous = resolveCard(dir, "Алекс");
  assert.equal(ambiguous.matchedBy, "new");
  assert.equal(ambiguous.candidates?.length, 2);
});

// Свойство индекса имён: на ЛЮБОЙ последовательности правок каталога прогретый модуль
// отвечает то же, что модуль с пустым индексом на том же состоянии диска. Эталон — тот
// же код в свежем экземпляре модуля (import с уникальным query-параметром даёт новую
// запись в реестре модулей, значит пустые кэши), поэтому сверяется именно инвалидация.
// Seed фиксирован и печатается при провале.
const SEED = Number(process.env.IVA_TEST_SEED ?? 20260814);

// mulberry32: детерминированный PRNG в четыре строки, без зависимостей.
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("индекс имён не меняет ответ: случайные правки каталога против свежего модуля", async () => {
  const dir = tempDir();
  const random = rng(SEED);
  const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)];
  // Имена нарочно пересекаются: голые, квалифицированные и одинаковые у разных файлов —
  // так в выборку попадают и совпадение по H1, и неоднозначность (два кандидата).
  const names = [
    "Ясмин",
    "Ясмин (AI Content Creator)",
    "Ясмин (Editor)",
    "Иван Петров",
    "Иван",
    "Ольга Смирнова",
  ];
  const slugs = ["one", "two", "three", "four"];

  for (let step = 0; step < 80; step++) {
    const slug = pick(slugs);
    const file = join(dir, `${slug}.md`);
    const op = pick(["create", "rename-h1", "delete"]);
    if (op === "delete") rmSync(file, { force: true });
    else makeCard(dir, slug, pick(names));

    const title = pick(names);
    const warm = resolveCard(dir, title);
    // Свежий экземпляр модуля: тот же код, индекс пуст, каталог тот же.
    const cold = (await import(
      `../agent/lib/card-store.ts?step=${String(step)}`
    )) as typeof import("../agent/lib/card-store.ts");
    assert.deepEqual(
      warm,
      cold.resolveCard(dir, title),
      `шаг ${step} (op=${op}, title="${title}"): индекс разошёлся с чтением с нуля. seed=${SEED}`,
    );
  }
});

test("несуществующий каталог не роняет разрешение", () => {
  const missing = join(tmpdir(), "cards-resolve-missing-нет-такого");
  const id = resolveCard(missing, "Кто-то");
  assert.equal(id.matchedBy, "new");
  assert.ok(id.file.endsWith("кто-то.md"), id.file);
});
