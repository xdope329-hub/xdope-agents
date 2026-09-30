import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { z } from "zod";

// Estado de un lote en runs/<run_id>/run.json. Ver specs/01-workflow.md, "Estados de un lote".
export type RunStatus = "curated" | "design_ready" | "shots_planned" | "generating" | "qa" | "publishing" | "inactive_created" | "live" | "failed";

const NEXT: Record<RunStatus, RunStatus[]> = {
  curated: ["design_ready"],
  design_ready: ["shots_planned"],
  shots_planned: ["generating"],
  generating: ["qa"],
  qa: ["generating", "publishing"],
  publishing: ["inactive_created"],
  inactive_created: ["live"],
  live: [],
  failed: [],
};

export interface RunState {
  run_id: string;
  design_id: string | null;
  status: RunStatus;
  history: Array<{ status: RunStatus; at: string }>;
  error: { step: RunStatus; reason: string } | null;
}

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class RunStore {
  constructor(readonly dir: string) {}

  runDir(runId: string) {
    if (!RUN_ID.test(runId)) throw new Error(`run_id inválido: ${runId}`);
    return path.join(this.dir, runId);
  }

  // Ruta de un archivo del lote; nunca fuera de su carpeta.
  file(runId: string, name: string) {
    const dir = this.runDir(runId);
    const file = path.resolve(dir, name);
    if (!file.startsWith(path.resolve(dir) + path.sep)) throw new Error(`Ruta fuera del lote: ${name}`);
    return file;
  }

  async create(runId: string, designId: string | null = null): Promise<RunState> {
    const dir = this.runDir(runId);
    if (await exists(path.join(dir, "run.json"))) throw new Error(`El lote ${runId} ya existe`);
    await mkdir(dir, { recursive: true });
    const state: RunState = { run_id: runId, design_id: designId, status: "curated", history: [{ status: "curated", at: now() }], error: null };
    await this.save(state);
    return state;
  }

  async exists(runId: string) {
    return exists(this.file(runId, "run.json"));
  }

  async get(runId: string): Promise<RunState> {
    return JSON.parse(await readFile(this.file(runId, "run.json"), "utf8"));
  }

  async list(): Promise<RunState[]> {
    if (!(await exists(this.dir))) return [];
    const out: RunState[] = [];
    for (const e of await readdir(this.dir, { withFileTypes: true })) {
      if (e.isDirectory() && RUN_ID.test(e.name) && (await this.exists(e.name))) out.push(await this.get(e.name));
    }
    return out;
  }

  async transition(runId: string, to: RunStatus): Promise<RunState> {
    const state = await this.get(runId);
    if (!NEXT[state.status].includes(to)) throw new Error(`Transición inválida: ${state.status} → ${to}`);
    state.status = to;
    state.history.push({ status: to, at: now() });
    await this.save(state);
    return state;
  }

  async fail(runId: string, reason: string): Promise<RunState> {
    const state = await this.get(runId);
    state.error = { step: state.status, reason };
    state.status = "failed";
    state.history.push({ status: "failed", at: now() });
    await this.save(state);
    return state;
  }

  // Un lote fallido vuelve al paso donde falló para reintentarlo (p. ej. tras crear un color en la tienda).
  async reopen(runId: string): Promise<RunState> {
    const state = await this.get(runId);
    if (state.status !== "failed" || !state.error) throw new Error(`El lote ${runId} no está fallido`);
    state.status = state.error.step;
    state.error = null;
    state.history.push({ status: state.status, at: now() });
    await this.save(state);
    return state;
  }

  async writeArtifact<T>(runId: string, name: string, schema: z.ZodType<T>, data: unknown): Promise<T> {
    const file = this.file(runId, name);
    const parsed = schema.parse(data);
    await writeFile(file, JSON.stringify(parsed, null, 2) + "\n");
    return parsed;
  }

  async readArtifact<T>(runId: string, name: string, schema: z.ZodType<T>): Promise<T | null> {
    const file = this.file(runId, name);
    if (!(await exists(file))) return null;
    return schema.parse(JSON.parse(await readFile(file, "utf8")));
  }

  private async save(state: RunState) {
    await writeFile(path.join(this.runDir(state.run_id), "run.json"), JSON.stringify(state, null, 2) + "\n");
  }
}

async function exists(p: string) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

const now = () => new Date().toISOString();
