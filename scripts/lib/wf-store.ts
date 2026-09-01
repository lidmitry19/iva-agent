// Карантин вместо необратимого rm для reset-состояния: rename в соседний
// *.trash-<штамп> (атомарно в пределах одной ФС) с ротацией старых карантинов.
// Даёт откат после случайного reset: припаркованные диалоги возвращаются обратным
// переименованием, пока карантин не вытеснен ротацией.
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { throughLink } from "./version-layout.ts";

export const TRASH_KEEP = 2;

function hasErrorCode(error: unknown, code: string): boolean {
  return (error as { code?: unknown } | null | undefined)?.code === code;
}

function pathStat(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw error;
  }
}

// file/dir → path.trash-<stamp>. Одна операция reset передаёт общий stamp; если такой
// карантин уже есть, суффикс не даёт затереть предыдущую копию.
export function quarantinePath(
  link: string,
  stamp = new Date().toISOString().replace(/[:.]/g, "-"),
): string | null {
  const path = throughLink(link);
  const stat = pathStat(path);
  if (!stat) return null;
  const base = `${path}.trash-${stamp}`;
  let dest = base;
  for (let collision = 1; pathStat(dest); collision++)
    dest = `${base}-${collision}`;

  // Права едут вместе с inode после rename. Закрываем источник заранее: при сбое chmod
  // исходник остаётся на месте, а вызывающий reset честно отмечает incomplete.
  if (stat.isDirectory()) chmodSync(path, 0o700);
  else if (stat.isFile()) chmodSync(path, 0o600);
  renameSync(path, dest);
  // Ссылка не должна повиснуть: mkdir через висящий симлинк — ENOENT, и сервис,
  // который сам создаёт свой стор при старте, после reset уже не поднимется.
  if (path !== link && stat.isDirectory())
    mkdirSync(path, { recursive: true, mode: 0o700 });
  pruneTrash(path);
  return dest;
}

// Старое имя остаётся публичным alias для существующих вызовов и тестов.
export function quarantineDir(dir: string, stamp?: string): string | null {
  return quarantinePath(dir, stamp);
}

/** State that an update retires so every conversation starts with fresh context. */
export function conversationStateTargets(
  root: string,
  dataDir: string,
): string[] {
  let rollupSessions: string[];
  try {
    rollupSessions = readdirSync(dataDir)
      .filter((name) => /^rollup-session-.+\.json$/u.test(name))
      .sort()
      .map((name) => join(dataDir, name));
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
    rollupSessions = [];
  }
  return [
    join(root, ".eve", ".workflow-data"),
    join(root, ".workflow-data"),
    join(dataDir, "run-status.d"),
    join(dataDir, "run-status.json"),
    ...rollupSessions,
  ];
}

/** Inbound Telegram input belongs to reset, never to an update. */
export function queuedInputTargets(dataDir: string): string[] {
  return [join(dataDir, "telegram-queue.json")];
}

// Полный reset должен атомарно вывести из обращения workflow, status и очередь.
export function resetStateTargets(root: string, dataDir: string): string[] {
  return [
    ...conversationStateTargets(root, dataDir),
    ...queuedInputTargets(dataDir),
  ];
}

// Оставляет keep свежих карантинов path (ISO-штампы сортируются лексикографически).
export function pruneTrash(path: string, keep = TRASH_KEEP): void {
  const prefix = `${basename(path)}.trash-`;
  let names: string[];
  try {
    names = readdirSync(dirname(path))
      .filter((name) => name.startsWith(prefix))
      .sort();
  } catch {
    return;
  }
  for (const name of names.slice(0, Math.max(0, names.length - keep))) {
    rmSync(join(dirname(path), name), { recursive: true, force: true });
  }
}
