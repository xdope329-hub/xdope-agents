// Panel local para manejar los lotes sin bloquear la consola: ver estados, revisar batches pendientes,
// recogerlos, crear lotes, reanudar y publicar. Uso: npm run gui (abre http://127.0.0.1:4646).
// Cada acción corre `pipeline` como proceso aparte; el panel solo lee runs/ y consulta a Gemini.
import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { GeminiImages } from "../images/gemini.js";
import { readProgress } from "../images/mockups.js";
import { parseQuality } from "../quality.js";
import { RunStore } from "../runs/store.js";

const env = process.env;
const PORT = Number(env.GUI_PORT ?? 4646);
const store = new RunStore(env.RUNS_DIR ?? "runs");
const gemini = env.GEMINI_API_KEY ? new GeminiImages(env.GEMINI_API_KEY) : null;

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

function startJob(args: string[]): Job {
  if (running()) throw new Error("Ya hay una acción en curso; espera a que termine");
  const job: Job = { id: jobs.length + 1, args, started_at: new Date().toISOString(), finished_at: null, exit_code: null, log: [] };
  jobs.push(job);
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli/pipeline.ts", ...args], { env, cwd: process.cwd() });
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
    out.push({
      run_id: r.run_id,
      design_id: r.design_id,
      status: r.status,
      error: r.error,
      updated_at: r.history.at(-1)?.at ?? null,
      title: curator?.title ?? null,
      quality: source?.quality ?? "media",
      batch: qa ? null : (progress?.batch ?? null),
      awaiting_review: qa ? null : (progress?.awaiting_review ?? null),
      has_progress: !!progress,
      approved: qa ? `${qa.results.filter((x: { passed: boolean }) => x.passed).length}/${qa.results.length}` : null,
      image_cost_usd: qa?.image_cost_usd ?? progress?.image_cost_usd ?? null,
      has_listing: await exists(path.join(dir, "listing.json")),
      has_review: await exists(path.join(dir, "review.html")),
      admin_url: publish?.admin_url ?? null,
    });
  }
  return out.sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
}

