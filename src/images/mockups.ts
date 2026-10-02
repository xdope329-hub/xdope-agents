// Generación de las fotos de un producto (Gemini) con QA y reintento con el modelo de escalamiento.
// La primera toma fija a la persona modelo; las demás la usan como referencia de identidad.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { runQa, type QaResult } from "../agents/qa.js";
import type { MockupSet, Shot, ShotList } from "../contracts/index.js";
import type { Claude, ImageInput } from "../llm/claude.js";
import type { GeminiImages, GeneratedImage, ImageRequest, ImageSize } from "./gemini.js";

const CONCURRENCY = 3;

export interface MockupOptions {
  claude: Claude;
  gemini: GeminiImages;
  runId: string;
  design: ImageInput; // foto del bordado en JPG
  shotList: ShotList;
  dir: string; // las fotos quedan en <dir>/mockups/
  model: string;
  escalationModel: string;
  maxCostUsd: number;
  outSize: [number, number];
  imageSize: ImageSize; // se genera a esta resolución y se ajusta a outSize
  batch: boolean;
  log: (msg: string) => void;
}

export interface Attempt {
  model: string;
  candidate: string | null;
  cost_usd: number;
  qa: QaResult | null;
  error?: string;
}

export interface ShotResult {
  shot: Shot;
  file: string | null; // relativo a dir
  attempts: Attempt[];
  passed: boolean;
}

