import { describe, expect, it } from "vitest";
import { CuratorPick, ShotList } from "../src/contracts/index.js";

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

describe("CuratorPick", () => {
  const pick = {
    run_id: "r1",
    design_id: "d_1",
    selection_reason: "nuevo y en alta resolución",
    title_options: ["Hoodie Calcifer Bordado", "Calcifer: Fuego Bordado", "Hoodie Llama Viva"],
    title: "Hoodie Calcifer Bordado",
    title_reason: "el más claro",
    short_description: "El demonio de fuego más querido, bordado hilo a hilo.",
    categories: [
      { category_id: "c_anime", name: "Anime", role: "primary", confidence: 0.95, reason: "personaje de Studio Ghibli" },
      { category_id: "c_animales", name: "Animales", role: "secondary", confidence: 0.4, reason: "criatura" },
    ],
  };

  it("acepta una elección válida", () => {
    expect(CuratorPick.safeParse(pick).success).toBe(true);
  });

  it("rechaza un título que no está entre las opciones", () => {
    expect(CuratorPick.safeParse({ ...pick, title: "Otro" }).success).toBe(false);
  });

  it("rechaza una descripción corta de más de 160 caracteres", () => {
    expect(CuratorPick.safeParse({ ...pick, short_description: "x".repeat(161) }).success).toBe(false);
  });

  it("exige exactamente una categoría principal", () => {
    const categories = pick.categories.map((c) => ({ ...c, role: "secondary" }));
    expect(CuratorPick.safeParse({ ...pick, categories }).success).toBe(false);
  });

  it("rechaza más de 2 categorías secundarias", () => {
    const extra = ["a", "b"].map((id) => ({ category_id: id, name: id, role: "secondary", confidence: 0.7, reason: "x" }));
    expect(CuratorPick.safeParse({ ...pick, categories: [...pick.categories, ...extra] }).success).toBe(false);
  });

  it("rechaza categorías repetidas", () => {
    const categories = [pick.categories[0], { ...pick.categories[0], role: "secondary" }];
    expect(CuratorPick.safeParse({ ...pick, categories }).success).toBe(false);
  });
});
