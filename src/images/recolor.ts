// Recoloreado sin IA (experimento, specs/04): se genera cada pose una sola vez en un color claro y los demás
// colores se tiñen por código. Gemini entrega una máscara de la tela; el bordado, la piel y el fondo no se tocan.
import sharp from "sharp";
import { hexToRgb, rgbToLab } from "../color.js";
import type { GeminiImages } from "./gemini.js";

// Distancia máxima de croma (a, b) al color base para que un píxel cuente como tela: protege los hilos del bordado.
const MAX_CHROMA_DISTANCE = 18;
// Distancia de croma al color medido de la tela, y píxeles que se recortan en el borde de la máscara.
const FABRIC_CHROMA_DISTANCE = 10;
const EDGE_PX = 2;

// La máscara se arma por color, no la "dibuja" un modelo: Gemini solo da los recuadros del hoodie y del bordado
// (respuesta corta y barata) y el código marca, dentro del recuadro del hoodie, los píxeles del color real de la tela
// que forman la zona continua del hoodie. Pedir la máscara completa a un modelo devolvía imágenes que no calzaban
// o JSON truncado, y se teñían la piel y el fondo.
export const SEGMENT_MODEL = process.env.SEGMENT_MODEL || "gemini-3.8-flash";
const SEGMENT_COST_USD = 0.002; // estimado: una foto de entrada y una respuesta de pocas líneas
const SEGMENT_PROMPT =
  "Find the hoodie the person is wearing and the embroidery on it. " +
  'Output a JSON list with one entry per object: {"label": "hoodie" | "embroidery", "box_2d": [y0, x0, y1, x1]} normalized to 0-1000. ' +
  "The hoodie box covers the whole garment (body, sleeves, hood). Only boxes, no masks.";
// Fuera de este rango la máscara no es creíble (vacía, o tomó la foto entera) y se rechaza en vez de teñir de más.
const MIN_COVERAGE = 0.03;
const MAX_COVERAGE = 0.75;
// Tolerancia de color de la tela: croma (a, b) respecto al color real del hoodie en la foto; la luz se tolera más.
const FABRIC_CHROMA = 9;
const FABRIC_LIGHTNESS = 40;
const EMB_FABRIC_CHROMA = 5;
const EMB_FABRIC_LIGHTNESS = 25;

interface Segment {
  box_2d: [number, number, number, number];
  mask?: string;
  label: string;
}
type Box = [number, number, number, number]; // y0, x0, y1, x1 en 0–1000

const isEmbroidery = (label: string) => /embroider|bordad|logo|print|design|patch/i.test(label ?? "");

export async function garmentMask(gemini: GeminiImages, photo: Buffer): Promise<{ data: Buffer; cost_usd: number }> {
  const text = await gemini.describeImage({ model: SEGMENT_MODEL, prompt: SEGMENT_PROMPT, image: photo, mimeType: "image/jpeg" });
  const segs = parseSegments(text);
  const hoodie = segs.filter((s) => !isEmbroidery(s.label)).map((s) => s.box_2d);
  if (!hoodie.length) throw new Error("Gemini no encontró el hoodie en la foto");
  const embroidery = segs.filter((s) => isEmbroidery(s.label)).map((s) => s.box_2d);
  return { data: await colorMask(photo, hoodie, embroidery), cost_usd: SEGMENT_COST_USD };
}

