// Vista previa del recoloreado sin IA (specs/04): tiñe las fotos de un lote a los colores de la tienda
// (config/garment-colors.json) y deja runs/<lote>/recolor.html para comparar. No publica nada.
// Uso: npm run recolor -- <run_id> [--colors Negro,Beige]
// La máscara de la tela se pide a Gemini una vez por foto y queda guardada; volver a correrlo no cuesta.
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { GarmentColor } from "../agents/director.js";
import { hexToRgb, rgbToLab } from "../color.js";
import type { ShotList } from "../contracts/index.js";
import { GeminiImages } from "../images/gemini.js";
import { readProgress, type Attempt } from "../images/mockups.js";
import { garmentMask, recolorGarment } from "../images/recolor.js";
import { QUALITY, parseQuality } from "../quality.js";
import { RunStore } from "../runs/store.js";

const env = process.env;
const args = process.argv.slice(2);
const runId = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--colors");
const colorsArg = args.includes("--colors") ? args[args.indexOf("--colors") + 1] : null;
if (!runId) throw new Error("Uso: npm run recolor -- <run_id> [--colors Negro,Beige]");
if (!env.GEMINI_API_KEY) throw new Error("Falta GEMINI_API_KEY");

const store = new RunStore(env.RUNS_DIR ?? "runs");
const dir = store.runDir(runId);
const shotList: ShotList = JSON.parse(await readFile(path.join(dir, "shots.json"), "utf8"));
const source = JSON.parse(await readFile(path.join(dir, "source.json"), "utf8"));
const palette: GarmentColor[] = JSON.parse(await readFile("config/garment-colors.json", "utf8"));
const base = shotList.colors[0];
const targets = colorsArg
  ? colorsArg.split(",").map((name) => {
      const c = palette.find((p) => p.name.toLowerCase() === name.trim().toLowerCase());
      if (!c) throw new Error(`El color "${name}" no está en config/garment-colors.json`);
      return c;
    })
  : palette.filter((c) => c.name !== base.name);

const photos = await bestPhotos();
if (!photos.length) throw new Error("Este lote todavía no tiene fotos generadas");

const { model, imageSize } = QUALITY[parseQuality(source.quality)];
const gemini = new GeminiImages(env.GEMINI_API_KEY);
const outDir = path.join(dir, "mockups", "recolor");
await mkdir(outDir, { recursive: true });
let maskCost = 0;
const rows: Array<{ color: GarmentColor; files: Array<string | null> }> = targets.map((color) => ({ color, files: [] }));

console.log(`Recoloreado de ${runId}: de ${base.name} a ${targets.map((c) => c.name).join(", ")}`);
if (rgbToLab(hexToRgb(base.hex))[0] < 55) console.log(`Aviso: ${base.name} es oscuro; el teñido sale mejor desde un hoodie claro`);
for (const p of photos) {
  const photo = await readFile(path.join(dir, p.file));
  const maskFile = path.join(outDir, `${p.shot_id}-mask.png`);
  let mask: Buffer | null = null;
  if (await exists(maskFile)) mask = await readFile(maskFile);
  else {
    try {
      const m = await garmentMask(gemini, photo, model, imageSize);
      maskCost += m.cost_usd;
      mask = await sharp(m.data).png().toBuffer();
      await writeFile(maskFile, mask);
      console.log(`  máscara de ${p.shot_id} lista (USD ${m.cost_usd.toFixed(3)})`);
    } catch (err) {
      console.log(`  máscara de ${p.shot_id} falló: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  for (const row of rows) {
    if (!mask) {
      row.files.push(null);
      continue;
    }
    const file = `mockups/recolor/${p.shot_id}--${slug(row.color.name)}.jpg`;
    await writeFile(path.join(dir, file), await recolorGarment(photo, mask, base.hex, row.color.hex));
    row.files.push(file);
  }
}

const previous = JSON.parse(await readFile(path.join(dir, "recolor.json"), "utf8").catch(() => "{}"));
const totalMaskCost = Number(((previous.mask_cost_usd ?? 0) + maskCost).toFixed(3));
await writeFile(path.join(dir, "recolor.json"), JSON.stringify({ base: base.name, mask_model: model, mask_cost_usd: totalMaskCost, photos, rows: rows.map((r) => ({ color: r.color.name, hex: r.color.hex, files: r.files })) }, null, 2) + "\n");
await writeFile(path.join(dir, "recolor.html"), page(totalMaskCost));
console.log(`Listo: ${path.join(dir, "recolor.html")} (máscaras: USD ${totalMaskCost.toFixed(3)} en total; los colores no cuestan)`);

// La mejor foto de cada toma: la final si el lote ya pasó QA, o el mejor intento hasta ahora.
async function bestPhotos(): Promise<Array<{ shot_id: string; file: string }>> {
  const qa = JSON.parse(await readFile(path.join(dir, "qa.json"), "utf8").catch(() => "null"));
  if (qa) return qa.results.filter((r: { file: string | null }) => r.file).map((r: { shot: { shot_id: string }; file: string }) => ({ shot_id: r.shot.shot_id, file: r.file }));
  const progress = await readProgress(dir);
  const score = (a: Attempt) => (a.qa ? (a.qa.passed ? 100 : 0) + a.qa.embroidery_fidelity + a.qa.realism : 0);
  return shotList.shots.flatMap((s) => {
    const best = (progress?.attempts[s.shot_id] ?? []).filter((a) => a.candidate).sort((a, b) => score(b) - score(a))[0];
    return best?.candidate ? [{ shot_id: s.shot_id, file: best.candidate }] : [];
  });
}

function page(cost: number) {
  const cell = (file: string | null) => (file ? `<img src="${file}" loading="lazy">` : `<div class="empty">sin máscara</div>`);
  const row = (name: string, hex: string, files: Array<string | null>, note = "") =>
    `<section><h2><span class="sw" style="background:${hex}"></span>${esc(name)}${note}</h2><div class="grid">${files.map(cell).join("")}</div></section>`;
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Recoloreado ${esc(runId!)}</title>
<style>:root{--bg:#fafafa;--fg:#111;--muted:#666}@media (prefers-color-scheme:dark){:root{--bg:#121212;--fg:#eee;--muted:#9a9a9a}}
body{font-family:system-ui,sans-serif;margin:0 auto;max-width:1200px;padding:16px;background:var(--bg);color:var(--fg)}h2{font-size:16px;margin:24px 0 8px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}img{width:100%;aspect-ratio:4/5;object-fit:cover;border-radius:8px;display:block}
.empty{aspect-ratio:4/5;display:grid;place-items:center;background:#8882;border-radius:8px}.sw{display:inline-block;width:16px;height:16px;border-radius:4px;border:1px solid #0003;vertical-align:-2px;margin-right:8px}.muted{color:var(--muted)}</style></head>
<body><h1>Recoloreado sin IA</h1><p class="muted">Vista previa: las fotos de ${esc(base.name)} teñidas por código a los colores de la tienda. No se publicó nada. Máscaras: USD ${cost.toFixed(3)}; cada color extra no cuesta.</p>
${row(base.name, base.hex, photos.map((p) => p.file), ' <span class="muted">(original generado)</span>')}
${rows.map((r) => row(r.color.name, r.color.hex, r.files)).join("\n")}
</body></html>`;
}

function slug(s: string) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

async function exists(p: string) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
