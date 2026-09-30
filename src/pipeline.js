// Orquestador: Curador → Analista → Director de arte → Generador → QA → Copywriter → (Publicador con --publish).
// Cada paso deja su JSON en output/<id>/ y se salta si ya existe, así una ejecución fallida se puede reanudar.
//
// Uso:
//   npm run pipeline -- --design 10            procesa el diseño 10
//   npm run pipeline -- --designs 3            el Curador elige 3 diseños pendientes
//   ... --publish                              además crea el producto (inactivo) en XDOPE_API_URL
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { ROOT, loadConfig, requireEnv, readJson, writeJson } = require('./lib/config');
const { generateImage } = require('./lib/imagegen');
const { curate } = require('./agents/curator');
const { analyze } = require('./agents/analyst');
const { direct } = require('./agents/artDirector');
const { review } = require('./agents/qa');
const { write } = require('./agents/copywriter');
const { publish } = require('./agents/publisher');

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const log = (...m) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...m);

const config = loadConfig();
const catalogFile = path.join(ROOT, config.catalog.output);

function saveStatus(catalog, id, status, extra = {}) {
  const d = catalog.designs.find((x) => x.id === id);
  Object.assign(d, { status, status_at: new Date().toISOString() }, extra);
  writeJson(catalogFile, catalog);
}

async function step(file, fn) {
  if (fs.existsSync(file)) return readJson(file);
  const out = await fn();
  writeJson(file, out);
  return out;
}

async function existingTitles() {
  if (!process.env.XDOPE_API_URL) return [];
  try {
    const res = await fetch(`${process.env.XDOPE_API_URL.replace(/\/$/, '')}/product?paginate=500`);
    return ((await res.json()).data || []).map((p) => p.name);
  } catch (e) {
    log('No se pudieron leer los títulos de la tienda:', e.message);
    return [];
  }
}

// Primer plano: recorte vertical de la foto real del bordado (no usa IA).
async function closeup(brief, file) {
  if (!fs.existsSync(file)) {
    await sharp(brief.start_image).rotate().resize(1080, 1350, { fit: 'cover', position: 'attention' }).png().toFile(file);
  }
  return file;
}

async function processDesign(catalog, design, brief) {
  const dir = path.join(ROOT, 'output', String(design.id));
  const mockDir = path.join(dir, 'mockups');
  fs.mkdirSync(mockDir, { recursive: true });
  writeJson(path.join(dir, 'brief.json'), brief);
  saveStatus(catalog, design.id, 'in_progress');

  const analysis = await step(path.join(dir, 'analysis.json'), () => analyze({ config, brief, design }));
  log(`#${design.id} análisis: ${analysis.motif.slice(0, 80)}… colores ${analysis.garment_colors.map((c) => c.key).join(', ')}`);
  if (analysis.risks.ip === 'likely' || brief.ip_risk === 'likely') {
    saveStatus(catalog, design.id, 'rejected', { reason: `Riesgo de propiedad intelectual: ${analysis.risks.notes}` });
    log(`#${design.id} descartado por riesgo de propiedad intelectual`);
    return null;
  }

  const colors = analysis.garment_colors.slice(0, config.garment.minColors).map((c) => c.key);
  const aiShots = Object.entries(config.shots).filter(([, src]) => src === 'ai').map(([s]) => s);
  const prompts = await step(path.join(dir, 'prompts.json'), () => direct({ config, brief, analysis, colors, aiShots }));

  const houseModel = config.houseModels?.length ? config.houseModels[design.id % config.houseModels.length] : null;
  const gen = { model: config.imageGen.model, images: 0, attempts: [] };
  const qa = { items: [] };
  let personRef = null; // primera toma con modelo aprobada: referencia de persona para el resto de colores
  const approved = [];

  for (const color of colors) {
    const colorLabel = config.garment.colors.find((c) => c.key === color).label;
    const files = [];
    let colorOk = true;
    for (const shot of aiShots) {
      const item = prompts.items.find((i) => i.color === color && i.shot === shot);
      if (!item) { colorOk = false; log(`#${design.id} falta prompt ${color}/${shot}`); break; }
      let prompt = [item.prompt, `Person: ${prompts.model_description}`, `Set: ${prompts.set_description}`].join('\n');
      let result = null;
      for (let attempt = 1; attempt <= 1 + config.qa.maxRetries; attempt++) {
        const outFile = path.join(mockDir, `${color}_${shot}_v${attempt}.png`);
        const refs = [brief.start_image];
        if (shot.startsWith('model') && (personRef || houseModel)) refs.push(personRef || houseModel);
        if (shot === 'garment_flat' && config.garment.flatBases?.[color]) refs.push(config.garment.flatBases[color]);
        if (!fs.existsSync(outFile)) {
          log(`#${design.id} generando ${color}/${shot} (intento ${attempt})`);
          await generateImage({ model: config.imageGen.model, prompt, referenceImages: refs, outFile });
          gen.images++;
        }
        gen.attempts.push({ color, shot, attempt, file: path.relative(dir, outFile) });
        result = await review({ config, brief, file: outFile, colorLabel });
        qa.items.push({ ...result, file: path.relative(dir, outFile), color, shot, attempt });
        log(`#${design.id} QA ${color}/${shot} v${attempt}: ${result.approved ? 'aprobado' : 'rechazado'} ${JSON.stringify(result.scores)}`);
        if (result.approved) break;
        prompt += `\nCorrections from previous attempt: ${result.fix}`;
      }
      if (!result.approved) { colorOk = false; break; }
      files.push(result.file);
      if (shot.startsWith('model') && !personRef) personRef = result.file;
    }
    if (colorOk) {
      if (config.shots.embroidery_closeup === 'crop_original') files.push(await closeup(brief, path.join(mockDir, `${color}_embroidery_closeup.png`)));
      approved.push({ color, files });
    }
  }

  qa.approved_colors = approved.map((a) => a.color);
  qa.needs_manual_review = approved.length < config.garment.minColors;
  writeJson(path.join(dir, 'qa.json'), qa);
  writeJson(path.join(dir, 'generation.json'), gen);
  log(`#${design.id} imágenes generadas: ${gen.images}; colores aprobados: ${qa.approved_colors.join(', ') || 'ninguno'}`);
  if (qa.needs_manual_review) {
    saveStatus(catalog, design.id, 'rejected', { reason: `Solo ${approved.length} colores aprobados por QA` });
    return null;
  }

  const copy = await step(path.join(dir, 'copy.json'), () => write({ config, brief, analysis, colors: qa.approved_colors }));
  if (!flag('publish')) {
    saveStatus(catalog, design.id, 'ready');
    log(`#${design.id} listo para publicar (sin --publish no se crea en la tienda). Revisa ${path.relative(ROOT, dir)}`);
    return { id: design.id, dir };
  }
  const pub = await publish({ config, brief, copy, approved, outDir: mockDir });
  writeJson(path.join(dir, 'publish.json'), pub);
  saveStatus(catalog, design.id, 'published', { product_id: pub.product_id });
  log(`#${design.id} creado en la tienda como inactivo: ${pub.slug} (${pub.variations} variantes)`);
  return { id: design.id, dir, ...pub };
}

