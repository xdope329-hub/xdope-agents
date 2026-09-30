import { nextRuns, readSchedule } from "../schedule.js";

const file = process.env.SCHEDULE_FILE ?? "schedule.json";
const schedule = await readSchedule(file);
const fmt = new Intl.DateTimeFormat("es", {
  timeZone: schedule.timezone,
  weekday: "long",
  day: "numeric",
  month: "long",
  hour: "2-digit",
  minute: "2-digit",
});

console.log(`Próximas ejecuciones (${schedule.timezone}):`);
for (const run of nextRuns(schedule, new Date(), 10)) {
  const extra = run.slot.task === "publish" ? `, ${run.slot.products} producto(s)` : "";
  console.log(`  ${fmt.format(run.at)}  ${run.slot.name} (${run.slot.task}${extra})`);
}
