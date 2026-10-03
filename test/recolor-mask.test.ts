import sharp from "sharp";
import { describe, expect, it } from "vitest";
import type { GeminiImages } from "../src/images/gemini.js";
import { garmentMask, maskFromSegments, parseSegments, recolorGarment } from "../src/images/recolor.js";

const W = 100;
const solid = (v: number, w: number, h: number) => sharp(Buffer.alloc(w * h, v), { raw: { width: w, height: h, channels: 1 } }).png().toBuffer();
const b64 = async (v: number, w = 10, h = 10) => "data:image/png;base64," + (await solid(v, w, h)).toString("base64");

describe("máscara por segmentación", () => {
  it("lee el JSON de Gemini aunque venga en un bloque ```json", () => {
    const segs = parseSegments('```json\n[{"box_2d":[0,0,10,10],"mask":"x","label":"hoodie"},{"label":"sin caja"}]\n```');
    expect(segs).toHaveLength(1);
  });

  it("marca solo el recuadro del hoodie y le resta el bordado", async () => {
    const png = await maskFromSegments(
      [
        { box_2d: [200, 200, 800, 800], mask: await b64(255), label: "hoodie" },
        { box_2d: [400, 400, 600, 600], mask: await b64(255), label: "embroidery" },
      ],
      W,
      W,
    );
    const px = await sharp(png).greyscale().raw().toBuffer();
    expect(px[5 * W + 5]).toBe(0); // fondo
    expect(px[30 * W + 30]).toBe(255); // tela
    expect(px[50 * W + 50]).toBe(0); // bordado
  });

  it("pide la segmentación a Gemini y arma la máscara del tamaño de la foto", async () => {
    const photo = await sharp({ create: { width: W, height: 120, channels: 3, background: "#ddd" } }).jpeg().toBuffer();
    const fake = { describeImage: async () => JSON.stringify([{ box_2d: [100, 100, 900, 900], mask: await b64(255), label: "hoodie" }]) } as unknown as GeminiImages;
    const { data } = await garmentMask(fake, photo);
    expect(await sharp(data).metadata()).toMatchObject({ width: W, height: 120 });
  });

  it("rechaza una máscara que marca casi toda la foto en vez de teñirla entera", async () => {
    const photo = await sharp({ create: { width: W, height: W, channels: 3, background: "#ddd" } }).jpeg().toBuffer();
    await expect(recolorGarment(photo, await solid(255, W, W), "#DCDCDC", "#2E4A7D")).rejects.toThrow(/no confiable/);
  });
});
