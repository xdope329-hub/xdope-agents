// Flujo completo por lote: Curador → Director de arte → generación + QA → Copywriter → Publicador.
// Cada paso guarda su artefacto en runs/<run_id>/; si algo falla, --resume sigue desde el último paso guardado.
//
//   npm run pipeline -- --design <design_id|ruta>[,…]   crea lotes para esos diseños
//   npm run pipeline -- --designs 3                    el Curador toma los 3 diseños nuevos más antiguos del catálogo
//   npm run pipeline -- --resume <run_id>[,…]          continúa (o reintenta) lotes existentes
//   npm run pipeline -- --status                       muestra en qué paso va cada lote
//   npm run pipeline -- --collect                      recoge los batch terminados y sigue los lotes en curso
//   npm run pipeline -- --approve <run_id>             tras revisar: aprueba las fotos actuales por encima de QA, sin reintentos
//   npm run pipeline -- --retry <run_id>               tras revisar: hace los reintentos configurados de las fotos rechazadas
//   … --publish   crea el producto INACTIVO en XDOPE_API_URL (sin esto el lote se queda listo en "qa")
//   … --quality baja|media|alta   calidad de las fotos del lote nuevo (por defecto IMAGE_QUALITY o baja)
//   … --auto-retries  el lote nuevo reintenta solo lo que QA rechaza, sin esperar la revisión de Diego
//   … --realtime  genera las fotos al momento (precio completo). Por defecto todo va en batch de Gemini (mitad de
//                 precio): el lote queda en "generating" y se recoge con --collect cuando cada batch termina.
import { unlinkSync } from "node:fs";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { z } from "zod";
import { runCopywriter } from "../agents/copywriter.js";
import { runCurator, type StoreCategory } from "../agents/curator.js";
import { runDirector, type GarmentColor } from "../agents/director.js";
import { attributeOfValues, colorAttribute, resolveColors, runPublisher, runTag } from "../agents/publisher.js";
import { CuratorPick, Defaults, MIN_COLORS, MockupSet, ProductBrief, ProductListing, PublishResult, ShotList } from "../contracts/index.js";
import { readCatalog, writeCatalog } from "../designs/library.js";
import { GeminiImages } from "../images/gemini.js";
import { approvedColors, decide, generateMockups, readProgress, toMockupSet, type ShotResult } from "../images/mockups.js";
import { Claude, type ImageInput } from "../llm/claude.js";
import { renderReview } from "../review.js";
import { QUALITY, parseQuality } from "../quality.js";
import { RunStore } from "../runs/store.js";
import { XdopeApi } from "../store/xdope.js";

const env = process.env;
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const list = (v?: string) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const MAX_COST = Number(env.MAX_IMAGE_COST_PER_PRODUCT ?? 3);
const [OUT_W, OUT_H] = (env.IMAGE_OUTPUT_SIZE ?? "1080x1350").split("x").map(Number);
const BATCH = !flag("realtime") && env.IMAGE_USE_BATCH !== "false";
const QUALITY_ARG = parseQuality(opt("quality") ?? env.IMAGE_QUALITY);
const PUBLISH = flag("publish");
const CATALOG = env.DESIGNS_CATALOG ?? "designs.json";
const DEFAULTS_FILE = env.DEFAULTS_FILE ?? "config/defaults.json";
const DESCRIPTION_TEMPLATE = env.DESCRIPTION_TEMPLATE ?? "config/description-template.html";

const store = new RunStore(env.RUNS_DIR ?? "runs");

if (flag("status")) {
  for (const r of await store.list()) {
    console.log(`${r.run_id}  ${r.status}${r.error ? `  (falló en ${r.error.step}: ${r.error.reason})` : ""}`);
  }
  process.exit(0);
}

for (const k of ["ANTHROPIC_API_KEY", "GEMINI_API_KEY"]) if (!env[k]) throw new Error(`Falta ${k}`);
if (PUBLISH) for (const k of ["XDOPE_API_URL", "XDOPE_AGENT_EMAIL", "XDOPE_AGENT_PASSWORD", "XDOPE_ADMIN_URL"]) if (!env[k]) throw new Error(`Falta ${k} para --publish`);

