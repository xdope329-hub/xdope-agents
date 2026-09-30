// Agente 5 — QA visual: compara cada mockup con la foto real del bordado.
const { z } = require('zod');
const { ask } = require('../lib/claude');

const SYSTEM = `Eres el control de calidad de fotos de producto de una tienda de hoodies bordados. Recibes la FOTO REAL
del bordado y un MOCKUP generado por IA. Sé exigente: la foto se publicará en la tienda.
Puntúa de 1 a 5:
- fidelity: el bordado del mockup coincide con el real (formas, colores de hilo, proporciones, sin elementos inventados).
- embroidery_look: se ve como bordado real con relieve y puntada, no como estampado plano.
- color: el hoodie es del color pedido.
- anatomy: persona y prenda sin deformaciones (manos, dedos, cara, costuras); sin logos ni textos extra.
- realism: parece una FOTO de una persona real (no piel plastificada o demasiado lisa, ojos/dientes naturales, cabello
  real, luz coherente, fondo creíble). Si no hay persona, evalúa el realismo de la prenda y la escena.
Si algo falla, explica en "fix" qué cambiar en el prompt, de forma concreta y breve (en inglés).`;

const Review = z.object({
  scores: z.object({
    fidelity: z.number().int(), embroidery_look: z.number().int(), color: z.number().int(),
    anatomy: z.number().int(), realism: z.number().int(),
  }),
  notes: z.string(),
  fix: z.string(),
});

async function review({ config, brief, file, colorLabel }) {
  const out = await ask({
    model: config.llm.models.default, system: SYSTEM,
    images: [
      { label: 'Foto real del bordado:', file: brief.start_image },
      { label: `Mockup (hoodie color ${colorLabel}):`, file },
    ],
    text: 'Evalúa el mockup.', schema: Review,
  });
  const approved = Object.values(out.scores).every((s) => s >= config.qa.minScore);
  return { file, ...out, approved };
}

module.exports = { review };
