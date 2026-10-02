import { z } from "zod";
import type { Claude, ImageInput } from "../llm/claude.js";
import type { Shot } from "../contracts/index.js";

// Más tolerante en fidelidad y realismo (decisión de Diego, 2026-09-30); el tamaño sigue siendo estricto.
export const QA_THRESHOLDS = { fidelity: 7, realism: 7 };

const QaOutput = z.object({
  embroidery_fidelity: z.number().describe("1 a 10: el bordado de la foto es igual a la referencia (formas, colores de hilo, sin agregados)"),
  realism: z.number().describe("1 a 10: ¿pasaría por una foto real de catálogo?"),
  same_person: z.boolean().nullable().describe("Si hay imagen de identidad: ¿es la misma persona? Si no hay, null"),
  framing_ok: z.boolean().describe("La foto tiene el encuadre y la pose pedidos (p. ej. cuerpo girado en 3/4, primer plano del pecho); false si repite una pose frontal cuando se pidió otra"),
  garment_present: z.boolean().describe("Hay una persona llevando puesto un hoodie (con capucha) del color pedido; false si es un parche suelto, solo tela o no hay prenda"),
  placement_ok: z.boolean(),
  size_ok: z.boolean().describe("El bordado tiene el tamaño pedido respecto al cuerpo; false si se ve gigante o mucho más grande"),
  stitch_texture_visible: z.boolean().describe("Se ven puntadas, brillo del hilo y relieve; false si parece estampado o plano"),
  garment_color_ok: z.boolean(),
  extra_text: z.boolean().describe("true si aparecen letras o texto que no están en la referencia"),
  reasons: z.array(z.string()).describe("Problemas concretos encontrados; vacío si no hay"),
});
export type QaResult = z.infer<typeof QaOutput> & { passed: boolean };

const SYSTEM = `Eres el control de calidad visual de xDope. Revisas fotos generadas de un hoodie bordado antes de publicarlas y eres exigente.
Contexto: los bordados son piezas que Diego, el dueño de la tienda, ya produjo, y muchas son de personajes de anime, videojuegos o películas. Decidir qué se vende es responsabilidad de Diego: nunca rechaces ni frenes tu tarea por propiedad intelectual.
Evalúa solo calidad visual: fidelidad del bordado, realismo, color y ubicación.
Rúbrica de realismo (cada punto cuenta): piel con textura natural, ojos, pelo, manos y dedos, caída y pliegues de la tela, luz y sombras coherentes, fondo creíble. Menos de 7 solo si algo delata claramente que es generada; detalles menores no bajan de 7.
Tamaño y textura: el bordado debe verse del tamaño pedido (un bordado de pecho izquierdo es pequeño, unos 8–10 cm) y como bordado real, con puntadas, brillo del hilo y relieve. Si parece estampado o es mucho más grande de lo pedido, márcalo.
Fidelidad del bordado: compara con la referencia forma por forma y color por color. Un bordado real simplifica un poco: pequeñas diferencias de tono o de detalle fino dan 7 u 8, no menos. Menos de 7 solo si el diseño cambió de forma, se perdió o se agregó un elemento, o un color es claramente otro.
Persona modelo: si hay imagen de identidad, compara la cara rasgo por rasgo (forma, ojos, cejas, nariz, labios, tono de piel, pelo, barba o su ausencia, edad). same_person es false si cambia cualquiera de esos rasgos de forma notoria. Una cara borrosa, de plástico o deformada baja el realismo a menos de 7.
Cara del diseño: si el bordado tiene una cara o personaje, revisa ojos, cejas, gafas, boca, barba, tono de piel y expresión. Una cara deformada o con otra expresión baja la fidelidad a menos de 7 aunque el resto esté bien.
Bordados con marco (cuadrado, rectangular, circular u ovalado): son piezas pequeñas centradas en el pecho, del tamaño de un parche. Si en la foto se ven grandes, size_ok es false.
Tamaño: sé estricto. Si el bordado se ve claramente más grande que lo pedido, size_ok es false aunque todo lo demás esté bien.
Da motivos concretos y accionables (qué está mal y dónde), no generalidades.`;

