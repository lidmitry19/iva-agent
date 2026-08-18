// Свойства конвертера Telegram-разметки на случайном тексте. Якоря контракта — в
// telegram-format.test.ts, здесь генератор перебирает то, чего фантазия автора не
// покрывает: цифры вперемешку с пачками пробелов и code-span посреди обычной прозы.
// Ровно на этом ломалась старая метка code-span, а ломалась она молча — текст просто
// не доезжал до чата (ADR-0002).
//
// КАК ВОСПРОИЗВЕСТИ ПАДЕНИЕ: при провале fast-check печатает строку вида
// `Property failed after N tests { seed: -1234567, path: "12:3:0", endOnFailure: true }`.
// Подставь её вторым аргументом — fc.assert(prop, { seed: -1234567, path: "12:3:0" }) —
// и прогон повторится байт в байт, включая shrink.
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { escHtml, htmlToPlain, mdToTelegramHtml } from "./telegram-format.ts";

const SEED = 20_260_818;
const RUNS = 500;

// Алфавит прозы: буквы, цифры и пробелы пачками по 1–4 — ровно то, из чего
// складывалась прежняя метка. Управляющих символов разметки в нём нет, поэтому строка
// гарантированно идёт по ветке обычной строки в convert(): ни фенсом, ни таблицей, ни
// заголовком, ни цитатой, ни списком, ни горизонтальной чертой она стать не может.
const proseUnit = fc.constantFrom(
  ..."abcxyzABCXYZабвэюя0123456789",
  " ",
  "  ",
  "   ",
  "    ",
);
const prose = fc.string({ unit: proseUnit, maxLength: 12 });

// Тело code-span: любой юникод, кроме обратной кавычки (она закрыла бы span раньше
// времени), переводов строки (convert режет вход по строкам ДО inlineHtml) и самих
// символов метки (их inlineHtml срезает на входе).
const codeBody = fc
  .string({ unit: "binary", minLength: 1, maxLength: 24 })
  .filter((body) => !/[`\n\r\uE000\uE001]/.test(body));

await test(`обычная проза переживает конвертацию без потерь (seed ${SEED})`, () => {
  fc.assert(
    fc.property(prose, (text) => {
      // Единственная честная нормализация такой строки — финальный trim() всего
      // вывода в convert(): inlineHtml её не трогает (escHtml нечего экранировать,
      // ни одна inline-регулярка не срабатывает), а htmlToPlain нечего распаковывать.
      // Поэтому сравниваем с text.trim(), а не с text: более сильное утверждение было
      // бы неправдой, более слабое пропустило бы ровно ту потерю, которую ищем.
      assert.equal(htmlToPlain(mdToTelegramHtml(text)), text.trim());
    }),
    { seed: SEED, numRuns: RUNS },
  );
});

await test(`code-span восстанавливается ровно один раз (seed ${SEED})`, () => {
  fc.assert(
    fc.property(prose, prose, codeBody, (before, after, body) => {
      const html = mdToTelegramHtml(`${before}\`${body}\`${after}`);
      const spans = html.match(/<code>[\s\S]*?<\/code>/g) ?? [];

      assert.equal(spans.length, 1);
      assert.equal(spans[0], `<code>${escHtml(body)}</code>`);
      // Проза вокруг span остаётся в тексте. Общий trim() съедает только внешние
      // пробелы всей строки, поэтому сравниваем по обрезанным краям.
      const plain = htmlToPlain(html);
      assert.ok(plain.includes(before.trim()));
      assert.ok(plain.includes(after.trim()));
    }),
    { seed: SEED, numRuns: RUNS },
  );
});