// Máscara por color: tela = dentro de algún recuadro del hoodie, fuera del bordado, con el color real de la tela y
// conectada a la zona principal del hoodie. Así no entran la piel, el pelo, el fondo ni los hilos del bordado.
export async function colorMask(photo: Buffer, hoodieBoxes: Box[], embroideryBoxes: Box[]): Promise<Buffer> {
  const { data, info } = await sharp(photo).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const n = width * height;
  const toRect = ([y0, x0, y1, x1]: Box, pad = 0) => {
    const c = (v: number) => Math.min(1000, Math.max(0, v)) / 1000;
    const py = (c(y1) - c(y0)) * pad;
    const px = (c(x1) - c(x0)) * pad;
    return { top: (c(y0) - py) * height, left: (c(x0) - px) * width, bottom: (c(y1) + py) * height, right: (c(x1) + px) * width };
  };
  const hoodies = hoodieBoxes.map((b) => toRect(b));
  const embs = embroideryBoxes.map((b) => toRect(b, 0.08));
  const inside = (r: { top: number; left: number; bottom: number; right: number }, x: number, y: number) => x >= r.left && x < r.right && y >= r.top && y < r.bottom;

  const lab = new Float32Array(n * 3);
  const area = new Uint8Array(n);
  const inEmb = new Uint8Array(n);
  const as: number[] = [];
  const bs: number[] = [];
  const Ls: number[] = [];
  const bg: number[][] = [];
  const outer = hoodieBoxes.map((b) => toRect(b, 0.03));
  for (let i = 0; i < n; i++) {
    const x = i % width;
    const y = (i / width) | 0;
    const v = rgbToLab([data[i * 3], data[i * 3 + 1], data[i * 3 + 2]]);
    lab.set(v, i * 3);
    if (i % 11 === 0 && !outer.some((r) => inside(r, x, y))) bg.push(v);
    if (hoodies.some((r) => inside(r, x, y))) {
      area[i] = 1;
      if (embs.some((r) => inside(r, x, y))) {
        inEmb[i] = 1;
        continue;
      }
      if (i % 7 === 0) {
        Ls.push(v[0]);
        as.push(v[1]);
        bs.push(v[2]);
      }
    }
  }
  if (!Ls.length) throw new Error("El recuadro del hoodie está vacío");
  // Color de la tela: la mediana dentro del recuadro (la tela es lo que más ocupa ahí).
  const med = (xs: number[]) => xs.sort((p, q) => p - q)[xs.length >> 1];
  const [mL, mA, mB] = [med(Ls), med(as), med(bs)];
  // Color del fondo (fuera del recuadro del hoodie): un píxel que se parece más al fondo que a la tela no es tela.
  const bgColor = bg.length ? [med(bg.map((v) => v[0])), med(bg.map((v) => v[1])), med(bg.map((v) => v[2]))] : null;
  const dist = (L: number, a: number, b: number, c: number[]) => Math.hypot((L - c[0]) * 0.5, a - c[1], b - c[2]);
  const cand = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!area[i]) continue;
    const [L, a, b] = [lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2]];
    // Dentro del recuadro del bordado solo la tela de alrededor (color muy parecido); los hilos quedan fuera.
    const [maxC, maxL] = inEmb[i] ? [EMB_FABRIC_CHROMA, EMB_FABRIC_LIGHTNESS] : [FABRIC_CHROMA, FABRIC_LIGHTNESS];
    if (Math.hypot(a - mA, b - mB) > maxC || Math.abs(L - mL) > maxL) continue;
    // Solo se descarta si se parece claramente más al fondo: las sombras de la tela también se acercan al gris de una pared.
    if (bgColor && dist(L, a, b, bgColor) < 0.6 * dist(L, a, b, [mL, mA, mB])) continue;
    cand[i] = 1;
  }
  // Componentes conectadas: se quedan las grandes (cuerpo, mangas, capucha); manchas sueltas del fondo, no.
  const label = new Int32Array(n);
  const sizes: number[] = [0];
  const reachesOut: boolean[] = [false]; // la componente toca tela fuera del recuadro del bordado
  const stack: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!cand[i] || label[i]) continue;
    const id = sizes.length;
    let size = 0;
    let out = false;
    stack.push(i);
    label[i] = id;
    while (stack.length) {
      const j = stack.pop()!;
      size++;
      if (!inEmb[j]) out = true;
      const x = j % width;
      for (const k of [j - 1, j + 1, j - width, j + width]) {
        if (k < 0 || k >= n || !cand[k] || label[k]) continue;
        if ((k === j - 1 && x === 0) || (k === j + 1 && x === width - 1)) continue;
        label[k] = id;
        stack.push(k);
      }
    }
    sizes.push(size);
    reachesOut.push(out);
  }
  const largest = Math.max(...sizes);
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) if (label[i] && reachesOut[label[i]] && sizes[label[i]] >= largest * 0.1) out[i] = 255;
  // Cierre morfológico: rellena pliegues y sombras finas de la tela; no se rellena hacia los hilos del bordado.
  const r = Math.max(2, Math.round(width / 200));
  const closed = await sharp(out, { raw: { width, height, channels: 1 } }).dilate(r).erode(r).extractChannel(0).raw().toBuffer();
  for (let i = 0; i < n; i++) if (closed[i] && (!area[i] || (inEmb[i] && !out[i]))) closed[i] = 0;
  return sharp(closed, { raw: { width, height, channels: 1 } }).median(5).threshold(128).extractChannel(0).png().toBuffer();
}

