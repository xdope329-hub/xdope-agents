import { describe, expect, it } from "vitest";
import { Schedule, nextRuns, toCron } from "../src/schedule.js";

const schedule = Schedule.parse({
  timezone: "America/Bogota",
  slots: [
    { name: "Publicación", task: "publish", days: ["lun", "vie"], times: ["10:00", "18:30"], products: 2 },
    { name: "Escaneo", task: "scan", days: ["dom"], times: ["07:00"] },
    { name: "Pausado", task: "publish", days: ["mar"], times: ["09:00"], enabled: false },
  ],
});

describe("schedule", () => {
  it("convierte días y horas en expresiones cron", () => {
    expect(toCron(schedule.slots[0])).toEqual(["0 10 * * 1,5", "30 18 * * 1,5"]);
  });

  it("calcula las próximas ejecuciones en la zona horaria configurada", () => {
    // Miércoles 30 sep 2026, 12:00 en Bogotá (UTC-5)
    const runs = nextRuns(schedule, new Date("2026-09-30T17:00:00Z"), 4);
    expect(runs.map((r) => [r.at.toISOString(), r.slot.name])).toEqual([
      ["2026-10-02T15:00:00.000Z", "Publicación"], // viernes 10:00
      ["2026-10-02T23:30:00.000Z", "Publicación"], // viernes 18:30
      ["2026-10-04T12:00:00.000Z", "Escaneo"], // domingo 07:00
      ["2026-10-05T15:00:00.000Z", "Publicación"], // lunes 10:00
    ]);
  });

  it("ignora horarios desactivados", () => {
    const runs = nextRuns(schedule, new Date("2026-09-30T17:00:00Z"), 20);
    expect(runs.some((r) => r.slot.name === "Pausado")).toBe(false);
  });

  it("rechaza horas y zonas horarias inválidas", () => {
    expect(Schedule.safeParse({ ...schedule, timezone: "Marte/Olympus" }).success).toBe(false);
    const bad = { ...schedule.slots[0], times: ["25:00"] };
    expect(Schedule.safeParse({ ...schedule, slots: [bad] }).success).toBe(false);
  });
});
