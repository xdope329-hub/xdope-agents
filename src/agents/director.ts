import { z } from "zod";
import { MIN_COLORS, MIN_SHOTS_PER_COLOR, ShotList } from "../contracts/index.js";
import { MIN_GARMENT_CONTRAST, contrastWithPalette } from "../color.js";
import type { Claude, ImageInput } from "../llm/claude.js";

export interface GarmentColor {
  name: string;
  hex: string;
}

const DirectorOutput = z.object({
  analysis: z.object({
    subject: z.string(),
    style: z.string(),
    thread_palette: z.array(z.string()).describe("Colores de hilo en hex #RRGGBB, máximo 12"),
    has_text: z.boolean(),
    best_placement: z.enum(["chest_left", "chest_center", "back", "sleeve_left", "sleeve_right"]),
    embroidery_description: z.string().describe("Descripción precisa del bordado para usar dentro de los prompts"),
  }),
  model_description: z.string().describe("Descripción física y de estilo de UNA persona modelo, realista y coherente con el diseño"),
  colors: z.array(z.string()).describe("Nombres exactos de colores de la lista"),
  shots: z.array(
    z.object({
      color: z.string(),
      framing: z.enum(["front_mid", "three_quarter", "side", "back", "detail", "lifestyle"]),
      pose: z.string(),
      background: z.string(),
      lighting: z.string(),
      prompt: z.string(),
      negative_prompt: z.string(),
    }),
  ),
});

const SYSTEM = `Eres el Director de arte de xDope. Diseñas las fotos de catálogo de un hoodie bordado que se generarán con un modelo de imágenes.
Reglas del producto:
- Formato vertical 4:5. Mínimo ${MIN_COLORS} colores de hoodie y exactamente ${MIN_SHOTS_PER_COLOR} fotos por color: una "front_mid" (frontal plano medio), una "three_quarter" o "side", y una "detail" (primer plano del bordado sobre la tela).
- Siempre la MISMA persona modelo en todas las fotos, descrita en model_description. Nada de flat lay ni maniquí.
- Elige colores de hoodie de la lista que contrasten claramente con los hilos del bordado para que se lea bien.
- El bordado va en la ubicación best_placement y debe verse en cada encuadre (si va en la espalda, las tomas lo muestran de espaldas).
Cómo escribir cada prompt (en inglés, que el modelo de imágenes sigue mejor):
- Empieza por: "Real catalog photograph, shot on a full-frame camera with an 85mm lens".
- Describe a la persona modelo con los mismos rasgos en todas las tomas, la pose, el hoodie (color exacto, algodón afelpado grueso, pliegues reales) y la ubicación y tamaño del bordado.
- Pide que el bordado sea "raised thread embroidery that reproduces the reference image exactly: same shapes, same thread colors, no additions".
- Realismo: textura de piel natural con poros e imperfecciones leves, mechones de pelo sueltos, manos naturales, luz y sombras coherentes, fondo real.
- negative_prompt: extra text or letters, printed or flat graphic, added logos, plastic or airbrushed skin, 3D render or illustration look, perfect symmetry, deformed hands, extra fingers, glassy eyes, fake bokeh.
- No inventes elementos del diseño que no estén en la imagen.`;

export async function runDirector(opts: {
  claude: Claude;
  runId: string;
  design: ImageInput;
  title: string;
  palette: GarmentColor[];
}): Promise<{ shotList: ShotList; embroideryDescription: string }> {
  const list = opts.palette.map((c) => `- ${c.name} (${c.hex})`).join("\n");
  let feedback = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const out = await opts.claude.ask({
      system: SYSTEM,
      images: [{ ...opts.design, label: "Foto del bordado (referencia exacta):" }],
      prompt: `Producto: ${opts.title}\nColores de hoodie disponibles:\n${list}\n\nDiseña el concepto, los colores y las tomas.${feedback}`,
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
    const colorName = (n: string) => byName.get(n.toLowerCase())?.name ?? n;
    const counters = new Map<string, number>();
    const shots = out.shots.map((s) => {
      const color = colorName(s.color);
      const i = (counters.get(color) ?? 0) + 1;
      counters.set(color, i);
      return {
        shot_id: `${slug(color)}-${i}-${s.framing}`,
        color,
        placement: out.analysis.best_placement,
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
        best_placement: out.analysis.best_placement,
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
