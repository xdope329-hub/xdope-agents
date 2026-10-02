// Prueba de punta a punta sin publicar: foto de bordado → Curador → Director de arte →
// generación (Gemini) → QA → mockups 1080×1350 y un review.html para revisar.
// Uso: npm run trial -- [--batch] <ruta o URL de imagen> [...]
// --batch: la primera foto (la que fija a la persona modelo) sale en modo normal y las demás
// van en un trabajo batch de Gemini a mitad de precio; puede tardar desde minutos hasta horas.
// --recolor: experimento (specs/04). Además de las fotos generadas, tiñe por código las fotos del color más claro
// a los otros colores y las pone al lado en review.html para comparar.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { z } from "zod";
import { runCurator, type StoreCategory } from "../agents/curator.js";
import { runDirector, type GarmentColor } from "../agents/director.js";
import { GeminiImages } from "../images/gemini.js";
import { generateMockups, type ShotResult } from "../images/mockups.js";
import { garmentMask, lightestColor, recolorGarment } from "../images/recolor.js";
import { runQa } from "../agents/qa.js";
import type { ShotList } from "../contracts/index.js";
import { Claude, type ImageInput } from "../llm/claude.js";
import { renderReview } from "../review.js";

const env = process.env;
const MODEL = env.IMAGE_MODEL ?? "gemini-3.1-flash-image";
const ESCALATION = env.IMAGE_ESCALATION_MODEL ?? MODEL;
const MAX_COST = Number(env.MAX_IMAGE_COST_PER_PRODUCT ?? 3);
const [OUT_W, OUT_H] = (env.IMAGE_OUTPUT_SIZE ?? "1080x1350").split("x").map(Number);
// 1K (≈ 928×1152 en 4:5) se amplía un poco a 1080×1350; cuesta un tercio menos que 2K (specs/04).
const IMAGE_SIZE = z.enum(["1K", "2K", "4K"]).parse(env.IMAGE_SIZE ?? "1K");

const args = process.argv.slice(2);
const BATCH = args.includes("--batch") || env.IMAGE_USE_BATCH === "true";
const RECOLOR = args.includes("--recolor");
const sources = args.filter((a) => !a.startsWith("--")).flatMap((a) => a.split(/[\s,]+/)).filter(Boolean);
if (sources.length === 0) throw new Error("Pasa al menos una ruta o URL de imagen de bordado");
if (!env.GEMINI_API_KEY) throw new Error("Falta GEMINI_API_KEY");
if (!env.ANTHROPIC_API_KEY) throw new Error("Falta ANTHROPIC_API_KEY");

