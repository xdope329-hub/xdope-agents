import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CuratorPick } from "../src/contracts/index.js";
import { RunStore } from "../src/runs/store.js";

let dir: string;
let store: RunStore;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "runs-"));
  store = new RunStore(dir);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("RunStore", () => {
  it("crea un lote en curated y no permite repetir el run_id", async () => {
    const s = await store.create("2026-09-30-calcifer");
    expect(s.status).toBe("curated");
    await expect(store.create("2026-09-30-calcifer")).rejects.toThrow("ya existe");
  });

  it("sigue las transiciones del workflow, incluido el reintento qa → generating", async () => {
    await store.create("r1");
    for (const to of ["design_ready", "shots_planned", "generating", "qa", "generating", "qa", "publishing", "inactive_created"] as const) {
      await store.transition("r1", to);
    }
    const s = await store.get("r1");
    expect(s.status).toBe("inactive_created");
    expect(s.history).toHaveLength(9);
  });

  it("rechaza saltarse pasos", async () => {
    await store.create("r1");
    await expect(store.transition("r1", "publishing")).rejects.toThrow("Transición inválida");
  });

  it("registra fallas con el paso donde ocurrieron", async () => {
    await store.create("r1");
    await store.transition("r1", "design_ready");
    const s = await store.fail("r1", "foto de baja resolución");
    expect(s.status).toBe("failed");
    expect(s.error).toEqual({ step: "design_ready", reason: "foto de baja resolución" });
  });

  it("valida los artefactos al escribirlos", async () => {
    await store.create("r1");
    await expect(store.writeArtifact("r1", "curator.json", CuratorPick, { run_id: "r1" })).rejects.toThrow();
  });

  it("no permite escribir fuera de la carpeta del lote", async () => {
    await store.create("r1");
    await expect(store.writeArtifact("r1", "../x.json", CuratorPick, {})).rejects.toThrow("fuera del lote");
    await expect(store.create("../escape")).rejects.toThrow("run_id inválido");
  });
});
