// Recoloreado sin IA (experimento, specs/04): se genera cada pose una sola vez en un color claro y los demás
// colores se tiñen por código. Gemini entrega una máscara de la tela; el bordado, la piel y el fondo no se tocan.
import sharp from "sharp";
import { hexToRgb, rgbToLab } from "../color.js";
import type { GeminiImages, GeneratedImage, ImageSize } from "./gemini.js";

// Distancia máxima de croma (a, b) al color base para que un píxel cuente como tela: protege los hilos del bordado.
const MAX_CHROMA_DISTANCE = 18;

export async function garmentMask(gemini: GeminiImages, photo: Buffer, model: string, imageSize: ImageSize): Promise<GeneratedImage> {
  return gemini.generate({
    model,
    prompt:
      "Return a black and white segmentation mask of this photo with the same framing. " +
      "Pure white: only the hoodie fabric (body, sleeves, hood, cuffs, drawstrings). " +
      "Pure black: everything else, including the embroidery, skin, hair, other clothes and the background. No gray, no shading.",
    refs: [{ role: "Photo to segment:", data: photo, mimeType: "image/jpeg" }],
    aspectRatio: "4:5",
    imageSize,
  });
}

// Tiñe la tela de `photo` (hoodie de color `baseHex`) a `targetHex` conservando pliegues y sombras.
export async function recolorGarment(photo: Buffer, mask: Buffer, baseHex: string, targetHex: string): Promise<Buffer> {
  const { data, info } = await sharp(photo).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  // Máscara al tamaño de la foto, con borde suavizado para que el corte no se note.
  const alpha = await sharp(mask).resize(width, height, { fit: "fill" }).greyscale().blur(1.5).raw().toBuffer();

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
