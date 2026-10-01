import { describe, expect, it } from "vitest";
import { presetSize } from "../src/agents/director.js";
import { hoodieLine, shotHeader, sizeLine } from "../src/images/mockups.js";
import type { ShotList } from "../src/contracts/index.js";

describe("tamaños estándar de bordado", () => {
  it("ajusta el lado mayor del diseño al tamaño estándar", () => {
    expect(presetSize("pecho_izquierdo", 2)).toEqual({ w: 9, h: 4.5 });
    expect(presetSize("centro_estandar", 0.75)).toEqual({ w: 11.3, h: 15 });
    expect(presetSize("centro_pequeno", 1)).toEqual({ w: 10, h: 10 });
  });
});

describe("prompts de imagen", () => {
  const shotList = {
    analysis: { best_placement: "chest_left", embroidery_size_cm: { w: 9, h: 6 } },
    colors: [{ name: "Vino Vintage", hex: "#6B2E3A" }],
  } as unknown as ShotList;
  const shot = (framing: string) => ({ color: "Vino Vintage", framing }) as never;

  it("da el tamaño como % del ancho de la imagen según el encuadre", () => {
    expect(sizeLine(shotList, shot("front_mid"))).toContain("about 9% of the image width");
    expect(sizeLine(shotList, shot("detail"))).toContain("about 26% of the image width");
  });

  it("exige el hoodie puesto y del color pedido, también en el primer plano", () => {
    const line = hoodieLine(shot("detail"), shotList, { "Vino Vintage": "deep washed burgundy wine red" });
    expect(line).toContain("Vino Vintage pullover hoodie (deep washed burgundy wine red, #6B2E3A)");
    expect(line).toContain("Never show a loose patch");
  });

  it("pone el tipo de toma, la pose y el fondo al inicio del prompt", () => {
    const h = shotHeader({ framing: "three_quarter", pose: "mano en el bolsillo", background: "interior claro" } as never);
    expect(h).toContain("THREE-QUARTER VIEW");
    expect(h).toContain("POSE: mano en el bolsillo");
    expect(h).toContain("BACKGROUND: interior claro");
  });
});
