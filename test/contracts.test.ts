import { describe, expect, it } from "vitest";
import { ShotList } from "../src/contracts/index.js";

const color = (name: string, hex: string) => ({ name, attribute_value_id: `av_${name}`, hex, contrast_ok: true });
const shot = (color: string, framing: string, i: number) => ({
  shot_id: `${color}-${i}`,
  color,
  placement: "chest_left",
  framing,
  background: "muro de concreto",
  lighting: "luz natural suave",
  aspect: "4:5",
  prompt: `hoodie ${color} con bordado en el pecho izquierdo`,
  negative_prompt: "texto extra, estampado plano",
});
const shotsFor = (c: string) => [shot(c, "front_mid", 1), shot(c, "three_quarter", 2), shot(c, "detail", 3)];

const base = {
  run_id: "r1",
  analysis: { subject: "Calcifer", style: "anime", thread_palette: ["#F2C230"], has_text: false, best_placement: "chest_left" },
  concept: { type: "model", description: "hombre 25-30, streetwear" },
  colors: [color("Negro", "#111111"), color("Hueso", "#EDE6D6"), color("Verde", "#2F4F3A")],
  shots: [...shotsFor("Negro"), ...shotsFor("Hueso"), ...shotsFor("Verde")],
};

describe("ShotList", () => {
  it("acepta 3 colores × 3 tomas con detalle", () => {
    expect(ShotList.safeParse(base).success).toBe(true);
  });

  it("rechaza menos de 3 colores", () => {
    const r = ShotList.safeParse({ ...base, colors: base.colors.slice(0, 2), shots: base.shots.slice(0, 6) });
    expect(r.success).toBe(false);
  });

  it("rechaza un color con menos de 3 tomas", () => {
    const r = ShotList.safeParse({ ...base, shots: base.shots.slice(0, 8) });
    expect(r.success).toBe(false);
  });

  it("rechaza un color sin toma de detalle", () => {
    const shots = base.shots.map((s) => (s.shot_id === "Verde-3" ? { ...s, framing: "lifestyle" } : s));
    expect(ShotList.safeParse({ ...base, shots }).success).toBe(false);
  });

  it("rechaza colores sin contraste suficiente", () => {
    const colors = base.colors.map((c) => (c.name === "Negro" ? { ...c, contrast_ok: false } : c));
    expect(ShotList.safeParse({ ...base, colors }).success).toBe(false);
  });
});
