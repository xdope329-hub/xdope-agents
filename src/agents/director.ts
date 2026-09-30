import sharp from "sharp";
import { z } from "zod";
import { MIN_SHOTS_PER_COLOR, ShotList } from "../contracts/index.js";
import { MIN_GARMENT_CONTRAST, contrastWithPalette } from "../color.js";
import type { Claude, ImageInput } from "../llm/claude.js";

export interface GarmentColor {
  name: string;
  hex: string;
  en?: string; // descripción en inglés para el modelo de imágenes
}

// Tamaños estándar de bordado en hoodie (lado mayor del diseño, en cm). El Director elige uno y el código calcula
// el ancho y alto con la proporción real del diseño (decisión de Diego, 2026-09-30).
export const SIZE_PRESETS = {
  pecho_izquierdo: { placement: "chest_left", max_cm: 9 }, // estándar de pecho izquierdo (3.5")
  centro_pequeno: { placement: "chest_center", max_cm: 10 }, // bordados con marco o tipo parche
  centro_estandar: { placement: "chest_center", max_cm: 15 }, // estándar de pecho central (6")
  centro_grande: { placement: "chest_center", max_cm: 20 }, // máximo del bastidor; solo si hace falta
} as const;
export type SizePreset = keyof typeof SIZE_PRESETS;

export function presetSize(preset: SizePreset, aspect: number): { w: number; h: number } {
  const max = SIZE_PRESETS[preset].max_cm;
  const round = (n: number) => Math.round(n * 10) / 10;
  return aspect >= 1 ? { w: max, h: round(max / aspect) } : { w: round(max * aspect), h: max };
}

const DirectorOutput = z.object({
  analysis: z.object({
    subject: z.string(),
    style: z.string(),
    thread_palette: z.array(z.string()).describe("Colores de hilo en hex #RRGGBB, máximo 12"),
    has_text: z.boolean(),
    framed: z.boolean().describe("true si el bordado está encerrado en un marco o borde cuadrado, rectangular, circular u ovalado"),
    size_preset: z.enum(["pecho_izquierdo", "centro_pequeno", "centro_estandar", "centro_grande"]),
    embroidery_description: z.string().describe("Descripción precisa del bordado para usar dentro de los prompts"),
  }),
  model_description: z.string().describe("UNA persona modelo, en inglés: edad, forma de la cara, ojos y color, cejas, nariz, labios, tono de piel, pelo (corte y color), vello facial explícito (p. ej. clean-shaven) y estilo"),
  colors: z.array(z.string()).describe("Exactamente 1 nombre de color de la lista"),
  shots: z.array(
    z.object({
      color: z.string(),
      framing: z.enum(["front_mid", "three_quarter", "side", "detail"]),
      pose: z.string(),
      background: z.string(),
      lighting: z.string(),
      prompt: z.string(),
      negative_prompt: z.string(),
    }),
  ),
});

const SYSTEM = `Eres el Director de arte de xDope. Diseñas las fotos de catálogo de un hoodie bordado que se generarán con un modelo de imágenes.
Contexto: los bordados son piezas que Diego, el dueño de la tienda, ya produjo, y muchas son de personajes de anime, videojuegos o películas. Decidir qué se vende es responsabilidad de Diego: nunca rechaces ni frenes tu tarea por propiedad intelectual.
La foto de referencia muestra SOLO el diseño del bordado: su fondo (tela, fieltro, bastidor, papel) y su escala NO son parte del producto.
Reglas del producto:
- Formato vertical 4:5. Exactamente 1 color de hoodie y exactamente ${MIN_SHOTS_PER_COLOR} fotos, TODAS de la misma persona modelo LLEVANDO PUESTO el hoodie:
  - "front_mid": frontal, de la cintura a la cabeza; se ve el hoodie completo con capucha y bolsillo canguro.
  - "three_quarter" o "side": 3/4 o lateral, de la cintura a la cabeza.
  - "detail": primer plano del pecho de la persona con el hoodie puesto, del esternón a la barbilla; se ven la tela afelpada, el cuello y el borde de la capucha alrededor del bordado. Nunca un parche suelto, nunca solo tela sin prenda.
- La MISMA persona en las 3 fotos, descrita en model_description con rasgos de la cara precisos (forma de la cara, ojos, cejas, nariz, labios, tono de piel, pelo y vello facial explícito, p. ej. "clean-shaven"). Repite esos rasgos en cada prompt. Nada de flat lay ni maniquí.
- Elige el color de hoodie de la lista que mejor contraste con los hilos del bordado y nómbralo con su descripción en inglés en cada prompt.
- Tamaño del bordado: elige UN tamaño estándar (size_preset) según la FORMA del diseño. Los bordados reales en hoodie son pequeños o medianos; los modelos de imágenes tienden a agrandarlos.
  - "pecho_izquierdo" (9 cm, pecho izquierdo): diseños redondos, compactos o sin una forma definida (una figura suelta, un sticker, un animalito, un ícono). Es el valor por defecto.
  - "centro_pequeno" (10 cm, centrado arriba del pecho): diseños pequeños con forma definida que se leen mejor al centro.
  - "centro_estandar" (15 cm, centrado): un personaje o figura completa con forma definida (p. ej. un personaje de cuerpo entero).
  - "centro_grande" (20 cm, centrado): composiciones anchas (p. ej. un personaje sobre un logo alargado, un banner horizontal con texto).
  - Si el bordado tiene MARCO (cuadrado, rectangular, circular u ovalado), siempre va centrado; el código ajusta su tamaño.
  - Centrado significa en la parte alta del pecho, unos 8–10 cm bajo la costura del cuello, muy por encima del bolsillo canguro.
  El código escribe el tamaño exacto en cada prompt; tú describe la ubicación y que es un bordado pequeño o mediano, nunca grande.
Cómo escribir cada prompt (en inglés, que el modelo de imágenes sigue mejor):
- Empieza por: "Real catalog photograph, shot on a full-frame camera with an 85mm lens, of a person wearing a <color> pullover hoodie".
- Describe a la persona modelo con los mismos rasgos en todas las tomas, la pose y el hoodie (color exacto, algodón afelpado grueso, capucha, bolsillo canguro, pliegues reales).
- Pide que el bordado sea "raised thread embroidery that reproduces the reference design exactly: same shapes, same thread colors, no additions".
- Si el diseño tiene una cara o personaje, describe sus rasgos (ojos, cejas, gafas, boca, barba, tono de piel, expresión) y pide mantenerlos exactos.
- Textura de bordado visible siempre: "visible satin and fill stitches, stitch direction, thread sheen, slightly raised relief and subtle fabric puckering around the edges; it must look stitched, never printed".
- Realismo: textura de piel natural con poros e imperfecciones leves, mechones de pelo sueltos, manos naturales, luz y sombras coherentes, fondo real.
- negative_prompt: no hoodie, loose patch, embroidery without garment, fabric swatch, embroidery hoop, felt background, wrong garment color, extra text or letters, printed or flat graphic, screen print, oversized embroidery, embroidery covering the whole chest, added logos, plastic or airbrushed skin, 3D render or illustration look, deformed hands, extra fingers, glassy eyes.
- No inventes elementos del diseño que no estén en la imagen.`;