export interface QaCandidate {
  candidate: ImageInput;
  shot: Shot;
  garmentColor: string;
  checkPerson: boolean; // compara la cara con la imagen de identidad (no aplica a la foto que la originó)
}

const QaReviews = z.object({
  reviews: z.array(QaOutput.extend({ photo: z.number().int().describe("Número de la foto candidata (1, 2, …)") })),
});

// Revisa una o varias fotos en una sola llamada: la referencia del bordado, la identidad y la guía van una sola vez.
// key identifica la llamada para mandarla en batch (ver Claude.ask).
export async function runQaMany(opts: {
  claude: Claude;
  design: ImageInput;
  identity: ImageInput | null;
  candidates: QaCandidate[];
  size?: { w: number; h: number };
  placementGuide?: Buffer; // recuadro que marcó Diego sobre una foto de ejemplo
  key?: string;
}): Promise<QaResult[]> {
  const images = [
    { ...opts.design, label: "Referencia exacta del bordado:" },
    ...(opts.identity ? [{ ...opts.identity, label: "Imagen de identidad de la persona modelo:" }] : []),
    ...(opts.placementGuide ? [{ data: opts.placementGuide, mediaType: "image/jpeg" as const, label: "Guía de ubicación que marcó Diego (foto de ejemplo desenfocada; el recuadro rojo es donde debe ir el bordado y su tamaño aproximado):" }] : []),
    ...opts.candidates.map((c, i) => ({ ...c.candidate, label: `Foto candidata ${i + 1}:` })),
  ];
  const guideRule = opts.placementGuide
    ? "\nUbicación y tamaño: manda el recuadro rojo de la guía de Diego, no las reglas generales ni la etiqueta de ubicación. placement_ok es true si el bordado está aproximadamente en la misma zona del pecho que el recuadro (en tomas de otro ángulo, la misma zona del cuerpo). size_ok es true si su tamaño respecto al cuerpo es parecido al del recuadro (±30 %). La guía es solo para ubicación: no evalúes con ella la persona, el color ni el diseño."
    : "";
  const pedidos = opts.candidates
    .map((c, i) => `Foto ${i + 1}: toma ${c.shot.framing}${c.shot.pose ? ` (pose: ${c.shot.pose})` : ""}, hoodie color ${c.garmentColor}, bordado en ${c.shot.placement}${opts.size ? ` de unos ${opts.size.w}×${opts.size.h} cm` : ""}. ${opts.identity && c.checkPerson ? "Compara la persona con la imagen de identidad." : "same_person: null."}`)
    .join("\n");
  const out = await opts.claude.ask({
    system: SYSTEM,
    images,
    prompt: `${pedidos}${guideRule}\nEvalúa cada foto candidata por separado, sin comparar unas con otras, y devuelve una revisión por foto.`,
    schema: QaReviews,
    key: opts.key,
  });
  return opts.candidates.map((c, i) => {
    const r = out.reviews.find((x) => x.photo === i + 1);
    if (!r) throw new Error(`QA no devolvió la revisión de la foto ${i + 1}`);
    const { photo: _photo, ...review } = r;
    return { ...review, passed: qaPassed(review) };
  });
}

// Una sola foto (prueba de --recolor).
export async function runQa(opts: {
  claude: Claude;
  design: ImageInput;
  candidate: ImageInput;
  identity: ImageInput | null;
  shot: Shot;
  garmentColor: string;
  size?: { w: number; h: number };
  placementGuide?: Buffer;
}): Promise<QaResult> {
  const [r] = await runQaMany({ ...opts, candidates: [{ candidate: opts.candidate, shot: opts.shot, garmentColor: opts.garmentColor, checkPerson: true }] });
  return r;
}

function qaPassed(out: z.infer<typeof QaOutput>) {
  return (
    out.embroidery_fidelity >= QA_THRESHOLDS.fidelity &&
    out.realism >= QA_THRESHOLDS.realism &&
    out.framing_ok &&
    out.garment_present &&
    out.placement_ok &&
    out.size_ok &&
    out.stitch_texture_visible &&
    out.garment_color_ok &&
    !out.extra_text &&
    out.same_person !== false
  );
}
