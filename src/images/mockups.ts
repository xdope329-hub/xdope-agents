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
  // true: si QA rechaza fotos, se detiene y espera la decisión de Diego (aprobar o reintentar) antes de gastar en reintentos.
  reviewBeforeRetry: boolean;
  log: (msg: string) => void;
  colorDescriptions?: Record<string, string>; // nombre del color → descripción en inglés
  placementRefsDir?: string; // fotos de ejemplo de ubicación y escala: <preset>.jpg y enmarcado.jpg
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
  // Decisión de Diego tras revisar: "approve" aprueba las fotos actuales por encima de QA; "retry" lanza los reintentos.
  decision?: "approve" | "retry" | null;
  awaiting_review?: AwaitingReview | null;
}

export interface AwaitingReview {
  rejected: string[]; // fotos que QA no aprobó
  can_retry: boolean;
  retry_cost_usd: number;
  since: string;
}

export type MockupOutcome =
  | { kind: "done"; results: ShotResult[]; imageCost: number }
  | { kind: "waiting"; job: string; state: string }
  | { kind: "review"; results: ShotResult[]; imageCost: number; awaiting: AwaitingReview };

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

  // Foto de ejemplo de ubicación y escala del bordado según su tamaño estándar (o enmarcado).
  const placementRef = await (async () => {
    const a = o.shotList.analysis;
    if (!o.placementRefsDir || !a.size_preset) return null;
    const file = path.join(o.placementRefsDir, `${a.framed ? "enmarcado" : a.size_preset}.jpg`);
    return (await exists(file)) ? await readFile(file) : null;
  })();

  const request = async (shot: Shot, model: string): Promise<ImageRequest> => {
    const last = attemptsOf(shot).at(-1);
    const fix = last?.qa?.reasons.length ? `\n\nFix these problems found in the previous attempt: ${last.qa.reasons.join("; ")}` : "";
    const id = shot === first ? null : await identity();
    return {
      model,
      prompt: `${shot.prompt}${hoodieLine(shot, o.shotList, o.colorDescriptions)}${sizeLine(o.shotList, shot)}${FACE_LINE}${modelFaceLine(o.shotList, !!id)}\n\nAvoid: ${shot.negative_prompt}${fix}`,
      refs: [
        {
          role: "Reference 1: ONLY the embroidery design to reproduce as raised thread embroidery, identical shapes and thread colors. Ignore this photo's background (fabric, felt, hoop, paper), framing and scale: it is not the garment and not the size.",
          data: o.design.data,
          mimeType: "image/jpeg",
        },
        ...(id
          ? [{ role: "Reference 2: ONLY the face and hair of the model, cropped. Use this exact same person, but create a NEW photograph with the pose, camera angle, framing and background described in the prompt. Never copy the composition of another photo.", data: id.data, mimeType: id.mediaType }]
          : []),
        ...(placementRef
          ? [{ role: "Placement reference: ONLY shows where the embroidery sits on the hoodie and how big it is relative to the body. Copy that position and scale. Do NOT copy its person, pose, background, garment color or design.", data: placementRef, mimeType: "image/jpeg" }]
          : []),
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
      if (best?.candidate) await writeFile(identityFile, await faceCrop(path.join(o.dir, best.candidate)));
    }
  };

  // Siguiente etapa pendiente, una pausa para que Diego revise, o null si ya no queda nada por generar.
  const nextStage = (): { stage: string; shots: Shot[]; model: string } | { review: AwaitingReview } | null => {
    if (attemptsOf(first).length === 0) return { stage: "primera foto", shots: [first], model: o.model };
    const pending = rest.filter((s) => attemptsOf(s).length === 0);
    if (pending.length) return { stage: "fotos restantes", shots: pending, model: o.model };
    if (progress.decision === "approve") return null;
    const rejected = o.shotList.shots.filter((s) => !passed(s));
    if (!rejected.length) return null;
    const retry = rejected.filter((s) => attemptsOf(s).length < MAX_ATTEMPTS);
    const cost = retry.length * imagePrice(o.retryModel, o.imageSize, o.batch);
    const canRetry = retry.length > 0 && progress.image_cost_usd + cost <= o.maxCostUsd;
    if (o.reviewBeforeRetry && progress.decision !== "retry") {
      return { review: { rejected: rejected.map((s) => s.shot_id), can_retry: canRetry, retry_cost_usd: Number(cost.toFixed(3)), since: new Date().toISOString() } };
    }
    if (!canRetry) {
      if (retry.length) o.log(`  Sin reintentos: superarían el tope de USD ${o.maxCostUsd} (van USD ${progress.image_cost_usd.toFixed(2)})`);
      return null;
    }
    progress.decision = null; // la decisión de reintentar se usa una vez
    return { stage: "reintentos", shots: retry, model: o.retryModel };
  };

  // Foto final por toma: el mejor intento, recortado a outSize. Con "approve", las fotos que existen quedan aprobadas.
  const finalize = async (): Promise<ShotResult[]> => {
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
      results.push({ shot, file, attempts, passed: !!best?.qa?.passed || (progress.decision === "approve" && !!file) });
    }
    return results;
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
    if ("review" in next) {
      progress.awaiting_review = next.review;
      await save();
      o.log(`QA rechazó ${next.review.rejected.length} foto(s); esperando tu revisión (aprobar o reintentar)`);
      return { kind: "review", results: await finalize(), imageCost: progress.image_cost_usd, awaiting: next.review };
    }
    progress.awaiting_review = null;
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

  progress.awaiting_review = null;
  await save();
  return { kind: "done", results: await finalize(), imageCost: progress.image_cost_usd };
}

