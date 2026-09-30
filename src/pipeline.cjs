// Orquestador: Curador → Analista → Director de arte → Generador → QA → Copywriter → (Publicador).
//
// Cada diseño avanza por pasos; lo hecho queda en output/<id>/ (brief, analysis, prompts, state, copy, publish).
// Modo batch (por defecto, 50 % más barato): cada ejecución recoge los lotes terminados, avanza los diseños y
// envía los lotes del siguiente paso. Un diseño completo toma varias ejecuciones (usa las tareas programadas).
// Modo tiempo real (--realtime): ejecuta todos los pasos seguidos en esta misma corrida.
//
//   npm run pipeline -- --design 10 [--realtime]   procesa el diseño 10
//   npm run pipeline -- --designs 3                el Curador elige 3 diseños pendientes
//   npm run pipeline -- --collect-only             solo recoge lotes y avanza lo que ya está en curso
//   npm run pipeline -- --status                   muestra en qué paso va cada diseño y los lotes abiertos
//   ... --publish                                  crea los productos listos (inactivos) en XDOPE_API_URL
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { ROOT, loadConfig, requireEnv, readJson, writeJson } = require('./lib/config.cjs');
const claude = require('./lib/claude.cjs');
const images = require('./lib/imagegen.cjs');
const agents = {
  curate: require('./agents/curator.cjs'),
  analyze: require('./agents/analyst.cjs'),
  direct: require('./agents/artDirector.cjs'),
  qa: require('./agents/qa.cjs'),
  copy: require('./agents/copywriter.cjs'),
};
const { publish } = require('./agents/publisher.cjs');

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const log = (...m) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...m);

const config = loadConfig();
const mode = flag('realtime') ? 'realtime' : (config.pipeline?.mode ?? 'batch');
const shouldPublish = flag('publish') || config.pipeline?.publish === true;
const catalogFile = path.join(ROOT, config.catalog.output);
const batchesFile = path.join(ROOT, 'data', 'batches.json');
const outDir = (id) => path.join(ROOT, 'output', String(id));
const fileOf = (id, name) => path.join(outDir(id), name);
const has = (id, name) => fs.existsSync(fileOf(id, name));

let catalog;
const designOf = (id) => catalog.designs.find((d) => d.id === id);
function setStatus(id, status, extra = {}) {
  Object.assign(designOf(id), { status, status_at: new Date().toISOString() }, extra);
  writeJson(catalogFile, catalog);
}
const loadBatches = () => (fs.existsSync(batchesFile) ? readJson(batchesFile) : []);

// ── Planificación: qué solicitud necesita cada diseño en curso ─────────────────────────────────────

const colorLabel = (key) => config.garment.colors.find((c) => c.key === key).label;
const aiShots = () => Object.entries(config.shots).filter(([, src]) => src === 'ai').map(([s]) => s);

function initState(id) {
  const analysis = readJson(fileOf(id, 'analysis.json'));
  const prompts = readJson(fileOf(id, 'prompts.json'));
  const colors = analysis.garment_colors.slice(0, config.garment.minColors).map((c) => c.key);
  const items = [];
  for (const color of colors) {
    for (const shot of aiShots()) {
      const p = prompts.items.find((i) => i.color === color && i.shot === shot);
      if (!p) throw new Error(`El director de arte no escribió el prompt ${color}/${shot}`);
      items.push({
        key: `${color}_${shot}`, color, shot, attempt: 1, status: 'todo',
        prompt: [p.prompt, `Person: ${prompts.model_description}`, `Set: ${prompts.set_description}`].join('\n'),
      });
    }
  }
  const state = { colors, items };
  writeJson(fileOf(id, 'state.json'), state);
  return state;
}

// Referencia de persona: modelo de la casa, o la primera toma con modelo aprobada (para que sea la misma persona).
function personRef(id, state) {
  if (config.houseModels?.length) return config.houseModels[id % config.houseModels.length];
  return state.items.find((i) => i.shot.startsWith('model') && i.status === 'approved')?.file ?? null;
}

