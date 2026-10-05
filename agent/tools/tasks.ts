import { defineTool } from "eve/tools";
import { z } from "zod";
import { join } from "node:path";
import {
  acquireLock,
  loadJsonStrict,
  releaseLock,
  saveJsonAtomic,
} from "../lib/json-store.js";
import { dataDir } from "../lib/data-dir.js";
import { verifiedBriefTasks } from "../lib/bitrix-task-freshness.js";

// Хранилище задач — простой JSON-файл на диске app-runtime (на VPS переживает рестарты).
// Путь настраивается через ASSISTANT_DATA_DIR; по умолчанию ./data рядом с процессом.
const DATA_DIR = dataDir();
const FILE = join(DATA_DIR, "tasks.json");
const LOCK = `${FILE}.lock`;
const dueDate = z.iso.date();

type Priority = "low" | "med" | "high";
interface Task {
  id: number;
  text: string;
  priority: Priority;
  due: string | null;
  done: boolean;
  createdAt: string;
  bitrixTaskId?: string;
}

// Нет файла → []. Битый JSON — НЕ пустой список: loadJsonStrict откладывает бэкап и
// бросает (иначе следующий save молча уничтожил бы все задачи). Поверх этого — форма
// записей: файл лежит в data/ и правится руками, а одна запись без целого id ломала
// Math.max → NaN → "id": null у ВСЕХ новых задач, и закрыть их было нельзя (схема
// требует целый положительный id). Записи не по форме пропускаются со строкой в журнал;
// чужой корень (не массив) — явная ошибка: перезаписать его пустотой значит стереть данные.
async function load(): Promise<Task[]> {
  const raw = await loadJsonStrict<unknown>(FILE, []);
  if (!Array.isArray(raw))
    throw new Error(`${FILE} damaged (not an array) — fix or delete it`);
  const tasks = raw.filter(isTask);
  if (tasks.length !== raw.length)
    console.warn(
      `tasks.json: пропущено ${raw.length - tasks.length} записей не по форме, читаются остальные ${tasks.length}; файл починится следующей записью`,
    );
  return tasks;
}
const save = (tasks: Task[]) => saveJsonAtomic(FILE, tasks);

function isTask(value: unknown): value is Task {
  if (typeof value !== "object" || value === null) return false;
  const task = value as Record<string, unknown>;
  return (
    typeof task.id === "number" &&
    Number.isInteger(task.id) &&
    task.id > 0 &&
    typeof task.text === "string" &&
    (task.priority === "low" ||
      task.priority === "med" ||
      task.priority === "high") &&
    (task.due === null || typeof task.due === "string") &&
    typeof task.done === "boolean" &&
    typeof task.createdAt === "string"
  );
}

export default defineTool({
  description:
    "Для Brief используй list с verifyBitrix:true: только проверенные открытые задачи, warning обязательно включи в обзор. " +
    "Задачи: add (text, priority, due), list (includeDone; по умолчанию — незавершённые), " +
    "update (id, due, expectedDue — прежний срок из list), done/remove (id). " +
    "Срок — календарная дата YYYY-MM-DD, null — без срока. Для относительных сроков и " +
    "исправления старых записей загрузи skill task-management. Задачи не выдумываются из памяти: список ведёт тул.",
  inputSchema: z.object({
    action: z.enum(["add", "list", "update", "done", "remove"]),
    text: z.string().min(1).optional().describe("Текст задачи"),
    id: z.number().int().positive().optional().describe("ID задачи"),
    priority: z.enum(["low", "med", "high"]).optional().describe("Приоритет"),
    due: dueDate.nullable().optional().describe("Срок: YYYY-MM-DD или null"),
    expectedDue: z
      .string()
      .nullable()
      .optional()
      .describe("Для update: точное прежнее due из list, включая null"),
    verifyBitrix: z
      .boolean()
      .optional()
      .describe(
        "Для list в Brief: проверить связанные Bitrix-задачи живым запросом; без локального кэша",
      ),
    includeDone: z.boolean().optional().describe("Показать и выполненные"),
  }),
  async execute({
    action,
    text,
    id,
    priority,
    due,
    expectedDue,
    includeDone,
    verifyBitrix,
  }) {
    // Мутации — под локом: параллельный ход (расписание + живой чат) на голом
    // load→mutate→save терял записи и дублировал id (id = max+1 от своей копии).
    let lockToken: string | null = null;
    if (action !== "list") {
      try {
        lockToken = await acquireLock(LOCK);
      } catch (e) {
        return {
          ok: false,
          error: `Задачи заняты другим ходом: ${(e as Error).message}`,
        };
      }
    }
    try {
      return await run({
        action,
        text,
        id,
        priority,
        due,
        expectedDue,
        includeDone,
        verifyBitrix,
      });
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    } finally {
      if (lockToken !== null) releaseLock(LOCK, lockToken);
    }
  },
});

