/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registration promises. */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// settings.ts берёт каталог данных из окружения на импорте — задаём ДО загрузки экрана,
// чтобы тумблер не тронул настоящий data/ (тот же приём, что в lang.test.ts).
const dataDir = mkdtempSync(join(tmpdir(), "iva-menu-notices-"));
process.env.ASSISTANT_DATA_DIR = dataDir;

const loaded: unknown = await import(
  new URL("./notices.ts", import.meta.url).href
);
if (typeof loaded !== "object" || loaded === null || !("default" in loaded))
  throw new Error("notices menu has no default screen");
const screen = loaded.default as Screen;

after(() => rmSync(dataDir, { recursive: true, force: true }));

type View = { text: string };
type MenuState = { page: number };
type MenuContext = {
  tr: (english: string, russian: string) => string;
  show: (state: MenuState, screenId: string) => Promise<void>;
};
type Screen = {
  parent: string;
  render: (state: MenuState, context: MenuContext) => View;
  on: (
    verb: string,
    args: string[],
    state: MenuState,
    context: MenuContext,
  ) => Promise<void>;
};

const settingsPath = join(dataDir, "settings.json");

function writeSettingsFile(settings: Record<string, unknown>): void {
  writeFileSync(settingsPath, JSON.stringify(settings));
}

function readSettingsFile(): Record<string, unknown> {
  return JSON.parse(readFileSync(settingsPath, "utf8")) as Record<
    string,
    unknown
  >;
}

function makeContext(lang: string, redrawn: string[] = []): MenuContext {
  return {
    tr: (english, russian) => (lang === "ru" ? russian : english),
    show: (_state, screenId) => {
      redrawn.push(screenId);
      return Promise.resolve();
    },
  };
}

// Кнопка — тег в markdown: подпись и data достаём из строки.
const buttonsOf = (text: string): Array<[string, string]> =>
  [
    ...text.matchAll(
      /<tg-button[^>]*data="([^"]+)"[^>]*>([^<]*)<\/tg-button>/g,
    ),
  ].map((match) => [match[2], match[1]] as [string, string]);

const labels = (view: View) => buttonsOf(view.text);

test("reports render off and Watch on on a fresh installation, in either language", () => {
  rmSync(settingsPath, { force: true });

  const russian = screen.render({ page: 3 }, makeContext("ru"));
  assert.match(russian.text, /🔔 Уведомления/);
  assert.match(
    russian.text,
    /Алерты — о проблемах и обновлениях — приходят всегда/,
  );
  assert.deepEqual(labels(russian), [
    ["○ Отчёты памяти", "iva_menu:ntc:set:rep:1"],
    ["✓ Сама пишет", "iva_menu:ntc:set:pro:0"],
    ["‹ Меню", "iva_menu:r:o"],
  ]);
  assert.match(
    russian.text,
    /Присмотр за пропущенным и обзор дня\. О сбоях пишу всегда\./,
  );
  // Строка дайджеста ушла: её место — времена Brief из настроек.
  assert.match(russian.text, /Обзор дня: 08:30 и 14:00/u);
  assert.doesNotMatch(russian.text, /дайджест/iu);

  const english = screen.render({ page: 0 }, makeContext("en"));
  assert.match(english.text, /🔔 Notices/);
  assert.match(english.text, /Alerts — problems and updates — always arrive/);
  assert.deepEqual(labels(english), [
    ["○ Memory reports", "iva_menu:ntc:set:rep:1"],
    ["✓ Writes on her own", "iva_menu:ntc:set:pro:0"],
    ["‹ Menu", "iva_menu:r:o"],
  ]);
  assert.match(
    english.text,
    /Watch for missed items and the daily brief\. Failures are always reported\./,
  );
  assert.match(english.text, /Daily brief: 08:30 and 14:00/u);
  assert.doesNotMatch(english.text, /digest/iu);
  assert.equal(screen.parent, "r");
});

test("a switched-on toggle is ticked and offers the way back off", () => {
  writeSettingsFile({
    memoryReports: { enabled: true },
    // Не больше двух Brief в сутки: три времени — уже значение по умолчанию.
    proactive: { enabled: false, briefTimes: ["09:00", "18:00"] },
  });

  const view = screen.render({ page: 0 }, makeContext("ru"));
  assert.deepEqual(labels(view), [
    ["✓ Отчёты памяти", "iva_menu:ntc:set:rep:0"],
    ["○ Сама пишет", "iva_menu:ntc:set:pro:1"],
    ["‹ Меню", "iva_menu:r:o"],
  ]);
  assert.match(view.text, /Обзор дня: 09:00 и 18:00/u);
});