function imageRequest(id, brief, state, item) {
  const refs = [brief.start_image];
  if (item.shot.startsWith('model')) {
    const person = personRef(id, state);
    const anchor = state.items.find((i) => i.shot.startsWith('model') && i.status !== 'failed');
    if (person) refs.push(person);
    else if (anchor !== item) return null; // espera a que se apruebe la primera toma con modelo
  }
  if (item.shot === 'garment_flat' && config.garment.flatBases?.[item.color]) refs.push(config.garment.flatBases[item.color]);
  return { kind: 'image', id: `d${id}-gen-${item.key}-v${item.attempt}`, designId: id, step: 'gen', item: item.key, prompt: item.prompt, referenceImages: refs };
}

function planDesign(id) {
  const design = designOf(id);
  const brief = readJson(fileOf(id, 'brief.json'));
  const claudeReq = (step, ctx, extra = {}) => ({ kind: 'claude', id: `d${id}-${step}${extra.item ? `-${extra.item}` : ''}`, designId: id, step, spec: agents[step].request(ctx), ...extra });

  if (!has(id, 'analysis.json')) return [claudeReq('analyze', { config, brief, design })];
  const analysis = readJson(fileOf(id, 'analysis.json'));
  if (!has(id, 'prompts.json')) {
    const colors = analysis.garment_colors.slice(0, config.garment.minColors).map((c) => c.key);
    return [claudeReq('direct', { config, brief, analysis, colors, aiShots: aiShots() })];
  }
  const state = has(id, 'state.json') ? readJson(fileOf(id, 'state.json')) : initState(id);

  const reqs = [];
  for (const item of state.items) {
    if (item.status === 'todo') {
      const r = imageRequest(id, brief, state, item);
      if (r) reqs.push(r);
    } else if (item.status === 'generated') {
      reqs.push(claudeReq('qa', { config, brief, file: item.file, colorLabel: colorLabel(item.color) }, { item: item.key }));
    }
  }
  if (reqs.length) return reqs;
  if (state.items.some((i) => i.status === 'todo')) {
    // Solo quedan tomas esperando una referencia de persona que ya no llegará.
    for (const i of state.items) if (i.status === 'todo') i.status = 'failed';
    writeJson(fileOf(id, 'state.json'), state);
  }

  const approvedColors = state.colors.filter((c) => state.items.filter((i) => i.color === c).every((i) => i.status === 'approved'));
  if (approvedColors.length < config.garment.minColors) {
    setStatus(id, 'rejected', { reason: `Solo ${approvedColors.length} colores aprobados por QA` });
    log(`#${id} descartado: solo ${approvedColors.length} colores aprobados`);
    return [];
  }
  if (!has(id, 'copy.json')) return [claudeReq('copy', { config, brief, analysis, colors: approvedColors })];
  if (design.status === 'in_progress') {
    setStatus(id, 'ready');
    log(`#${id} listo: revisa output/${id}/mockups`);
  }
  return [];
}

// ── Aplicar resultados ─────────────────────────────────────────────────────────────────────────────

async function closeup(brief, file) {
  if (!fs.existsSync(file)) {
    await sharp(brief.start_image).rotate().resize(1080, 1350, { fit: 'cover', position: 'attention' }).png().toFile(file);
  }
  return file;
}