export function parseSegments(text: string): Segment[] {
  const json = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
  const list: unknown[] = Array.isArray(json) ? json : (json.masks ?? json.segments ?? []);
  return list.filter(
    (e): e is Segment =>
      !!e && typeof e === "object" && Array.isArray((e as Segment).box_2d) && (e as Segment).box_2d.length === 4 && typeof (e as Segment).label === "string",
  );
}

// Arma la máscara del tamaño de la foto: blanco = tela del hoodie, menos el bordado.
export async function maskFromSegments(segments: Segment[], width: number, height: number): Promise<Buffer> {
  const out = Buffer.alloc(width * height);
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
      if (!seg.mask) continue;
      const png = Buffer.from(seg.mask.replace(/^data:image\/\w+;base64,/, ""), "base64");
      const local = await sharp(png).greyscale().resize(w, h, { fit: "fill" }).raw().toBuffer();
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) if (local[y * w + x] > 127 && top + y < height && left + x < width) out[(top + y) * width + left + x] = value;
    }
  }
  return sharp(out, { raw: { width, height, channels: 1 } }).png().toBuffer();
}

// Tiñe la tela de `photo` (hoodie de color `baseHex`) a `targetHex` conservando pliegues y sombras.
// La máscara de Gemini es aproximada: se recorta 2 px en el borde, se queda solo con los píxeles del color real
// de la tela (medido en la foto) y se descartan manchas sueltas, para no tocar piel, pelo ni fondo.
export async function recolorGarment(photo: Buffer, mask: Buffer, baseHex: string, targetHex: string): Promise<Buffer> {
  const { data, info } = await sharp(photo).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const n = width * height;
  // Se binariza antes de nada: una máscara gris o "pintada" no puede teñir media foto a medias.
  const hard = await sharp(mask).resize(width, height, { fit: "fill" }).greyscale().threshold(128).raw().toBuffer();
  const coverage = hard.reduce((sum, v) => sum + (v ? 1 : 0), 0) / n;
  if (coverage < MIN_COVERAGE || coverage > MAX_COVERAGE)
    throw new Error(`Máscara no confiable: marca ${(coverage * 100).toFixed(0)}% de la foto como hoodie`);
  const inner = erode(hard, width, height, EDGE_PX);

  const lab = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) lab.set(rgbToLab([data[i * 3], data[i * 3 + 1], data[i * 3 + 2]]), i * 3);

  // Color real de la tela: mediana de a/b y rango de luminosidad de los píxeles de la máscara cercanos al color base.
  const [, baseA, baseB] = rgbToLab(hexToRgb(baseHex));
  const sample = { a: [] as number[], b: [] as number[], L: [] as number[] };
  for (let i = 0; i < n; i++) {
    if (!inner[i] || Math.hypot(lab[i * 3 + 1] - baseA, lab[i * 3 + 2] - baseB) > MAX_CHROMA_DISTANCE) continue;
    sample.L.push(lab[i * 3]);
    sample.a.push(lab[i * 3 + 1]);
    sample.b.push(lab[i * 3 + 2]);
  }
  if (sample.L.length < n * 0.01) throw new Error("La máscara no marcó tela del hoodie");
  const [fabA, fabB] = [quantile(sample.a, 0.5), quantile(sample.b, 0.5)];
  const [minL, maxL] = fabricLightness(sample.L);

  const fabric = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const L = lab[i * 3];
    if (inner[i] && L >= minL && L <= maxL && Math.hypot(lab[i * 3 + 1] - fabA, lab[i * 3 + 2] - fabB) <= FABRIC_CHROMA_DISTANCE) fabric[i] = 255;
  }
  dropSpecks(fabric, width, height, Math.max(50, Math.round(n * 0.002)));
  const alpha = await sharp(Buffer.from(fabric), { raw: { width, height, channels: 1 } }).blur(1).toColourspace("b-w").raw().toBuffer();

  let sumL = 0;
  let count = 0;
  for (let i = 0; i < n; i++) if (fabric[i]) (sumL += lab[i * 3]), count++;
  if (count === 0) throw new Error("La máscara no marcó tela del hoodie");
  const meanL = sumL / count;
  const [targetL, targetA, targetB] = rgbToLab(hexToRgb(targetHex));
  // Las sombras se escalan con la luminosidad del color destino para que un hoodie oscuro no quede plano ni gris.
  const shade = Math.min(1, Math.max(0.35, targetL / meanL));

  const out = Buffer.from(data);
  for (let i = 0; i < n; i++) {
    // El suavizado del borde solo puede quitar tinte hacia adentro, nunca agregarlo fuera de la tela.
    const w = inner[i] ? alpha[i] / 255 : 0;
    if (w === 0) continue;
    const L = Math.min(100, Math.max(0, targetL + (lab[i * 3] - meanL) * shade));
    const rgb = labToRgb([L, targetA, targetB]);
    for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.round(data[i * 3 + c] * (1 - w) + rgb[c] * w);
  }
  return sharp(out, { raw: { width, height, channels: 3 } }).jpeg({ quality: 90, chromaSubsampling: "4:4:4" }).toBuffer();
}

