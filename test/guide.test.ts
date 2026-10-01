import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { boxPlacement, guideImage, parseBox } from "../src/images/guide.js";

describe("ubicación marcada por Diego", () => {
  it("lee el recuadro y rechaza valores fuera de la foto", () => {
    expect(parseBox("pecho_izquierdo:0.55,0.4,0.1,0.08")).toEqual({ ref: "pecho_izquierdo", x: 0.55, y: 0.4, w: 0.1, h: 0.08 });
    expect(() => parseBox("x:0.9,0.1,0.3,0.1")).toThrow("fuera de la foto");
    expect(() => parseBox("x:1,2")).toThrow("inválido");
  });

  it("recuadro al centro = centrado; a un lado = pecho izquierdo; tamaño limitado al bastidor", () => {
    expect(boxPlacement({ ref: "r", x: 0.4, y: 0.4, w: 0.2, h: 0.12 }, 2)).toEqual({ placement: "chest_center", size: { w: 20, h: 10 } });
    const left = boxPlacement({ ref: "r", x: 0.6, y: 0.35, w: 0.15, h: 0.15 }, 1);
    expect(left.placement).toBe("chest_left");
    expect(left.size.w).toBeLessThanOrEqual(12);
    expect(boxPlacement({ ref: "r", x: 0.1, y: 0.2, w: 0.8, h: 0.6 }, 1).size).toEqual({ w: 20, h: 20 });
  });

  it("dibuja el recuadro rojo sobre la foto de ejemplo", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "refs-"));
    await writeFile(path.join(dir, "r.jpg"), await sharp({ create: { width: 400, height: 500, channels: 3, background: "#fff" } }).jpeg().toBuffer());
    const out = await guideImage(dir, { ref: "r", x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    const px = (x: number, y: number) => data.slice((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3);
    const edge = px(Math.round(info.width * 0.5), Math.round(info.height * 0.25));
    expect(edge[0]).toBeGreaterThan(200);
    expect(edge[1]).toBeLessThan(80);
    await rm(dir, { recursive: true, force: true });
  });
});
