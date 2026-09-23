import { existsSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { acquireLock, loadJsonStrict, releaseLock, saveJsonAtomic } from "./json-store.js";
import { dataDir } from "./data-dir.js";

type Priority = "low" | "med" | "high";
type LocalTask = { id: number; text: string; priority: Priority; due: string | null; done: boolean; createdAt: string; bitrixTaskId?: string };
type Remote = { id: string; title: string; status: string; deadline: string | null; checkedAt: string };
export type DigestOutcome = { message: string; shown: number; excluded: number; unchecked: number; verified: number };
const LINKS: Record<number, string> = { 3: "396026", 6: "396023" };

function valid(x: unknown): x is LocalTask {
  const t = x as Record<string, unknown>;
  return !!t && typeof t.id === "number" && Number.isInteger(t.id) && t.id > 0 && typeof t.text === "string" && ["low", "med", "high"].includes(String(t.priority)) && (t.due === null || typeof t.due === "string") && typeof t.done === "boolean" && typeof t.createdAt === "string" && (t.bitrixTaskId === undefined || (typeof t.bitrixTaskId === "string" && /^[1-9]\d*$/.test(t.bitrixTaskId)));
}
async function localTasks(): Promise<LocalTask[]> {
  const file = join(dataDir(), "tasks.json"); const lock = `${file}.lock`; const token = await acquireLock(lock);
  try {
    const raw = await loadJsonStrict<unknown>(file, []); if (!Array.isArray(raw) || !raw.every(valid)) throw new Error("tasks.json damaged");
    let changed = false;
    for (const task of raw) { const link = LINKS[task.id]; if (link && !task.bitrixTaskId) { task.bitrixTaskId = link; changed = true; } }
    if (changed) { const backup = `${file}.bitrix-link-backup-v1.json`; if (!existsSync(backup)) await saveJsonAtomic(backup, raw.map((t) => ({ ...t, bitrixTaskId: undefined }))); await saveJsonAtomic(file, raw); }
    return raw;
  } finally { releaseLock(lock, token); }
}
export async function readBitrixStatus(id: string, timeoutMs: number): Promise<Remote> {
  return await new Promise((resolve, reject) => {
    const req = request({ socketPath: "/run/iva-bitrix/gateway.sock", path: `/v1/tasks/${id}/status`, method: "GET", headers: { accept: "application/json" } }, (res) => {
      const chunks: Buffer[] = []; res.on("data", (c: Buffer) => chunks.push(c)); res.on("end", () => { try { const body = JSON.parse(Buffer.concat(chunks).toString("utf8")); const status = body?.status; if (!body?.ok || !status || status.id !== id || typeof status.checkedAt !== "string") throw new Error(body?.error?.code ?? "invalid_response"); resolve(status); } catch (e) { reject(e); } });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout"))); req.on("error", reject); req.end();
  });
}
function dateKey(value: string | null) { const m = /^(\d{4}-\d{2}-\d{2})/.exec(value ?? ""); return m?.[1] ?? null; }
export async function buildMorningDigest(now = new Date(), reader = readBitrixStatus): Promise<DigestOutcome> {
  const tasks = await localTasks(); const deadline = Date.now() + 90_000; let excluded = 0, unchecked = 0, verified = 0;
  const items: Array<LocalTask & { title: string; remoteStatus?: string; waiting?: boolean }> = [];
  for (const task of tasks) {
    if (!task.bitrixTaskId) { if (!task.done) items.push({ ...task, title: task.text }); continue; }
    const left = deadline - Date.now(); if (left <= 0) { unchecked++; continue; }
    try { const remote = await reader(task.bitrixTaskId, left); verified++; if (["completed", "declined"].includes(remote.status)) { excluded++; continue; } items.push({ ...task, title: remote.title, due: remote.deadline, done: false, remoteStatus: remote.status, waiting: remote.status === "supposed_completed" }); } catch { unchecked++; }
  }
  const today = now.toISOString().slice(0, 10); const ranked = [...items].sort((a,b) => (Number(dateKey(a.due)! <= today) - Number(dateKey(b.due)! <= today)) || (Number(b.priority === "high") - Number(a.priority === "high")) || a.id-b.id).slice(0,7);
  const lines = ranked.map((t) => `• [${t.id}] ${t.title}${t.due ? ` — срок ${dateKey(t.due) ?? t.due}` : ""}${t.waiting ? " (ожидает контроля)" : ""}`);
  const focus = ranked.find((t) => !t.waiting && t.remoteStatus !== "deferred");
  const message = ["Доброе утро.", ...(lines.length ? lines : ["Проверенных открытых задач нет."]), focus ? `Фокус: ${focus.title}.` : "", unchecked ? "Часть задач Bitrix не удалось проверить; они не включены в сводку." : ""].filter(Boolean).join("\n");
  return { message, shown: ranked.length, excluded, unchecked, verified };
}
