import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ShotList } from "../src/contracts/index.js";
import type { GeminiImages, GeneratedImage } from "../src/images/gemini.js";
import { generateMockups, readProgress, type MockupOptions } from "../src/images/mockups.js";
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
const claude = { ask: async () => ({ embroidery_fidelity: 9, realism: 9, same_person: true, placement_ok: true, size_ok: true, stitch_texture_visible: true, garment_color_ok: true, extra_text: false, reasons: [] }) } as unknown as Claude;

function fakeGemini(batchState: { value: string }) {
  const calls = { generate: 0, submit: 0, check: 0 };
  const img = async (batch: boolean): Promise<GeneratedImage> => ({ data: await png(), mimeType: "image/png", model: "m", cost_usd: batch ? 0.05 : 0.1, batch });
  const gemini = {
    generate: async () => (calls.generate++, img(false)),
    submitBatch: async () => (calls.submit++, "batches/1"),
    checkBatch: async (_job: string, keys: string[]) => {
      calls.check++;
      if (batchState.value !== "JOB_STATE_SUCCEEDED") return { state: batchState.value, done: false };
      return { state: batchState.value, done: true, results: new Map(await Promise.all(keys.map(async (k) => [k, await img(true)] as const))) };
    },
  } as unknown as GeminiImages;
  return { gemini, calls };
}

const options = (gemini: GeminiImages): MockupOptions => ({
  claude, gemini, runId: "r1", design: { data: Buffer.from(""), mediaType: "image/jpeg", label: "" }, shotList, dir,
  model: "m", escalationModel: "m2", maxCostUsd: 3, outSize: [40, 50], batch: true, waitForBatch: false, log: () => {},
});

describe("generateMockups con batch sin esperar", () => {
  it("envía el batch, devuelve waiting y en otra llamada recoge los resultados sin repetir la primera toma", async () => {
    const state = { value: "JOB_STATE_RUNNING" };
    const { gemini, calls } = fakeGemini(state);

    const first = await generateMockups(options(gemini));
    expect(first).toEqual({ kind: "waiting", job: "batches/1", state: "JOB_STATE_RUNNING" });
    expect(calls).toMatchObject({ generate: 1, submit: 1 });
    expect((await readProgress(dir))?.batch?.state).toBe("JOB_STATE_RUNNING");

    expect((await generateMockups(options(gemini))).kind).toBe("waiting");
    expect(calls.submit).toBe(1);

    state.value = "JOB_STATE_SUCCEEDED";
    const done = await generateMockups(options(gemini));
    if (done.kind !== "done") throw new Error("debía terminar");
    expect(done.results.map((r) => [r.shot.shot_id, r.passed])).toEqual([["n-1", true], ["n-2", true], ["n-3", true]]);
    expect(calls.generate).toBe(1);
    expect(done.imageCost).toBeCloseTo(0.2);
  });
});
