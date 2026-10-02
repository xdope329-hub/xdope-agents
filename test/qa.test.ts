import { describe, expect, it } from "vitest";
import { runQa, runQaMany } from "../src/agents/qa.js";
import type { Claude } from "../src/llm/claude.js";

const ok = { embroidery_fidelity: 9, realism: 9, same_person: null, framing_ok: true, garment_present: true, placement_ok: true, size_ok: true, stitch_texture_visible: true, garment_color_ok: true, extra_text: false, reasons: [] };
const img = { data: Buffer.from("x"), mediaType: "image/jpeg" as const, label: "" };
const shot = { shot_id: "s", color: "Negro", placement: "chest_left" as const, framing: "front_mid" as const, background: "b", lighting: "l", aspect: "4:5", prompt: "p", negative_prompt: "n" };

function fakeClaude() {
  const calls: Array<{ images: Array<{ label: string }>; prompt: string; key?: string }> = [];
  // Responde una revisión por cada foto candidata; la 2.ª sale con el bordado mal.
  const claude = {
    ask: async (o: { images: Array<{ label: string }>; prompt: string; key?: string }) => {
      calls.push(o);
      const n = o.images.filter((i) => i.label.startsWith("Foto candidata")).length;
      return { reviews: Array.from({ length: n }, (_, i) => ({ ...ok, photo: i + 1, embroidery_fidelity: i === 1 ? 4 : 9 })) };
    },
  } as unknown as Claude;
  return { claude, calls };
}

describe("QA con la ubicación marcada por Diego", () => {
  it("recibe la guía y evalúa ubicación y tamaño contra el recuadro", async () => {
    const { claude, calls } = fakeClaude();
    await runQa({ claude, design: img, candidate: img, identity: null, shot, garmentColor: "Negro", placementGuide: Buffer.from("g") });
    expect(calls[0].images.map((i) => i.label).some((l) => l.startsWith("Guía de ubicación"))).toBe(true);
    expect(calls[0].prompt).toContain("manda el recuadro rojo");
  });

  it("sin guía usa las reglas generales", async () => {
    const { claude, calls } = fakeClaude();
    await runQa({ claude, design: img, candidate: img, identity: null, shot, garmentColor: "Negro" });
    expect(calls[0].images).toHaveLength(2);
    expect(calls[0].prompt).not.toContain("recuadro");
  });
});

describe("QA de varias fotos en una llamada", () => {
  it("manda la referencia una sola vez y devuelve una revisión por foto", async () => {
    const { claude, calls } = fakeClaude();
    const candidates = [1, 2, 3].map(() => ({ candidate: img, shot, garmentColor: "Negro", checkPerson: true }));
    const out = await runQaMany({ claude, design: img, identity: img, candidates, key: "qa-x" });
    expect(calls).toHaveLength(1);
    expect(calls[0].key).toBe("qa-x");
    expect(calls[0].images.filter((i) => i.label.startsWith("Referencia exacta"))).toHaveLength(1);
    expect(calls[0].images.filter((i) => i.label.startsWith("Imagen de identidad"))).toHaveLength(1);
    expect(out.map((r) => r.passed)).toEqual([true, false, true]);
  });
});
