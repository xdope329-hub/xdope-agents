// Agente 0 — Curador creativo: elige diseños, imagen de partida, título, descripción corta y categorías.
const { z } = require('zod');
const { ask } = require('../lib/claude');

const SYSTEM = `Eres el curador creativo de xDope, una marca colombiana de hoodies bordados con estética streetwear.
Recibes fotos de diseños de bordado candidatos (cada uno con su ID y, a veces, varias fotos numeradas).
Tu trabajo:
1. Elegir los diseños con más potencial de venta en un hoodie: foto nítida, diseño atractivo y legible, variedad frente
   a lo ya publicado. Los diseños con personajes o marcas reconocibles están permitidos; solo márcalos en ip_risk.
2. Para cada diseño elegido, escoger la foto de partida más clara (índice dentro de sus fotos).
3. Escribir un título de producto en español: corto (2–5 palabras), memorable, que empiece por "Hoodie" o lo incluya
   con naturalidad, sin nombres de marcas ni personajes con copyright, distinto a los títulos ya existentes.
4. Escribir una descripción corta creativa (1–2 frases, máximo 200 caracteres), voz de marca cercana y con actitud.
5. Categorizar: un tema principal (y uno secundario solo si aplica con claridad) de la lista permitida, con confianza
   0–1 y razón breve; si ninguno encaja con confianza >= al mínimo, usa el tema de respaldo. Añade 3–8 tags en español.`;

const Brief = z.object({
  picks: z.array(z.object({
    id: z.number().int(),
    start_photo_index: z.number().int(),
    title: z.string(),
    short_description: z.string(),
    themes: z.array(z.object({ slug: z.string(), confidence: z.number(), reason: z.string() })),
    tags: z.array(z.string()),
    ip_risk: z.enum(['none', 'possible', 'likely']),
    selection_reason: z.string(),
  })),
});

function photosOf(d) { return [d.photo, ...(d.extra_photos || [])]; }

async function curate({ config, candidates, count, existingTitles }) {
  const { taxonomy } = config;
  const images = candidates.flatMap((d) => photosOf(d).map((file, i) => ({
    label: `Diseño ID ${d.id}${d.name ? ` ("${d.name}")` : ''} — foto ${i}`,
    file,
    maxSide: 512,
  })));
  const text = [
    `Elige exactamente ${count} diseño(s) entre los candidatos.`,
    `Temas permitidos (slug: nombre): ${taxonomy.themes.map((t) => `${t.slug}: ${t.name}`).join('; ')}.`,
    `Máximo ${taxonomy.maxThemesPerProduct} temas por producto. Confianza mínima ${taxonomy.minConfidence}; respaldo: ${taxonomy.fallback}.`,
    `Títulos ya usados en la tienda: ${existingTitles.length ? existingTitles.join(' | ') : '(ninguno)'}.`,
  ].join('\n');

  const out = await ask({ model: config.llm.models.default, system: SYSTEM, images, text, schema: Brief });
  const valid = new Set(taxonomy.themes.map((t) => t.slug));
  const now = new Date().toISOString();

  return out.picks.slice(0, count).map((p) => {
    const design = candidates.find((d) => d.id === p.id);
    if (!design) throw new Error(`El curador eligió un ID que no estaba entre los candidatos: ${p.id}`);
    let themes = p.themes.filter((t) => valid.has(t.slug) && t.confidence >= taxonomy.minConfidence)
      .slice(0, taxonomy.maxThemesPerProduct);
    if (!themes.length) themes = [{ slug: taxonomy.fallback, confidence: 0, reason: 'Ningún tema superó la confianza mínima' }];
    const photos = photosOf(design);
    return {
      id: design.id,
      start_image: photos[p.start_photo_index] ?? photos[0],
      title: p.title.trim(),
      short_description: p.short_description.trim().slice(0, 200),
      selection_reason: p.selection_reason,
      ip_risk: p.ip_risk,
      categories: { garment: config.store.categorySlugs, themes },
      tags: p.tags,
      created_at: now,
    };
  });
}

module.exports = { curate };
