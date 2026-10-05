// `iva diagnose` — one package of evidence for a bug report: a GitHub issue or the
// support chat (agent/skills/report-problem). A thin collector: it takes what the machine
// already knows and cuts secrets BEFORE the file is written. What broke is the model's
// question, not this command's.
//
// Only `scripts/` is imported statically: the CLI has to start on an installation whose
// `agent/` is missing (ADR-0003, scripts/authored-tree-guard.test.ts). The turn journal is
// therefore read where it lies — `data/trace/*.jsonl`, the contract of docs/trace.md — and
// the reminders table as `data/reminders.json`; its rows are parsed by the store's own
// reader, imported at run time, so a missing authored tree costs only that section.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import type { Reminder } from "../../agent/lib/reminder-store.ts";
import {
  redact,
  secretValuesFromEnv,
} from "../../packages/secret-redaction/index.ts";
import {
  authoredTreeMissing,
  createDoctorCommand,
  errorCode,
  reminderIdHash,
  scheduleFactsReport,
} from "./doctor.ts";
import type { createCliRuntime } from "./runtime.ts";
import type { createCliSystemd } from "./systemd.ts";

type CliRuntime = ReturnType<typeof createCliRuntime>;
type SystemdLifecycle = ReturnType<typeof createCliSystemd>;

export type DiagnoseDependencies = {
  readonly now?: () => Date;
};

// Правило вырезания секретов — одно на установку и лежит в пакете, который видят и
// `scripts/`, и authored tree (packages/secret-redaction/index.ts): пакет улик и хвост
// журнала расписания режут одинаково. Реэкспорт держит прежний вход тестов-якорей
// scripts/cli/diagnose-redact.test.ts.
export {
  REDACTED,
  redact,
  secretValuesFromEnv,
} from "../../packages/secret-redaction/index.ts";
export const JOURNAL_LINES = 200;
/** Потолок списка на раздел: пакет должен читаться, а не весить мегабайт. */
export const SECTION_ITEM_LIMIT = 100;

/** Потолок кода ошибки хода: код — короткое слово, а не текст. */
const TRACE_CODE_CHARS = 60;
/** Файлы журнала хода: имя дня — единственный контракт каталога (docs/trace.md). */
const TRACE_DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/u;
/** События провала хода: имена из docs/trace.md, без синонимов. */
const FAILED_TURNS = new Set(["turn.failed", "step.failed", "failed"]);
const DAY_MS = 24 * 60 * 60 * 1000;
const NO_COLOR = { g: "", y: "", r: "", c: "", b: "", d: "", x: "" };

