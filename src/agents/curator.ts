import { z } from "zod";
import { CuratorPick, MIN_CATEGORY_CONFIDENCE } from "../contracts/index.js";
import type { Claude, ImageInput } from "../llm/claude.js";

export interface StoreCategory {
  category_id: string;
  name: string;
}

const CuratorOutput = z.object({
  subject: z.string().describe("Qué muestra el bordado, en una frase"),
  title_options: z.array(z.string()).describe("Exactamente 3 títulos de máximo 60 caracteres"),
  title: z.string().describe("Uno de los 3 títulos, copiado exacto"),
  title_reason: z.string(),
  short_description: z.string().describe("1 o 2 frases, máximo 160 caracteres"),
  categories: z.array(
    z.object({
      name: z.string().describe("Nombre exacto de una categoría de la lista"),
      role: z.enum(["primary", "secondary"]),
      confidence: z.number().describe("Entre 0 y 1"),
      reason: z.string(),
    }),
  ),
  suggested_new_category: z.string().nullable().describe("Solo si ninguna categoría encaja bien; si no, null"),
  franchise_reference: z.string().nullable().describe("Personaje o franquicia que referencia el diseño, si hay; si no, null"),
});

const SYSTEM = `Eres el Curador de xDope, una tienda de hoodies bordados. Recibes la foto de un bordado y preparas el lanzamiento del producto.
Contexto: los bordados son piezas que Diego, el dueño de la tienda, ya produjo. Muchos son de personajes de anime, videojuegos o películas. Decidir qué se vende es responsabilidad de Diego, no tuya: nunca descartes ni frenes un diseño por propiedad intelectual o derechos de autor. Si el diseño referencia un personaje o franquicia, anótalo en franchise_reference y continúa con tu trabajo normalmente.
Reglas:
- El producto es siempre un hoodie con el diseño BORDADO (no estampado).
- Título: máximo 60 caracteres, con gancho, que nombre el diseño y deje claro que es un hoodie bordado. Propón exactamente 3 y elige uno.
- Descripción corta: 1 o 2 frases creativas, máximo 160 caracteres, tono streetwear cercano, en español.
- No inventes materiales, medidas, licencias ni datos que no se vean en la imagen.
- Categorías: elige SOLO nombres de la lista dada. Exactamente 1 "primary" (la temática principal) y como máximo 2 "secondary" si aplican de verdad. Confianza entre 0 y 1.
- Si ninguna categoría encaja con confianza de al menos ${MIN_CATEGORY_CONFIDENCE}, usa la categoría de respaldo indicada como primary y propone suggested_new_category.`;

export async function runCurator(opts: {
  claude: Claude;
  runId: string;
  designId: string;
  design: ImageInput;
  categories: StoreCategory[];
  selectionReason: string;
  fallbackCategory?: string;
}): Promise<CuratorPick & { subject: string }> {
  const list = opts.categories.map((c) => `- ${c.name}`).join("\n");
  let feedback = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const out = await opts.claude.ask({
      system: SYSTEM,
      images: [{ ...opts.design, label: "Foto del bordado:" }],
      prompt: `Categorías existentes en la tienda:\n${list}\n\nPrepara título, descripción corta y categorías.${feedback}`,
      schema: CuratorOutput,
    });
    const byName = new Map(opts.categories.map((c) => [c.name.toLowerCase(), c]));
    const categories = out.categories.flatMap((c) => {
      const match = byName.get(c.name.toLowerCase());
      return match ? [{ category_id: match.category_id, name: match.name, role: c.role, confidence: c.confidence, reason: c.reason }] : [];
    });
    const parsed = CuratorPick.safeParse({
      run_id: opts.runId,
      design_id: opts.designId,
      selection_reason: opts.selectionReason,
      title_options: out.title_options,
      title: out.title,
      title_reason: out.title_reason,
      short_description: out.short_description,
      categories,
      suggested_new_category: out.suggested_new_category,
      franchise_reference: out.franchise_reference,
    });
    if (parsed.success) return { ...parsed.data, subject: out.subject };
    feedback = `\n\nTu respuesta anterior no cumplió estas reglas; corrígelas:\n${parsed.error.issues.map((i) => `- ${i.message}`).join("\n")}`;
  }
  throw new Error("El Curador no produjo una respuesta válida en 2 intentos");
}
