// Гвард T2: свои таймеры и отправки в Telegram из bash режем до exec. Судим позиции
// commandPositions (self-restart-guard.ts) — кавычки/экранирование/обёртки уже сняты.
// Прямые списки: команды (BAN_COMMANDS), пути, читатели. Аргументы разбираем только там,
// где иначе нельзя: `crontab -l`, глаголы systemctl, `sed -i`, длительности sleep.
// Намеренно не блокируем: чтение (`crontab -l`, `systemctl status`, `journalctl`,
// `list-timers`, `daemon-reload`), юниты `iva*` (рестарт моста/таймеров не убивает агента),
// обвязку сна (`wait`, `done`, `:`, второй sleep). Принятое ложное срабатывание:
// `grep … > /tmp/out` (вывод в файл — отдельной командой). Deterrence, не граница.
import { commandSegments, type CommandPosition } from "./self-restart-guard.ts";

const WHAT = {
  SYSTEMD_RUN: "systemd-run: свой таймер",
  CRONTAB: "crontab: запись расписания",
  AT_BATCH: "at/batch: отложенный запуск",
  SYSTEMCTL: "systemctl: запуск или включение своего юнита",
  UNIT_DIR: "запись в ~/.config/systemd/user",
  SCRIPTS_DIR: "~/.iva-scripts: свой скрипт",
  TELEGRAM_HOST: "прямой вызов api.telegram.org",
  SLEEP: "sleep как таймер перед следующей командой",
} as const;
/** Прямой список запрещённых имён: ключ — имя, значение — текст отказа. */
const BAN_COMMANDS: Record<string, string> = {
  "systemd-run": WHAT.SYSTEMD_RUN,
  crontab: WHAT.CRONTAB,
  at: WHAT.AT_BATCH,
  batch: WHAT.AT_BATCH,
};
const UNIT_DIR = /systemd\/user(?![\w-])/;
const SCRIPTS_DIR = /\.iva-scripts(?![\w-])/;
const TELEGRAM_HOST = /api\.telegram\.org/;
// Чтение — единственный способ упомянуть запретное в командной позиции. `sed -i` пишет,
// поэтому читателем не считается; перенаправление вывода в файл — тоже запись.
const READERS = new Set(
  "grep egrep fgrep rg cat head tail less more awk wc diff git jq find fd ls stat file echo printf sed".split(
    " ",
  ),
);
// Летальные глаголы systemctl и чтение crontab — то немногое, что нужно разобрать
// по аргументам, а не по одному regexp.
const SYSTEMCTL_LETHAL_VERBS = new Set(
  "start restart reload-or-restart enable reenable link edit".split(" "),
);
const CRONTAB_LIST = /(?:^|\s)-l(?:\s|$)/;
const SED_IN_PLACE = /(?:^|\s)-i/;
const SLEEP_UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86_400 };
const SLEEP_THRESHOLD_SECONDS = 60;
// Что НЕ делает следующий sleep таймером: управляющие слова, ожидание фонового
// задания, проверка условия, второй sleep, no-op и обрывки редиректов. `exec sleep 3600
// & wait` и `while [ ! -s pid ]; do sleep 0.01; done` — обвязка вокруг самого сна,
// а не отложенная команда; судить нечего. Фоновые формы T2 не трогает вовсе.
const NOT_A_PAYLOAD = new Set(
  "wait done fi then else do : true false test exit".split(" "),
);
// Командное слово, а не хвост `2>`/`1`, который оставил разделитель `&`. `$` в начале —
// форма из промпта (`$HOME/.local/bin/iva`), присваивания (`TZ=UTC iva notify x`) снимаются
// до проверки: непонятная нагрузка после длинного sleep — это блок, а не пропуск.
const COMMAND_WORD = /^[$A-Za-z_./~][\w./~$-]*$/;
const ASSIGNMENT = /^\w+=/;

// Матч по началу сегмента: путь до бинаря допустим (`/usr/bin/systemd-run` — тот же
// вызов), а приклеенный редирект (`crontab>/dev/null`) — тоже вызов, а не промах:
// после имени разрешён любой не-словный символ.
const anchored = (name: string): RegExp =>
  new RegExp(`^(?:[\\w./~-]*\\/)?${name}(?![\\w-])`);

function tokens(segment: string): string[] {
  return segment.split(/\s+/).filter(Boolean);
}

// Запись — это `>` не перед /dev/null и не перед dup'ом файлового дескриптора (2>&1).
function writesToFile(segment: string): boolean {
  for (const match of segment.matchAll(/>/g)) {
    const rest = segment.slice((match.index ?? 0) + 1);
    if (/^&[0-9]/.test(rest)) continue;
    if (/^\s*\/dev\/null(?![\w./-])/.test(rest)) continue;
    return true;
  }
  return false;
}

