import { describe, expect, it } from "vitest";
import { schtasksCommands } from "../src/cli/schedule-install.js";
import { Schedule } from "../src/schedule.js";

const schedule = Schedule.parse({
  timezone: "America/Bogota",
  slots: [
    { name: "Escaneo de bordados", task: "scan", days: ["lun", "mie"], times: ["08:00"] },
    { name: "Publicación", task: "publish", days: ["vie"], times: ["10:00", "16:30"], products: 2 },
    { name: "Pausado", task: "scan", days: ["dom"], times: ["09:00"], enabled: false },
  ],
});
const runner = "C:\\repo\\scripts\\run-task.cmd";

describe("schtasksCommands", () => {
  it("crea una tarea semanal por horario activo y hora", () => {
    const cmds = schtasksCommands(schedule, runner, "create");
    expect(cmds).toHaveLength(3);
    expect(cmds[0]).toEqual(["/Create", "/F", "/TN", "xdope-agents\\escaneo-de-bordados-0800", "/SC", "WEEKLY", "/D", "MON,WED", "/ST", "08:00", "/TR", `"${runner}" scan`]);
    expect(cmds[2].at(-1)).toBe(`"${runner}" pipeline -- --designs 2 --publish`);
    expect(cmds[2]).toContain("xdope-agents\\publicacion-1630");
  });

  it("borra las mismas tareas con --remove", () => {
    expect(schtasksCommands(schedule, "r.cmd", "remove")[0]).toEqual(["/Delete", "/F", "/TN", "xdope-agents\\escaneo-de-bordados-0800"]);
  });
});
