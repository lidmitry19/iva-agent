// Что нового в предлагаемом релизе — для ежедневного Alert'а «доступна новая версия».
// Источник один и уже существующий: секция What's New / Что нового в README.md и
// README.ru.md, которую владелец пишет каждый релиз на обоих языках. Второго списка
// новостей проект не заводит: дрейф доки чинится правкой доки, а не кодом поверх неё
// (docs/philosophy.md §5), поэтому сторож формата живёт в тесте, а не в рантайме.
//
// Формат одного пункта — конвенция релиза, её сторожит `scripts/whats-new.test.ts`:
//   - 🔁 **Заголовок**: остальной текст
// Заголовок вместе с эмодзи и есть то, что читает владелец в чате. Старый текст без
// эмодзи и без жирного парсится тем же кодом: тогда заголовком считается всё до первого
// двоеточия — так эта секция выглядела до появления конвенции.
//
// Разметку читаем построчно: HTML-парсер ради `<details>` — лишняя трущаяся деталь.
import { compareStableVersions } from "./update-check.ts";

export type WhatsNewEntry = { version: string; headlines: string[] };
export type WhatsNewSelection = {
  versions: WhatsNewEntry[];
  truncated: boolean;
};

/** Полный список релизов — одна ссылка на все места, где Iva о них говорит. */
export const RELEASE_NOTES_URL = "https://github.com/smixs/iva-agent/releases";

/** Потолок блока в знаках: Alert обязан читаться в чате, а не быть простынёй. */
export const WHATS_NEW_BUDGET = 1500;

const VERSION_HEADING = /^####\s+v(\d+\.\d+\.\d+)\s*$/;
const ANY_HEADING = /^#{1,6}\s/;
const BULLET = /^-\s+(.+)$/;
const BOLD_HEADLINE = /^([^*]*)\*\*([^*].*?)\*\*/;
const MARKDOWN_LINK = /\[([^\]]*)\]\([^)]*\)/g;

function tidy(value: string): string {
  return value.replaceAll("**", "").replace(/\s+/g, " ").trim();
}

/**
 * Заголовок пункта: эмодзи плюс жирный текст. Без жирного берётся текст до первого
 * двоеточия, без двоеточия — весь пункт: выдумывать заголовок нельзя, а потерять
 * новость релиза — тем более.
 */
function bulletHeadline(body: string): string {
  const text = body.trim();
  const bold = BOLD_HEADLINE.exec(text);
  if (bold) return tidy(`${bold[1]} ${bold[2]}`);
  const colon = text.indexOf(":");
  return tidy(colon === -1 ? text : text.slice(0, colon));
}

/**
 * Все блоки `#### vX.Y.Z` секции What's New с заголовками их пунктов. Мусор на входе —
 * пустой список, никогда исключение: блок новостей украшает Notice, а не решает, уйдёт
 * ли он вообще.
 */
export function parseWhatsNew(readmeText: string): WhatsNewEntry[] {
  if (typeof readmeText !== "string") return [];
  const entries: WhatsNewEntry[] = [];
  let current: WhatsNewEntry | null = null;
  for (const raw of readmeText.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const heading = VERSION_HEADING.exec(line);
    if (heading) {
      current = { version: heading[1], headlines: [] };
      entries.push(current);
      continue;
    }
    // Любой другой заголовок и конец `<details>` закрывают блок: список за его границей
    // принадлежит другому разделу, и приписать его релизу — то же выдумывание.
    if (ANY_HEADING.test(line) || line.trimStart().startsWith("</details>")) {
      current = null;
      continue;
    }
    if (!current) continue;
    const bullet = BULLET.exec(line);
    if (!bullet) continue;
    const headline = bulletHeadline(bullet[1]);
    if (headline) current.headlines.push(headline);
  }
  return entries.filter((entry) => entry.headlines.length > 0);
}

/**
 * Что нового между установленным и предлагаемым релизом: новее установленного, не новее
 * предлагаемого, сверху самый свежий. `truncated` — README помнит только последние три
 * даты, и установка старше самой старой записи не увидит всего.
 */
export function whatsNewBetween(
  entries: readonly WhatsNewEntry[],
  installedVersion: string | null | undefined,
  targetVersion: string | null | undefined,
): WhatsNewSelection {
  const given: readonly WhatsNewEntry[] = Array.isArray(entries) ? entries : [];
  const usable = given.filter(
    (entry) =>
      Array.isArray(entry?.headlines) &&
      compareStableVersions(entry.version, targetVersion) !== null,
  );
  if (usable.length === 0) return { versions: [], truncated: false };

  const versions = usable
    .filter(
      (entry) =>
        compareStableVersions(installedVersion, entry.version) === 1 &&
        compareStableVersions(entry.version, targetVersion) !== -1,
    )
    // Сверху самый свежий: компаратор отдаёт 1, когда `other` новее `one`, — значит
    // `one` уходит вниз.
    .sort(
      (one, other) => compareStableVersions(one.version, other.version) ?? 0,
    );
  const oldest = usable.reduce((least, entry) =>
    compareStableVersions(least.version, entry.version) === -1 ? entry : least,
  );
  return {
    versions,
    truncated: compareStableVersions(installedVersion, oldest.version) === 1,
  };
}

/**
 * Один пункт в том виде, в каком он уходит в Telegram. Notice об обновлении шлётся БЕЗ
 * parse_mode (`sendUpdateOffer`), поэтому маркеры markdown из README — бэктики, звёздочки
 * и ссылки — снимаются здесь: сломать сообщение они не могут, но и читать их владельцу
 * незачем. Одиночная `*` остаётся: в заголовке это содержимое (`OnCalendar=*-*-*`), а не
 * разметка.
 */
function plainHeadline(headline: string): string {
  return headline
    .replace(MARKDOWN_LINK, "$1")
    .replaceAll("**", "")
    .replaceAll("`", "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Блок для текста Notice: версия, под ней её заголовки, в конце ссылка на полный список.
 * Потолок режет целыми версиями — обрезанный на середине заголовок хуже отсутствующего.
 * Пустой выбор даёт пустую строку: Notice уходит без блока, как будто его и не просили.
 */
export function formatWhatsNew(
  result: WhatsNewSelection,
  locale = "en",
  releaseUrlBase: string = RELEASE_NOTES_URL,
): string {
  const versions = result?.versions ?? [];
  if (versions.length === 0) return "";
  const ru = locale === "ru";
  const head = ru ? "Что нового:" : "What's new:";
  const link = `${ru ? "Полный список:" : "Full list:"} ${releaseUrlBase}`;
  const lines = [head];
  let used = head.length + link.length + 2;
  for (const entry of versions) {
    const block = [
      `v${entry.version}`,
      ...entry.headlines.map((headline) => `• ${plainHeadline(headline)}`),
    ];
    const cost = block.reduce((sum, line) => sum + line.length + 1, 0);
    if (used + cost > WHATS_NEW_BUDGET) break;
    lines.push(...block);
    used += cost;
  }
  lines.push(link);
  return lines.join("\n");
}