function isReader(segment: string): boolean {
  const first = tokens(segment)[0] ?? "";
  const name = first.slice(first.lastIndexOf("/") + 1);
  if (!READERS.has(name)) return false;
  if (name === "sed" && SED_IN_PLACE.test(segment)) return false;
  return !writesToFile(segment);
}

function systemctlTouchesForeignUnit(segment: string): boolean {
  const parts = tokens(segment).slice(1);
  const lethal =
    parts.some((part) => SYSTEMCTL_LETHAL_VERBS.has(part)) ||
    parts.includes("--now");
  if (!lethal) return false;
  const units = parts.filter(
    (part) =>
      !part.startsWith("-") &&
      !part.includes("=") &&
      !SYSTEMCTL_LETHAL_VERBS.has(part),
  );
  return units.length > 0 && units.some((unit) => !unit.startsWith("iva"));
}

// Сумма длительностей sleep. Неразбираемый аргумент (`$DELAY`) считается длинным: правило
// не должно зависеть от значения переменной, которую модель подставит в рантайме.
function sleepSeconds(segment: string): number {
  let total = 0;
  for (const token of tokens(segment).slice(1)) {
    if (token.startsWith("-")) continue;
    const match = /^(\d+(?:\.\d+)?)([smhd]?)$/.exec(token);
    if (!match) return Number.POSITIVE_INFINITY;
    total += Number(match[1]) * (SLEEP_UNITS[match[2] || "s"] ?? 1);
  }
  return total;
}

function carriesPayload(segment: string): boolean {
  const first =
    tokens(segment).filter((token) => !ASSIGNMENT.test(token))[0] ?? "";
  if (!COMMAND_WORD.test(first)) return false;
  if (anchored("sleep").test(segment)) return false;
  return !NOT_A_PAYLOAD.has(first);
}

// Правило одной командной позиции. Ранние ветви НЕ выходят с null: `crontab -l` и
// нелетальный systemctl продолжают проверять пути той же позиции. `positions` и `index`
// нужны sleep: сам по себе он безвреден, таймером его делает отложенная команда ПОСЛЕ.
function positionViolation(
  at: CommandPosition,
  positions: readonly CommandPosition[],
  index: number,
): string | null {
  // Имя команды - по снятому сегменту: обёртка не должна превращать читателя в
  // писателя. Пути и хост - по сегменту как он написан: запретный путь умеет лежать
  // в значении присваивания или обёртки (`S=~/.iva-scripts/x.sh bash -c '… $S'`), и
  // снятие префикса уносило улику из-под суда.
  const segment = at.command;
  const written = at.segment;
  for (const [name, what] of Object.entries(BAN_COMMANDS)) {
    if (!anchored(name).test(segment)) continue;
    // Чтение расписания — не запись, но позицию всё равно судят проверки путей ниже.
    if (name === "crontab" && CRONTAB_LIST.test(segment)) continue;
    return what;
  }
  if (
    anchored("systemctl").test(segment) &&
    systemctlTouchesForeignUnit(segment)
  ) {
    return WHAT.SYSTEMCTL;
  }
  if (UNIT_DIR.test(written) && !isReader(segment)) return WHAT.UNIT_DIR;
  if (SCRIPTS_DIR.test(written) && !isReader(segment)) return WHAT.SCRIPTS_DIR;
  if (TELEGRAM_HOST.test(written) && !isReader(segment))
    return WHAT.TELEGRAM_HOST;
  if (
    anchored("sleep").test(segment) &&
    sleepSeconds(segment) >= SLEEP_THRESHOLD_SECONDS &&
    positions.slice(index + 1).some((next) => carriesPayload(next.command))
  ) {
    return WHAT.SLEEP;
  }
  return null;
}

/**
 * Текст отказа, если команда ставит свой таймер или отправляет в Telegram
 * мимо штатных инструментов, иначе null.
 */
export function schedulerBypassViolation(command: string): string | null {
  const positions = commandSegments(command);
  for (let index = 0; index < positions.length; index += 1) {
    const at = positions[index];
    if (!at) continue;
    const what = positionViolation(at, positions, index);
    if (what) {
      return (
        `ЗАБЛОКИРОВАНО: ${what}. Свои таймеры и свои отправки в Telegram из bash ` +
        `запрещены. Напоминания и пользовательские расписания создаёт только инструмент ` +
        `remind: он посчитает время в зоне владельца, вернёт next_run_at и доставит сам. ` +
        `Поставь напоминание им, обходной путь не ищи. Регулярные задачи Ивы - eve-schedule ` +
        `в agent/schedules/. Файл в чат отправляет инструмент send_file.`
      );
    }
  }
  return null;
}
