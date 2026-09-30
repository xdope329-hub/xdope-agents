// Generación de las fotos de un producto (Gemini) con QA y un reintento por foto.
// Etapas: primera foto (fija a la persona modelo) → resto de fotos con esa identidad → reintentos de las que no pasan QA.
// Con batch, cada etapa es un trabajo batch de Gemini (mitad de precio) y la función devuelve "waiting" hasta que termine;
// el progreso queda en mockups/progress.json, así que se puede volver a llamar en otra corrida.
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { runQa, type QaResult } from "../agents/qa.js";
import type { MockupSet, Shot, ShotList } from "../contracts/index.js";
import type { Claude, ImageInput } from "../llm/claude.js";
import { imagePrice, type GeminiImages, type GeneratedImage, type ImageRequest, type ImageSize } from "./gemini.js";

const CONCURRENCY = 3;
const MAX_ATTEMPTS = 2;

export interface MockupOptions {
  claude: Claude;
  gemini: GeminiImages;
  runId: string;
  design: ImageInput; // foto del bordado en JPG
  shotList: ShotList;
  dir: string; // las fotos quedan en <dir>/mockups/
  model: string;
  retryModel: string;
  imageSize: ImageSize;
  maxCostUsd: number;
  outSize: [number, number];
  batch: boolean;
  // true: espera el batch aquí (trial). false: si sigue pendiente devuelve "waiting" y se recoge en otra corrida.
  waitForBatch: boolean;
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

export interface PendingBatch {
  job: string;
  model: string;
  keys: string[];
  stage: string;
  submitted_at: string;
  state: string;
  checked_at: string | null;
}

// Progreso guardado en mockups/progress.json.
export interface Progress {
  attempts: Record<string, Attempt[]>; // por shot_id
  batch: PendingBatch | null;
  image_cost_usd: number;
}

export type MockupOutcome = { kind: "done"; results: ShotResult[]; imageCost: number } | { kind: "waiting"; job: string; state: string };

export async function generateMockups(o: MockupOptions): Promise<MockupOutcome> {
  await mkdir(path.join(o.dir, "mockups"), { recursive: true });
  const progressFile = path.join(o.dir, "mockups", "progress.json");
  const identityFile = path.join(o.dir, "mockups", "_identity.jpg");
  const progress: Progress = (await readProgress(o.dir)) ?? { attempts: {}, batch: null, image_cost_usd: 0 };
  const save = () => writeFile(progressFile, JSON.stringify(progress, null, 2));
  const [first, ...rest] = o.shotList.shots;
  const attemptsOf = (s: Shot) => (progress.attempts[s.shot_id] ??= []);
  const passed = (s: Shot) => attemptsOf(s).some((a) => a.qa?.passed);
  const identity = async (): Promise<ImageInput | null> => ((await exists(identityFile)) ? { data: await readFile(identityFile), mediaType: "image/jpeg", label: "" } : null);

  const request = async (shot: Shot, model: string): Promise<ImageRequest> => {
    const last = attemptsOf(shot).at(-1);
    const fix = last?.qa?.reasons.length ? `\n\nFix these problems found in the previous attempt: ${last.qa.reasons.join("; ")}` : "";
    const id = shot === first ? null : await identity();
    return {
      model,
      prompt: `${shot.prompt}${sizeLine(o.shotList)}\n\nAvoid: ${shot.negative_prompt}${fix}`,
      refs: [
        { role: "Reference 1: the exact embroidery design. Reproduce it as raised thread embroidery, identical shapes and thread colors.", data: o.design.data, mimeType: "image/jpeg" },
        ...(id ? [{ role: "Reference 2: the model. Use this exact same person (face, hair, body).", data: id.data, mimeType: id.mediaType }] : []),
      ],
      aspectRatio: "4:5",
      imageSize: o.imageSize,
    };
  };

  // Guarda la candidata, pasa QA y registra el intento.
  const review = async (shot: Shot, model: string, img: GeneratedImage | Error) => {
    const n = attemptsOf(shot).length + 1;
    if (img instanceof Error) {
      attemptsOf(shot).push({ model, candidate: null, cost_usd: 0, qa: null, error: img.message });
      o.log(`  ${shot.shot_id}: sin imagen (${img.message})`);
      return;
    }
    progress.image_cost_usd += img.cost_usd;
    const data = await sharp(img.data).jpeg({ quality: 90 }).toBuffer();
    const candidate = `mockups/${shot.shot_id}/candidate_${n}.jpg`;
    await mkdir(path.join(o.dir, "mockups", shot.shot_id), { recursive: true });
    await writeFile(path.join(o.dir, candidate), data);
    const id = shot === first ? null : await identity();
    try {
      const qa = await runQa({ claude: o.claude, design: o.design, candidate: { data, mediaType: "image/jpeg", label: "" }, identity: id, shot, garmentColor: shot.color, size: o.shotList.analysis.embroidery_size_cm });
      attemptsOf(shot).push({ model: img.batch ? `${model} (batch)` : model, candidate, cost_usd: img.cost_usd, qa });
      o.log(`  ${shot.shot_id}: ${qa.passed ? "OK" : "NO PASA"} (bordado ${qa.embroidery_fidelity}/10, realismo ${qa.realism}/10)`);
    } catch (err) {
      attemptsOf(shot).push({ model, candidate, cost_usd: img.cost_usd, qa: null, error: `QA falló: ${err instanceof Error ? err.message : String(err)}` });
    }
    // La mejor foto de la primera toma es la referencia de identidad para las demás.
    if (shot === first) {
      const best = bestAttempt(attemptsOf(first));
      if (best?.candidate) await writeFile(identityFile, await sharp(path.join(o.dir, best.candidate)).resize(1024, 1024, { fit: "inside" }).jpeg({ quality: 85 }).toBuffer());
    }
  };

  // Siguiente etapa pendiente, o null si ya no queda nada por generar.
  const nextStage = (): { stage: string; shots: Shot[]; model: string } | null => {
    if (attemptsOf(first).length === 0) return { stage: "primera foto", shots: [first], model: o.model };
    const pending = rest.filter((s) => attemptsOf(s).length === 0);
    if (pending.length) return { stage: "fotos restantes", shots: pending, model: o.model };
    const retry = o.shotList.shots.filter((s) => !passed(s) && attemptsOf(s).length < MAX_ATTEMPTS);
    if (!retry.length) return null;
    const cost = retry.length * imagePrice(o.retryModel, o.imageSize, o.batch);
    if (progress.image_cost_usd + cost > o.maxCostUsd) {
      o.log(`  Sin reintentos: superarían el tope de USD ${o.maxCostUsd} (van USD ${progress.image_cost_usd.toFixed(2)})`);
      return null;
    }
    return { stage: "reintentos", shots: retry, model: o.retryModel };
  };

  for (;;) {
    if (progress.batch) {
      const b = progress.batch;
      const check = await o.gemini.checkBatch(b.job, b.keys, b.model, o.imageSize);
      b.state = check.state;
      b.checked_at = new Date().toISOString();
      await save();
      if (!check.done) {
        if (!o.waitForBatch) return { kind: "waiting", job: b.job, state: check.state };
        o.log(`  batch (${b.stage}) ${check.state}; vuelvo a revisar en 60 s`);
        await new Promise((r) => setTimeout(r, 60_000));
        continue;
      }
      o.log(`Batch de ${b.stage} ${check.results ? "terminado" : `terminó en ${check.state}`}; revisando fotos…`);
      for (const key of b.keys) {
        const shot = o.shotList.shots.find((s) => s.shot_id === key);
        if (shot) await review(shot, b.model, check.results?.get(key) ?? new Error(`Batch ${check.state}: ${check.error ?? "sin detalle"}`));
      }
      progress.batch = null;
      await save();
      continue;
    }

    const next = nextStage();
    if (!next) break;
    if (o.batch) {
      o.log(`Enviando batch de ${next.stage} (${next.shots.length} foto${next.shots.length > 1 ? "s" : ""})…`);
      const requests = await Promise.all(next.shots.map(async (s) => ({ key: s.shot_id, req: await request(s, next.model) })));
      const job = await o.gemini.submitBatch(requests, `${o.runId}-${next.stage.replace(/\s+/g, "-")}`);
      progress.batch = { job, model: next.model, keys: requests.map((r) => r.key), stage: next.stage, submitted_at: new Date().toISOString(), state: "JOB_STATE_PENDING", checked_at: null };
      await save();
      o.log(`  trabajo batch: ${job}`);
      continue;
    }
    o.log(`Generando ${next.stage}…`);
    for (let i = 0; i < next.shots.length; i += CONCURRENCY) {
      await Promise.all(
        next.shots.slice(i, i + CONCURRENCY).map(async (s) => {
          const img = await o.gemini.generate(await request(s, next.model)).catch((err: unknown) => (err instanceof Error ? err : new Error(String(err))));
          await review(s, next.model, img);
        }),
      );
    }
    await save();
  }

  // Foto final por toma: el mejor intento, recortado a outSize.
  const results: ShotResult[] = [];
  for (const shot of o.shotList.shots) {
    const attempts = attemptsOf(shot);
    const best = bestAttempt(attempts);
    let file: string | null = null;
    if (best?.candidate) {
      file = `mockups/${shot.shot_id}.jpg`;
      const [w, h] = o.outSize;
      await writeFile(path.join(o.dir, file), await sharp(path.join(o.dir, best.candidate)).resize(w, h, { fit: "cover", position: "attention" }).jpeg({ quality: 90 }).toBuffer());
    }
    results.push({ shot, file, attempts, passed: !!best?.qa?.passed });
  }
  return { kind: "done", results, imageCost: progress.image_cost_usd };
}

// Tamaño del bordado en términos que el modelo de imágenes respeta mejor que solo centímetros:
// proporción del ancho del pecho (un hoodie de adulto mide unos 55 cm de ancho a la altura del pecho).
export function sizeLine(shotList: ShotList): string {
  const size = shotList.analysis.embroidery_size_cm;
  if (!size) return "";
  const pct = Math.round((size.w / 55) * 100);
  const where = shotList.analysis.best_placement === "chest_left" ? "on the left chest (wearer's left), above the heart" : "centered on the upper chest, below the neckline";
  return `\n\nEMBROIDERY SIZE IS CRITICAL: the embroidery measures only ${size.w} cm wide × ${size.h} cm tall, ${where}. That is about ${pct}% of the chest width${size.w <= 12 ? ", roughly the size of a palm" : ""}. Keep plenty of plain hoodie fabric visible around it. Do NOT enlarge it, do not let it cover the chest, and keep this exact size in every shot.`;
}

function bestAttempt(attempts: Attempt[]): Attempt | null {
  const score = (a: Attempt) => (a.qa ? (a.qa.passed ? 100 : 0) + a.qa.embroidery_fidelity + a.qa.realism : -1);
  return attempts.filter((a) => a.candidate).sort((a, b) => score(b) - score(a))[0] ?? null;
}

export async function readProgress(dir: string): Promise<Progress | null> {
  const file = path.join(dir, "mockups", "progress.json");
  if (!(await exists(file))) return null;
  const p = JSON.parse(await readFile(file, "utf8"));
  return p.attempts ? p : null; // formato anterior: se ignora
}

async function exists(p: string) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
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
