import { request } from "node:http";

export type BriefTask = {
  id: number;
  text: string;
  priority: "low" | "med" | "high";
  due: string | null;
  done: boolean;
  createdAt: string;
  bitrixTaskId?: string;
};
export type BitrixStatus = {
  id: string;
  title: string;
  status: string;
  deadline: string | null;
  checkedAt: string;
};
const STATUSES = new Set([
  "pending",
  "new",
  "in_progress",
  "supposed_completed",
  "completed",
  "deferred",
  "declined",
]);

/** The gateway performs a live read. No cache or local title is a fallback. */
export function readBitrixStatus(
  id: string,
  timeoutMs: number,
): Promise<BitrixStatus> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: "/run/iva-bitrix/gateway.sock",
        path: `/v1/tasks/${id}/status`,
        method: "GET",
        headers: { accept: "application/json" },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
          if (body.length > 1_000_000)
            req.destroy(new Error("Bitrix response too large"));
        });
        res.on("error", reject);
        res.on("end", () => {
          try {
            const parsed = JSON.parse(body) as {
              ok?: boolean;
              status?: BitrixStatus;
            };
            if (res.statusCode !== 200 || !parsed.ok || !parsed.status)
              throw new Error("Bitrix task could not be verified");
            resolve(parsed.status);
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      },
    );
    const timer = setTimeout(
      () => req.destroy(new Error("Bitrix timeout")),
      timeoutMs,
    );
    req.on("close", () => clearTimeout(timer));
    req.on("error", reject);
    req.end();
  });
}

/** Closed, deleted, denied and unverified linked tasks never enter the Brief. */
export async function verifiedBriefTasks(
  tasks: readonly BriefTask[],
  reader = readBitrixStatus,
  now: () => number = Date.now,
) {
  const deadline = now() + 90_000;
  const items: Array<BriefTask & { remoteStatus?: string }> = [];
  let verified = 0,
    excluded = 0,
    unchecked = 0;
  for (const task of tasks) {
    if (!task.bitrixTaskId) {
      if (!task.done) items.push(task);
      continue;
    }
    const remaining = deadline - now();
    if (!/^[1-9]\d*$/u.test(task.bitrixTaskId) || remaining <= 0) {
      unchecked++;
      continue;
    }
    try {
      const started = now();
      const remote = await reader(
        task.bitrixTaskId,
        Math.min(remaining, 10_000),
      );
      const checked = Date.parse(remote.checkedAt);
      if (
        remote.id !== task.bitrixTaskId ||
        typeof remote.title !== "string" ||
        !STATUSES.has(remote.status) ||
        !(remote.deadline === null || typeof remote.deadline === "string") ||
        !Number.isFinite(checked) ||
        checked < started - 5_000 ||
        checked > now() + 5_000
      )
        throw new Error("Bitrix response is invalid or stale");
      verified++;
      if (remote.status === "completed" || remote.status === "declined") {
        excluded++;
        continue;
      }
      items.push({
        ...task,
        text: remote.title,
        due: remote.deadline,
        done: false,
        remoteStatus: remote.status,
      });
    } catch {
      unchecked++;
    }
  }
  return {
    tasks: items,
    freshness: { verified, excluded, unchecked },
    warning: unchecked
      ? "Часть задач Bitrix не удалось проверить; они не включены в обзор."
      : null,
  };
}
