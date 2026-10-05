import { defineSchedule } from "eve/schedules";
import { memoryNightJob } from "../lib/schedule-paths.js";
import { SCHEDULE_CRON } from "../lib/schedule-table.js";
import { runScheduledJob } from "../lib/schedule-runner.js";

export default defineSchedule({
  cron: SCHEDULE_CRON["memory-night"],
  run({ waitUntil }) {
    waitUntil(runScheduledJob(memoryNightJob()));
  },
});
