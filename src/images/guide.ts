// Guía de ubicación dibujada por Diego: un recuadro sobre una foto de ejemplo marca dónde va el bordado.
import { readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { MAX_CHEST_LEFT_CM, MAX_HOOP_CM } from "../contracts/index.js";

export interface PlacementBox {
  ref: string; // foto de ejemplo en config/placement-refs, sin extensión
  x: number; // esquina superior izquierda, fracción del ancho y alto de la foto (0–1)
  y: number;
  w: number;
  h: number;
}

// "ref:x,y,w,h" (argumento --box del pipeline).
export function parseBox(v: string): PlacementBox {
  const m = /^([a-z0-9_-]+):([\d.]+),([\d.]+),([\d.]+),([\d.]+)$/i.exec(v);
  if (!m) throw new Error(`--box inválido: ${v} (usa ref:x,y,w,h con fracciones 0–1)`);
  const [x, y, w, h] = m.slice(2).map(Number);
  if ([x, y, w, h].some((n) => !(n >= 0 && n <= 1)) || w <= 0 || h <= 0 || x + w > 1.001 || y + h > 1.001) throw new Error(`--box fuera de la foto: ${v}`);
  return { ref: m[1], x, y, w, h };
}

// Ubicación y tamaño aproximados: en las fotos de ejemplo (plano de cintura a cabeza) el ancho de la imagen
// equivale a ~100 cm. El centro del recuadro cerca del centro de la foto = centrado; a un lado = pecho.
export function boxPlacement(box: PlacementBox, designAspect: number): { placement: "chest_left" | "chest_center"; size: { w: number; h: number } } {
  const placement = Math.abs(box.x + box.w / 2 - 0.5) < 0.1 ? "chest_center" : "chest_left";
  const max = placement === "chest_left" ? MAX_CHEST_LEFT_CM : MAX_HOOP_CM;
  const round = (n: number) => Math.round(n * 10) / 10;
  // El diseño ocupa el recuadro sin deformarse: se ajusta por el lado que limite.
  const boxW = Math.min(box.w * 100, max);
  const boxH = Math.min(box.h * 100 * 1.25, max); // fotos 4:5 aprox.: el alto de la imagen equivale a ~125 cm
  const w = Math.min(boxW, boxH * designAspect);
  return { placement, size: { w: round(Math.max(w, 4)), h: round(Math.max(w / designAspect, 3)) } };
}

// Foto de ejemplo con el recuadro rojo dibujado.
export async function guideImage(refsDir: string, box: PlacementBox): Promise<Buffer> {
  const src = await readFile(path.join(refsDir, `${box.ref}.jpg`));
  // Desenfocada: conserva silueta, posición y escala, pero no el diseño ni la persona del ejemplo.
  const img = sharp(src).resize(768, 768, { fit: "inside" }).blur(6);
  const { data, info } = await img.jpeg().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const stroke = Math.max(3, Math.round(W / 150));
  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><rect x="${box.x * W}" y="${box.y * H}" width="${box.w * W}" height="${box.h * H}" fill="none" stroke="#ff0000" stroke-width="${stroke}"/></svg>`;
  return sharp(data).composite([{ input: Buffer.from(svg) }]).jpeg({ quality: 85 }).toBuffer();
}
