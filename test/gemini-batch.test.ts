import { describe, expect, it } from "vitest";
import type { GoogleGenAI } from "@google/genai";
import { GeminiImages, type ImageRequest } from "../src/images/gemini.js";

const req: ImageRequest = { model: "gemini-3.1-flash-image", prompt: "p", refs: [], aspectRatio: "4:5", imageSize: "2K" };
const imagePart = (b: string) => ({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: Buffer.from(b).toString("base64") } }] } }] });

function fakeAi(states: string[], inlinedResponses: unknown[]) {
  let calls = 0;
  const created: unknown[] = [];
  const ai = {
    batches: {
      create: async (p: unknown) => {
        created.push(p);
        return { name: "batches/1", state: "JOB_STATE_PENDING" };
      },
      get: async () => {
        const state = states[Math.min(calls++, states.length - 1)];
        return { name: "batches/1", state, dest: { inlinedResponses } };
      },
    },
  } as unknown as GoogleGenAI;
  return { ai, created };
}

describe("GeminiImages.generateBatch", () => {
  it("espera al batch y mapea cada resultado por clave, a mitad de precio", async () => {
    const { ai, created } = fakeAi(
      ["JOB_STATE_RUNNING", "JOB_STATE_SUCCEEDED"],
      [
        { metadata: { key: "b" }, response: imagePart("img-b") },
        { metadata: { key: "a" }, error: { message: "bloqueada" } },
      ],
    );
    const gemini = new GeminiImages("x", ai);
    const out = await gemini.generateBatch(
      [
        { key: "a", req },
        { key: "b", req },
        { key: "c", req },
      ],
      { displayName: "t", pollSeconds: 0 },
    );
    expect(created).toHaveLength(1);
    const b = out.get("b");
    expect(b).not.toBeInstanceOf(Error);
    if (!(b instanceof Error)) {
      expect(b?.data.toString()).toBe("img-b");
      expect(b?.cost_usd).toBeCloseTo(0.0505);
      expect(b?.batch).toBe(true);
    }
    expect(out.get("a")).toBeInstanceOf(Error);
    expect(out.get("c")).toBeInstanceOf(Error);
  });

  it("falla si el trabajo termina mal", async () => {
    const { ai } = fakeAi(["JOB_STATE_FAILED"], []);
    await expect(new GeminiImages("x", ai).generateBatch([{ key: "a", req }], { displayName: "t", pollSeconds: 0 })).rejects.toThrow("JOB_STATE_FAILED");
  });

  it("rechaza mezclar modelos en un batch", async () => {
    const { ai } = fakeAi(["JOB_STATE_SUCCEEDED"], []);
    const other = { ...req, model: "gemini-3-pro-image" };
    await expect(
      new GeminiImages("x", ai).generateBatch(
        [
          { key: "a", req },
          { key: "b", req: other },
        ],
        { displayName: "t", pollSeconds: 0 },
      ),
    ).rejects.toThrow("un modelo");
  });
});

describe("Nano Banana original", () => {
  it("no envía imageSize, que ese modelo no acepta", async () => {
    const { ai, created } = fakeAi(["JOB_STATE_SUCCEEDED"], []);
    await new GeminiImages("x", ai).submitBatch([{ key: "a", req: { ...req, model: "gemini-2.5-flash-image", imageSize: "1K" } }], "t");
    const src = (created[0] as { src: Array<{ config: { imageConfig: Record<string, unknown> } }> }).src;
    expect(src[0].config.imageConfig).toEqual({ aspectRatio: "4:5" });
  });
});