const claude = new Claude();
const gemini = new GeminiImages(env.GEMINI_API_KEY!);
const palette: GarmentColor[] = JSON.parse(await readFile("config/garment-colors.json", "utf8"));
const defaults = (await exists(DEFAULTS_FILE)) ? Defaults.parse(JSON.parse(await readFile(DEFAULTS_FILE, "utf8"))) : null;
if (PUBLISH && !defaults) throw new Error(`Falta ${DEFAULTS_FILE} para --publish (copia config/defaults.example.json)`);
const api = env.XDOPE_API_URL ? new XdopeApi(env.XDOPE_API_URL) : null;
let loggedIn = false;

// Una sola corrida a la vez (GUI, tareas programadas o consola), para no procesar dos veces el mismo lote.
const lockFile = path.join(store.dir, ".pipeline.lock");
if (await exists(lockFile)) {
  const pid = Number(await readFile(lockFile, "utf8"));
  if (isAlive(pid)) throw new Error(`Ya hay una corrida en curso (pid ${pid})`);
}
await mkdir(store.dir, { recursive: true });
await writeFile(lockFile, String(process.pid));
process.on("exit", () => {
  try {
    unlinkSync(lockFile);
  } catch {}
});

const runIds = [...list(opt("resume"))];
for (const id of list(opt("approve"))) runIds.push(await applyDecision(id, "approve"));
for (const id of list(opt("retry"))) runIds.push(await applyDecision(id, "retry"));
if (flag("collect")) {
  for (const r of await store.list()) if (["design_ready", "shots_planned", "generating"].includes(r.status) && !runIds.includes(r.run_id)) runIds.push(r.run_id);
}
for (const ref of list(opt("design"))) runIds.push(await createRun(ref, "elegido por Diego (--design)"));
if (opt("designs")) {
  const count = Number(opt("designs"));
  const catalog = await readCatalog(CATALOG);
  const busy = new Set((await store.list()).filter((r) => r.status !== "failed").map((r) => r.design_id));
  const picks = catalog.filter((d) => d.status === "new" && !busy.has(d.design_id)).slice(0, count);
  if (picks.length === 0) console.log("No hay diseños nuevos elegibles en el catálogo (corre npm run scan)");
  for (const d of picks) runIds.push(await createRun(d.design_id, "diseño nuevo más antiguo del catálogo"));
}
if (runIds.length === 0) {
  console.log("Nada que hacer: usa --design, --designs, --resume, --collect o --status");
  process.exit(0);
}

for (const runId of runIds) {
  const log = (msg: string) => console.log(`[${runId}] ${msg}`);
  try {
    await processRun(runId, log);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`FALLÓ: ${message}`);
    if ((await store.get(runId)).status !== "failed") await store.fail(runId, message);
  }
}
console.log(`Costo Claude: USD ${claude.usage.cost_usd.toFixed(2)}`);

// ── Lotes ───────────────────────────────────────────────────────────────────────────────────────

async function createRun(ref: string, reason: string): Promise<string> {
  let designId: string;
  let photo: string;
  let name: string;
  const catalog = await readCatalog(CATALOG);
  const entry = catalog.find((d) => d.design_id === ref);
  if (entry) {
    if (!env.DESIGNS_DIR) throw new Error("Falta DESIGNS_DIR");
    designId = entry.design_id;
    photo = path.join(env.DESIGNS_DIR, entry.photo_path);
    name = entry.name;
  } else if (await exists(ref)) {
    name = path.basename(ref, path.extname(ref));
    designId = `manual-${slug(name)}`;
    photo = ref;
  } else {
    throw new Error(`No existe el diseño ${ref} en ${CATALOG} ni como archivo`);
  }
  const base = `${new Date().toISOString().slice(0, 10)}-${slug(name) || "diseno"}`.slice(0, 60);
  let runId = base;
  for (let i = 2; await store.exists(runId); i++) runId = `${base}-${i}`;
  await store.create(runId, designId);
  const jpg = await sharp(await readFile(photo)).rotate().resize(1536, 1536, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 92 }).toBuffer();
  await writeFile(store.file(runId, "design.jpg"), jpg);
  await writeFile(store.file(runId, "source.json"), JSON.stringify({ design_id: designId, photo, selection_reason: reason, quality: QUALITY_ARG, batch: BATCH, review_before_retry: !flag("auto-retries") }, null, 2) + "\n");
  console.log(`[${runId}] lote creado para ${designId}`);
  return runId;
}

