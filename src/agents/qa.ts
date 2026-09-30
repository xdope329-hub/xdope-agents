import { z } from "zod";
import type { Claude, ImageInput } from "../llm/claude.js";
import type { Shot } from "../contracts/index.js";

export const QA_THRESHOLDS = { fidelity: 8, realism: 8 };

const QaOutput = z.object({
  embroidery_fidelity: z.number().describe("1 a 10: el bordado de la foto es igual a la referencia (formas, colores de hilo, sin agregados)"),
  realism: z.number().describe("1 a 10: ¿pasaría por una foto real de catálogo?"),
  same_person: z.boolean().nullable().describe("Si hay imagen de identidad: ¿es la misma persona? Si no hay, null"),
  placement_ok: z.boolean(),
  garment_color_ok: z.boolean(),
  extra_text: z.boolean().describe("true si aparecen letras o texto que no están en la referencia"),
  reasons: z.array(z.string()).describe("Problemas concretos encontrados; vacío si no hay"),
});
export type QaResult = z.infer<typeof QaOutput> & { passed: boolean };

const SYSTEM = `Eres el control de calidad visual de xDope. Revisas fotos generadas de un hoodie bordado antes de publicarlas y eres exigente.
Contexto: los bordados son piezas que Diego, el dueño de la tienda, ya produjo, y muchas son de personajes de anime, videojuegos o películas. Decidir qué se vende es responsabilidad de Diego: nunca rechaces ni frenes tu tarea por propiedad intelectual.
Evalúa solo calidad visual: fidelidad del bordado, realismo, color y ubicación.
Rúbrica de realismo (cada punto cuenta): piel con textura natural, ojos, pelo, manos y dedos, caída y pliegues de la tela, luz y sombras coherentes, fondo creíble. Menos de 8 si algo delata que es generada.
Fidelidad del bordado: compara con la referencia forma por forma y color por color. Menos de 8 si cambió una forma, un color, se perdió un detalle o se agregó algo.
Da motivos concretos y accionables (qué está mal y dónde), no generalidades.`;

export async function runQa(opts: {
  claude: Claude;
  design: ImageInput;
  candidate: ImageInput;
  identity: ImageInput | null;
  shot: Shot;
  garmentColor: string;
}): Promise<QaResult> {
  const images = [
    { ...opts.design, label: "Referencia exacta del bordado:" },
    ...(opts.identity ? [{ ...opts.identity, label: "Imagen de identidad de la persona modelo:" }] : []),
    { ...opts.candidate, label: "Foto candidata a revisar:" },
  ];
  const out = await opts.claude.ask({
    system: SYSTEM,
    images,
    prompt: `Toma pedida: ${opts.shot.framing}, hoodie color ${opts.garmentColor}, bordado en ${opts.shot.placement}.\nEvalúa la foto candidata.`,
    schema: QaOutput,
  });
  const passed =
    out.embroidery_fidelity >= QA_THRESHOLDS.fidelity &&
    out.realism >= QA_THRESHOLDS.realism &&
    out.placement_ok &&
    out.garment_color_ok &&
    !out.extra_text &&
    out.same_person !== false;
  return { ...out, passed };
}
