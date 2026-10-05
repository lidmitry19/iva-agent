// Тик Watch и Brief (ADR-0020) — тонкий спавнер: каждые полчаса запускает
// scripts/proactive/tick.ts, который сам берёт свой замок, проверяет источники без модели и
// будит её только при новом. Тумблер «Сама пишет» читает сам тик: сбои идут и при выключенном.
// Срок 30 минут; агента о себе не будит (провал виден в открытых провалах), успех пишет
// фактом только после провала — иначе 48 строк в сутки вытеснили бы остальные факты.
import { defineSchedule } from "eve/schedules";
import { resolvePaths } from "../lib/schedule-paths.js";
import { runScheduledJob } from "../lib/schedule-runner.js";
import {
  PROACTIVE_SCHEDULE,
  PROACTIVE_TICK_CRON,
} from "../lib/schedule-table.js";

export default defineSchedule({
  cron: PROACTIVE_TICK_CRON,
  run({ waitUntil }) {
    const { root, statusPath, factsPath } = resolvePaths();
    waitUntil(
      runScheduledJob({
        name: PROACTIVE_SCHEDULE,
        argv: ["scripts/proactive/tick.ts"],
        root,
        nodeBin: process.execPath,
        statusPath,
        factsPath,
        guardMs: 0,
        timeoutMs: 30 * 60_000,
        wake: false,
        factOnSuccess: "after-failure",
      }),
    );
  },
});