async function processRun(runId: string, log: (m: string) => void) {
  let state = await store.get(runId);
  if (state.status === "failed") {
    log(`Reintentando desde ${state.error?.step}`);
    state = await store.reopen(runId);
  }
  if (state.status === "inactive_created" || state.status === "live") return log(`Ya publicado (${state.status})`);
  const dir = store.runDir(runId);
  const design: ImageInput = { data: await readFile(store.file(runId, "design.jpg")), mediaType: "image/jpeg", label: "" };
  const source = JSON.parse(await readFile(store.file(runId, "source.json"), "utf8"));

  // 1. Curador
  let curator = await store.readArtifact(runId, "curator.json", CuratorPick);
  if (!curator) {
    log("Curador: título, descripción y categorías…");
    const { categories, fallback } = await curatorCategories();
    const out = await runCurator({ claude, runId, designId: source.design_id, design, categories, selectionReason: source.selection_reason, fallbackCategory: fallback });
    curator = await store.writeArtifact(runId, "curator.json", CuratorPick, out);
    log(`  ${curator.title} | ${curator.categories.map((c) => `${c.name} (${c.role})`).join(", ")}`);
  }
  if (state.status === "curated") state = await store.transition(runId, "design_ready");

  // 3. Director de arte
  let shotList = await store.readArtifact(runId, "shots.json", ShotList);
  if (!shotList) {
    log("Director de arte: colores, concepto y prompts…");
    shotList = await store.writeArtifact(runId, "shots.json", ShotList, (await runDirector({ claude, runId, design, title: curator.title, palette })).shotList);
    log(`  Colores: ${shotList.colors.map((c) => c.name).join(", ")} | ${shotList.shots.length} tomas`);
  }
  if (state.status === "design_ready") state = await store.transition(runId, "shots_planned");

  // 4–5. Generación y QA
  const QaFile = z.object({ results: z.array(z.any()), image_cost_usd: z.number() });
  let qa = (await store.readArtifact(runId, "qa.json", QaFile)) as { results: ShotResult[]; image_cost_usd: number } | null;
  if (!qa) {
    if (state.status === "shots_planned") state = await store.transition(runId, "generating");
    const outcome = await generateMockups({
      claude, gemini, runId, design, shotList, dir,
      ...QUALITY[parseQuality(source.quality)], maxCostUsd: MAX_COST, outSize: [OUT_W, OUT_H], batch: source.batch ?? BATCH, waitForBatch: false,
      reviewBeforeRetry: source.review_before_retry ?? true, log,
    });
    if (outcome.kind === "waiting") return log(`Batch pendiente (${outcome.state}); se recoge con --collect o con el botón de la GUI`);
    if (outcome.kind === "review") {
      const a = outcome.awaiting;
      await writeReview(runId, curator, shotList, { results: outcome.results, image_cost_usd: Number(outcome.imageCost.toFixed(3)) }, [], `Esperando tu revisión: QA rechazó ${a.rejected.join(", ")}. Aprueba las fotos (--approve) ${a.can_retry ? `o haz los reintentos (--retry, ~USD ${a.retry_cost_usd.toFixed(2)})` : "o descarta el lote; ya no quedan reintentos"}.`);
      return log(`Esperando tu revisión (${a.rejected.length} foto(s) rechazada(s) por QA). Revisa review.html y usa "Fotos OK" o "Hacer reintentos" en el panel`);
    }
    const { results, imageCost } = outcome;
    await store.writeArtifact(runId, "mockups.json", MockupSet, toMockupSet(runId, results, imageCost));
    qa = { results, image_cost_usd: Number(imageCost.toFixed(3)) };
    await writeFile(store.file(runId, "qa.json"), JSON.stringify(qa, null, 2) + "\n");
    log(`Fotos aprobadas: ${results.filter((r) => r.passed).length}/${results.length} | costo imágenes USD ${imageCost.toFixed(2)}`);
  }
  if (state.status === "generating") state = await store.transition(runId, "qa");
  const colors = approvedColors(shotList, qa.results);
  const approved = qa.results.filter((r) => r.passed && colors.includes(r.shot.color));
  await writeReview(runId, curator, shotList, qa, colors);
  if (colors.length < MIN_COLORS) {
    throw new Error(`Solo ${colors.length} colores con todas sus fotos aprobadas (mínimo ${MIN_COLORS}); revisa review.html`);
  }

  // 6. Copywriter
  let listing = await store.readArtifact(runId, "listing.json", ProductListing);
  if (!listing) {
    log("Copywriter: ficha y SEO…");
    const out = await runCopywriter({
      claude,
      title: curator.title,
      shortDescription: curator.short_description,
      subject: shotList.analysis.subject,
      style: shotList.analysis.style,
      garment: defaults?.garment ?? null,
      colors,
      sizes: [],
      categories: curator.categories.map((c) => c.name),
      shots: approved.map((r) => ({ shot_id: r.shot.shot_id, color: r.shot.color, framing: r.shot.framing })),
    });
    listing = await store.writeArtifact(runId, "listing.json", ProductListing, out);
  }

  if (!PUBLISH) return log(`Listo para publicar. Revisa ${path.join(dir, "review.html")} y corre: npm run pipeline -- --resume ${runId} --publish`);

  // 7. Publicador
  await login();
  const attrs = await api!.attributes();
  const colorAttr = colorAttribute(attrs);
  const sizeAttr = attributeOfValues(attrs, defaults!.size_attribute_value_ids);
  let brief = await store.readArtifact(runId, "brief.json", ProductBrief);
  if (!brief) {
    brief = await store.writeArtifact(runId, "brief.json", ProductBrief, await buildBrief(runId, curator, shotList, colors, colorAttr));
  }
  if (state.status === "qa") state = await store.transition(runId, "publishing");
  const images = await Promise.all(
    approved.map(async (r) => ({ color: r.shot.color, filename: `${brief!.slug}-${r.shot.shot_id}.jpg`, data: await readFile(path.join(dir, r.file!)) })),
  );
  const result = await runPublisher({
    api: api!, runId, environment: env.XDOPE_API_ENV === "prod" ? "prod" : "qa", adminUrl: env.XDOPE_ADMIN_URL!,
    brief, listing, images, colorAttr, sizeAttr, taxId: defaults!.tax_id, sizeChartImageId: defaults!.size_chart_image_id,
    descriptionTemplate: (await exists(DESCRIPTION_TEMPLATE)) ? await readFile(DESCRIPTION_TEMPLATE, "utf8") : undefined, log,
  });
  await store.writeArtifact(runId, "publish.json", PublishResult, result);
  await store.transition(runId, "inactive_created");
  await markPublished(brief.design_id, result.product_id);
  log(`Producto inactivo creado: ${result.admin_url}`);
}

