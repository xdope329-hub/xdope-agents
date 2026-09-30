// Prueba de punta a punta sin publicar: foto de bordado → Curador → Director de arte →
// generación (Gemini) → QA → mockups 1080×1350 y un review.html para revisar.
// Uso: npm run trial -- <ruta o URL de imagen> [...]
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { runCurator, type StoreCategory } from "../agents/curator.js";
import { runDirector, type GarmentColor } from "../agents/director.js";
import { runQa, type QaResult } from "../agents/qa.js";
import type { Shot } from "../contracts/index.js";
import { GeminiImages, type GeneratedImage } from "../images/gemini.js";
import { Claude, type ImageInput } from "../llm/claude.js";

const env = process.env;
const MODEL = env.IMAGE_MODEL ?? "gemini-3.1-flash-image";
const ESCALATION = env.IMAGE_ESCALATION_MODEL ?? "gemini-3-pro-image";
const MAX_COST = Number(env.MAX_IMAGE_COST_PER_PRODUCT ?? 3);
const CONCURRENCY = 3;
const [OUT_W, OUT_H] = (env.IMAGE_OUTPUT_SIZE ?? "1080x1350").split("x").map(Number);

const sources = process.argv.slice(2).flatMap((a) => a.split(/[\s,]+/)).filter(Boolean);
if (sources.length === 0) throw new Error("Pasa al menos una ruta o URL de imagen de bordado");
if (!env.GEMINI_API_KEY) throw new Error("Falta GEMINI_API_KEY");
if (!env.ANTHROPIC_API_KEY) throw new Error("Falta ANTHROPIC_API_KEY");

const claude = new Claude();
const gemini = new GeminiImages(env.GEMINI_API_KEY);
const palette: GarmentColor[] = JSON.parse(await readFile("config/garment-colors.json", "utf8"));
const categories: StoreCategory[] = JSON.parse(await readFile("config/categories.trial.json", "utf8"));
const trialId = `trial-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
const outDir = path.join(env.RUNS_DIR ?? "runs", trialId);

interface ShotResult {
  shot: Shot;
  file: string | null;
  attempts: Array<{ model: string; qa: QaResult | null; error?: string }>;
  passed: boolean;
}

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

  let imageCost = 0;
  const results: ShotResult[] = [];
  const colorName = (s: Shot) => s.color;

  const generateShot = async (shot: Shot, identity: ImageInput | null): Promise<ShotResult & { image?: Buffer }> => {
    const result: ShotResult & { image?: Buffer } = { shot, file: null, attempts: [], passed: false };
    let best: { img: GeneratedImage; qa: QaResult; score: number } | null = null;
    let fix = "";
    for (const model of [MODEL, ESCALATION]) {
      if (imageCost >= MAX_COST) {
        result.attempts.push({ model, qa: null, error: `Tope de costo USD ${MAX_COST} alcanzado` });
        break;
      }
      try {
        const img = await gemini.generate({
          model,
          prompt: `${shot.prompt}\n\nAvoid: ${shot.negative_prompt}${fix}`,
          refs: [
            { role: "Reference 1: the exact embroidery design. Reproduce it as raised thread embroidery, identical shapes and thread colors.", data: design.data, mimeType: "image/jpeg" },
            ...(identity ? [{ role: "Reference 2: the model. Use this exact same person (face, hair, body).", data: identity.data, mimeType: identity.mediaType }] : []),
          ],
          aspectRatio: "4:5",
          imageSize: "2K",
        });
        imageCost += img.cost_usd;
        const candidate: ImageInput = { data: await sharp(img.data).jpeg({ quality: 90 }).toBuffer(), mediaType: "image/jpeg", label: "" };
        const qa = await runQa({ claude, design, candidate, identity, shot, garmentColor: colorName(shot) });
        result.attempts.push({ model, qa });
        const score = qa.embroidery_fidelity + qa.realism;
        if (!best || score > best.score) best = { img: { ...img, data: candidate.data }, qa, score };
        if (qa.passed) break;
        fix = `\n\nFix these problems found in the previous attempt: ${qa.reasons.join("; ")}`;
      } catch (err) {
        result.attempts.push({ model, qa: null, error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (best) {
      const file = `mockups/${shot.shot_id}.jpg`;
      const final = await sharp(best.img.data).resize(OUT_W, OUT_H, { fit: "cover", position: "attention" }).jpeg({ quality: 90 }).toBuffer();
      await writeFile(path.join(dir, file), final);
      result.file = file;
      result.passed = best.qa.passed;
      result.image = best.img.data;
    }
    const last = result.attempts.at(-1);
    log(`  ${shot.shot_id}: ${result.passed ? "OK" : "NO PASA"}${last?.qa ? ` (bordado ${last.qa.embroidery_fidelity}/10, realismo ${last.qa.realism}/10)` : last?.error ? ` (${last.error})` : ""}`);
    return result;
  };

  log("Generando fotos…");
  // La primera toma fija a la persona modelo; las demás la usan como referencia de identidad.
  const [first, ...rest] = shotList.shots;
  const firstResult = await generateShot(first, null);
  results.push(firstResult);
  const identity: ImageInput | null = firstResult.image ? { data: firstResult.image, mediaType: "image/jpeg", label: "" } : null;
  for (let i = 0; i < rest.length; i += CONCURRENCY) {
    results.push(...(await Promise.all(rest.slice(i, i + CONCURRENCY).map((s) => generateShot(s, identity)))));
  }

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
  };
  await writeFile(path.join(dir, "qa.json"), JSON.stringify(summary, null, 2));
  return summary;
}

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function renderReview(items: Array<Record<string, any>>) {
  const blocks = items
    .map((d) => {
      if (d.error) return `<section><h2>${esc(d.designId)}</h2><p class="bad">Falló: ${esc(d.error)}</p></section>`;
      const shots = d.shots
        .map((s: any) => {
          const qa = s.attempts.at(-1)?.qa;
          return `<figure>${s.file ? `<img src="${d.designId}/${s.file}" loading="lazy">` : "<div class=empty>sin imagen</div>"}