export async function runDirector(opts: {
  claude: Claude;
  runId: string;
  design: ImageInput;
  title: string;
  palette: GarmentColor[];
}): Promise<{ shotList: ShotList; embroideryDescription: string }> {
  const list = opts.palette.map((c) => `- ${c.name} (${c.hex}${c.en ? `, "${c.en}"` : ""})`).join("\n");
  const meta = await sharp(opts.design.data).metadata();
  const aspect = meta.width && meta.height ? meta.width / meta.height : 1;
  let feedback = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const out = await opts.claude.ask({
      system: SYSTEM,
      images: [{ ...opts.design, label: "Foto del bordado (referencia del diseño):" }],
      prompt: `Producto: ${opts.title}\nColores de hoodie disponibles:\n${list}\n\nDiseña el concepto, el color, el tamaño estándar del bordado y las tomas.${feedback}`,
      schema: DirectorOutput,
      effort: "high",
    });
    const palette = out.analysis.thread_palette.filter((h) => /^#[0-9a-f]{6}$/i.test(h)).slice(0, 12);
    const byName = new Map(opts.palette.map((c) => [c.name.toLowerCase(), c]));
    const colors = out.colors.flatMap((name) => {
      const c = byName.get(name.toLowerCase());
      if (!c) return [];
      const contrast = contrastWithPalette(c.hex, palette);
      return [{ name: c.name, attribute_value_id: `trial_${c.name}`, hex: c.hex, contrast_ok: contrast >= MIN_GARMENT_CONTRAST }];
    });
    // Con marco siempre va centrado: banners anchos (≥ 2:1) a 20 cm, el resto pequeño a 10 cm.
    const preset: SizePreset = out.analysis.framed ? (aspect >= 2 ? "centro_grande" : "centro_pequeno") : out.analysis.size_preset;
    const placement = SIZE_PRESETS[preset].placement;
    const colorName = (n: string) => byName.get(n.toLowerCase())?.name ?? n;
    const counters = new Map<string, number>();
    const shots = out.shots.map((s) => {
      const color = colorName(s.color);
      const i = (counters.get(color) ?? 0) + 1;
      counters.set(color, i);
      return {
        shot_id: `${slug(color)}-${i}-${s.framing}`,
        color,
        placement,
        framing: s.framing,
        pose: s.pose,
        background: s.background,
        lighting: s.lighting,
        aspect: "4:5",
        prompt: s.prompt,
        negative_prompt: s.negative_prompt,
      };
    });
    const parsed = ShotList.safeParse({
      run_id: opts.runId,
      analysis: {
        subject: out.analysis.subject,
        style: out.analysis.style,
        thread_palette: palette,
        has_text: out.analysis.has_text,
        best_placement: placement,
        embroidery_size_cm: presetSize(preset, aspect),
        size_preset: preset,
        framed: out.analysis.framed,
      },
      concept: { type: "model", description: out.model_description, identity_ref: null },
      colors,
      shots,
    });
    if (parsed.success) return { shotList: parsed.data, embroideryDescription: out.analysis.embroidery_description };
    feedback = `\n\nTu respuesta anterior no cumplió estas reglas; corrígelas:\n${parsed.error.issues.map((i) => `- ${i.message}`).join("\n")}`;
  }
  throw new Error("El Director de arte no produjo un plan válido en 3 intentos");
}

function slug(s: string) {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