function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function capText(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function tailLines(text: string, limit: number): string {
  const lines = text.split("\n");
  return lines.length <= limit ? text : lines.slice(-limit).join("\n");
}

/** Сколько элементов списка попало в пакет и сколько осталось за потолком. */
function capped(items: readonly string[]): { shown: string[]; rest: number } {
  return {
    shown: items.slice(0, SECTION_ITEM_LIMIT),
    rest: Math.max(0, items.length - SECTION_ITEM_LIMIT),
  };
}

function listOrNone(items: readonly string[]): string {
  if (items.length === 0) return "- (none)";
  const { shown, rest } = capped(items);
  const lines = shown.map((item) => `- ${item}`);
  if (rest > 0)
    lines.push(`- … ${rest} more (list cut at ${SECTION_ITEM_LIMIT})`);
  return lines.join("\n");
}

function versionsSection(root: string, gitHead: string): string {
  const manifest = readJsonObject(join(root, "package.json"));
  const iva =
    typeof manifest?.version === "string"
      ? manifest.version
      : "unknown (package.json unreadable)";
  const dependencies = manifest?.dependencies;
  const eve =
    typeof dependencies === "object" &&
    dependencies !== null &&
    typeof (dependencies as Record<string, unknown>).eve === "string"
      ? String((dependencies as Record<string, unknown>).eve)
      : "unknown (eve is not in package.json)";
  const commit = gitHead.length > 0 ? ` (git ${gitHead})` : "";
  return `- iva: ${iva}${commit}\n- eve: ${eve}`;
}

function hostSection(): string {
  return [
    `- os: ${os.platform()} ${os.release()} ${os.arch()} (${os.type()})`,
    `- node: ${process.version}`,
  ].join("\n");
}

/**
 * Факты строк напоминаний. Разбор тела отдан стору (`parseReminderTable`): схема строки —
 * его собственность, второй копии полей здесь нет; разбор подгружается на исполнении, потому
 * что CLI грузится и без authored tree (ADR-0003). В пакет едут хеш id и код ошибки, не текст:
 * текст ошибки несёт тело ответа Telegram, а его слова — владельца.
 */
async function remindersSection(
  dataDir: string,
  nowMs: number,
): Promise<string> {
  const file = join(dataDir, "reminders.json");
  if (!existsSync(file)) return "- no reminders.json on this install";
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return "- reminders.json is not valid JSON";
  }
  let parseReminderTable: (
    file: string,
    raw: unknown,
    nowMs: number,
  ) => Reminder[];
  try {
    parseReminderTable = (await import("../../agent/lib/reminder-store.ts"))
      .parseReminderTable;
  } catch {
    return "- reminders.json present, but the authored tree that reads it is missing";
  }
  let rows: Reminder[];
  try {
    rows = parseReminderTable(file, raw, nowMs);
  } catch (error) {
    // Причина отказа несёт JSON строки: в пакет идёт только класс ошибки.
    const name = error instanceof Error ? error.constructor.name : "unknown";
    return `- reminders.json unreadable (${name})`;
  }
  const facts: string[] = [];
  for (const row of rows) {
    const last = row.firedAt;
    const due = row.nextRunAtMs;
    // Факт за сутки — то, что сработало за последние сутки, и то, что висит просроченным
    // прямо сейчас: молчащий диспетчер виден именно по второму.
    const recent = last !== null && nowMs - last <= DAY_MS;
    const overdue = due <= nowMs;
    if (!recent && !overdue) continue;
    const status =
      row.delivered === true ? "yes" : row.delivered === false ? "no" : "never";
    const error =
      row.error !== null && row.error.length > 0
        ? errorCode(row.error)
        : "none";
    facts.push(
      `${reminderIdHash(row.id)} · due ${new Date(due).toISOString()} · ` +
        `last ${last === null ? "-" : new Date(last).toISOString()} · delivered ${status} · ` +
        `error ${error}`,
    );
  }
  const { shown, rest } = capped(facts);
  const lines = shown.map((fact) => `- ${fact}`);
  if (rest > 0)
    lines.push(`- … ${rest} more (list cut at ${SECTION_ITEM_LIMIT})`);
  return lines.length > 0
    ? lines.join("\n")
    : "- no reminder facts in the last day";
}

/** Один провал — одна строка: код, а не текст ошибки: текст может нести сообщение. */
function failureFact(event: Record<string, unknown>): string | null {
  const kind = event.kind;
  const name = event.name;
  if (typeof kind !== "string" || typeof name !== "string") return null;
  const failed =
    (kind === "eve" && FAILED_TURNS.has(name)) ||
    ((kind === "outbox" || kind === "stop") && name === "failed");
  if (!failed) return null;
  const data =
    typeof event.data === "object" && event.data !== null
      ? (event.data as Record<string, unknown>)
      : {};
  const code =
    typeof data.errorCode === "string"
      ? capText(data.errorCode, TRACE_CODE_CHARS)
      : typeof data.code === "string" || typeof data.code === "number"
        ? capText(String(data.code), TRACE_CODE_CHARS)
        : "-";
  const turn =
    typeof event.turn === "string" && event.turn.length > 0 ? event.turn : "-";
  const ts =
    typeof event.ts === "string" && event.ts.length > 0 ? event.ts : "-";
  return `${ts} · ${kind}.${name} · turn ${turn} · code ${code}`;
}

/**
 * Таблица фактов расписаний (T20 §5): последний запуск каждого имени и незакрытые провалы
 * (до починки, ADR-0020). Разбор не дублируем: отчёт собирает doctor.scheduleFactsReport теми же
 * authored-функциями, что и раздел доктора; хвост уже вырезан при записи, а пакет
 * целиком проходит общее вырезание секретов ниже.
 */
async function schedulesSection(dataDir: string): Promise<string> {
  let report;
  try {
    report = await scheduleFactsReport(dataDir);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return authoredTreeMissing(error)
      ? "- schedule facts unavailable: the authored tree is missing"
      : `- job facts unreadable: ${reason}`;
  }
  const lines = report.lastRuns.map((line) => `- ${line}`);
  for (const failure of report.openFailures) {
    lines.push(
      `- незакрытый провал: ${failure.name} (${failure.reason}) — закрыть: iva jobs ack ${failure.name}`,
    );
    const row = report.facts.find(
      (fact) => fact.name === failure.name && fact.finishedAt === failure.at,
    );
    if (row?.tail)
      lines.push(...row.tail.split("\n").map((line) => `  ${line}`));
  }
  return lines.length > 0
    ? lines.join("\n")
    : "- no schedule runs in the facts table";
}