async function apply(req, result) {
  const id = req.designId;
  if (result.error && (req.step === 'gen' || req.step === 'qa')) {
    // Falla de una sola imagen: se reintenta como un rechazo de QA, sin tumbar el diseño.
    const state = readJson(fileOf(id, 'state.json'));
    const item = state.items.find((i) => i.key === req.item);
    log(`#${id} ${req.step} ${item.key} v${item.attempt} falló: ${result.error}`);
    if (item.attempt <= config.qa.maxRetries) { item.attempt++; item.status = 'todo'; } else item.status = 'failed';
    writeJson(fileOf(id, 'state.json'), state);
    return;
  }
  if (result.error) {
    log(`#${id ?? '-'} ${req.step} falló: ${result.error}`);
    if (id != null) setStatus(id, 'error', { reason: `${req.step}: ${result.error}` });
    return;
  }
  if (req.step === 'curate') {
    for (const brief of agents.curate.finish({ ...req.ctx, config }, result.value)) {
      writeJson(fileOf(brief.id, 'brief.json'), brief);
      setStatus(brief.id, 'in_progress');
      log(`#${brief.id} "${brief.title}" — ${brief.short_description} [${brief.categories.themes.map((t) => t.slug).join(', ')}]`);
    }
    return;
  }
  const brief = readJson(fileOf(id, 'brief.json'));
  if (req.step === 'analyze') {
    const analysis = agents.analyze.finish({ config, design: designOf(id) }, result.value);
    writeJson(fileOf(id, 'analysis.json'), analysis);
    if (analysis.risks.ip !== 'none') log(`#${id} aviso de propiedad intelectual (${analysis.risks.ip}): ${analysis.risks.notes.slice(0, 120)}`);
    if (config.ipPolicy === 'reject' && (analysis.risks.ip === 'likely' || brief.ip_risk === 'likely')) {
      setStatus(id, 'rejected', { reason: `Riesgo de propiedad intelectual: ${analysis.risks.notes}` });
    }
    log(`#${id} análisis listo; colores ${analysis.garment_colors.map((c) => c.key).join(', ')}`);
    return;
  }
  if (req.step === 'direct') {
    writeJson(fileOf(id, 'prompts.json'), agents.direct.finish({}, result.value));
    log(`#${id} prompts listos`);
    return;
  }
  if (req.step === 'copy') {
    writeJson(fileOf(id, 'copy.json'), agents.copy.finish({ brief }, result.value));
    log(`#${id} textos listos`);
    return;
  }

  const state = readJson(fileOf(id, 'state.json'));
  const item = state.items.find((i) => i.key === req.item);
  if (req.step === 'gen') {
    item.file = await images.saveImage(result.b64, path.join(outDir(id), 'mockups', `${item.key}_v${item.attempt}.png`));
    item.status = 'generated';
    log(`#${id} imagen ${item.key} v${item.attempt} generada`);
  } else if (req.step === 'qa') {
    const review = agents.qa.finish({ config }, result.value);
    item.qa = [...(item.qa || []), { attempt: item.attempt, ...review }];
    log(`#${id} QA ${item.key} v${item.attempt}: ${review.approved ? 'aprobada' : 'rechazada'} ${JSON.stringify(review.scores)}`);
    if (review.approved) {
      item.status = 'approved';
      if (config.shots.embroidery_closeup === 'crop_original') await closeup(brief, path.join(outDir(id), 'mockups', 'embroidery_closeup.png'));
    } else if (item.attempt <= config.qa.maxRetries) {
      item.attempt++;
      item.status = 'todo';
      item.prompt += `\nCorrections from previous attempt: ${review.fix}`;
    } else {
      item.status = 'failed';
    }
  }
  writeJson(fileOf(id, 'state.json'), state);
}

// ── Ejecución: tiempo real o por lotes ─────────────────────────────────────────────────────────────

async function runRealtime(req) {
  try {
    if (req.kind === 'claude') return { value: await claude.ask(req.spec) };
    const tmp = path.join(outDir(req.designId), 'mockups', `.tmp-${req.item}.png`);
    await images.generateImage({ model: config.imageGen.model, prompt: req.prompt, referenceImages: req.referenceImages, outFile: tmp });
    const b64 = (await sharp(tmp).png().toBuffer()).toString('base64');
    fs.unlinkSync(tmp);
    return { b64 };
  } catch (e) {
    return { error: e.message };
  }
}

