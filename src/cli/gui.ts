// Panel local para manejar los lotes sin bloquear la consola: ver estados, revisar batches pendientes,
// recogerlos, crear lotes, reanudar y publicar. Uso: npm run gui (abre http://127.0.0.1:4646).
// Cada acción corre `pipeline` como proceso aparte; el panel solo lee runs/ y consulta a Gemini.
import { spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import sharp from "sharp";
import { readCatalog } from "../designs/library.js";
import { readdir } from "node:fs/promises";
import { GeminiImages } from "../images/gemini.js";
import { readProgress } from "../images/mockups.js";
import { claudeBatchState, pendingClaudeBatches } from "../llm/claude.js";
import { parseQuality } from "../quality.js";
import { RunStore } from "../runs/store.js";

const env = process.env;
const PORT = Number(env.GUI_PORT ?? 4646);
const store = new RunStore(env.RUNS_DIR ?? "runs");
const gemini = env.GEMINI_API_KEY ? new GeminiImages(env.GEMINI_API_KEY) : null;
const CATALOG = env.DESIGNS_CATALOG ?? "designs.json";
const THUMBS = path.join(store.dir, ".thumbs");
const DESIGN_ID = /^[A-Za-z0-9_-]+$/;
const PLACEMENT_REFS = env.PLACEMENT_REFS_DIR ?? "config/placement-refs";

interface Job {
  id: number;
  args: string[];
  started_at: string;
  finished_at: string | null;
  exit_code: number | null;
  log: string[];
}
const jobs: Job[] = [];
const running = () => jobs.find((j) => j.finished_at === null) ?? null;

// Acciones de recoloreado van a otro script; el resto al pipeline.
function startJob(args: string[]): Job {
  const script = args[0] === "recolor" ? "src/cli/recolor.ts" : "src/cli/pipeline.ts";
  if (args[0] === "recolor") args = args.slice(1);
  if (running()) throw new Error("Ya hay una acción en curso; espera a que termine");
  const job: Job = { id: jobs.length + 1, args, started_at: new Date().toISOString(), finished_at: null, exit_code: null, log: [] };
  jobs.push(job);
  const child = spawn(process.execPath, ["--import", "tsx", script, ...args], { env, cwd: process.cwd() });
  const push = (chunk: Buffer) => {
    job.log.push(...chunk.toString().split(/\r?\n/).filter(Boolean));
    if (job.log.length > 500) job.log.splice(0, job.log.length - 500);
  };
  child.stdout.on("data", push);
  child.stderr.on("data", push);
  child.on("close", (code) => {
    job.exit_code = code;
    job.finished_at = new Date().toISOString();
  });
  return job;
}

async function readJson(file: string) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function exists(p: string) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function runsSummary() {
  const runs = await store.list();
  const out = [];
  for (const r of runs) {
    const dir = store.runDir(r.run_id);
    const curator = await readJson(path.join(dir, "curator.json"));
    const qa = await readJson(path.join(dir, "qa.json"));
    const publish = await readJson(path.join(dir, "publish.json"));
    const progress = await readProgress(dir);
    const source = await readJson(path.join(dir, "source.json"));
    // Batch de Claude (Curador, Director, QA o Copywriter) esperando respuesta; se muestra como un batch más.
    const claudeBatch = (await pendingClaudeBatches(path.join(dir, "claude")))[0];
    const geminiBatch = qa ? null : (progress?.batch ?? null);
    out.push({
      run_id: r.run_id,
      design_id: r.design_id,
      status: r.status,
      error: r.error,
      updated_at: r.history.at(-1)?.at ?? null,
      title: curator?.title ?? null,
      quality: source?.quality ?? "media",
      batch: geminiBatch ?? (claudeBatch ? { job: claudeBatch.batch_id, model: "claude", stage: `Claude ${claudeBatch.key}`, state: claudeBatch.state, submitted_at: claudeBatch.submitted_at, checked_at: null, claude: true } : null),
      awaiting_review: qa ? null : (progress?.awaiting_review ?? null),
      has_progress: !!progress,
      approved: qa ? `${qa.results.filter((x: { passed: boolean }) => x.passed).length}/${qa.results.length}` : null,
      image_cost_usd: qa?.image_cost_usd ?? progress?.image_cost_usd ?? null,
      claude: await readJson(path.join(dir, "claude-usage.json")),
      has_listing: await exists(path.join(dir, "listing.json")),
      has_review: await exists(path.join(dir, "review.html")),
      has_photos: await exists(path.join(dir, "mockups", "progress.json")),
      has_recolor: await exists(path.join(dir, "recolor.html")),
      base_color: (await readJson(path.join(dir, "shots.json")))?.colors?.[0]?.name ?? null,
      admin_url: publish?.admin_url ?? null,
    });
  }
  return out.sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
}

// Catálogo de designs.json (npm run scan:library) con el lote de cada diseño, paginado y filtrable.
async function designsPage(url: URL) {
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
  const filter = url.searchParams.get("filter") ?? "new";
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));
  const perPage = 48;
  const lotes = new Map<string, { run_id: string; status: string }>();
  for (const r of await store.list()) if (r.design_id) lotes.set(r.design_id, { run_id: r.run_id, status: r.status });
  const all = (await readCatalog(CATALOG))
    .filter((d) => d.status !== "missing")
    .filter((d) => (filter === "new" ? d.status === "new" && !lotes.has(d.design_id) : filter === "lote" ? lotes.has(d.design_id) : true))
    .filter((d) => !q || d.name.toLowerCase().includes(q) || d.photo_path.toLowerCase().includes(q))
    .sort((a, b) => a.photo_path.localeCompare(b.photo_path, "es", { numeric: true }));
  const items = all.slice((page - 1) * perPage, page * perPage).map((d) => ({ design_id: d.design_id, name: d.name, photo_path: d.photo_path, status: d.status, lote: lotes.get(d.design_id) ?? null }));
  return { total: all.length, page, per_page: perPage, items };
}