function turnsSection(dataDir: string, nowMs: number): string {
  const directory = join(dataDir, "trace");
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return "- no data/trace — the turn journal has nothing";
  }
  const days = names
    .filter((name) => TRACE_DAY_FILE.test(name))
    .sort()
    .reverse();
  const since = nowMs - DAY_MS;
  const facts: string[] = [];
  let unreadable = 0;
  // Двух последних дневных файлов хватает на сутки: ход идёт от сегодняшнего дня назад.
  for (const day of days.slice(0, 2)) {
    let text: string;
    try {
      text = readFileSync(join(directory, day), "utf8");
    } catch {
      unreadable++;
      continue;
    }
    for (const line of text.split("\n")) {
      if (line.trim().length === 0) continue;
      let event: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed !== "object" || parsed === null)
          throw new Error("not an object");
        event = parsed as Record<string, unknown>;
      } catch {
        unreadable++;
        continue;
      }
      const ts =
        typeof event.ts === "string" ? Date.parse(event.ts) : Number.NaN;
      if (Number.isFinite(ts) && ts < since) continue;
      const fact = failureFact(event);
      if (fact) facts.push(fact);
    }
  }
  const { shown, rest } = capped(facts);
  const lines = shown.map((fact) => `- ${fact}`);
  if (rest > 0)
    lines.push(`- … ${rest} more (list cut at ${SECTION_ITEM_LIMIT})`);
  if (unreadable > 0)
    lines.push(`- ${unreadable} unreadable journal lines skipped`);
  return lines.length > 0
    ? lines.join("\n")
    : "- no failed turns in the last day";
}

/** Имена файлов своего слоя, без содержимого: что владелец правил — видно, что там — нет. */
function customLayerSection(dataDir: string): string {
  const root = join(dataDir, "custom", "agent");
  const names: string[] = [];
  const visit = (relative: string): void => {
    let entries;
    try {
      entries = readdirSync(join(root, relative), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path =
        relative.length > 0 ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) names.push(path);
    }
  };
  visit("");
  names.sort();
  return listOrNone(names);
}

/** Новейший файл журнала из data/logs: у self-host это единственный лог, который есть. */
function newestLogFile(
  dataDir: string,
  prefix = "",
): { name: string; text: string } | null {
  const directory = join(dataDir, "logs");
  let names: string[];
  try {
    names = readdirSync(directory)
      .filter((name) => name.endsWith(".log") && name.startsWith(prefix))
      .sort()
      .reverse();
  } catch {
    return null;
  }
  for (const name of names) {
    try {
      return {
        name,
        text: tailLines(
          readFileSync(join(directory, name), "utf8"),
          JOURNAL_LINES,
        ),
      };
    } catch {
      continue;
    }
  }
  return null;
}

/** Хвост последнего лога обновлятора: без него «не удалось собрать» в чате не разобрать. */
function updateLogSection(dataDir: string): string {
  const latest = newestLogFile(dataDir, "update-");
  return latest
    ? `data/logs/${latest.name}\n\n${latest.text}`
    : "- no data/logs/update-*.log — no update has run on this install yet";
}

/**
 * Последние строки журнала сервиса: journalctl по службам Ивы; нет journalctl — говорим
 * об этом честно и отдаём новейший файл журнала, если он есть.
 */
function journalSection(
  cap: CliRuntime["cap"],
  dataDir: string,
  units: readonly string[],
): string {
  const args = [
    "--user",
    ...units.flatMap((unit) => ["-u", unit]),
    "-n",
    String(JOURNAL_LINES),
    "--no-pager",
  ];
  const result = cap("journalctl", args);
  if (result.code === 0 && result.out.trim().length > 0) return result.out;
  const fallback = newestLogFile(dataDir);
  if (fallback) {
    return (
      `journalctl did not return the unit journal (${result.err || "no output"}); ` +
      `newest log file data/logs/${fallback.name}\n\n${fallback.text}`
    );
  }
  return (
    `journalctl unavailable (${result.err || "no journalctl on this host"}) — ` +
    "read the service journal where the service logs: journalctl --user -u iva.service -n 200, " +
    "or the terminal that started it"
  );
}

/**
 * Строка о том, ЧЕМ вырезано. Без неё пакет с пустым списком секретов выглядел бы так же,
 * как пакет с полным (слепая приёмка T21): владелец и модель обязаны видеть, что `.env`
 * не нашли и работают только шаблонные правила.
 */
function redactionLine(envFound: boolean, secretCount: number): string {
  if (!envFound)
    return (
      "- redaction: .env not found — only the pattern rules were applied " +
      "(bot token, telegram ids, e-mail); values of keys are NOT in the cut list"
    );
  return `- redaction: ${secretCount} values from .env, pattern rules always on`;
}

