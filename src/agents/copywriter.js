// Agente 6 — Copywriter/SEO: descripción larga y metadatos; título y descripción corta vienen del Curador.
const { z } = require('zod');
const { ask } = require('../lib/claude');

const SYSTEM = `Eres copywriter y SEO de xDope, marca colombiana de hoodies bordados (español de Colombia, tono cercano
y con actitud). Escribe:
- description: HTML simple (<p>, <ul><li>, <strong>) con: la historia/vibe del diseño, que es bordado (no estampado),
  detalles de la prenda y cuidados (lavar al revés en agua fría, no planchar sobre el bordado). No inventes material,
  gramaje ni características que no se te den.
- meta_title (máx. 60 caracteres), meta_description (máx. 155), og_title, og_description.
- slug en minúsculas con guiones.
No uses nombres de marcas ni personajes con copyright.`;

const Copy = z.object({
  description: z.string(), meta_title: z.string(), meta_description: z.string(),
  og_title: z.string(), og_description: z.string(), slug: z.string(),
});

async function write({ config, brief, analysis, colors }) {
  const labels = colors.map((k) => config.garment.colors.find((c) => c.key === k).label);
  const out = await ask({
    model: config.llm.models.copywriter, system: SYSTEM, schema: Copy,
    text: [
      `Título: "${brief.title}". Descripción corta: "${brief.short_description}".`,
      `Bordado: ${analysis.motif} (${analysis.style}). Ubicación: ${analysis.placement.area}.`,
      `Colores disponibles: ${labels.join(', ')}. Tallas: ${config.garment.sizes.join(', ')}.`,
      `Temas: ${brief.categories.themes.map((t) => t.slug).join(', ')}. Tags: ${brief.tags.join(', ')}.`,
    ].join('\n'),
  });
  return {
    name: brief.title, short_description: brief.short_description, ...out,
    meta_title: out.meta_title.slice(0, 60), meta_description: out.meta_description.slice(0, 155),
  };
}

module.exports = { write };
