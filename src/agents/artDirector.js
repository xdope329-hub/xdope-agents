// Agente 3 — Director de arte: escribe los prompts de generación para cada color y toma con IA.
const { z } = require('zod');

const SYSTEM = `Eres director de arte y fotógrafo de producto para una marca streetwear de hoodies bordados.
Escribes prompts en inglés para un modelo de generación de imágenes que recibirá como referencia la FOTO REAL DEL
BORDADO (y, si existe, la foto de un modelo de la casa y/o una foto base de la prenda).
Reglas para cada prompt:
- Describe una fotografía real: cámara y lente (p. ej. "shot on 35mm, f/2.8"), luz (natural suave o estudio), fondo,
  encuadre vertical 4:5, textura de piel natural con poros, cabello con mechones sueltos, pliegues reales de la tela.
- Hoodie de algodón grueso tipo heavyweight del color indicado, sin otros logos ni textos.
- El bordado debe reproducirse FIEL a la imagen de referencia (formas, colores de hilo, proporciones), con relieve y
  textura de puntada de bordado real (satin stitch / fill stitch), en la ubicación y ancho indicados. Nunca estampado.
- Consistencia: dentro del mismo producto usa SIEMPRE la misma persona (misma descripción física), mismo set y misma luz;
  cambia solo el color del hoodie. Modelo creíble de 20–35 años, pose y expresión naturales.
- Incluye un bloque "Avoid:" con: extra logos, invented text, printed or flat-looking embroidery, plastic skin,
  3D render or illustration look, deformed hands, extra fingers, distorted face.`;

const Prompts = z.object({
  model_description: z.string(),
  set_description: z.string(),
  items: z.array(z.object({ color: z.string(), shot: z.enum(['model_front', 'garment_flat', 'model_alt']), prompt: z.string() })),
});

const SHOT_TEXT = {
  model_front: 'modelo usando el hoodie, plano medio frontal, estilo lifestyle/estudio',
  garment_flat: 'el hoodie solo, sin persona, flat lay o ghost mannequin frontal, fondo neutro',
  model_alt: 'la misma persona en otra pose (tres cuartos o de perfil), mostrando el bordado',
};

function request({ config, brief, analysis, colors, aiShots, feedback }) {
  const colorInfo = colors.map((key) => {
    const c = config.garment.colors.find((x) => x.key === key);
    return `${key} (${c.label}, ${c.hex})`;
  });
  const text = [
    `Producto: "${brief.title}". Bordado: ${analysis.motif}. Estilo: ${analysis.style}.`,
    `Hilos: ${analysis.thread_colors.map((t) => `${t.name} ${t.hex}`).join(', ')}.`,
    analysis.visible_text ? `Texto del bordado (literal): "${analysis.visible_text}".` : 'El bordado no tiene texto.',
    `Ubicación: ${analysis.placement.area}, ancho ${analysis.placement.width_cm} cm.`,
    `Estilo general: ${config.style}.`,
    `Colores: ${colorInfo.join('; ')}.`,
    `Tomas por color: ${aiShots.map((s) => `${s} = ${SHOT_TEXT[s]}`).join('; ')}.`,
    `Escribe un item por cada combinación color × toma (${colors.length * aiShots.length} en total).`,
    feedback ? `Correcciones pedidas por QA en el intento anterior (aplícalas):\n${feedback}` : '',
  ].filter(Boolean).join('\n');

  return {
    model: config.llm.models.default, system: SYSTEM, text,
    images: [{ label: 'Foto real del bordado:', file: brief.start_image }], schema: Prompts,
  };
}

const finish = (_ctx, out) => out;

module.exports = { request, finish };
