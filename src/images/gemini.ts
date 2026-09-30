import { GoogleGenAI } from "@google/genai";

// USD por imagen a 2K, precios públicos al 2026-09-30 (specs/04).
const PRICE_2K: Record<string, number> = {
  "gemini-3.1-flash-image": 0.101,
  "gemini-3-pro-image": 0.134,
};

export interface RefImage {
  data: Buffer;
  mimeType: string;
  role: string; // descripción de para qué sirve la referencia, va antes de la imagen
}

export interface GeneratedImage {
  data: Buffer;
  mimeType: string;
  model: string;
  cost_usd: number;
}

export class GeminiImages {
  private readonly ai: GoogleGenAI;

  constructor(apiKey: string) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  async generate(opts: {
    model: string;
    prompt: string;
    refs: RefImage[];
    aspectRatio: string;
    imageSize: "1K" | "2K" | "4K";
  }): Promise<GeneratedImage> {
    const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];
    for (const ref of opts.refs) {
      parts.push({ text: ref.role });
      parts.push({ inlineData: { mimeType: ref.mimeType, data: ref.data.toString("base64") } });
    }
    parts.push({ text: opts.prompt });

    const response = await this.ai.models.generateContent({
      model: opts.model,
      contents: [{ role: "user", parts }],
      config: {
        responseModalities: ["IMAGE"],
        imageConfig: { aspectRatio: opts.aspectRatio, imageSize: opts.imageSize },
      },
    });

    const out = response.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
    if (!out?.inlineData?.data) {
      const reason = response.candidates?.[0]?.finishReason ?? response.promptFeedback?.blockReason ?? "desconocido";
      throw new Error(`Gemini no devolvió imagen (motivo: ${reason})`);
    }
    return {
      data: Buffer.from(out.inlineData.data, "base64"),
      mimeType: out.inlineData.mimeType ?? "image/png",
      model: opts.model,
      cost_usd: PRICE_2K[opts.model] ?? 0,
    };
  }
}