<figcaption><b class="${s.passed ? "ok" : "bad"}">${s.passed ? "Aprobada" : "No pasa"}</b> · ${esc(s.color)} · ${esc(s.framing)}<br>
${qa ? `Bordado ${qa.embroidery_fidelity}/10 · Realismo ${qa.realism}/10 · ${s.attempts.length} intento(s)` : esc(s.attempts.at(-1)?.error ?? "")}
${qa?.reasons?.length ? `<details><summary>Motivos</summary><ul>${qa.reasons.map((r: string) => `<li>${esc(r)}</li>`).join("")}</ul></details>` : ""}
<details><summary>Prompt</summary><p>${esc(s.prompt)}</p></details></figcaption></figure>`;
        })
        .join("\n");
      return `<section><h2>${esc(d.curator.title)}</h2>
<div class="meta"><img class="design" src="${d.designId}/design.jpg"><div>
<p><i>${esc(d.curator.short_description)}</i></p>
<p><b>Categorías:</b> ${d.curator.categories.map((c: any) => `${esc(c.name)} (${c.role === "primary" ? "principal" : "secundaria"}, ${Math.round(c.confidence * 100)}%)`).join(", ")}${d.curator.suggested_new_category ? ` · sugerida: ${esc(d.curator.suggested_new_category)}` : ""}</p>
<p><b>Otros títulos:</b> ${d.curator.title_options.filter((t: string) => t !== d.curator.title).map(esc).join(" · ")}</p>
<p><b>Colores:</b> ${d.colors.map((c: any) => `<span class="sw" style="background:${c.hex}"></span>${esc(c.name)}`).join(" ")}</p>
<p><b>Modelo:</b> ${esc(d.concept)}</p>
<p><b>Costo imágenes:</b> USD ${d.image_cost_usd.toFixed(2)}</p></div></div>
<div class="grid">${shots}</div></section>`;
    })
    .join("\n");
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Prueba de agentes xDope</title>
<style>body{font-family:system-ui,sans-serif;margin:0 auto;max-width:1200px;padding:16px;background:#fafafa;color:#111}h2{margin-top:40px}
.meta{display:flex;gap:16px;flex-wrap:wrap}.design{width:200px;border-radius:8px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px}
figure{margin:0;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px #0002}figure img{width:100%;display:block;aspect-ratio:4/5;object-fit:cover}
figcaption{padding:8px;font-size:14px}.ok{color:#137333}.bad{color:#b3261e}.sw{display:inline-block;width:14px;height:14px;border-radius:3px;border:1px solid #0003;vertical-align:middle;margin:0 4px 0 8px}.empty{aspect-ratio:4/5;display:grid;place-items:center;background:#eee}</style></head>
<body><h1>Prueba de agentes xDope</h1><p>Nada de esto se publicó en la tienda.</p>${blocks}</body></html>`;
}
