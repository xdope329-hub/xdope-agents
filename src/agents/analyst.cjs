// Agente 2 — Analista visual: describe el bordado y elige colores de prenda.
const { z } = require('zod');

const SYSTEM = `Eres analista visual de bordados para una tienda de hoodies. A partir de la foto de un bordado real:
- Describe el motivo con precisión (qué muestra, estilo, formas clave, texto visible literal si lo hay).
- Lista los colores de hilo con su hex aproximado.
- Propón la ubicación en el hoodie (chest_left, chest_center o back_center) y el ancho en cm (chest_left 7–10,
  chest_center 18–26, back_center 25–30), según el nivel de detalle del diseño.
- Elige los colores de prenda de la lista permitida que mejor contrasten con los hilos, ordenados del mejor al peor,
  con una razón breve para cada uno. Nunca elijas un color de prenda que haga desaparecer el bordado.
- Evalúa riesgo de propiedad intelectual (none/possible/likely) y la calidad de la foto (ok/low).`;

function schemaFor(colorKeys) {
  return z.object({
    motif: z.string(),
    style: z.string(),
    visible_text: z.string().nullable(),
    thread_colors: z.array(z.object({ name: z.string(), hex: z.string() })),
    placement: z.object({ area: z.enum(['chest_left', 'chest_center', 'back_center']), width_cm: z.number() }),
    garment_colors: z.array(z.object({ key: z.enum(colorKeys), reason: z.string() })),
    risks: z.object({ ip: z.enum(['none', 'possible', 'likely']), quality: z.enum(['ok', 'low']), notes: z.string() }),
  });
}

function request({ config, brief, design }) {
  const colors = config.garment.colors;
  const text = [
    `Diseño ID ${design.id}${design.name ? `, nombre de carpeta: "${design.name}"` : ''}. Título de producto: "${brief.title}".`,
    `Colores de prenda permitidos: ${colors.map((c) => `${c.key} (${c.label}, ${c.hex})`).join(', ')}.`,
    `Devuelve al menos ${config.garment.minColors + 1} colores ordenados por preferencia.`,
  ].join('\n');
  return {
    model: config.llm.models.default, system: SYSTEM, text,
    images: [{ file: brief.start_image }], schema: schemaFor(colors.map((c) => c.key)),
  };
}

function finish({ config, design }, out) {
  const seen = new Set();
  out.garment_colors = out.garment_colors.filter((c) => !seen.has(c.key) && seen.add(c.key));
  if (out.garment_colors.length < config.garment.minColors) {
    throw new Error(`El analista propuso solo ${out.garment_colors.length} colores (mínimo ${config.garment.minColors})`);
  }
  return { id: design.id, ...out };
}

module.exports = { request, finish };