export async function generateMockups(o: MockupOptions): Promise<{ results: ShotResult[]; imageCost: number }> {
  await mkdir(path.join(o.dir, "mockups"), { recursive: true });
  let imageCost = 0;

  const request = (shot: Shot, identity: ImageInput | null, model: string, fix: string): ImageRequest => ({
    model,
    prompt: `${shot.prompt}\n\nAvoid: ${shot.negative_prompt}${fix}`,
    refs: [
      { role: "Reference 1: the exact embroidery design. Reproduce it as raised thread embroidery, identical shapes and thread colors.", data: o.design.data, mimeType: "image/jpeg" },
      ...(identity ? [{ role: "Reference 2: the model. Use this exact same person (face, hair, body).", data: identity.data, mimeType: identity.mediaType }] : []),
    ],
    aspectRatio: "4:5",
    imageSize: o.imageSize,
  });

  // `pregenerated` es el resultado del primer intento cuando ya salió en un batch.
  const generateShot = async (shot: Shot, identity: ImageInput | null, pregenerated?: GeneratedImage | Error): Promise<ShotResult & { image?: Buffer }> => {
    const result: ShotResult & { image?: Buffer } = { shot, file: null, attempts: [], passed: false };
    let best: { data: Buffer; qa: QaResult; score: number } | null = null;
    let fix = "";
    for (const [attempt, model] of [o.model, o.escalationModel].entries()) {
      const fromBatch = attempt === 0 ? pregenerated : undefined;
      if (!fromBatch && imageCost >= o.maxCostUsd) {
        result.attempts.push({ model, candidate: null, cost_usd: 0, qa: null, error: `Tope de costo USD ${o.maxCostUsd} alcanzado` });
        break;
      }
      try {
        if (fromBatch instanceof Error) throw fromBatch;
        const img = fromBatch ?? (await o.gemini.generate(request(shot, identity, model, fix)));
        if (!fromBatch) imageCost += img.cost_usd;
        const data = await sharp(img.data).jpeg({ quality: 90 }).toBuffer();
        const candidate = `mockups/${shot.shot_id}/candidate_${attempt + 1}.jpg`;
        await mkdir(path.join(o.dir, "mockups", shot.shot_id), { recursive: true });
        await writeFile(path.join(o.dir, candidate), data);
        const qa = await runQa({ claude: o.claude, design: o.design, candidate: { data, mediaType: "image/jpeg", label: "" }, identity, shot, garmentColor: shot.color });
        result.attempts.push({ model: img.batch ? `${model} (batch)` : model, candidate, cost_usd: img.cost_usd, qa });
        const score = qa.embroidery_fidelity + qa.realism;
        if (!best || score > best.score) best = { data, qa, score };
        if (qa.passed) break;
        fix = `\n\nFix these problems found in the previous attempt: ${qa.reasons.join("; ")}`;
      } catch (err) {
        result.attempts.push({ model, candidate: null, cost_usd: 0, qa: null, error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (best) {
      const file = `mockups/${shot.shot_id}.jpg`;
      const [w, h] = o.outSize;
      const final = await sharp(best.data).resize(w, h, { fit: "cover", position: "attention" }).jpeg({ quality: 90 }).toBuffer();
      await writeFile(path.join(o.dir, file), final);
      result.file = file;
      result.passed = best.qa.passed;
      result.image = best.data;
    }
    const last = result.attempts.at(-1);
    o.log(`  ${shot.shot_id}: ${result.passed ? "OK" : "NO PASA"}${last?.qa ? ` (bordado ${last.qa.embroidery_fidelity}/10, realismo ${last.qa.realism}/10)` : last?.error ? ` (${last.error})` : ""}`);
    return result;
  };

  o.log("Generando fotos…");
  const [first, ...rest] = o.shotList.shots;
  const firstResult = await generateShot(first, null);
  const results: ShotResult[] = [firstResult];
  // La referencia de identidad va reducida para no inflar las solicitudes (sobre todo en batch).
  const identity: ImageInput | null = firstResult.image
    ? { data: await sharp(firstResult.image).resize(1024, 1024, { fit: "inside" }).jpeg({ quality: 85 }).toBuffer(), mediaType: "image/jpeg", label: "" }
    : null;
  let pregenerated = new Map<string, GeneratedImage | Error>();
  if (o.batch && rest.length > 0) {
    o.log(`Enviando ${rest.length} fotos en batch (mitad de precio; puede tardar)…`);
    pregenerated = await o.gemini
      .generateBatch(
        rest.map((shot) => ({ key: shot.shot_id, req: request(shot, identity, o.model, "") })),
        {
          displayName: o.runId,
          onCreated: (name) => {
            o.log(`  trabajo batch: ${name}`);
            void writeFile(path.join(o.dir, "batch-job.txt"), name + "\n");
          },
          log: o.log,
        },
      )
      .catch((err) => {
        o.log(`  El batch falló (${err instanceof Error ? err.message : String(err)}); sigo en modo normal`);
        return new Map<string, GeneratedImage | Error>();
      });
    for (const r of pregenerated.values()) if (!(r instanceof Error)) imageCost += r.cost_usd;
  }
  for (let i = 0; i < rest.length; i += CONCURRENCY) {
    results.push(...(await Promise.all(rest.slice(i, i + CONCURRENCY).map((s) => generateShot(s, identity, pregenerated.get(s.shot_id))))));
  }
  for (const r of results) delete (r as { image?: Buffer }).image;
  return { results, imageCost };
}

// MockupSet (specs/03) con las tomas que produjeron al menos una imagen.
export function toMockupSet(runId: string, results: ShotResult[], imageCost: number): MockupSet {
  return {
    run_id: runId,
    shots: results
      .filter((r) => r.attempts.some((a) => a.candidate))
      .map((r) => {
        const qa = [...r.attempts].reverse().find((a) => a.qa)?.qa;
        return {
          shot_id: r.shot.shot_id,
          candidates: r.attempts
            .filter((a) => a.candidate)
            .map((a) => ({ path: a.candidate!, api: "gemini", model: a.model, prompt: r.shot.prompt, seed: null, cost_usd: a.cost_usd, fallback: false })),
          final: r.passed ? r.file : null,
          qa: {
            passed: r.passed,
            scores: (qa ? { embroidery_fidelity: qa.embroidery_fidelity, realism: qa.realism } : {}) as Record<string, number>,
            reasons: qa?.reasons ?? [],
          },
        };
      }),
    total_cost_usd: Number(imageCost.toFixed(3)),
  };
}

// Colores con todas sus tomas aprobadas por QA.
export function approvedColors(shotList: ShotList, results: ShotResult[]): string[] {
  return shotList.colors
    .map((c) => c.name)
    .filter((name) => {
      const shots = results.filter((r) => r.shot.color === name);
      return shots.length > 0 && shots.every((r) => r.passed);
    });
}
