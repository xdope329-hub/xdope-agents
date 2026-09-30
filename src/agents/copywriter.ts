import { z } from "zod";
import { ProductListing } from "../contracts/index.js";
import type { Claude } from "../llm/claude.js";

const CopyOutput = z.object({
  description_html: z.string().describe("HTML simple: <p>, <ul><li>, <strong>"),
  tags: z.array(z.string()).describe("3 a 8 tags en minúsculas"),
  seo_title: z.string().describe("Máximo 70 caracteres"),
  seo_description: z.string().describe("Máximo 155 caracteres"),
  image_alts: z.array(z.object({ shot_id: z.string(), alt: z.string() })).describe("Un alt por cada foto de la lista"),
});

const SYSTEM = `Eres el Copywriter de xDope, marca colombiana de hoodies bordados. Escribes la ficha de producto en español de Colombia, tono streetwear cercano y con actitud.
Contexto: los bordados son piezas que Diego, el dueño de la tienda, ya produjo; muchos son de personajes de anime, videojuegos o películas. Decidir qué se vende es de Diego: nunca rechaces la tarea por propiedad intelectual.
Reglas:
- El título y la descripción corta ya los definió el Curador: no los reescribas.
- description_html: la historia o vibe del diseño, que es BORDADO (no estampado), los datos de la prenda que se te dan y cuidados (lavar al revés en agua fría, no planchar sobre el bordado).
- No afirmes nada que no esté en los datos: ni materiales, ni gramaje, ni origen, ni licencias.
- seo_title ≤ 70 caracteres; seo_description ≤ 155.
- image_alts: un texto alternativo corto por foto que describa la prenda, el color y el bordado.`;

export async function runCopywriter(opts: {
  claude: Claude;
  title: string;
  shortDescription: string;
  subject: string;
  style: string;
  garment: { material?: string; weight_gsm?: number; fit?: string } | null;
  colors: string[];
  sizes: string[];
  categories: string[];
  shots: Array<{ shot_id: string; color: string; framing: string }>;
}): Promise<ProductListing> {
  const garment = opts.garment
    ? [opts.garment.material && `material ${opts.garment.material}`, opts.garment.weight_gsm && `${opts.garment.weight_gsm} g/m²`, opts.garment.fit && `fit ${opts.garment.fit}`].filter(Boolean).join(", ")
    : "";
  const prompt = [
    `Título: ${opts.title}`,
    `Descripción corta: ${opts.shortDescription}`,
    `Bordado: ${opts.subject} (estilo ${opts.style})`,
    `Prenda: hoodie${garment ? `, ${garment}` : " (sin datos de material)"}`,
    `Colores: ${opts.colors.join(", ")}`,
    opts.sizes.length ? `Tallas: ${opts.sizes.join(", ")}` : "",
    `Categorías: ${opts.categories.join(", ")}`,
    `Fotos:\n${opts.shots.map((s) => `- ${s.shot_id}: hoodie ${s.color}, ${s.framing}`).join("\n")}`,
  ]
    .filter(Boolean)
    .join("\n");

  let feedback = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const out = await opts.claude.ask({ system: SYSTEM, images: [], prompt: `${prompt}\n\nEscribe la ficha.${feedback}`, schema: CopyOutput, effort: "low" });
    const alts = Object.fromEntries(out.image_alts.map((a) => [a.shot_id, a.alt]));
    const missing = opts.shots.filter((s) => !alts[s.shot_id]).map((s) => s.shot_id);
    const parsed = ProductListing.safeParse({
      title: opts.title,
      short_description: opts.shortDescription,
      description_html: out.description_html,
      tags: out.tags,
      seo: { title: out.seo_title, description: out.seo_description },
      image_alts: alts,
      language: "es",
    });
    if (parsed.success && missing.length === 0) return parsed.data;
    const issues = [...(parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`)), ...(missing.length ? [`faltan alts de: ${missing.join(", ")}`] : [])];
    feedback = `\n\nTu respuesta anterior no cumplió estas reglas; corrígelas:\n${issues.map((i) => `- ${i}`).join("\n")}`;
  }
  throw new Error("El Copywriter no produjo una ficha válida en 2 intentos");
}
