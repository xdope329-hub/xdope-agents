import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ShotList } from "../src/contracts/index.js";
import type { GeminiImages, GeneratedImage } from "../src/images/gemini.js";
import { decide, generateMockups, readProgress, type MockupOptions } from "../src/images/mockups.js";
import type { Claude } from "../src/llm/claude.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "mockups-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const png = () => sharp({ create: { width: 40, height: 50, channels: 3, background: "#888" } }).png().toBuffer();
const shot = (id: string, color: string, framing: "front_mid" | "side" | "detail") => ({
  shot_id: id, color, placement: "chest_left" as const, framing, background: "b", lighting: "l", aspect: "4:5", prompt: "p", negative_prompt: "n",
});
const shotList: ShotList = {
  run_id: "r1",
  analysis: { subject: "s", style: "s", thread_palette: ["#000000"], has_text: false, best_placement: "chest_left" },
  concept: { type: "model", description: "d", identity_ref: null },
  colors: [{ name: "Negro", attribute_value_id: "x", hex: "#151515", contrast_ok: true }],
  shots: [shot("n-1", "Negro", "front_mid"), shot("n-2", "Negro", "side"), shot("n-3", "Negro", "detail")],
};
const qaOk = { embroidery_fidelity: 9, realism: 9, same_person: true, garment_present: true, placement_ok: true, size_ok: true, stitch_texture_visible: true, garment_color_ok: true, extra_text: false, reasons: [] };
// QA falla las primeras `failures` revisiones y después aprueba.
const fakeClaude = (failures = 0) => {
  let n = 0;
  return { ask: async () => (n++ < failures ? { ...qaOk, embroidery_fidelity: 5, reasons: ["gafas deformadas"] } : qaOk) } as unknown as Claude;
};

function fakeGemini(batchState: { value: string }) {
  const calls = { generate: 0, submit: [] as Array<{ keys: string[]; model: string; prompt: string; roles: string[] }>, check: 0 };
  const img = async (batch: boolean): Promise<GeneratedImage> => ({ data: await png(), mimeType: "image/png", model: "m", cost_usd: batch ? 0.05 : 0.1, batch });
  const gemini = {
    generate: async () => (calls.generate++, img(false)),
    submitBatch: async (reqs: Array<{ key: string; req: { model: string; prompt: string; refs: Array<{ role: string }> } }>) => {
      calls.submit.push({ keys: reqs.map((r) => r.key), model: reqs[0].req.model, prompt: reqs[0].req.prompt, roles: reqs[0].req.refs.map((r) => r.role) });
      return `batches/${calls.submit.length}`;
    },
    checkBatch: async (_job: string, keys: string[]) => {
      calls.check++;
      if (batchState.value !== "JOB_STATE_SUCCEEDED") return { state: batchState.value, done: false };
      return { state: batchState.value, done: true, results: new Map(await Promise.all(keys.map(async (k) => [k, await img(true)] as const))) };
    },
  } as unknown as GeminiImages;
  return { gemini, calls };
}

const options = (gemini: GeminiImages, claude = fakeClaude(), batch = true, reviewBeforeRetry = false): MockupOptions => ({
  claude, gemini, runId: "r1", design: { data: Buffer.from(""), mediaType: "image/jpeg", label: "" }, shotList, dir,
  model: "flash", retryModel: "pro", imageSize: "2K", maxCostUsd: 3, outSize: [40, 50], batch, waitForBatch: false, reviewBeforeRetry, log: () => {},
});

