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

describe("recolorGarment con una máscara que se sale del hoodie", () => {
  it("no tiñe la piel ni el fondo gris aunque la máscara los cubra", async () => {
    // 100×100: fondo gris claro, hoodie negro en el centro, "piel" a la izquierda del hoodie.
    const raw = Buffer.alloc(W * W * 3);
    for (let y = 0; y < W; y++)
      for (let x = 0; x < W; x++) {
        const px = x >= 30 && x < 70 ? [25, 25, 25] : x >= 20 && x < 30 ? [224, 172, 140] : [200, 200, 200];
        raw.set(px, (y * W + x) * 3);
      }
    const photo = await sharp(raw, { raw: { width: W, height: W, channels: 3 } }).png().toBuffer();
    // Máscara demasiado ancha: x 15–85 (incluye piel y fondo).
    const m = Buffer.alloc(W * W);
    for (let y = 0; y < W; y++) for (let x = 15; x < 85; x++) m[y * W + x] = 255;
    const mask = await sharp(m, { raw: { width: W, height: W, channels: 1 } }).png().toBuffer();
    const out = await sharp(await recolorGarment(photo, mask, "#151515", "#2E4A7D")).raw().toBuffer();
    const at = (x: number, y: number) => [...out.subarray((y * W + x) * 3, (y * W + x) * 3 + 3)];
    expect(at(50, 50)[2]).toBeGreaterThan(at(50, 50)[0] + 20); // hoodie teñido
    const skin = at(25, 50);
    expect(Math.abs(skin[0] - 224)).toBeLessThan(12);
    expect(Math.abs(skin[2] - 140)).toBeLessThan(12);
    const bg = at(78, 50);
    expect(Math.abs(bg[0] - bg[2])).toBeLessThan(8); // el fondo sigue gris
  });
});
