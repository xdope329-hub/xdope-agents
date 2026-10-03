import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { hexToRgb, rgbToLab } from "../src/color.js";
import { labToRgb, lightestColor, recolorGarment } from "../src/images/recolor.js";

describe("labToRgb", () => {
  it("es la inversa de rgbToLab", () => {
    for (const hex of ["#151515", "#F5F5F2", "#C8B48F", "#2E4A7D", "#7A1F2B"]) {
      const rgb = hexToRgb(hex);
      labToRgb(rgbToLab(rgb)).forEach((v, i) => expect(Math.abs(v - rgb[i])).toBeLessThanOrEqual(1));
    }
  });
});

describe("recolorGarment", () => {
  // Foto de 40×40: fondo azul, "hoodie" gris claro con sombra gradual, y un "bordado" rojo dentro de la tela.
  const W = 40;
  const pixel = (x: number, y: number): [number, number, number] => {
    if (x < 10 || x >= 30) return [40, 90, 200];
    if (x >= 18 && x < 22 && y >= 18 && y < 22) return [200, 30, 30];
    const g = Math.round(220 - y * 1.5); // sombra continua, como en una foto real
    return [g, g, g];
  };
  const raw = Buffer.alloc(W * W * 3);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) raw.set(pixel(x, y), (y * W + x) * 3);
  const photo = () => sharp(raw, { raw: { width: W, height: W, channels: 3 } }).png().toBuffer();
  // La máscara cubre toda la franja central, incluido el bordado (el filtro de croma debe protegerlo).
  const maskRaw = Buffer.alloc(W * W);
  for (let y = 0; y < W; y++) for (let x = 10; x < 30; x++) maskRaw[y * W + x] = 255;
  const mask = () => sharp(maskRaw, { raw: { width: W, height: W, channels: 1 } }).png().toBuffer();

  it("tiñe la tela, conserva la sombra y no toca el bordado ni el fondo", async () => {
    const out = await recolorGarment(await photo(), await mask(), "#DCDCDC", "#2E4A7D");
    const px = await sharp(out).raw().toBuffer();
    const at = (x: number, y: number) => [...px.subarray((y * W + x) * 3, (y * W + x) * 3 + 3)];
    const [light, dark] = [at(15, 5), at(15, 35)]; // lejos del borde, que se recorta a propósito
    expect(light[2]).toBeGreaterThan(light[0] + 30); // azul marino
    expect(rgbToLab(light as [number, number, number])[0]).toBeGreaterThan(rgbToLab(dark as [number, number, number])[0]);
    const red = at(20, 20);
    expect(red[0]).toBeGreaterThan(170);
    expect(red[1]).toBeLessThan(70);
    const bg = at(3, 3);
    expect(Math.abs(bg[2] - 200)).toBeLessThan(15);
  });
});

describe("lightestColor", () => {
  it("elige el color más claro", () => {
    expect(lightestColor([{ hex: "#151515" }, { hex: "#C8B48F" }, { hex: "#F5F5F2" }]).hex).toBe("#F5F5F2");
  });
});
