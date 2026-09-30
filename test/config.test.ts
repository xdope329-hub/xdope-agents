import { describe, expect, it } from "vitest";
import { loadConfig, loadScanConfig } from "../src/config.js";

const full = {
  DESIGNS_DIR: "C:/designs",
  XDOPE_API_URL: "https://api-qa.example.com",
  XDOPE_AGENT_EMAIL: "agentes@xdope.test",
  XDOPE_AGENT_PASSWORD: "x",
  CLOUDINARY_CLOUD_NAME: "c",
  CLOUDINARY_API_KEY: "k",
  CLOUDINARY_API_SECRET: "s",
  GEMINI_API_KEY: "g",
  ANTHROPIC_API_KEY: "a",
};

describe("config", () => {
  it("aplica los valores por defecto acordados", () => {
    const c = loadConfig(full);
    expect(c.XDOPE_API_ENV).toBe("qa");
    expect(c.IMAGE_MODEL).toBe("gemini-3.1-flash-image");
    expect(c.IMAGE_OUTPUT_SIZE).toBe("1080x1350");
    expect(c.MAX_IMAGE_COST_PER_PRODUCT).toBe(3);
  });

  it("exige la clave del proveedor de imágenes elegido", () => {
    const { GEMINI_API_KEY: _omit, ...rest } = full;
    expect(() => loadConfig(rest)).toThrow("GEMINI_API_KEY");
  });

  it("el escaneo solo necesita la carpeta de diseños", () => {
    expect(loadScanConfig({ DESIGNS_DIR: "C:/designs" }).DESIGNS_CATALOG).toBe("designs.json");
    expect(() => loadScanConfig({})).toThrow("DESIGNS_DIR");
  });
});
