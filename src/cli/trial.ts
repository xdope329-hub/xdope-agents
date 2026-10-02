// Prueba de punta a punta sin publicar: foto de bordado → Curador → Director de arte →
// generación (Gemini) → QA → mockups 1080×1350 y un review.html para revisar.
// Uso: npm run trial -- [--batch] <ruta o URL de imagen> [...]
// --batch: la primera foto (la que fija a la persona modelo) sale en modo normal y las demás
// van en un trabajo batch de Gemini a mitad de precio; puede tardar desde minutos hasta horas.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { runCurator, type StoreCategory } from "../agents/curator.js";
import { runDirector, type GarmentColor } from "../agents/director.js";
import { GeminiImages } from "../images/gemini.js";
import { generateMockups } from "../images/mockups.js";
import { Claude, type ImageInput } from "../llm/claude.js";
import { renderReview } from "../review.js";

const env = process.env;
const MODEL = env.IMAGE_MODEL ?? "gemini-3.1-flash-image";
const ESCALATION = env.IMAGE_ESCALATION_MODEL ?? MODEL;
const MAX_COST = Number(env.MAX_IMAGE_COST_PER_PRODUCT ?? 3);
const [OUT_W, OUT_H] = (env.IMAGE_OUTPUT_SIZE ?? "1080x1350").split("x").map(Number);

const args = process.argv.slice(2);
const BATCH = args.includes("--batch") || env.IMAGE_USE_BATCH === "true";
const sources = args.filter((a) => a !== "--batch").flatMap((a) => a.split(/[\s,]+/)).filter(Boolean);
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
    batch: BATCH,
    log,
  });

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
  };
  await writeFile(path.join(dir, "qa.json"), JSON.stringify(summary, null, 2));
  return summary;
}