describe("generateMockups", () => {
  it("todo en batch: primera foto, luego el resto con la identidad, sin generar al momento", async () => {
    const state = { value: "JOB_STATE_RUNNING" };
    const { gemini, calls } = fakeGemini(state);

    expect(await generateMockups(options(gemini))).toEqual({ kind: "waiting", job: "batches/1", state: "JOB_STATE_RUNNING" });
    expect(calls.submit.map((c) => c.keys)).toEqual([["n-1"]]);
    expect((await readProgress(dir))?.batch).toMatchObject({ stage: "primera foto", state: "JOB_STATE_RUNNING" });

    expect((await generateMockups(options(gemini))).kind).toBe("waiting");
    expect(calls.submit).toHaveLength(1);

    state.value = "JOB_STATE_SUCCEEDED";
    const done = await generateMockups(options(gemini));
    if (done.kind !== "done") throw new Error("debía terminar");
    expect(calls.submit.map((c) => c.keys)).toEqual([["n-1"], ["n-2", "n-3"]]);
    expect(calls.generate).toBe(0);
    expect(done.results.map((r) => [r.shot.shot_id, r.passed])).toEqual([["n-1", true], ["n-2", true], ["n-3", true]]);
    expect(done.imageCost).toBeCloseTo(0.15);
  });

  it("reintenta en batch con el modelo de reintento y los motivos de QA", async () => {
    const { gemini, calls } = fakeGemini({ value: "JOB_STATE_SUCCEEDED" });
    const done = await generateMockups(options(gemini, fakeClaude(1)));
    if (done.kind !== "done") throw new Error("debía terminar");
    expect(calls.submit.map((c) => [c.keys, c.model])).toEqual([[["n-1"], "flash"], [["n-2", "n-3"], "flash"], [["n-1"], "pro"]]);
    expect(calls.submit[2].prompt).toContain("gafas deformadas");
    expect(done.results[0].attempts).toHaveLength(2);
    expect(done.results.every((r) => r.passed)).toBe(true);
  });

  it("sin batch genera al momento", async () => {
    const { gemini, calls } = fakeGemini({ value: "JOB_STATE_SUCCEEDED" });
    const done = await generateMockups(options(gemini, fakeClaude(), false));
    expect(done.kind).toBe("done");
    expect(calls.generate).toBe(3);
    expect(calls.submit).toHaveLength(0);
  });

  it("con revisión: se detiene antes de reintentar y Diego aprueba por encima de QA sin gastar más", async () => {
    const { gemini, calls } = fakeGemini({ value: "JOB_STATE_SUCCEEDED" });
    const claude = fakeClaude(1); // QA rechaza la primera foto
    const paused = await generateMockups(options(gemini, claude, true, true));
    if (paused.kind !== "review") throw new Error("debía esperar revisión");
    expect(paused.awaiting).toMatchObject({ rejected: ["n-1"], can_retry: true });
    expect(calls.submit).toHaveLength(2);

    await decide(dir, "approve");
    const done = await generateMockups(options(gemini, claude, true, true));
    if (done.kind !== "done") throw new Error("debía terminar");
    expect(done.results.every((r) => r.passed)).toBe(true);
    expect(calls.submit).toHaveLength(2);
  });

  it("con revisión: Diego pide reintentos y, si aún falla, puede aprobar", async () => {
    const { gemini, calls } = fakeGemini({ value: "JOB_STATE_SUCCEEDED" });
    const claude = fakeClaude(4); // QA rechaza n-1, n-2, n-3 y el reintento de n-1
    expect((await generateMockups(options(gemini, claude, true, true))).kind).toBe("review");
    await decide(dir, "retry");
    const again = await generateMockups(options(gemini, claude, true, true));
    if (again.kind !== "review") throw new Error("debía volver a esperar revisión");
    expect(calls.submit.map((c) => c.model)).toEqual(["flash", "flash", "pro"]);
    expect(again.awaiting.can_retry).toBe(false);
    await expect(decide(dir, "retry")).rejects.toThrow("No quedan reintentos");
    await decide(dir, "approve");
    expect((await generateMockups(options(gemini, claude, true, true))).kind).toBe("done");
  });

  it("agrega la foto de ejemplo de ubicación del tamaño elegido", async () => {
    const refs = path.join(dir, "refs");
    await mkdir(refs, { recursive: true });
    await writeFile(path.join(refs, "pecho_izquierdo.jpg"), await png());
    const { gemini, calls } = fakeGemini({ value: "JOB_STATE_RUNNING" });
    const withPreset = { ...shotList, analysis: { ...shotList.analysis, size_preset: "pecho_izquierdo", framed: false } };
    await generateMockups({ ...options(gemini), shotList: withPreset, placementRefsDir: refs });
    expect(calls.submit[0].roles.some((r) => r.startsWith("Placement reference"))).toBe(true);
  });
});