async function main() {
  if (flag('collect-only')) { log('Modo batch aún no implementado: nada que recoger.'); return; }
  requireEnv('ANTHROPIC_API_KEY', 'GEMINI_API_KEY');
  if (flag('publish')) requireEnv('XDOPE_API_URL', 'XDOPE_ADMIN_EMAIL', 'XDOPE_ADMIN_PASSWORD');
  if (!fs.existsSync(catalogFile)) throw new Error('No hay catálogo: corre primero "npm run scan"');
  const catalog = readJson(catalogFile);

  const ids = opt('design') ? opt('design').split(',').map(Number) : null;
  const count = ids ? ids.length : Number(opt('designs', config.batch.designsPerRun));
  let candidates;
  if (ids) {
    candidates = ids.map((id) => catalog.designs.find((d) => d.id === id) ?? (() => { throw new Error(`No existe el diseño ${id}`); })());
  } else {
    let pool = catalog.designs.filter((d) => d.status === 'pending');
    if (config.batch.preferWithMachineFiles && pool.some((d) => d.machine_dir)) pool = pool.filter((d) => d.machine_dir);
    candidates = pool.sort(() => Math.random() - 0.5).slice(0, Math.max(count * 4, 8));
  }

  // Si ya hay brief (ejecución anterior interrumpida), se reutiliza.
  const pending = [];
  const briefs = [];
  for (const d of candidates) {
    const f = path.join(ROOT, 'output', String(d.id), 'brief.json');
    if (ids && fs.existsSync(f)) briefs.push(readJson(f)); else pending.push(d);
  }
  if (pending.length && briefs.length < count) {
    log(`Curador revisando ${pending.length} candidato(s)…`);
    briefs.push(...await curate({ config, candidates: pending, count: count - briefs.length, existingTitles: await existingTitles() }));
  }
  for (const b of briefs) log(`#${b.id} "${b.title}" — ${b.short_description} [${b.categories.themes.map((t) => t.slug).join(', ')}]`);

  for (const brief of briefs) {
    const design = catalog.designs.find((d) => d.id === brief.id);
    try {
      await processDesign(catalog, design, brief);
    } catch (e) {
      saveStatus(catalog, design.id, 'error', { reason: e.message });
      log(`#${design.id} ERROR: ${e.message}`);
    }
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
