// Resumen HTML de un lote: fotos, puntajes de QA, prompts y costo.
export function renderReview(items: Array<Record<string, any>>, heading = "Prueba de agentes xDope", note = "Nada de esto se publicó en la tienda.") {
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
<details><summary>Prompt</summary><p>${esc(s.prompt)}</p></details></figcaption></figure>${recolored(d, s.shot_id)}`;
        })
        .join("\n");
      return `<section><h2>${esc(d.curator.title)}</h2>
<div class="meta"><img class="design" src="${d.designId}/design.jpg"><div>
<p><i>${esc(d.curator.short_description)}</i></p>
<p><b>Categorías:</b> ${d.curator.categories.map((c: any) => `${esc(c.name)} (${c.role === "primary" ? "principal" : "secundaria"}, ${Math.round(c.confidence * 100)}%)`).join(", ")}${d.curator.suggested_new_category ? ` · sugerida: ${esc(d.curator.suggested_new_category)}` : ""}</p>
${d.curator.franchise_reference ? `<p><b>Referencia a franquicia:</b> ${esc(d.curator.franchise_reference)}</p>` : ""}
<p><b>Otros títulos:</b> ${d.curator.title_options.filter((t: string) => t !== d.curator.title).map(esc).join(" · ")}</p>
<p><b>Colores:</b> ${d.colors.map((c: any) => `<span class="sw" style="background:${c.hex}"></span>${esc(c.name)}`).join(" ")}</p>
<p><b>Modelo:</b> ${esc(d.concept)}</p>
<p><b>Costo imágenes:</b> USD ${d.image_cost_usd.toFixed(2)}${d.batch ? " (con batch)" : ""}${d.recolor ? ` · recoloreado desde ${esc(d.recolor.base)}: USD ${d.recolor.cost_usd.toFixed(2)} en máscaras` : ""}</p></div></div>
<div class="grid">${shots}</div></section>`;
    })
    .join("\n");
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(heading)}</title>
<style>body{font-family:system-ui,sans-serif;margin:0 auto;max-width:1200px;padding:16px;background:#fafafa;color:#111}h2{margin-top:40px}
.meta{display:flex;gap:16px;flex-wrap:wrap}.design{width:200px;border-radius:8px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px}
figure{margin:0;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px #0002}figure img{width:100%;display:block;aspect-ratio:4/5;object-fit:cover}
figcaption{padding:8px;font-size:14px}.ok{color:#137333}.bad{color:#b3261e}.sw{display:inline-block;width:14px;height:14px;border-radius:3px;border:1px solid #0003;vertical-align:middle;margin:0 4px 0 8px}.empty{aspect-ratio:4/5;display:grid;place-items:center;background:#eee}.recolor{outline:3px dashed #8a6d00}</style></head>
<body><h1>${esc(heading)}</h1><p>${esc(note)}</p>${blocks}</body></html>`;
}

// Versión teñida por código de la misma toma (experimento --recolor), al lado de la generada.
function recolored(d: Record<string, any>, shotId: string) {
  return (d.recolor?.shots ?? []).filter((x: any) => x.from === shotId).map((r: any) => `<figure class="recolor"><img src="${d.designId}/${r.file}" loading="lazy">
<figcaption><b class="${r.qa.passed ? "ok" : "bad"}">Teñida: ${r.qa.passed ? "aprobada" : "no pasa"}</b> · ${esc(r.color)} · teñida desde esta toma<br>
Bordado ${r.qa.embroidery_fidelity}/10 · Realismo ${r.qa.realism}/10
${r.qa.reasons?.length ? `<details><summary>Motivos</summary><ul>${r.qa.reasons.map((x: string) => `<li>${esc(x)}</li>`).join("")}</ul></details>` : ""}</figcaption></figure>`).join("");
}

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
