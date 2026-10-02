// Prueba de punta a punta sin publicar: foto de bordado → Curador → Director de arte →
// generación (Gemini) → QA → mockups 1080×1350 y un review.html para revisar.
// Uso: npm run trial -- [--batch] <ruta o URL de imagen> [...]
// --batch: la primera foto (la que fija a la persona modelo) sale en modo normal y las demás
// van en un trabajo batch de Gemini a mitad de precio; puede tardar desde minutos hasta horas.
// --recolor [Color1,Color2]: experimento (specs/04). Tiñe por código las fotos del color elegido a otros colores
// de la paleta (por defecto los 2 más distintos) y las muestra al lado en review.html para comparar.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { runCurator, type StoreCategory } from "../agents/curator.js";
import { runDirector, type GarmentColor } from "../agents/director.js";
import { GeminiImages } from "../images/gemini.js";
import { generateMockups, type ShotResult } from "../images/mockups.js";
import { garmentMask, recolorGarment } from "../images/recolor.js";
import { runQa } from "../agents/qa.js";
import { deltaE, hexToRgb, rgbToLab } from "../color.js";
import type { ShotList } from "../contracts/index.js";
import { Claude, type ImageInput } from "../llm/claude.js";
import { QUALITY, parseQuality } from "../quality.js";
import { renderReview } from "../review.js";

const env = process.env;
const MAX_COST = Number(env.MAX_IMAGE_COST_PER_PRODUCT ?? 3);
const [OUT_W, OUT_H] = (env.IMAGE_OUTPUT_SIZE ?? "1080x1350").split("x").map(Number);

const args = process.argv.slice(2);
const BATCH = args.includes("--batch") || env.IMAGE_USE_BATCH === "true";
const QUALITY_NAME = parseQuality(env.IMAGE_QUALITY);
const recolorAt = args.indexOf("--recolor");
const RECOLOR = recolorAt >= 0;
// Lista opcional de colores justo después de --recolor (si no es una ruta ni URL de imagen).
const recolorArg = RECOLOR && args[recolorAt + 1] && !/[\\/.]/.test(args[recolorAt + 1]) && !args[recolorAt + 1].startsWith("--") ? args[recolorAt + 1] : null;
const sources = args.filter((a, i) => !a.startsWith("--") && !(recolorArg && i === recolorAt + 1)).flatMap((a) => a.split(/[\s,]+/)).filter(Boolean);
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

  const outcome = await generateMockups({
    claude,
    gemini,
    runId: `${trialId}-${designId}`,
    design,
    shotList,
    dir,
    ...QUALITY[QUALITY_NAME],
    maxCostUsd: MAX_COST,
    outSize: [OUT_W, OUT_H],
    batch: BATCH,
    waitForBatch: true,
    reviewBeforeRetry: false,
    log,
  });
  if (outcome.kind !== "done") throw new Error("La generación no terminó");
  const { results, imageCost } = outcome;

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

// Experimento de recoloreado: una máscara por foto del color generado y un teñido por cada color extra.
async function recolorShots(shotList: ShotList, results: ShotResult[], design: ImageInput, dir: string, log: (m: string) => void) {
  const base = shotList.colors[0];
  const targets = recolorArg
    ? recolorArg.split(",").map((name) => {
        const c = palette.find((p) => p.name.toLowerCase() === name.trim().toLowerCase());
        if (!c) throw new Error(`--recolor: el color "${name}" no está en config/garment-colors.json`);
        return c;
      })
    : palette.filter((c) => c.name !== base.name).sort((a, b) => deltaE(b.hex, base.hex) - deltaE(a.hex, base.hex)).slice(0, 2);
  if (rgbToLab(hexToRgb(base.hex))[0] < 55) log(`  Aviso: la base ${base.name} es oscura; el teñido sale mejor desde un hoodie claro`);
  log(`Recoloreado: de ${base.name} a ${targets.map((c) => c.name).join(", ")}…`);
  await mkdir(path.join(dir, "mockups", "recolor"), { recursive: true });
  const { model, imageSize } = QUALITY[QUALITY_NAME];
  let cost = 0;
  const shots = [];
  for (const src of results.filter((r) => r.shot.color === base.name)) {
    if (!src.file) continue;
    const photo = await readFile(path.join(dir, src.file));
    let mask: Buffer;
    try {
      const m = await garmentMask(gemini, photo, model, imageSize);
      cost += m.cost_usd;
      mask = m.data;
      await writeFile(path.join(dir, "mockups", "recolor", `${src.shot.shot_id}-mask.png`), await sharp(mask).png().toBuffer());
    } catch (err) {
      log(`  máscara de ${src.shot.shot_id} falló: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    for (const color of targets) {
      const data = await recolorGarment(photo, mask, base.hex, color.hex);
      const file = `mockups/recolor/${src.shot.shot_id}-${color.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.jpg`;
      await writeFile(path.join(dir, file), data);
      const shot = { ...src.shot, color: color.name };
      const qa = await runQa({ claude, design, candidate: { data, mediaType: "image/jpeg", label: "" }, identity: null, shot, garmentColor: color.name, size: shotList.analysis.embroidery_size_cm });
      log(`  ${src.shot.shot_id} → ${color.name} (teñida): ${qa.passed ? "OK" : "NO PASA"} (bordado ${qa.embroidery_fidelity}/10, realismo ${qa.realism}/10)`);
      shots.push({ from: src.shot.shot_id, color: color.name, file, qa });
    }
  }
  return { base: base.name, cost_usd: Number(cost.toFixed(3)), shots };
}