async function packageMarkdown(input: {
  readonly root: string;
  readonly dataDir: string;
  readonly gitHead: string;
  readonly now: Date;
  readonly doctor: string;
  readonly journal: string;
  readonly updateLog: string;
  readonly redaction: string;
  readonly schedules: string;
}): Promise<string> {
  const nowMs = input.now.getTime();
  const reminders = await remindersSection(input.dataDir, nowMs);
  return [
    "# Iva diagnose package",
    "",
    `- collected: ${input.now.toISOString()}`,
    `- data dir: ${input.dataDir}`,
    input.redaction,
    "",
    "## Versions",
    versionsSection(input.root, input.gitHead),
    "",
    "## Host",
    hostSection(),
    "",
    "## iva doctor",
    "```",
    input.doctor.trimEnd(),
    "```",
    "",
    `## Last update log (data/logs/update-*.log, last ${JOURNAL_LINES} lines)`,
    "",
    input.updateLog.trimEnd(),
    "",
    `## Service journal (last ${JOURNAL_LINES} lines)`,
    "```",
    input.journal.trimEnd(),
    "```",
    "",
    "## Reminders (last 24h and overdue; id = sha256/8)",
    reminders,
    "",
    "## Failed turns (last 24h)",
    turnsSection(input.dataDir, nowMs),
    "",
    "## Schedules (facts table, last run per name; open failures of the last day)",
    input.schedules,
    "",
    "## Custom layer (file names only)",
    customLayerSection(input.dataDir),
    "",
  ].join("\n");
}

/**
 * `iva diagnose`: собрать пакет, вырезать секреты, записать в data/diagnose/<дата-время>.md
 * и напечатать путь. Доктор зовётся НАСТОЯЩИЙ — он и есть половина улик, — но со сборщиком
 * без цвета и с выходом, который не завершает этот процесс.
 */
export function createDiagnoseCommand(
  runtime: CliRuntime,
  systemdLifecycle: SystemdLifecycle,
  dependencies: DiagnoseDependencies = {},
) {
  const {
    ROOT,
    ENV_PATH,
    ok,
    warn,
    readEnv,
    dataDirAbs,
    cap,
    gitHead,
    SERVICES,
    BRAIN_SERVICE,
    SVC_USERBOT,
  } = runtime;
  const now = dependencies.now ?? (() => new Date());
  const units = [...SERVICES, BRAIN_SERVICE, SVC_USERBOT];

  return async function cmdDiagnose(): Promise<void> {
    const env = readEnv();
    const envFound = existsSync(ENV_PATH);
    if (!envFound)
      warn(
        "No .env — redaction applies only the pattern rules (bot token, telegram ids, e-mail); the package says so in its header",
      );
    const dataDirectory = dataDirAbs(env);
    const collectedAt = now();
    // Доктор — половина улик, поэтому зовётся настоящий: его строки уходят в пакет, а не в
    // терминал (сборщик без цвета и с выходом, который не завершает этот процесс).
    const doctorLines: string[] = [];
    const doctorRuntime: CliRuntime = {
      ...runtime,
      C: NO_COLOR,
      ok: (message: string) => void doctorLines.push(`✓ ${message}`),
      warn: (message: string) => void doctorLines.push(`! ${message}`),
      bad: (message: string) => void doctorLines.push(`✗ ${message}`),
    };
    await createDoctorCommand(doctorRuntime, systemdLifecycle, {
      log: (...args: unknown[]) => {
        doctorLines.push(args.map((arg) => String(arg)).join(" "));
      },
      exit: () => undefined,
    })();
    // Доктор мог записать в .env новый внутренний bearer — его значение тоже секрет, и
    // читать список только до прогона значит выпустить свежий ключ в пакет (T21).
    const secrets = [
      ...new Set([
        ...secretValuesFromEnv(env),
        ...secretValuesFromEnv(readEnv()),
      ]),
    ];
    const text = await packageMarkdown({
      root: ROOT,
      dataDir: dataDirectory,
      gitHead: gitHead(),
      now: collectedAt,
      doctor: doctorLines.join("\n"),
      journal: journalSection(cap, dataDirectory, units),
      updateLog: updateLogSection(dataDirectory),
      redaction: redactionLine(envFound, secrets.length),
      schedules: await schedulesSection(dataDirectory),
    });
    const file = join(
      dataDirectory,
      "diagnose",
      `${collectedAt.toISOString().replace(/[:.]/gu, "-")}.md`,
    );
    mkdirSync(join(dataDirectory, "diagnose"), { recursive: true });
    writeFileSync(file, redact(text, secrets), {
      encoding: "utf8",
      mode: 0o600,
    });
    ok(`Diagnose package: ${file}`);
  };
}
