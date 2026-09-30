import type { ImageSize } from "./images/gemini.js";

// Calidad de las fotos por lote (specs/04). Todas usan Nano Banana 2; cambian la resolución y el modelo del reintento.
//   economica: Nano Banana original (gemini-2.5-flash-image), ~1K, en prueba: más barata y más débil en bordado y caras.
//   baja:  1K (se amplía a 1080×1350, algo menos nítida), reintento con Flash.
//   media: 2K, reintento con Flash.
//   alta:  2K, reintento con Nano Banana Pro.
// Por defecto: baja (decisión de Diego, 2026-09-30).
export const QUALITIES = ["economica", "baja", "media", "alta"] as const;
export type Quality = (typeof QUALITIES)[number];

const FLASH = "gemini-3.1-flash-image";
const FLASH_25 = "gemini-2.5-flash-image";
const PRO = "gemini-3-pro-image";

export const QUALITY: Record<Quality, { model: string; retryModel: string; imageSize: ImageSize }> = {
  economica: { model: FLASH_25, retryModel: FLASH_25, imageSize: "1K" },
  baja: { model: FLASH, retryModel: FLASH, imageSize: "1K" },
  media: { model: FLASH, retryModel: FLASH, imageSize: "2K" },
  alta: { model: FLASH, retryModel: PRO, imageSize: "2K" },
};

export function parseQuality(v: string | undefined, fallback: Quality = "baja"): Quality {
  if (!v) return fallback;
  if (!(QUALITIES as readonly string[]).includes(v)) throw new Error(`Calidad inválida "${v}" (usa ${QUALITIES.join(", ")})`);
  return v as Quality;
}