type Args = {
  action: "add" | "list" | "update" | "done" | "remove";
  text?: string;
  id?: number;
  priority?: Priority;
  due?: string | null;
  expectedDue?: string | null;
  includeDone?: boolean;
  verifyBitrix?: boolean;
};

async function run({
  action,
  text,
  id,
  priority,
  due,
  expectedDue,
  includeDone,
  verifyBitrix,
}: Args) {
  // Проверяем и прямой вызов execute, который не проходит через схему eve.
  // Старые строки на чтении остаются нетронутыми: толкует их модель, не миграция.
  if (
    (action === "add" || action === "update") &&
    due !== undefined &&
    due !== null &&
    !dueDate.safeParse(due).success
  )
    return {
      ok: false,
      error:
        'due: нужна существующая календарная дата YYYY-MM-DD, например "2026-09-24", или null. ' +
        "Относительный срок сначала переведи в дату по skill task-management.",
    };
  const tasks = await load();

  switch (action) {
    case "add": {
      if (!text) return { ok: false, error: "Для add нужен text" };
      const nextId = tasks.reduce((m, t) => Math.max(m, t.id), 0) + 1;
      const task: Task = {
        id: nextId,
        text,
        priority: priority ?? "med",
        due: due ?? null,
        done: false,
        createdAt: new Date().toISOString(),
      };
      tasks.push(task);
      await save(tasks);
      return { ok: true, added: task, total: tasks.length };
    }
    case "list": {
      if (verifyBitrix) {
        const result = await verifiedBriefTasks(tasks);
        return { ok: true, count: result.tasks.length, ...result };
      }
      const items = includeDone ? tasks : tasks.filter((t) => !t.done);
      return { ok: true, count: items.length, tasks: items };
    }
    case "update": {
      if (!id || due === undefined || expectedDue === undefined)
        return {
          ok: false,
          error:
            'Для update нужны id, due и expectedDue из list: {action:"update",id:117,due:"2026-09-24",expectedDue:"завтра"}. ' +
            "due:null очищает срок; expectedDue:null означает, что срока не было.",
        };
      const task = tasks.find((item) => item.id === id);
      if (!task) return { ok: false, error: `Задача ${id} не найдена` };
      if (task.due !== expectedDue)
        return {
          ok: false,
          error: `Срок задачи ${id} изменился. Повтори list и проверь актуальный срок перед update.`,
          current: task,
        };
      task.due = due;
      await save(tasks);
      return { ok: true, updated: task };
    }
    case "done": {
      if (!id) return { ok: false, error: "Для done нужен id" };
      const t = tasks.find((x) => x.id === id);
      if (!t) return { ok: false, error: `Задача ${id} не найдена` };
      t.done = true;
      await save(tasks);
      return { ok: true, done: t };
    }
    case "remove": {
      if (!id) return { ok: false, error: "Для remove нужен id" };
      const idx = tasks.findIndex((x) => x.id === id);
      if (idx === -1) return { ok: false, error: `Задача ${id} не найдена` };
      const [removed] = tasks.splice(idx, 1);
      await save(tasks);
      return { ok: true, removed, total: tasks.length };
    }
  }
}