// ── Apoyo ───────────────────────────────────────────────────────────────────────────────────────

async function login() {
  if (loggedIn) return;
  await api!.login(env.XDOPE_AGENT_EMAIL!, env.XDOPE_AGENT_PASSWORD!);
  loggedIn = true;
}

// Categorías de la tienda si hay API configurada; si no, la lista de prueba.
async function curatorCategories(): Promise<{ categories: StoreCategory[]; fallback: string }> {
  if (!api) {
    const categories: StoreCategory[] = JSON.parse(await readFile("config/categories.trial.json", "utf8"));
    return { categories, fallback: "General" };
  }
  const base = new Set(defaults?.base_category_ids ?? []);
  const all = await api.categories();
  const categories = all.filter((c) => !base.has(c.id) || c.id === defaults?.fallback_category_id).map((c) => ({ category_id: c.id, name: c.name }));
  const fallback = all.find((c) => c.id === defaults?.fallback_category_id)?.name ?? "General";
  return { categories, fallback };
}

async function buildBrief(runId: string, curator: CuratorPick, shotList: ShotList, colors: string[], colorAttr: ReturnType<typeof colorAttribute>) {
  const d = defaults!;
  // Las categorías del Curador se buscan por nombre en la tienda (pudo correr con la lista de prueba).
  const storeCats = await api!.categories();
  const key = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
  const byName = new Map(storeCats.map((c) => [key(c.name), c.id]));
  const themeIds = curator.categories.map((c) => byName.get(key(c.name)) ?? (c.category_id.startsWith("trial_") ? null : c.category_id)).filter((x): x is string => !!x);
  // Si el Curador sugirió una categoría que no existe, se crea (decisión de Diego, 2026-09-30) y reemplaza al respaldo.
  let newCategory: string | null = null;
  if (curator.suggested_new_category) {
    const name = curator.suggested_new_category.trim();
    newCategory = byName.get(key(name)) ?? null;
    if (!newCategory) {
      const created = await api!.request("POST", "/category", { name, slug: slug(name), status: 1, type: "product", parent_id: null });
      newCategory = String(created?.id ?? created?._id);
      console.log(`[${runId}] Categoría nueva creada: ${name}`);
    }
  }
  const themes = [...themeIds.filter((id) => !newCategory || id !== d.fallback_category_id), ...(newCategory ? [newCategory] : [])];
  const categoryIds = [...new Set([...d.base_category_ids, ...(themes.length ? themes : [d.fallback_category_id])])];
  const resolved = resolveColors(colorAttr, colors);
  const sizeValues = new Map((await api!.attributes()).flatMap((a) => a.attribute_values.map((v) => [v.id, v.value] as const)));
  let productSlug = slug(curator.title);
  const taken = await api!.productBySlug(productSlug);
  if (taken && !taken.tags?.includes(runTag(runId))) productSlug = `${productSlug}-${slug(curator.design_id).slice(-8)}`;
  return {
    run_id: runId,
    name: curator.title,
    slug: productSlug,
    category_ids: categoryIds,
    design_id: curator.design_id,
    embroidery_placement: shotList.analysis.best_placement,
    garment: d.garment,
    colors: resolved.map((c) => ({ ...c, hex: shotList.colors.find((x) => x.name === c.name)!.hex })),
    sizes: d.size_attribute_value_ids.map((id) => ({ name: sizeValues.get(id) ?? id, attribute_value_id: id })),
    price: d.price,
    stock_per_variant: d.stock_per_variant,
    title: curator.title,
    short_description: curator.short_description,
  };
}