test("a tap on the old digest toggle from a stale screen changes nothing", async () => {
  writeSettingsFile({ language: "en" });
  const redrawn: string[] = [];
  await screen.on("set", ["dig", "1"], { page: 0 }, makeContext("ru", redrawn));
  assert.deepEqual(readSettingsFile(), { language: "en" });
  assert.deepEqual(redrawn, []);
});

test("a toggle writes its own key and leaves the neighbours alone", async () => {
  // Соседи двух видов: чужой ключ верхнего уровня (язык, второй тумблер) и сосед ВНУТРИ
  // того же объекта. Второго сегодня в коде нет — и потому он здесь: тумблер обязан патчить
  // вложенный объект целиком, а не переписывать его одним своим полем.
  writeSettingsFile({
    language: "en",
    memoryReports: { enabled: false, chatId: "123" },
  });
  const redrawn: string[] = [];
  const context = makeContext("ru", redrawn);

  await screen.on("set", ["rep", "1"], { page: 4 }, context);

  assert.deepEqual(readSettingsFile(), {
    language: "en",
    memoryReports: { enabled: true, chatId: "123" },
  });
  assert.deepEqual(redrawn, ["ntc"], "the screen redraws itself, not the root");
});

test("«Сама пишет» writes proactive.enabled and keeps the Watch settings beside it", async () => {
  writeSettingsFile({
    language: "en",
    proactive: { watchCapPerDay: 3, urgentSenders: ["wife"] },
  });
  await screen.on("set", ["pro", "0"], { page: 0 }, makeContext("ru"));
  assert.deepEqual(readSettingsFile(), {
    language: "en",
    proactive: { watchCapPerDay: 3, urgentSenders: ["wife"], enabled: false },
  });
  await screen.on("set", ["pro", "1"], { page: 0 }, makeContext("ru"));
  assert.equal(
    (readSettingsFile().proactive as { enabled?: unknown }).enabled,
    true,
  );
});

test("a stale tap sets the value it carries instead of flipping twice", async () => {
  writeSettingsFile({ memoryReports: { enabled: true } });
  const context = makeContext("ru");

  await screen.on("set", ["rep", "1"], { page: 0 }, context);
  await screen.on("set", ["rep", "1"], { page: 0 }, context);

  assert.deepEqual(readSettingsFile(), { memoryReports: { enabled: true } });
});

test("junk callback arguments change nothing and throw nothing", async () => {
  writeSettingsFile({ memoryReports: { enabled: true } });
  const before = readSettingsFile();
  const redrawn: string[] = [];
  const context = makeContext("en", redrawn);

  for (const args of [
    [],
    [""],
    ["rep"],
    ["rep", ""],
    ["rep", "true"],
    ["rep", "yes", "please"],
    ["REP", "1"],
    ["dig", "2"],
    ["toString", "1"],
    ["constructor", "1"],
    ["__proto__", "1"],
    ["hasOwnProperty", "0"],
  ])
    await screen.on("set", args, { page: 0 }, context);
  // Неизвестный верб тоже ничего не делает.
  await screen.on("rf", ["rep", "1"], { page: 0 }, context);

  assert.deepEqual(readSettingsFile(), before);
  assert.deepEqual(redrawn, [], "a junk tap redraws nothing");
});

test("corrupt settings render safely but a toggle refuses to replace their bytes", async () => {
  for (const corrupt of ["", "{ not json", "null", "[]", '"ru"', "42"]) {
    writeFileSync(settingsPath, corrupt);
    const view = screen.render({ page: 0 }, makeContext("en"));
    assert.deepEqual(labels(view)[0], [
      "○ Memory reports",
      "iva_menu:ntc:set:rep:1",
    ]);
    await assert.rejects(
      screen.on("set", ["rep", "1"], { page: 0 }, makeContext("en")),
      (error: unknown) =>
        (error as { code?: unknown; state?: unknown }).code ===
          "ESETTINGS_WRITE_REFUSED" &&
        (error as { state?: unknown }).state === "corrupt",
    );
    assert.equal(readFileSync(settingsPath, "utf8"), corrupt);
  }
});
