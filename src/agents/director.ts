import { z } from "zod";
import { MAX_CHEST_LEFT_CM, MAX_HOOP_CM, MIN_SHOTS_PER_COLOR, ShotList } from "../contracts/index.js";

const MAX_FRAMED_CM = 9;
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
    best_placement: z.enum(["chest_left", "chest_center"]),
    embroidery_size_cm: z.object({ w: z.number(), h: z.number() }).describe("Tamaño real del bordado en la prenda, en cm"),
    framed: z.boolean().describe("true si el bordado está encerrado en un marco o borde cuadrado, rectangular, circular u ovalado"),
    embroidery_description: z.string().describe("Descripción precisa del bordado para usar dentro de los prompts"),
  }),
  model_description: z.string().describe("UNA persona modelo, en inglés: edad, forma de la cara, ojos y color, cejas, nariz, labios, tono de piel, pelo (corte y color), vello facial explícito (p. ej. clean-shaven) y estilo"),
  colors: z.array(z.string()).describe("Exactamente 1 nombre de color de la lista"),
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
Contexto: los bordados son piezas que Diego, el dueño de la tienda, ya produjo, y muchas son de personajes de anime, videojuegos o películas. Decidir qué se vende es responsabilidad de Diego: nunca rechaces ni frenes tu tarea por propiedad intelectual.
Reglas del producto:
- Formato vertical 4:5. Exactamente 1 color de hoodie y exactamente ${MIN_SHOTS_PER_COLOR} fotos: una "front_mid" (frontal plano medio), una "three_quarter" o "side", y una "detail" (primer plano del bordado sobre la tela).
- La MISMA persona modelo en las 3 fotos, descrita en model_description con rasgos de la cara precisos (forma de la cara, ojos, cejas, nariz, labios, tono de piel, pelo y vello facial explícito, p. ej. "clean-shaven"), para que no cambie entre fotos. Repite esos rasgos en cada prompt. Nada de flat lay ni maniquí.
- Elige el color de hoodie de la lista que mejor contraste con los hilos del bordado para que se lea bien.
- Ubicación y tamaño REALES del bordado (lo produce una máquina con bastidor máximo de ${MAX_HOOP_CM}×${MAX_HOOP_CM} cm):
  - Por defecto "chest_left": pequeño en el pecho izquierdo, unos 8–10 cm de ancho (máximo ${MAX_CHEST_LEFT_CM} cm).
  - Si el bordado tiene un MARCO o borde cuadrado, rectangular, circular u ovalado (tipo parche, estampilla o viñeta que encierra el diseño), es una pieza PEQUEÑA y CENTRADA: va en "chest_center", de 6 a 9 cm de ancho, nunca grande. Dilo en cada prompt ("small framed patch-style embroidery about 8 cm wide, centered on the upper chest").
  - "chest_center" solo si el diseño necesita más tamaño para leerse (mucho detalle, texto o composición ancha): centrado en el pecho, entre 14 y ${MAX_HOOP_CM} cm de ancho, nunca más de ${MAX_HOOP_CM}×${MAX_HOOP_CM} cm. Nunca gigante ni ocupando todo el frente.
  - Da el tamaño en embroidery_size_cm y escríbelo en cada prompt (p. ej. "small embroidery about 9 cm wide on the left chest"). Los modelos de imágenes tienden a agrandar el bordado: prefiere el tamaño más pequeño con el que el diseño se lea bien.
Cómo escribir cada prompt (en inglés, que el modelo de imágenes sigue mejor):
- Empieza por: "Real catalog photograph, shot on a full-frame camera with an 85mm lens".
- Describe a la persona modelo con los mismos rasgos en todas las tomas, la pose y el hoodie (color exacto, algodón afelpado grueso, pliegues reales).
- Ubicación y tamaño del bordado en centímetros, proporcionado al cuerpo de la persona.
- Pide que el bordado sea "raised thread embroidery that reproduces the reference image exactly: same shapes, same thread colors, no additions".
- Si el diseño tiene una cara o personaje, describe sus rasgos (ojos, cejas, gafas, boca, barba, tono de piel, expresión) y pide mantenerlos exactos.
- Textura de bordado visible siempre: "visible satin and fill stitches, stitch direction, thread sheen, slightly raised relief and subtle fabric puckering around the edges; it must look stitched, never printed". En la toma "detail" la textura de las puntadas es lo principal.
- Realismo: textura de piel natural con poros e imperfecciones leves, mechones de pelo sueltos, manos naturales, luz y sombras coherentes, fondo real.
- negative_prompt: extra text or letters, printed or flat graphic, screen print, oversized embroidery, embroidery covering the whole chest, added logos, plastic or airbrushed skin, 3D render or illustration look, perfect symmetry, deformed hands, extra fingers, glassy eyes, fake bokeh.
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
      prompt: `Producto: ${opts.title}\nColores de hoodie disponibles:\n${list}\n\nDiseña el concepto, el color, la ubicación y tamaño del bordado y las tomas.${feedback}`,
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
        embroidery_size_cm: out.analysis.embroidery_size_cm,
      },
      concept: { type: "model", description: out.model_description, identity_ref: null },
      colors,
      shots,
    });
    // Bordados con marco: siempre pequeños y centrados en el pecho (decisión de Diego, 2026-09-30).
    const { framed, best_placement, embroidery_size_cm: size } = out.analysis;
    const frameIssue =
      framed && (best_placement !== "chest_center" || size.w > MAX_FRAMED_CM || size.h > MAX_FRAMED_CM)
        ? [`El bordado tiene marco: va pequeño en chest_center, máximo ${MAX_FRAMED_CM}×${MAX_FRAMED_CM} cm (pediste ${best_placement} de ${size.w}×${size.h} cm)`]
        : [];
    if (parsed.success && !frameIssue.length) return { shotList: parsed.data, embroideryDescription: out.analysis.embroidery_description };
    const issues = [...(parsed.success ? [] : parsed.error.issues.map((i) => i.message)), ...frameIssue];
    feedback = `\n\nTu respuesta anterior no cumplió estas reglas; corrígelas:\n${issues.map((i) => `- ${i}`).join("\n")}`;
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