// Aplica la decisión de Diego tras revisar las fotos y deja el lote listo para seguir en "generating".
async function applyDecision(runId: string, decision: "approve" | "retry"): Promise<string> {
  const dir = store.runDir(runId);
  let state = await store.get(runId);
  const progress = await readProgress(dir);
  if (!progress) throw new Error(`El lote ${runId} no tiene fotos generadas con la versión actual`);
  if (progress.awaiting_review) {
    await decide(dir, decision);
  } else if (decision === "approve" && (state.status === "qa" || (state.status === "failed" && state.error?.step === "qa"))) {
    progress.decision = "approve";
    await writeFile(path.join(dir, "mockups", "progress.json"), JSON.stringify(progress, null, 2));
  } else {
    throw new Error(`El lote ${runId} no está esperando revisión`);
  }
  if (state.status === "failed") state = await store.reopen(runId);
  // Se rehacen el resumen de fotos y la ficha con la nueva aprobación.
  for (const f of ["qa.json", "mockups.json", "listing.json"]) await rm(store.file(runId, f), { force: true });
  if (state.status === "qa") await store.transition(runId, "generating");
  console.log(`[${runId}] ${decision === "approve" ? "Fotos aprobadas por Diego" : "Reintentos pedidos por Diego"}`);
  return runId;
}

async function markPublished(designId: string, productId: string) {
  const catalog = await readCatalog(CATALOG);
  const entry = catalog.find((d) => d.design_id === designId);
  if (!entry) return;
  entry.status = "published";
  entry.products = [...new Set([...entry.products, productId])];
  await writeCatalog(CATALOG, catalog);
}

async function writeReview(runId: string, curator: CuratorPick, shotList: ShotList, qa: { results: ShotResult[]; image_cost_usd: number }, colors: string[], customNote?: string) {
  const summary = {
    designId: ".",
    curator,
    colors: shotList.colors,
    concept: shotList.concept.description,
    shots: qa.results.map(({ shot, file, attempts, passed }) => ({ shot_id: shot.shot_id, color: shot.color, framing: shot.framing, prompt: shot.prompt, file, passed, attempts })),
    image_cost_usd: qa.image_cost_usd,
    batch: BATCH,
  };
  const note = `Colores aprobados: ${colors.join(", ") || "ninguno"}. Nada se publica sin --publish, y siempre queda inactivo.`;
  await writeFile(store.file(runId, "review.html"), renderReview([summary], `Lote ${runId}`, customNote ?? note));
}

function slug(s: string) {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

async function exists(p: string) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
