import { z } from "zod";
import type { Claude, ImageInput } from "../llm/claude.js";
import type { Shot } from "../contracts/index.js";

// Más tolerante en fidelidad y realismo (decisión de Diego, 2026-09-30); el tamaño sigue siendo estricto.
export const QA_THRESHOLDS = { fidelity: 7, realism: 7 };

const QaOutput = z.object({
  embroidery_fidelity: z.number().describe("1 a 10: el bordado de la foto es igual a la referencia (formas, colores de hilo, sin agregados)"),
  realism: z.number().describe("1 a 10: ¿pasaría por una foto real de catálogo?"),
  same_person: z.boolean().nullable().describe("Si hay imagen de identidad: ¿es la misma persona? Si no hay, null"),
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
Bordados con marco (cuadrado, rectangular, circular u ovalado): son piezas pequeñas de pecho izquierdo, del tamaño de un parche. Si en la foto se ven grandes o centrados, size_ok es false.
Tamaño: sé estricto. Si el bordado se ve claramente más grande que lo pedido, size_ok es false aunque todo lo demás esté bien.
Da motivos concretos y accionables (qué está mal y dónde), no generalidades.`;

export async function runQa(opts: {
  claude: Claude;
  design: ImageInput;
  candidate: ImageInput;
  identity: ImageInput | null;
  shot: Shot;
  garmentColor: string;
  size?: { w: number; h: number };
}): Promise<QaResult> {
  const images = [
    { ...opts.design, label: "Referencia exacta del bordado:" },
    ...(opts.identity ? [{ ...opts.identity, label: "Imagen de identidad de la persona modelo:" }] : []),
    { ...opts.candidate, label: "Foto candidata a revisar:" },
  ];
  const out = await opts.claude.ask({
    system: SYSTEM,
    images,
    prompt: `Toma pedida: ${opts.shot.framing}, hoodie color ${opts.garmentColor}, bordado en ${opts.shot.placement}${opts.size ? ` de unos ${opts.size.w}×${opts.size.h} cm` : ""}.\nEvalúa la foto candidata.`,
    schema: QaOutput,
  });
  const passed =
    out.embroidery_fidelity >= QA_THRESHOLDS.fidelity &&
    out.realism >= QA_THRESHOLDS.realism &&
    out.placement_ok &&
    out.size_ok &&
    out.stitch_texture_visible &&
    out.garment_color_ok &&
    !out.extra_text &&
    out.same_person !== false;
  return { ...out, passed };
}
