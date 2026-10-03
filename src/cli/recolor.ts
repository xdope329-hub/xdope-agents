// Vista previa del recoloreado sin IA (specs/04) para un lote ya generado: tiñe por código sus fotos finales a
// otros colores de la tienda y deja runs/<run_id>/recolor.html para compararlas con la original.
// Uso: npm run recolor -- <run_id> [--colors "Negro,Beige"]   (sin --colors: todos los demás colores de la tienda)
// Costo: 1 segmentación de Gemini por foto (≈ USD 0.01), solo la primera vez (se guarda y se reutiliza); el teñido es gratis.
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { GarmentColor } from "../agents/director.js";
import { ShotList } from "../contracts/index.js";
import { GeminiImages } from "../images/gemini.js";
import { garmentMask, recolorGarment } from "../images/recolor.js";
import { QUALITY, parseQuality } from "../quality.js";
import { RunStore } from "../runs/store.js";

const env = process.env;
const args = process.argv.slice(2);
const runId = args.find((a) => !a.startsWith("--"));
const colorsArg = args.includes("--colors") ? args[args.indexOf("--colors") + 1] : undefined;
if (!runId) throw new Error("Uso: npm run recolor -- <run_id> [--colors A,B]");
if (!env.GEMINI_API_KEY) throw new Error("Falta GEMINI_API_KEY");

const store = new RunStore(env.RUNS_DIR ?? "runs");
const dir = store.runDir(runId);
const shotList = await store.readArtifact(runId, "shots.json", ShotList);
if (!shotList) throw new Error(`El lote ${runId} aún no tiene plan de fotos`);
const palette: GarmentColor[] = JSON.parse(await readFile("config/garment-colors.json", "utf8"));
const source = JSON.parse(await readFile(store.file(runId, "source.json"), "utf8"));
const { model, imageSize } = QUALITY[parseQuality(source.quality)];
const gemini = new GeminiImages(env.GEMINI_API_KEY);

const baseName = shotList.colors[0].name;
const base = palette.find((c) => c.name === baseName) ?? shotList.colors[0];
const targets = colorsArg
  ? colorsArg.split(",").map((name) => {
      const c = palette.find((p) => p.name.toLowerCase() === name.trim().toLowerCase());
      if (!c) throw new Error(`El color "${name}" no está en config/garment-colors.json`);
      return c;
    })
  : palette.filter((c) => c.name !== base.name);
const slug = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

await mkdir(path.join(dir, "mockups", "recolor"), { recursive: true });
let cost = 0;
const rows: Array<{ shot_id: string; original: string; versions: Array<{ color: string; hex: string; file: string }> }> = [];
for (const shot of shotList.shots) {
  const original = `mockups/${shot.shot_id}.jpg`;
  if (!(await exists(path.join(dir, original)))) continue;
  const photo = await readFile(path.join(dir, original));
  const maskFile = path.join(dir, "mockups", "recolor", `${shot.shot_id}-mask-v3.png`);
  let mask: Buffer;
  if (await exists(maskFile)) {
    mask = await readFile(maskFile);
  } else {
    console.log(`Máscara de ${shot.shot_id}…`);
    try {
      const m = await garmentMask(gemini, photo);
      cost += m.cost_usd;
      mask = await sharp(m.data).png().toBuffer();
      await writeFile(maskFile, mask);
    } catch (err) {
      console.log(`  falló: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
  }
  const versions = [];
  for (const color of targets) {
    try {
      const file = `mockups/recolor/${shot.shot_id}-${slug(color.name)}.jpg`;
      await writeFile(path.join(dir, file), await recolorGarment(photo, mask, base.hex, color.hex));
      versions.push({ color: color.name, hex: color.hex, file });
    } catch (err) {
      console.log(`  ${shot.shot_id} → ${color.name} falló: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`  ${shot.shot_id}: ${versions.length} color(es)`);
  rows.push({ shot_id: shot.shot_id, original, versions });
}
if (!rows.length) throw new Error("El lote no tiene fotos finales para recolorear");

await writeFile(path.join(dir, "recolor.json"), JSON.stringify({ base: base.name, targets: targets.map((c) => c.name), mask_cost_usd: Number(cost.toFixed(3)), rows }, null, 2) + "\n");
await writeFile(path.join(dir, "recolor.html"), page());
console.log(`Listo: ${path.join(dir, "recolor.html")} | costo máscaras USD ${cost.toFixed(3)}`);

function page() {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const cell = (file: string, label: string, hex: string) =>
    `<figure><img src="${esc(file)}?v=${Date.now()}" loading="lazy"><figcaption><span class="sw" style="background:${esc(hex)}"></span>${esc(label)}</figcaption></figure>`;
  const body = rows
    .map((r) => `<h2>${esc(r.shot_id)}</h2><div class="grid">${cell(r.original, `${base.name} (original)`, base.hex)}${r.versions.map((v) => cell(v.file, v.color, v.hex)).join("")}${cell(`mockups/recolor/${r.shot_id}-mask-v3.png`, "máscara (blanco = se tiñe)", "#ffffff")}</div>`)
    .join("\n");
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Recoloreado ${esc(runId!)}</title>
<style>:root{--bg:#fafafa;--fg:#111;--card:#fff}@media (prefers-color-scheme:dark){:root{--bg:#121212;--fg:#eee;--card:#1c1c1c}}
body{font-family:system-ui,sans-serif;margin:0 auto;max-width:1200px;padding:16px;background:var(--bg);color:var(--fg)}h2{font-size:16px;margin:28px 0 8px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px}figure{margin:0;background:var(--card);border-radius:8px;overflow:hidden;box-shadow:0 1px 3px #0002}
figure img{width:100%;display:block;aspect-ratio:4/5;object-fit:cover}figcaption{padding:6px 8px;font-size:13px}
.sw{display:inline-block;width:12px;height:12px;border-radius:3px;border:1px solid #0003;vertical-align:middle;margin-right:6px}</style></head>
<body><h1>Recoloreado sin IA · ${esc(runId!)}</h1><p>Vista previa: la tela se tiñe por código desde ${esc(base.name)}; el bordado, la piel y el fondo no se tocan. No se publica nada.</p>${body}</body></html>`;
}

async function exists(p: string) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