// Los bordados suelen ser personajes o retratos: la cara es lo primero que se deforma.
const FACE_LINE =
  "\n\nFACE DETAILS OF THE DESIGN: if the embroidery shows a face or character, keep every facial detail exactly as in the reference: eyes, eyebrows, glasses, nose, mouth, facial hair, skin tone, expression and the lines that define them. Do not simplify, redraw, beautify or change the expression of the embroidered face.";

// Cara de la persona modelo: la misma en las 3 fotos y con detalle realista.
export function modelFaceLine(shotList: ShotList, hasIdentityRef: boolean): string {
  const same = hasIdentityRef
    ? "It must be the exact same person as Reference 2: identical face shape, eyes and eye color, eyebrows, nose, lips, jawline, skin tone, marks or freckles, age, hairstyle and hair color, and the same facial hair (or none if clean-shaven). Do not change the face between shots."
    : `Model: ${shotList.concept.description}. Follow the facial features exactly as described, including facial hair or its absence.`;
  return `\n\nMODEL FACE: ${same} Realistic facial detail: natural skin texture with visible pores, subtle natural asymmetry, sharp and natural eyes, well-defined eyebrows and lips; no plastic, blurred or airbrushed face.`;
}

// Tamaño del bordado en términos que el modelo de imágenes respeta mejor que solo centímetros:
// proporción del ancho del pecho (un hoodie de adulto mide unos 55 cm de ancho a la altura del pecho).
// Tamaño del bordado en % del ancho de la imagen según el encuadre, que el modelo respeta mejor que los centímetros.
// En un plano de cintura a cabeza la imagen abarca ~100 cm de ancho; en el primer plano del pecho, ~35 cm.
export function sizeLine(shotList: ShotList, shot: Shot): string {
  const size = shotList.analysis.embroidery_size_cm;
  if (!size) return "";
  const frameCm = shot.framing === "detail" ? 35 : 100;
  const pct = Math.max(1, Math.round((size.w / frameCm) * 100));
  const where =
    shotList.analysis.best_placement === "chest_left"
      ? "on the wearer's left chest, about 10 cm below the shoulder seam, halfway between the center of the chest and the side"
      : "centered on the upper chest, its top about 8–10 cm below the neckline seam, well above the kangaroo pocket";
  const feel = size.w <= 10 ? "small, about the size of a palm" : size.w <= 15 ? "medium, about the width of a hand with fingers spread" : "about the width of a sheet of letter paper";
  return `\n\nEMBROIDERY SIZE IS CRITICAL: a standard ${size.w} × ${size.h} cm embroidery (${feel}), ${where}. In this image it spans about ${pct}% of the image width. Plenty of plain hoodie fabric must be visible around it on every side. Do NOT enlarge it and never let it cover the chest from shoulder to shoulder.`;
}

// El hoodie siempre presente y del color pedido.
export function hoodieLine(shot: Shot, shotList: ShotList, descriptions: Record<string, string> = {}): string {
  const color = shotList.colors.find((c) => c.name === shot.color);
  const desc = descriptions[shot.color] ? `${descriptions[shot.color]}, ` : "";
  const detail = shot.framing === "detail" ? " This is a close-up of the chest of the person wearing it: the fleece fabric, the neckline and the edge of the hood are visible around the embroidery." : "";
  return `\n\nGARMENT: the person is wearing a ${shot.color} pullover hoodie (${desc}${color?.hex ?? ""}) with hood and kangaroo pocket, heavy cotton fleece. The hoodie color must be exactly this color.${detail} Never show a loose patch, a fabric swatch or an embroidery hoop.`;
}

// Referencia de identidad: solo la cabeza (parte alta central de la foto frontal). Con la foto entera, el modelo
// copiaba la misma pose y el mismo encuadre en las otras tomas.
export async function faceCrop(file: string): Promise<Buffer> {
  const img = sharp(file);
  const { width = 0, height = 0 } = await img.metadata();
  const w = Math.round(width * 0.6);
  const h = Math.round(height * 0.45);
  return img
    .extract({ left: Math.round((width - w) / 2), top: 0, width: w, height: h })
    .resize(768, 768, { fit: "inside" })
    .jpeg({ quality: 85 })
    .toBuffer();
}

function bestAttempt(attempts: Attempt[]): Attempt | null {
  const score = (a: Attempt) => (a.qa ? (a.qa.passed ? 100 : 0) + a.qa.embroidery_fidelity + a.qa.realism : -1);
  return attempts.filter((a) => a.candidate).sort((a, b) => score(b) - score(a))[0] ?? null;
}

// Guarda la decisión de Diego para que la próxima corrida la aplique.
export async function decide(dir: string, decision: "approve" | "retry") {
  const p = await readProgress(dir);
  if (!p?.awaiting_review) throw new Error("Este lote no está esperando revisión");
  if (decision === "retry" && !p.awaiting_review.can_retry) throw new Error("No quedan reintentos posibles (ya se hicieron o superan el tope de costo)");
  p.decision = decision;
  p.awaiting_review = null;
  await writeFile(path.join(dir, "mockups", "progress.json"), JSON.stringify(p, null, 2));
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