// Rango de luminosidad de la tela: el tramo continuo del histograma alrededor del valor más frecuente. Un fondo gris
// junto a un hoodie negro tiene el mismo croma pero otra luminosidad, y queda fuera por el hueco entre ambos.
function fabricLightness(values: number[]): [number, number] {
  const BIN = 2;
  const hist = new Array(Math.ceil(100 / BIN) + 1).fill(0);
  for (const L of values) hist[Math.min(hist.length - 1, Math.max(0, Math.floor(L / BIN)))]++;
  const mode = hist.indexOf(Math.max(...hist));
  const floor = Math.max(1, values.length * 0.002);
  let [lo, hi] = [mode, mode];
  while (lo > 0 && hist[lo - 1] >= floor) lo--;
  while (hi < hist.length - 1 && hist[hi + 1] >= floor) hi++;
  return [lo * BIN - 2, (hi + 1) * BIN + 2];
}

function quantile(values: number[], q: number) {
  const sorted = Float64Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

// Erosión cuadrada de radio r (dos pasadas separables): el borde de la máscara cae sobre piel o fondo.
function erode(mask: Buffer, width: number, height: number, r: number): Uint8Array {
  const tmp = new Uint8Array(width * height);
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let ok = 1;
      for (let k = -r; k <= r && ok; k++) if (!mask[y * width + Math.min(width - 1, Math.max(0, x + k))]) ok = 0;
      tmp[y * width + x] = ok;
    }
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let ok = 1;
      for (let k = -r; k <= r && ok; k++) if (!tmp[Math.min(height - 1, Math.max(0, y + k)) * width + x]) ok = 0;
      out[y * width + x] = ok;
    }
  return out;
}

// Borra regiones sueltas de menos de `minSize` píxeles (manchas en el fondo o la piel que pasaron el filtro de color).
function dropSpecks(mask: Uint8Array, width: number, height: number, minSize: number) {
  const seen = new Uint8Array(mask.length);
  const stack: number[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    const region: number[] = [];
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      region.push(i);
      const x = i % width;
      for (const j of [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, i - width, i + width])
        if (j >= 0 && j < mask.length && mask[j] && !seen[j]) (seen[j] = 1), stack.push(j);
    }
    if (region.length < minSize) for (const i of region) mask[i] = 0;
  }
  void height;
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
