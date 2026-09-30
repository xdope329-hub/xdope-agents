import { describe, expect, it } from "vitest";
import { contrastWithPalette, deltaE } from "../src/color.js";

describe("color", () => {
  it("da 0 para colores iguales y ~100 entre negro y blanco", () => {
    expect(deltaE("#123456", "#123456")).toBe(0);
    expect(deltaE("#000000", "#FFFFFF")).toBeCloseTo(100, 0);
  });

  it("un hilo amarillo contrasta más con hoodie negro que con hueso", () => {
    const palette = ["#F2C230"];
    expect(contrastWithPalette("#151515", palette)).toBeGreaterThan(contrastWithPalette("#E9E1CF", palette));
  });
});
