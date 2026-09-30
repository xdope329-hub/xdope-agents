// Registra en el Programador de tareas de Windows los horarios de schedule.json.
// Por defecto solo muestra los comandos; con --apply los crea (reemplazando los existentes); con --remove los borra.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { readSchedule, type Schedule } from "../schedule.js";

const DAYS = { lun: "MON", mar: "TUE", mie: "WED", jue: "THU", vie: "FRI", sab: "SAT", dom: "SUN" } as const;
const FOLDER = "xdope-agents";

// scan → npm run scan; publish → npm run pipeline -- --designs <products> --publish
export function schtasksCommands(schedule: Schedule, runner: string, mode: "create" | "remove"): string[][] {
  const out: string[][] = [];
  for (const slot of schedule.slots.filter((s) => s.enabled)) {
    const task = slot.task === "scan" ? "scan" : `pipeline -- --designs ${slot.products} --publish`;
    for (const time of slot.times) {
      const name = `${FOLDER}\\${slug(slot.name)}-${time.replace(":", "")}`;
      out.push(
        mode === "remove"
          ? ["/Delete", "/F", "/TN", name]
          : ["/Create", "/F", "/TN", name, "/SC", "WEEKLY", "/D", slot.days.map((d) => DAYS[d]).join(","), "/ST", time, "/TR", `"${runner}" ${task}`],
      );
    }
  }
  return out;
}

function slug(s: string) {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

if (process.argv[1]?.endsWith("schedule-install.ts")) {
  const apply = process.argv.includes("--apply");
  const remove = process.argv.includes("--remove");
  const schedule = await readSchedule(process.env.SCHEDULE_FILE ?? "schedule.json");
  const runner = path.resolve("scripts", "run-task.cmd");
  const commands = schtasksCommands(schedule, runner, remove ? "remove" : "create");
  for (const args of commands) {
    console.log(`schtasks ${args.map((a) => (/\s/.test(a) ? `'${a}'` : a)).join(" ")}`);
    if (apply || remove) execFileSync("schtasks", args, { stdio: "inherit" });
  }
  if (!apply && !remove) {
    console.log(`\n${commands.length} tareas (vista previa, hora local del PC; schedule.json dice ${schedule.timezone}).`);
    console.log('"npm run schedule:install -- --apply" las crea; "-- --remove" las borra.');
  }
}