// Las solicitudes pendientes se guardan sin el contenido (imágenes); basta con su id y paso para aplicar el resultado.
const slim = ({ spec, prompt, referenceImages, ...rest }) => rest;

async function submit(reqs) {
  const batches = loadBatches();
  const claudeReqs = reqs.filter((r) => r.kind === 'claude');
  const imageReqs = reqs.filter((r) => r.kind === 'image');
  if (claudeReqs.length) {
    const id = await claude.submitBatch(claudeReqs.map((r) => ({ id: r.id, spec: r.spec })));
    batches.push({ kind: 'claude', id, created_at: new Date().toISOString(), requests: claudeReqs.map(slim) });
    log(`Lote de Claude enviado (${claudeReqs.length} solicitudes): ${id}`);
  }
  if (imageReqs.length) {
    for (const job of await images.submitImageBatch(config.imageGen.model, imageReqs)) {
      batches.push({ kind: 'image', id: job.name, ids: job.ids, created_at: new Date().toISOString(), requests: imageReqs.filter((r) => job.ids.includes(r.id)).map(slim) });
      log(`Lote de imágenes enviado (${job.ids.length} solicitudes): ${job.name}`);
    }
  }
  writeJson(batchesFile, batches);
}

async function collect() {
  const open = [];
  for (const b of loadBatches()) {
    const results = b.kind === 'claude' ? await claude.fetchBatch(b.id) : await images.fetchImageBatch(b.id, b.ids);
    if (!results) { open.push(b); continue; }
    log(`Lote ${b.id} terminado (${results.size} resultados)`);
    for (const req of b.requests) {
      const r = results.get(req.id) ?? { error: 'sin resultado' };
      if (req.kind === 'claude' && r.message) {
        try { r.value = claude.parseMessage(r.message, agents[req.step].request(req.ctx ? { ...req.ctx, config } : ctxFor(req)).schema); }
        catch (e) { r.error = e.message; }
      }
      await apply(req, r);
    }
  }
  writeJson(batchesFile, open);
  return open;
}

// El esquema de salida depende de la config (p. ej. colores permitidos); se reconstruye con el mismo contexto.
function ctxFor(req) {
  const id = req.designId;
  const brief = readJson(fileOf(id, 'brief.json'));
  if (req.step === 'analyze') return { config, brief, design: designOf(id) };
  if (req.step === 'direct') {
    const analysis = readJson(fileOf(id, 'analysis.json'));
    return { config, brief, analysis, colors: [], aiShots: aiShots() };
  }
  if (req.step === 'qa') return { config, brief, file: brief.start_image, colorLabel: '' };
  return { config, brief, analysis: readJson(fileOf(id, 'analysis.json')), colors: [] };
}

// ── Curador: elegir diseños nuevos ─────────────────────────────────────────────────────────────────

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

async function curateRequest(pendingIds) {
  const ids = opt('design') ? opt('design').split(',').map(Number) : null;
  let candidates;
  let count;
  if (ids) {
    candidates = [];
    for (const id of ids) {
      const d = designOf(id);
      if (!d) throw new Error(`No existe el diseño ${id}`);
      if (has(id, 'brief.json')) { if (!['in_progress', 'ready', 'published'].includes(d.status)) setStatus(id, 'in_progress'); }
      else candidates.push(d);
    }
    count = candidates.length;
  } else {
    count = Number(opt('designs', config.batch.designsPerRun));
    let pool = catalog.designs.filter((d) => d.status === 'pending' && !pendingIds.has(d.id));
    if (config.batch.preferWithMachineFiles && pool.some((d) => d.machine_dir)) pool = pool.filter((d) => d.machine_dir);
    candidates = pool.sort(() => Math.random() - 0.5).slice(0, Math.max(count * 4, 8));
  }
  if (!count || !candidates.length) return null;
  const ctx = { config, candidates, count, existingTitles: await existingTitles() };
  log(`Curador revisando ${candidates.length} candidato(s) para elegir ${count}…`);
  return { kind: 'claude', id: `curate-${Date.now()}`, step: 'curate', spec: agents.curate.request(ctx), ctx: { config: null, candidates, count } };
}

