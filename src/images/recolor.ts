// Recoloreado sin IA (experimento, specs/04): se genera cada pose una sola vez en un color claro y los demás
// colores se tiñen por código. Gemini entrega una máscara de la tela; el bordado, la piel y el fondo no se tocan.
import sharp from "sharp";
import { hexToRgb, rgbToLab } from "../color.js";
import type { GeminiImages } from "./gemini.js";

// Distancia máxima de croma (a, b) al color base para que un píxel cuente como tela: protege los hilos del bordado.
const MAX_CHROMA_DISTANCE = 18;

// La máscara sale de la segmentación de Gemini (modelo de texto que devuelve recuadro + máscara por objeto), no de
// pedirle a un modelo de imagen que "dibuje" una máscara: eso devolvía imágenes que no calzaban con la foto y se teñía todo.
export const SEGMENT_MODEL = "gemini-2.5-flash";
const SEGMENT_COST_USD = 0.01; // estimado: ~1.3k tokens de entrada + la máscara en la salida
const SEGMENT_PROMPT =
  "Give the segmentation masks for the hoodie the person is wearing (body, sleeves, hood, cuffs, drawstrings) and, separately, for the embroidery on it. " +
  'Output a JSON list where each entry has the 2D bounding box in "box_2d" ([y0, x0, y1, x1], normalized to 0-1000), ' +
  'the segmentation mask in "mask" (base64 PNG) and the label in "label": "hoodie" or "embroidery". ' +
  "Do not include skin, hair, pants, other clothes or the background.";
// Fuera de este rango la máscara no es creíble (vacía, o tomó la foto entera) y se rechaza en vez de teñir de más.
const MIN_COVERAGE = 0.03;
const MAX_COVERAGE = 0.75;

interface Segment {
  box_2d: [number, number, number, number];
  mask: string;
  label: string;
}

export async function garmentMask(gemini: GeminiImages, photo: Buffer): Promise<{ data: Buffer; cost_usd: number }> {
  const text = await gemini.describeImage({ model: SEGMENT_MODEL, prompt: SEGMENT_PROMPT, image: photo, mimeType: "image/jpeg" });
  const { width, height } = await sharp(photo).metadata();
  if (!width || !height) throw new Error("No se pudo leer el tamaño de la foto");
  return { data: await maskFromSegments(parseSegments(text), width, height), cost_usd: SEGMENT_COST_USD };
}

export function parseSegments(text: string): Segment[] {
  const json = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
  const list: unknown[] = Array.isArray(json) ? json : (json.masks ?? json.segments ?? []);
  return list.filter(
    (e): e is Segment =>
      !!e && typeof e === "object" && Array.isArray((e as Segment).box_2d) && (e as Segment).box_2d.length === 4 && typeof (e as Segment).mask === "string",
  );
}

// Arma la máscara del tamaño de la foto: blanco = tela del hoodie, menos el bordado.
export async function maskFromSegments(segments: Segment[], width: number, height: number): Promise<Buffer> {
  const out = Buffer.alloc(width * height);
  const isEmbroidery = (label: string) => /embroider|bordad|logo|print|design|patch/i.test(label ?? "");
  const hoodie = segments.filter((s) => !isEmbroidery(s.label));
  if (!hoodie.length) throw new Error("Gemini no encontró el hoodie en la foto");
  for (const [value, list] of [[255, hoodie], [0, segments.filter((s) => isEmbroidery(s.label))]] as const) {
    for (const seg of list) {
      const [y0, x0, y1, x1] = seg.box_2d.map((v) => Math.min(1000, Math.max(0, v)) / 1000);
      const left = Math.round(x0 * width);
      const top = Math.round(y0 * height);
      const w = Math.round(x1 * width) - left;
      const h = Math.round(y1 * height) - top;
      if (w < 1 || h < 1) continue;
      const png = Buffer.from(seg.mask.replace(/^data:image\/\w+;base64,/, ""), "base64");
      const local = await sharp(png).greyscale().resize(w, h, { fit: "fill" }).raw().toBuffer();
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) if (local[y * w + x] > 127 && top + y < height && left + x < width) out[(top + y) * width + left + x] = value;
    }
  }
  return sharp(out, { raw: { width, height, channels: 1 } }).png().toBuffer();
}

// Tiñe la tela de `photo` (hoodie de color `baseHex`) a `targetHex` conservando pliegues y sombras.
export async function recolorGarment(photo: Buffer, mask: Buffer, baseHex: string, targetHex: string): Promise<Buffer> {
  const { data, info } = await sharp(photo).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  // Máscara al tamaño de la foto, con borde suavizado para que el corte no se note.
  // Se binariza antes de suavizar: una máscara gris o "pintada" no puede teñir media foto a medias.
  const hard = await sharp(mask).resize(width, height, { fit: "fill" }).greyscale().threshold(128).raw().toBuffer();
  const coverage = hard.reduce((sum, v) => sum + (v ? 1 : 0), 0) / hard.length;
  if (coverage < MIN_COVERAGE || coverage > MAX_COVERAGE)
    throw new Error(`Máscara no confiable: marca ${(coverage * 100).toFixed(0)}% de la foto como hoodie`);
  const alpha = await sharp(hard, { raw: { width, height, channels: 1 } }).blur(1.5).raw().toBuffer();

  const [, baseA, baseB] = rgbToLab(hexToRgb(baseHex));
  const [targetL, targetA, targetB] = rgbToLab(hexToRgb(targetHex));
  const n = width * height;
  const lab = new Float32Array(n * 3);
  const weight = new Float32Array(n);
  let sumL = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    const [L, a, b] = rgbToLab([data[i * 3], data[i * 3 + 1], data[i * 3 + 2]]);
    lab.set([L, a, b], i * 3);
    const inFabric = Math.hypot(a - baseA, b - baseB) <= MAX_CHROMA_DISTANCE;
    weight[i] = inFabric ? alpha[i] / 255 : 0;
    if (weight[i] > 0.5) {
      sumL += L;
      count++;
    }
  }
  if (count === 0) throw new Error("La máscara no marcó tela del hoodie");
  const meanL = sumL / count;
  // Las sombras se escalan con la luminosidad del color destino para que un hoodie oscuro no quede plano ni gris.
  const shade = Math.min(1, Math.max(0.35, targetL / meanL));

  const out = Buffer.from(data);
  for (let i = 0; i < n; i++) {
    const w = weight[i];
    if (w === 0) continue;
    const L = Math.min(100, Math.max(0, targetL + (lab[i * 3] - meanL) * shade));
    const rgb = labToRgb([L, targetA, targetB]);
    for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.round(data[i * 3 + c] * (1 - w) + rgb[c] * w);
  }
  return sharp(out, { raw: { width, height, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
}

export function labToRgb([L, a, b]: [number, number, number]): [number, number, number] {
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const inv = (t: number) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
  const [x, y, z] = [inv(fx) * 0.95047, inv(fy), inv(fz) * 1.08883];
  const lin = [
    x * 3.2406 + y * -1.5372 + z * -0.4986,
    x * -0.9689 + y * 1.8758 + z * 0.0415,
    x * 0.0557 + y * -0.204 + z * 1.057,
  ];
  return lin.map((v) => {
    const s = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.max(0, v) ** (1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, s)) * 255);
  }) as [number, number, number];
}

// Color base para recolorear: el más claro de la lista (de un hoodie claro se sacan mejor las sombras).
export function lightestColor<T extends { hex: string }>(colors: T[]): T {
  return [...colors].sort((x, y) => rgbToLab(hexToRgb(y.hex))[0] - rgbToLab(hexToRgb(x.hex))[0])[0];
}
