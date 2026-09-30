import { readFile } from "node:fs/promises";
import { Cron } from "croner";
import { z } from "zod";

// Programación de ejecuciones en días y horas fijas. Ver specs/01-workflow.md, "Programación".
const DAYS = { dom: 0, lun: 1, mar: 2, mie: 3, jue: 4, vie: 5, sab: 6 } as const;
export const Day = z.enum(["lun", "mar", "mie", "jue", "vie", "sab", "dom"]);

export const Task = z.enum(["scan", "publish"]);
export type Task = z.infer<typeof Task>;

export const Slot = z.object({
  name: z.string().min(1),
  task: Task,
  days: z.array(Day).min(1),
  times: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Hora en formato HH:MM, 24 h")).min(1),
  // Solo para task=publish: cuántos productos inicia cada ejecución.
  products: z.number().int().positive().default(1),
  enabled: z.boolean().default(true),
});
export type Slot = z.infer<typeof Slot>;

export const Schedule = z
  .object({
    timezone: z.string().min(1),
    slots: z.array(Slot).min(1),
  })
  .superRefine((s, ctx) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: s.timezone });
    } catch {
      ctx.addIssue({ code: "custom", path: ["timezone"], message: `Zona horaria desconocida: ${s.timezone}` });
    }
    const names = s.slots.map((x) => x.name);
    if (new Set(names).size !== names.length) {
      ctx.addIssue({ code: "custom", path: ["slots"], message: "Nombres de horario repetidos" });
    }
  });
export type Schedule = z.infer<typeof Schedule>;

export function toCron(slot: Slot): string[] {
  const dow = [...new Set(slot.days.map((d) => DAYS[d]))].sort().join(",");
  return slot.times.map((t) => {
    const [h, m] = t.split(":").map(Number);
    return `${m} ${h} * * ${dow}`;
  });
}

export interface PlannedRun {
  at: Date;
  slot: Slot;
}

export function nextRuns(schedule: Schedule, from: Date, count: number): PlannedRun[] {
  const all: PlannedRun[] = [];
  for (const slot of schedule.slots.filter((s) => s.enabled)) {
    for (const expr of toCron(slot)) {
      const cron = new Cron(expr, { timezone: schedule.timezone, paused: true });
      for (const at of cron.nextRuns(count, from)) all.push({ at, slot });
      cron.stop();
    }
  }
  return all.sort((a, b) => a.at.getTime() - b.at.getTime()).slice(0, count);
}

export type Handlers = Record<Task, (slot: Slot) => Promise<void>>;

// Arranca un job por horario. Si una ejecución sigue corriendo cuando toca la
// siguiente del mismo horario, la nueva se salta en vez de solaparse.
export function startScheduler(schedule: Schedule, handlers: Handlers, log: (msg: string) => void = console.log) {
  const jobs: Cron[] = [];
  for (const slot of schedule.slots.filter((s) => s.enabled)) {
    for (const expr of toCron(slot)) {
      jobs.push(
        new Cron(
          expr,
          {
            timezone: schedule.timezone,
            protect: () => log(`Se salta "${slot.name}": la ejecución anterior sigue en curso`),
            catch: (err: unknown) => log(`Falló "${slot.name}": ${err instanceof Error ? err.message : String(err)}`),
          },
          async () => {
            log(`Inicia "${slot.name}" (${slot.task})`);
            await handlers[slot.task](slot);
            log(`Terminó "${slot.name}"`);
          },
        ),
      );
    }
  }
  return { stop: () => jobs.forEach((j) => j.stop()) };
}

export async function readSchedule(file: string): Promise<Schedule> {
  return Schedule.parse(JSON.parse(await readFile(file, "utf8")));
}