// ── Principal ──────────────────────────────────────────────────────────────────────────────────────

function showStatus() {
  const counts = {};
  for (const d of catalog.designs) counts[d.status] = (counts[d.status] || 0) + 1;
  console.log('Diseños por estado:', counts);
  for (const d of catalog.designs.filter((x) => !['pending'].includes(x.status))) {
    console.log(`  #${d.id} ${d.status}${d.reason ? ` — ${d.reason}` : ''}`);
  }
  for (const b of loadBatches()) console.log(`  lote abierto ${b.kind} ${b.id} (${b.requests.length} solicitudes, desde ${b.created_at})`);
}

async function publishReady() {
  for (const d of catalog.designs.filter((x) => x.status === 'ready')) {
    const id = d.id;
    try {
      const state = readJson(fileOf(id, 'state.json'));
      const approved = state.colors
        .filter((c) => state.items.filter((i) => i.color === c).every((i) => i.status === 'approved'))
        .map((color) => {
          const files = state.items.filter((i) => i.color === color).map((i) => i.file);
          if (config.shots.embroidery_closeup === 'crop_original') files.push(path.join(outDir(id), 'mockups', 'embroidery_closeup.png'));
          return { color, files };
        });
      const pub = await publish({ config, brief: readJson(fileOf(id, 'brief.json')), copy: readJson(fileOf(id, 'copy.json')), approved, outDir: path.join(outDir(id), 'mockups') });
      writeJson(fileOf(id, 'publish.json'), pub);
      setStatus(id, 'published', { product_id: pub.product_id });
      log(`#${id} creado en la tienda como inactivo: ${pub.slug} (${pub.variations} variantes)`);
    } catch (e) {
      log(`#${id} no se pudo publicar: ${e.message}`);
    }
  }
}

async function main() {
  if (!fs.existsSync(catalogFile)) throw new Error('No hay catálogo: corre primero "npm run scan"');
  catalog = readJson(catalogFile);
  if (flag('status')) return showStatus();
  requireEnv('ANTHROPIC_API_KEY', 'GEMINI_API_KEY');
  if (shouldPublish) {
    requireEnv('XDOPE_API_URL');
    if (!(process.env.XDOPE_AGENT_EMAIL ?? process.env.XDOPE_ADMIN_EMAIL)) requireEnv('XDOPE_AGENT_EMAIL', 'XDOPE_AGENT_PASSWORD');
  }
  log(`Modo ${mode}`);

  const open = mode === 'batch' ? await collect() : [];
  const pendingIds = new Set(open.flatMap((b) => b.requests.map((r) => r.designId)).filter((x) => x != null));
  // El Curador necesita el contexto completo al aplicar su resultado; en batch se guarda sin la config.
  if (!flag('collect-only')) {
    const cur = await curateRequest(pendingIds);
    if (cur) {
      if (mode === 'realtime') await apply({ ...cur, ctx: { ...cur.ctx, config } }, await runRealtime(cur));
      else await submit([cur]);
    }
  }

  for (let round = 0; round < 60; round++) {
    const inProgress = catalog.designs.filter((d) => d.status === 'in_progress' && !pendingIds.has(d.id));
    const reqs = [];
    for (const d of inProgress) {
      try { reqs.push(...planDesign(d.id)); }
      catch (e) { setStatus(d.id, 'error', { reason: e.message }); log(`#${d.id} ERROR: ${e.message}`); }
    }
    if (!reqs.length) break;
    if (mode === 'batch') { await submit(reqs); break; }
    for (const r of reqs) await apply(r, await runRealtime(r));
  }

  if (shouldPublish) await publishReady();
  if (mode === 'batch') showStatus();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