const claude = new Claude();
const gemini = new GeminiImages(env.GEMINI_API_KEY);
const palette: GarmentColor[] = JSON.parse(await readFile("config/garment-colors.json", "utf8"));
const categories: StoreCategory[] = JSON.parse(await readFile("config/categories.trial.json", "utf8"));
const trialId = `trial-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
const outDir = path.join(env.RUNS_DIR ?? "runs", trialId);

const summaries = [];
for (const [i, src] of sources.entries()) {
  const designId = `design-${i + 1}`;
  const dir = path.join(outDir, designId);
  await mkdir(path.join(dir, "mockups"), { recursive: true });
  const log = (msg: string) => console.log(`[${designId}] ${msg}`);
  try {
    summaries.push(await runDesign(src, designId, dir, log));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`FALLÓ: ${message}`);
    summaries.push({ designId, source: src, error: message });
  }
}

await writeFile(path.join(outDir, "summary.json"), JSON.stringify({ trialId, claude: claude.usage, designs: summaries }, null, 2));
await writeFile(path.join(outDir, "review.html"), renderReview(summaries));
console.log(`\nListo: ${outDir}/review.html`);
console.log(`Costo Claude: USD ${claude.usage.cost_usd.toFixed(2)}`);

async function runDesign(src: string, designId: string, dir: string, log: (m: string) => void) {
  const raw = /^https?:\/\//.test(src) ? Buffer.from(await (await fetch(src)).arrayBuffer()) : await readFile(src);
  const designJpg = await sharp(raw).rotate().resize(1536, 1536, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 92 }).toBuffer();
  await writeFile(path.join(dir, "design.jpg"), designJpg);
  const design: ImageInput = { data: designJpg, mediaType: "image/jpeg", label: "" };

  log("Curador: título, descripción y categorías…");
  const curator = await runCurator({ claude, runId: trialId, designId, design, categories, selectionReason: "prueba manual" });
  await writeFile(path.join(dir, "curator.json"), JSON.stringify(curator, null, 2));
  log(`  ${curator.title} | ${curator.categories.map((c) => `${c.name} (${c.role})`).join(", ")}`);

  log("Director de arte: colores, concepto y prompts…");
  const { shotList, embroideryDescription } = await runDirector({ claude, runId: trialId, design, title: curator.title, palette });
  await writeFile(path.join(dir, "shots.json"), JSON.stringify({ ...shotList, embroideryDescription }, null, 2));
  log(`  Colores: ${shotList.colors.map((c) => c.name).join(", ")} | ${shotList.shots.length} tomas`);

  const { results, imageCost } = await generateMockups({
    claude,
    gemini,
    runId: `${trialId}-${designId}`,
    design,
    shotList,
    dir,
    model: MODEL,
    escalationModel: ESCALATION,
    maxCostUsd: MAX_COST,
    outSize: [OUT_W, OUT_H],
    imageSize: IMAGE_SIZE,
    batch: BATCH,
    log,
  });

  const recolor = RECOLOR ? await recolorShots(shotList, results, design, dir, log) : null;
  const passed = results.filter((r) => r.passed).length;
  log(`Fotos aprobadas: ${passed}/${results.length} | costo imágenes USD ${imageCost.toFixed(2)}`);
  const summary = {
    designId,
    source: src,
    curator,
    colors: shotList.colors,
    concept: shotList.concept.description,
    shots: results.map(({ shot, file, attempts, passed }) => ({ shot_id: shot.shot_id, color: shot.color, framing: shot.framing, prompt: shot.prompt, file, passed, attempts })),
    image_cost_usd: Number(imageCost.toFixed(3)),
    batch: BATCH,
    recolor,
  };
  await writeFile(path.join(dir, "qa.json"), JSON.stringify(summary, null, 2));
  return summary;
}

// Experimento de recoloreado: una máscara por pose del color más claro y un teñido por cada otro color.
async function recolorShots(shotList: ShotList, results: ShotResult[], design: ImageInput, dir: string, log: (m: string) => void) {
  const base = lightestColor(shotList.colors);
  log(`Recoloreado: base ${base.name}…`);
  await mkdir(path.join(dir, "mockups", "recolor"), { recursive: true });
  const byColor = (name: string) => results.filter((r) => r.shot.color === name);
  let cost = 0;
  const shots = [];
  for (const [i, src] of byColor(base.name).entries()) {
    if (!src.file) continue;
    const photo = await readFile(path.join(dir, src.file));
    let mask: Buffer;
    try {
      const m = await garmentMask(gemini, photo, MODEL, IMAGE_SIZE);
      cost += m.cost_usd;
      mask = m.data;
      await writeFile(path.join(dir, "mockups", "recolor", `${src.shot.shot_id}-mask.png`), await sharp(mask).png().toBuffer());
    } catch (err) {
      log(`  máscara de ${src.shot.shot_id} falló: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    for (const color of shotList.colors.filter((c) => c.name !== base.name)) {
      const target = byColor(color.name)[i]?.shot;
      if (!target) continue;
      const data = await recolorGarment(photo, mask, base.hex, color.hex);
      const file = `mockups/recolor/${target.shot_id}.jpg`;
      await writeFile(path.join(dir, file), data);
      const qa = await runQa({ claude, design, candidate: { data, mediaType: "image/jpeg", label: "" }, identity: null, shot: target, garmentColor: color.name });
      log(`  ${target.shot_id} (teñida): ${qa.passed ? "OK" : "NO PASA"} (bordado ${qa.embroidery_fidelity}/10, realismo ${qa.realism}/10)`);
      shots.push({ shot_id: target.shot_id, from: src.shot.shot_id, color: color.name, file, qa });
    }
  }
  return { base: base.name, cost_usd: Number(cost.toFixed(3)), shots };
}