// Consulta cada batch pendiente una vez. Si alguno terminó, arranca la recolección en segundo plano.
async function checkBatches() {
  if (!gemini) throw new Error("Falta GEMINI_API_KEY en .env");
  const pending = (await runsSummary()).filter((r) => r.batch && r.status !== "failed");
  const states = [];
  for (const r of pending) {
    try {
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

function actionArgs(body: { action?: string; run_id?: string; count?: number; batch?: boolean; quality?: string; review?: boolean }): string[] {
  const runId = (id?: string) => {
    if (!id || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new Error("run_id inválido");
    return id;
  };
  switch (body.action) {
    case "new": {
      const n = Math.floor(Number(body.count ?? 1));
      if (!(n >= 1 && n <= 20)) throw new Error("Cantidad entre 1 y 20");
      return ["--designs", String(n), "--quality", parseQuality(body.quality), ...(body.batch === false ? ["--realtime"] : []), ...(body.review === false ? ["--auto-retries"] : [])];
    }
    case "collect":
      return ["--collect"];
    case "resume":
      return ["--resume", runId(body.run_id)];
    case "approve":
      return ["--approve", runId(body.run_id)];
    case "retry":
      return ["--retry", runId(body.run_id)];
    case "publish":
      return ["--resume", runId(body.run_id), "--publish"];
    default:
      throw new Error("Acción desconocida");
  }
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
*{box-sizing:border-box}body{margin:0;font:14px/1.45 system-ui,sans-serif;background:var(--bg);color:var(--fg)}
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
</style></head><body><main>
<h1>Agentes xDope</h1>
<div class="bar">
  <button class="primary" id="check">Revisar batches</button>
  <button id="collect">Recoger y continuar lotes</button>
  <span class="muted">|</span>
  <label>Nuevo lote: <input type="number" id="count" min="1" max="20" value="1"></label>
  <label>Calidad: <select id="quality"><option value="baja" selected>baja</option><option value="media">media</option><option value="alta">alta</option></select></label>
  <label><input type="checkbox" id="batch" checked> batch (mitad de precio)</label>
  <label title="Si QA rechaza fotos, el lote espera a que las revises antes de gastar en reintentos"><input type="checkbox" id="review" checked> revisar antes de reintentar</label>
  <button id="new">Crear</button>
  <span class="muted">|</span>
  <button id="refresh">Actualizar</button>
</div>
<div id="msg" class="muted"></div>
<div class="card" id="batches" hidden></div>
<div class="card"><table><thead><tr><th></th><th>Lote</th><th>Estado</th><th>Batch</th><th>Fotos OK</th><th>Costo img.</th><th>Acciones</th></tr></thead><tbody id="runs"></tbody></table></div>
<div class="card"><div class="muted" id="jobtitle">Sin acciones en curso</div><pre id="log"></pre></div>
</main>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const ago = (iso) => { if (!iso) return ""; const m = Math.round((Date.now() - new Date(iso)) / 60000); return m < 60 ? m + " min" : Math.round(m / 60) + " h"; };
const STATE = { JOB_STATE_PENDING: "en cola", JOB_STATE_RUNNING: "procesando", JOB_STATE_SUCCEEDED: "terminado", JOB_STATE_FAILED: "falló", JOB_STATE_CANCELLED: "cancelado", JOB_STATE_EXPIRED: "expiró" };
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
    if (r.admin_url) acts.push('<a href="' + esc(r.admin_url) + '" target="_blank"><button>Abrir en admin</button></a>');
    return "<tr><td><img class=thumb loading=lazy src='/runs/" + encodeURIComponent(r.run_id) + "/design.jpg'></td>" +
      "<td><b>" + esc(r.title || r.run_id) + '</b><div class="muted">' + esc(r.run_id) + " · calidad " + esc(r.quality) + " · " + ago(r.updated_at) + "</div>" + (r.error ? '<div class="err">Falló en ' + esc(r.error.step) + ": " + esc(r.error.reason) + "</div>" : "") + "</td>" +
      '<td><span class="badge s-' + (a ? "qa" : esc(r.status)) + '">' + (a ? "revisión pendiente" : esc(r.status)) + "</span>" + (a ? '<div class="muted">QA rechazó: ' + esc(a.rejected.join(", ")) + "</div>" : "") + "</td><td>" + b + "</td><td>" + esc(r.approved ?? "—") + "</td><td>" + (r.image_cost_usd != null ? "USD " + Number(r.image_cost_usd).toFixed(2) : "—") + '</td><td><div class="actions">' + acts.join("") + "</div></td></tr>";
  }).join("") : '<tr><td colspan=7 class="muted">Aún no hay lotes. Crea uno con el botón de arriba.</td></tr>';
}

function showJob(job) {
  busy = !!job && !job.finished_at;
  for (const id of ["collect", "new"]) $(id).disabled = busy;
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
$("new").onclick = () => act({ action: "new", count: Number($("count").value), batch: $("batch").checked, quality: $("quality").value, review: $("review").checked });
$("refresh").onclick = () => load().catch((e) => msg(e.message, true));
$("runs").onclick = (e) => { const b = e.target.closest("[data-act]"); if (!b) return;
  if (b.dataset.act === "approve" && !confirm("¿Aprobar las fotos actuales de " + b.dataset.run + " por encima de QA? Revisa antes el review.")) return;
  if (b.dataset.act === "publish" && !confirm("¿Crear el producto INACTIVO en la tienda para " + b.dataset.run + "?")) return;
  act({ action: b.dataset.act, run_id: b.dataset.run }); };

load().catch((e) => msg(e.message, true));
setInterval(() => { if (busy) load().catch(() => {}); }, 2500);
</script></body></html>`;
