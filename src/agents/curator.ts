import { z } from "zod";
import { CuratorPick, MIN_CATEGORY_CONFIDENCE } from "../contracts/index.js";
import type { Claude, ImageInput } from "../llm/claude.js";

export interface StoreCategory {
  category_id: string;
  name: string;
}

// Nombres cortos y creativos (decisión de Diego, 2026-09-30); el contrato admite hasta 60 por lotes anteriores.
export const MAX_TITLE_CHARS = 30;

const CuratorOutput = z.object({
  subject: z.string().describe("Qué muestra el bordado, en una frase"),
  title_options: z.array(z.string()).describe(`Exactamente 3 nombres creativos de máximo ${MAX_TITLE_CHARS} caracteres`),
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
- Título (nombre del producto): corto, creativo y divertido, máximo ${MAX_TITLE_CHARS} caracteres (idealmente 2 a 4 palabras). Que suene a nombre de drop streetwear, con humor, juego de palabras o jerga colombiana cuando encaje, y que se relacione con lo que muestra el diseño.
  - NO uses "Hoodie", "Bordado", "Diseño" ni colores en el título: eso ya lo dice la tienda.
  - Nada genérico ni descriptivo tipo "Retrato Urbano con Letras Rosa y Negro".
  - Ejemplos del tono: "Gafas y Flow", "El Parcero de la Bandana", "Calcifer Anda Prendido", "Miau de Barrio", "Sin Miedo al Lunes".
  - Propón exactamente 3 opciones distintas y elige la más pegajosa.
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
  for (let attempt = 1; attempt <= 3; attempt++) {
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
    const long = out.title_options.filter((t) => t.length > MAX_TITLE_CHARS);
    if (parsed.success && long.length === 0) return { ...parsed.data, subject: out.subject };
    const issues = [...(parsed.success ? [] : parsed.error.issues.map((i) => i.message)), ...long.map((t) => `"${t}" tiene ${t.length} caracteres; máximo ${MAX_TITLE_CHARS}`)];
    feedback = `\n\nTu respuesta anterior no cumplió estas reglas; corrígelas:\n${issues.map((i) => `- ${i}`).join("\n")}`;
  }
  throw new Error("El Curador no produjo una respuesta válida en 3 intentos");
}