// Miniatura de la foto del bordado, generada una vez y guardada en runs/.thumbs/.
async function designThumb(designId: string): Promise<Buffer> {
  if (!DESIGN_ID.test(designId)) throw new Error("design_id inválido");
  const file = path.join(THUMBS, `${designId}.jpg`);
  if (await exists(file)) return readFile(file);
  const entry = (await readCatalog(CATALOG)).find((d) => d.design_id === designId);
  if (!entry || !env.DESIGNS_DIR) throw new Error("Diseño no encontrado");
  const data = await sharp(path.join(env.DESIGNS_DIR, entry.photo_path)).rotate().resize(240, 240, { fit: "inside" }).jpeg({ quality: 78 }).toBuffer();
  await mkdir(THUMBS, { recursive: true });
  await writeFile(file, data);
  return data;
}

// Consulta cada batch pendiente una vez. Si alguno terminó, arranca la recolección en segundo plano.
async function checkBatches() {
  if (!gemini) throw new Error("Falta GEMINI_API_KEY en .env");
  const pending = (await runsSummary()).filter((r) => r.batch && r.status !== "failed");
  const states = [];
  for (const r of pending) {
    try {
      if ("claude" in r.batch!) {
        const state = await claudeBatchState(r.batch!.job);
        states.push({ run_id: r.run_id, job: r.batch!.job, state, done: state === "ended", error: null });
        continue;
      }
      const check = await gemini.checkBatch(r.batch!.job, [], r.batch!.model);
      states.push({ run_id: r.run_id, job: r.batch!.job, state: check.state, done: check.done, error: check.error ?? null });
    } catch (err) {
      states.push({ run_id: r.run_id, job: r.batch!.job, state: "ERROR", done: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  let collecting = false;
  if (states.some((s) => s.done) && !running()) {
    startJob(["--collect"]);
    collecting = true;
  }
  return { states, collecting };
}

function send(res: ServerResponse, status: number, body: unknown, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".json": "application/json; charset=utf-8" };

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  try {
    if (req.method === "GET" && url.pathname === "/") return send(res, 200, PAGE, "text/html; charset=utf-8");
    if (req.method === "GET" && url.pathname === "/api/runs") return send(res, 200, { runs: await runsSummary(), job: running() ?? jobs.at(-1) ?? null });
    if (req.method === "GET" && url.pathname === "/api/job") return send(res, 200, running() ?? jobs.at(-1) ?? null);
    if (req.method === "GET" && url.pathname === "/api/palette") return send(res, 200, JSON.parse(await readFile("config/garment-colors.json", "utf8")));
    if (req.method === "GET" && url.pathname === "/api/placement-refs") {
      const files = (await exists(PLACEMENT_REFS)) ? await readdir(PLACEMENT_REFS) : [];
      return send(res, 200, files.filter((f) => f.endsWith(".jpg")).map((f) => f.slice(0, -4)));
    }
    if (req.method === "GET" && url.pathname.startsWith("/placement-refs/")) {
      const name = decodeURIComponent(url.pathname.slice("/placement-refs/".length));
      if (!/^[a-z0-9_-]+\.jpg$/i.test(name)) return send(res, 404, { error: "no encontrado" });
      return send(res, 200, await readFile(path.join(PLACEMENT_REFS, name)), "image/jpeg");
    }
    if (req.method === "GET" && url.pathname === "/api/designs") return send(res, 200, await designsPage(url));
    if (req.method === "GET" && url.pathname.startsWith("/designs/") && url.pathname.endsWith("/thumb")) {
      return send(res, 200, await designThumb(decodeURIComponent(url.pathname.split("/")[2])), "image/jpeg");
    }
    if (req.method === "POST" && url.pathname === "/api/check-batches") return send(res, 200, await checkBatches());
    if (req.method === "POST" && url.pathname === "/api/action") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const args = actionArgs(body);
      return send(res, 200, startJob(args));
    }
    if (req.method === "GET" && url.pathname.startsWith("/runs/")) {
      const [runId, ...rest] = decodeURIComponent(url.pathname.slice("/runs/".length)).split("/");
      const file = store.file(runId, rest.join("/"));
      const ext = path.extname(file).toLowerCase();
      if (!TYPES[ext]) return send(res, 404, { error: "no encontrado" });
      return send(res, 200, await readFile(file), TYPES[ext]);
    }
    send(res, 404, { error: "no encontrado" });
  } catch (err) {
    send(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
});

type Box = { ref: string; x: number; y: number; w: number; h: number };

function actionArgs(body: { action?: string; run_id?: string; count?: number; batch?: boolean; quality?: string; review?: boolean; design_ids?: string[]; placement_box?: Box | null; colors?: string[] }): string[] {
  const runId = (id?: string) => {
    if (!id || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new Error("run_id inválido");
    return id;
  };
  switch (body.action) {
    case "new": {
      const n = Math.floor(Number(body.count ?? 1));
      if (!(n >= 1 && n <= 20)) throw new Error("Cantidad entre 1 y 20");
      return ["--designs", String(n), ...lotOptions(body)];
    }
    case "new-selected": {
      const ids = body.design_ids ?? [];
      if (!ids.length || ids.length > 20) throw new Error("Elige entre 1 y 20 diseños");
      if (ids.some((id) => !DESIGN_ID.test(id))) throw new Error("design_id inválido");
      return ["--design", ids.join(","), ...lotOptions(body)];
    }
    case "collect":
      return ["--collect"];
    case "resume":
      return ["--resume", runId(body.run_id)];
    case "approve":
      return ["--approve", runId(body.run_id)];
    case "retry":
      return ["--retry", runId(body.run_id)];
    case "recolor": {
      const colors = (body.colors ?? []).map((c) => String(c));
      if (colors.some((c) => !/^[\p{L}\p{N} _-]+$/u.test(c))) throw new Error("Color inválido");
      return ["recolor", runId(body.run_id), ...(colors.length ? ["--colors", colors.join(",")] : [])];
    }
    case "publish":
      return ["--resume", runId(body.run_id), "--publish"];
    default:
      throw new Error("Acción desconocida");
  }
}

function lotOptions(body: { batch?: boolean; quality?: string; review?: boolean; placement_box?: Box | null }) {
  const b = body.placement_box;
  const box = b ? ["--box", `${b.ref}:${[b.x, b.y, b.w, b.h].map((n) => Number(n).toFixed(4)).join(",")}`] : [];
  return ["--quality", parseQuality(body.quality), ...(body.batch === false ? ["--realtime"] : []), ...(body.review === false ? ["--auto-retries"] : []), ...box];
}

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

server.listen(PORT, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`Panel de agentes xDope: ${url}  (Ctrl+C para cerrar)`);
  if (process.platform === "win32" && !process.argv.includes("--no-open")) spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
});

const PAGE = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agentes xDope</title>
<style>
:root{--bg:#f6f6f4;--card:#fff;--fg:#141414;--muted:#6b6b6b;--line:#e4e4e0;--accent:#1f5eff;--ok:#137333;--warn:#a15c00;--bad:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#121212;--card:#1c1c1c;--fg:#eee;--muted:#9a9a9a;--line:#2e2e2e;--accent:#6b9bff;--ok:#5bc27a;--warn:#e0a23a;--bad:#ff7a70}}
*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;font:14px/1.45 system-ui,sans-serif;background:var(--bg);color:var(--fg)}
main{max-width:1200px;margin:0 auto;padding:16px}h1{font-size:20px;margin:4px 0 16px}
.bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:16px}
button{font:inherit;padding:7px 12px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}button:disabled{opacity:.5;cursor:default}
select{font:inherit;padding:6px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg)}
input[type=number]{width:56px;font:inherit;padding:6px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg)}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px;margin-bottom:16px;overflow-x:auto}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:500}
.badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;border:1px solid currentColor}
.s-failed{color:var(--bad)}.s-inactive_created,.s-live{color:var(--ok)}.s-generating,.s-publishing{color:var(--warn)}.s-qa{color:var(--accent)}
.muted{color:var(--muted)}.err{color:var(--bad);font-size:12px}.thumb{width:44px;height:44px;object-fit:cover;border-radius:6px}
pre{white-space:pre-wrap;margin:0;max-height:320px;overflow:auto;font-size:12px}
.actions{display:flex;gap:6px;flex-wrap:wrap}#msg{min-height:20px}
input[type=search]{font:inherit;padding:6px 10px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);min-width:200px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px;margin:12px 0}
.dz{position:relative;border:2px solid var(--line);border-radius:10px;overflow:hidden;cursor:pointer;background:var(--bg)}
.dz.sel{border-color:var(--accent)}.dz img{width:100%;aspect-ratio:1;object-fit:contain;display:block;background:#fff}
.dz .cap{font-size:11px;padding:4px 6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dz .tag{position:absolute;top:6px;left:6px;font-size:10px;padding:1px 6px;border-radius:999px;background:var(--card);border:1px solid var(--line)}
.dz input{position:absolute;top:6px;right:6px;width:18px;height:18px}
</style></head><body><main>
<h1>Agentes xDope</h1>
<div class="bar">
  <button class="primary" id="check">Revisar batches</button>
  <button id="collect">Recoger y continuar lotes</button>
  <span class="muted">|</span>
  <label>Nuevo lote: <input type="number" id="count" min="1" max="20" value="1"></label>
  <label>Calidad: <select id="quality"><option value="economica" selected>económica</option><option value="baja">baja</option><option value="media">media</option><option value="alta">alta</option></select></label>
  <label><input type="checkbox" id="batch" checked> batch (mitad de precio)</label>
  <label title="Si QA rechaza fotos, el lote espera a que las revises antes de gastar en reintentos"><input type="checkbox" id="review" checked> revisar antes de reintentar</label>
  <button id="new">Crear</button>
  <span class="muted">|</span>
  <button id="refresh">Actualizar</button>
</div>
<div id="msg" class="muted"></div>
<div class="card" id="batches" hidden></div>
<div class="card">
  <div class="bar" style="margin:0">
    <b>Diseños</b>
    <input type="search" id="dq" placeholder="Buscar por nombre o carpeta">
    <select id="dfilter"><option value="new" selected>nuevos sin lote</option><option value="all">todos</option><option value="lote">con lote</option></select>
    <button id="dtoggle">Mostrar</button>
    <span class="muted" id="dcount"></span>
    <button class="primary" id="dprocess" disabled>Procesar seleccionados (0)</button>
    <button id="dclear">Limpiar selección</button>
    <button id="bopen" title="Dibuja en una foto de ejemplo dónde quieres el bordado">Marcar ubicación</button>
    <span class="muted" id="bstatus">ubicación: automática</span>
  </div>
  <div id="dpanel" hidden>
    <div class="grid" id="dgrid"></div>
    <div class="bar" style="margin:0"><button id="dprev">Anterior</button><span class="muted" id="dpage"></span><button id="dnext">Siguiente</button></div>
  </div>
</div>
<div class="card"><table><thead><tr><th></th><th>Lote</th><th>Estado</th><th>Batch</th><th>Fotos OK</th><th>Costo img.</th><th>Costo Claude</th><th>Acciones</th></tr></thead><tbody id="runs"></tbody></table></div>
<div id="bmodal" hidden style="position:fixed;inset:0;background:#0009;z-index:10;display:flex;align-items:center;justify-content:center;padding:16px">
  <div class="card" style="max-width:640px;width:100%;max-height:95vh;overflow:auto;margin:0">
    <div class="bar" style="margin:0 0 8px"><b>Marca dónde va el bordado</b>
      <select id="bref"></select><span class="muted">Arrastra para dibujar el recuadro</span></div>
    <div id="bwrap" style="position:relative;display:inline-block;cursor:crosshair;user-select:none;touch-action:none">
      <img id="bimg" style="display:block;max-width:100%;max-height:70vh" draggable="false">
      <div id="brect" style="position:absolute;border:3px solid #f00;display:none;pointer-events:none"></div>
    </div>
    <div class="bar" style="margin:8px 0 0"><button class="primary" id="buse">Usar esta ubicación</button><button id="bclear">Quitar (automática)</button><button id="bclose">Cerrar</button></div>
  </div>
</div>
<div id="rmodal" hidden style="position:fixed;inset:0;background:#0009;z-index:10;display:flex;align-items:center;justify-content:center;padding:16px">
  <div class="card" style="max-width:420px;width:100%;margin:0">
    <b>Recolorear sin IA (vista previa)</b>
    <p class="muted" id="rinfo"></p>
    <div id="rcolors" style="display:grid;gap:6px;margin:8px 0"></div>
    <p class="muted">Cuesta 1 máscara de Gemini por foto solo la primera vez (unos centavos); volver a teñir con otros colores es gratis. No publica nada.</p>
    <div class="bar" style="margin:0"><button class="primary" id="rgo">Recolorear</button><button id="rclose">Cerrar</button></div>
  </div>
</div>
<div class="card"><div class="muted" id="jobtitle">Sin acciones en curso</div><pre id="log"></pre></div>
</main>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const ago = (iso) => { if (!iso) return ""; const m = Math.round((Date.now() - new Date(iso)) / 60000); return m < 60 ? m + " min" : Math.round(m / 60) + " h"; };
const STATE = { in_progress: "en proceso", canceling: "cancelando", ended: "terminado", JOB_STATE_PENDING: "en cola", JOB_STATE_RUNNING: "procesando", JOB_STATE_SUCCEEDED: "terminado", JOB_STATE_FAILED: "falló", JOB_STATE_CANCELLED: "cancelado", JOB_STATE_EXPIRED: "expiró" };
let busy = false;

async function api(url, body) {
  const res = await fetch(url, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
function msg(t, bad) { $("msg").textContent = t; $("msg").style.color = bad ? "var(--bad)" : ""; }

async function load() {
  const { runs, job } = await api("/api/runs");
  showJob(job);
  $("runs").innerHTML = runs.length ? runs.map((r) => {
    const b = r.batch ? esc(r.batch.stage || "") + ": " + esc(STATE[r.batch.state] || r.batch.state) + '<div class="muted">enviado hace ' + ago(r.batch.submitted_at) + (r.batch.checked_at ? ", revisado hace " + ago(r.batch.checked_at) : "") + "</div>" : '<span class="muted">—</span>';
    const acts = [];
    if (r.has_review) acts.push('<a href="/runs/' + encodeURIComponent(r.run_id) + '/review.html" target="_blank"><button>Ver review</button></a>');
    // Con la ficha lista, lo único pendiente es publicar: un fallo ahí solo ofrece reintentar la publicación.
    const readyToPublish = r.has_listing && (["qa", "publishing"].includes(r.status) || (r.status === "failed" && ["qa", "publishing"].includes(r.error?.step)));
    const a = r.awaiting_review;
    const failedAtQa = r.status === "failed" && r.error?.step === "qa" && r.has_progress && !r.has_listing;
    if (a || failedAtQa) {
      acts.push('<button class="primary" data-act="approve" data-run="' + esc(r.run_id) + '">Fotos OK</button>');
      if (a?.can_retry) acts.push('<button data-act="retry" data-run="' + esc(r.run_id) + '">Hacer reintentos (~USD ' + Number(a.retry_cost_usd).toFixed(2) + ")</button>");
    }
    if (a) {
      // nada más: el lote espera la decisión
    } else if (readyToPublish) acts.push('<button data-act="publish" data-run="' + esc(r.run_id) + '">' + (r.status === "failed" ? "Reintentar publicación" : "Publicar (inactivo)") + "</button>");
    else if (!["inactive_created", "live"].includes(r.status)) acts.push('<button data-act="resume" data-run="' + esc(r.run_id) + '">' + (r.status === "failed" ? "Reintentar" : "Continuar") + "</button>");
    if (r.has_photos && r.base_color) acts.push('<button data-act="recolor" data-run="' + esc(r.run_id) + '" data-base="' + esc(r.base_color) + '">Recolorear (preview)</button>');
    if (r.has_recolor) acts.push('<a href="/runs/' + encodeURIComponent(r.run_id) + '/recolor.html" target="_blank"><button>Ver recoloreado</button></a>');
    if (r.admin_url) acts.push('<a href="' + esc(r.admin_url) + '" target="_blank"><button>Abrir en admin</button></a>');
    return "<tr><td><img class=thumb loading=lazy src='/runs/" + encodeURIComponent(r.run_id) + "/design.jpg'></td>" +
      "<td><b>" + esc(r.title || r.run_id) + '</b><div class="muted">' + esc(r.run_id) + " · calidad " + esc(r.quality) + " · " + ago(r.updated_at) + "</div>" + (r.error ? '<div class="err">Falló en ' + esc(r.error.step) + ": " + esc(r.error.reason) + "</div>" : "") + "</td>" +
      '<td><span class="badge s-' + (a ? "qa" : esc(r.status)) + '">' + (a ? "revisión pendiente" : esc(r.status)) + "</span>" + (a ? '<div class="muted">QA rechazó: ' + esc(a.rejected.join(", ")) + "</div>" : "") + "</td><td>" + b + "</td><td>" + esc(r.approved ?? "—") + "</td><td>" + (r.image_cost_usd != null ? "USD " + Number(r.image_cost_usd).toFixed(2) : "—") + "</td><td>" + claudeCell(r.claude) + '</td><td><div class="actions">' + acts.join("") + "</div></td></tr>";
  }).join("") : '<tr><td colspan=8 class="muted">Aún no hay lotes. Crea uno con el botón de arriba.</td></tr>';
}

function claudeCell(u) {
  if (!u) return '<span class="muted">—</span>';
  const parts = Object.entries(u.agents).sort((a, b) => b[1].cost_usd - a[1].cost_usd).map(([k, v]) => esc(k) + " " + Number(v.cost_usd).toFixed(3));
  return "USD " + Number(u.total_usd).toFixed(3) + '<div class="muted">' + parts.join(" · ") + "</div>";
}

function showJob(job) {
  busy = !!job && !job.finished_at;
  for (const id of ["collect", "new"]) $(id).disabled = busy;
  if (typeof updateSel === "function") updateSel();
  document.querySelectorAll("[data-act]").forEach((b) => (b.disabled = busy));
  if (!job) return;
  $("jobtitle").textContent = (busy ? "En curso: " : "Última acción: ") + "pipeline " + job.args.join(" ") + (job.finished_at ? " · terminó " + (job.exit_code === 0 ? "bien" : "con error " + job.exit_code) : "");
  $("log").textContent = job.log.join("\\n");
  $("log").scrollTop = $("log").scrollHeight;
}

async function act(body) {
  try { await api("/api/action", body); msg("Acción iniciada: corre en segundo plano"); await load(); }
  catch (e) { msg(e.message, true); }
}

$("check").onclick = async () => {
  $("check").disabled = true; msg("Consultando a Gemini…");
  try {
    const { states, collecting } = await api("/api/check-batches", {});
    $("batches").hidden = false;
    $("batches").innerHTML = states.length
      ? "<b>Batches pendientes</b><table>" + states.map((s) => "<tr><td>" + esc(s.run_id) + '</td><td class="muted">' + esc(s.job) + "</td><td>" + esc(STATE[s.state] || s.state) + (s.error ? ' <span class="err">' + esc(s.error) + "</span>" : "") + "</td></tr>").join("") + "</table>"
      : '<span class="muted">No hay batches pendientes.</span>';
    msg(collecting ? "Hay batches terminados: recogiendo resultados en segundo plano (QA y siguientes pasos)." : states.length ? "Ninguno terminó todavía; vuelve a revisar más tarde." : "");
    await load();
  } catch (e) { msg(e.message, true); }
  $("check").disabled = false;
};
$("collect").onclick = () => act({ action: "collect" });
// Selector de diseños: la selección se mantiene al cambiar de página o de filtro.
const selected = new Set();
let dpage = 1, dtotal = 0, dper = 48, dtimer;
async function loadDesigns() {
  const params = new URLSearchParams({ q: $("dq").value, filter: $("dfilter").value, page: String(dpage) });
  const d = await api("/api/designs?" + params);
  dtotal = d.total; dper = d.per_page;
  $("dcount").textContent = d.total + " diseños";
  $("dpage").textContent = "Página " + d.page + " de " + Math.max(1, Math.ceil(d.total / d.per_page));
  $("dgrid").innerHTML = d.items.map((x) => {
    const tag = x.lote ? '<span class="tag">lote: ' + esc(x.lote.status) + "</span>" : x.status !== "new" ? '<span class="tag">' + esc(x.status) + "</span>" : "";
    return '<label class="dz' + (selected.has(x.design_id) ? " sel" : "") + '" title="' + esc(x.photo_path) + '"><img loading="lazy" src="/designs/' + encodeURIComponent(x.design_id) + '/thumb">' + tag +
      '<input type="checkbox" data-id="' + esc(x.design_id) + '"' + (selected.has(x.design_id) ? " checked" : "") + '><div class="cap">' + esc(x.name) + "</div></label>";
  }).join("") || '<span class="muted">Sin resultados. ¿Corriste npm run scan:library?</span>';
}
function updateSel() {
  $("dprocess").textContent = "Procesar seleccionados (" + selected.size + ")";
  $("dprocess").disabled = busy || selected.size === 0;
}
$("dgrid").onchange = (e) => { const id = e.target.dataset?.id; if (!id) return;
  e.target.checked ? selected.add(id) : selected.delete(id); e.target.closest(".dz").classList.toggle("sel", e.target.checked); updateSel(); };
$("dtoggle").onclick = () => { const hidden = !$("dpanel").hidden; $("dpanel").hidden = hidden; $("dtoggle").textContent = hidden ? "Mostrar" : "Ocultar"; if (!hidden) loadDesigns().catch((e) => msg(e.message, true)); };
$("dq").oninput = () => { clearTimeout(dtimer); dtimer = setTimeout(() => { dpage = 1; $("dpanel").hidden = false; $("dtoggle").textContent = "Ocultar"; loadDesigns().catch((e) => msg(e.message, true)); }, 300); };
$("dfilter").onchange = () => { dpage = 1; if (!$("dpanel").hidden) loadDesigns().catch((e) => msg(e.message, true)); };
$("dprev").onclick = () => { if (dpage > 1) { dpage--; loadDesigns(); } };
$("dnext").onclick = () => { if (dpage * dper < dtotal) { dpage++; loadDesigns(); } };
$("dclear").onclick = () => { selected.clear(); updateSel(); if (!$("dpanel").hidden) loadDesigns(); };
// Recuadro de ubicación sobre una foto de ejemplo (coordenadas en fracciones de la foto).
let placementBox = null, draft = null, start = null;
function drawRect(b) {
  const r = $("brect");
  if (!b) { r.style.display = "none"; return; }
  const W = $("bimg").clientWidth, H = $("bimg").clientHeight;
  Object.assign(r.style, { display: "block", left: b.x * W + "px", top: b.y * H + "px", width: b.w * W + "px", height: b.h * H + "px" });
}
function pointer(e) {
  const r = $("bimg").getBoundingClientRect();
  return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
}
$("bopen").onclick = async () => {
  const refs = await api("/api/placement-refs");
  if (!refs.length) return msg("No hay fotos de ejemplo en config/placement-refs", true);
  $("bref").innerHTML = refs.map((n) => "<option>" + esc(n) + "</option>").join("");
  if (placementBox) $("bref").value = placementBox.ref;
  draft = placementBox;
  $("bimg").onload = () => drawRect(draft && draft.ref === $("bref").value ? draft : null);
  $("bimg").src = "/placement-refs/" + encodeURIComponent($("bref").value) + ".jpg";
  $("bmodal").hidden = false;
};
$("bref").onchange = () => { draft = null; $("bimg").src = "/placement-refs/" + encodeURIComponent($("bref").value) + ".jpg"; };
$("bwrap").onpointerdown = (e) => { start = pointer(e); try { $("bwrap").setPointerCapture(e.pointerId); } catch {} };
$("bwrap").onpointermove = (e) => { if (!start) return; const p = pointer(e);
  draft = { ref: $("bref").value, x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) }; drawRect(draft); };
$("bwrap").onpointerup = () => { start = null; };
$("buse").onclick = () => {
  if (!draft || draft.w < 0.02 || draft.h < 0.02) return alert("Dibuja un recuadro sobre la foto");
  placementBox = draft; $("bmodal").hidden = true;
  $("bstatus").textContent = "ubicación: marcada (" + placementBox.ref + ")";
};
$("bclear").onclick = () => { placementBox = null; draft = null; drawRect(null); $("bstatus").textContent = "ubicación: automática"; $("bmodal").hidden = true; };
$("bclose").onclick = () => { $("bmodal").hidden = true; };

$("dprocess").onclick = async () => {
  if (!confirm("¿Crear " + selected.size + " lote(s) con calidad " + $("quality").value + "?")) return;
  await act({ action: "new-selected", design_ids: [...selected], batch: $("batch").checked, quality: $("quality").value, review: $("review").checked, placement_box: placementBox });
  selected.clear(); updateSel(); if (!$("dpanel").hidden) loadDesigns();
};

$("new").onclick = () => act({ action: "new", count: Number($("count").value), batch: $("batch").checked, quality: $("quality").value, review: $("review").checked, placement_box: placementBox });
$("refresh").onclick = () => load().catch((e) => msg(e.message, true));
let recolorRun = null;
async function openRecolor(runId, base) {
  const palette = await api("/api/palette");
  recolorRun = runId;
  $("rinfo").textContent = "Lote " + runId + " · color base: " + base;
  $("rcolors").innerHTML = palette.filter((c) => c.name !== base).map((c) =>
    '<label><input type="checkbox" value="' + esc(c.name) + '" checked> <span style="display:inline-block;width:12px;height:12px;border-radius:3px;border:1px solid #0003;background:' + esc(c.hex) + '"></span> ' + esc(c.name) + "</label>").join("");
  $("rmodal").hidden = false;
}
$("rclose").onclick = () => { $("rmodal").hidden = true; };
$("rgo").onclick = () => {
  const colors = [...$("rcolors").querySelectorAll("input:checked")].map((i) => i.value);
  if (!colors.length) return alert("Elige al menos un color");
  $("rmodal").hidden = true;
  act({ action: "recolor", run_id: recolorRun, colors });
};

$("runs").onclick = (e) => { const b = e.target.closest("[data-act]"); if (!b) return;
  if (b.dataset.act === "recolor") return openRecolor(b.dataset.run, b.dataset.base);
  if (b.dataset.act === "approve" && !confirm("¿Aprobar las fotos actuales de " + b.dataset.run + " por encima de QA? Revisa antes el review.")) return;
  if (b.dataset.act === "publish" && !confirm("¿Crear el producto INACTIVO en la tienda para " + b.dataset.run + "?")) return;
  act({ action: b.dataset.act, run_id: b.dataset.run }); };

load().catch((e) => msg(e.message, true));
setInterval(() => { if (busy) load().catch(() => {}); }, 2500);
</script></body></html>`;
