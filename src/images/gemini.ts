import { GoogleGenAI, JobState, type GenerateContentResponse, type InlinedRequest } from "@google/genai";

// USD por imagen a 2K, precios públicos al 2026-09-30 (specs/04). El modo batch cuesta la mitad.
const PRICE_2K: Record<string, number> = {
  "gemini-3.1-flash-image": 0.101,
  "gemini-3-pro-image": 0.134,
};
const BATCH_DISCOUNT = 0.5;

export interface RefImage {
  data: Buffer;
  mimeType: string;
  role: string; // descripción de para qué sirve la referencia, va antes de la imagen
}

export interface ImageRequest {
  model: string;
  prompt: string;
  refs: RefImage[];
  aspectRatio: string;
  imageSize: "1K" | "2K" | "4K";
}

export interface GeneratedImage {
  data: Buffer;
  mimeType: string;
  model: string;
  cost_usd: number;
  batch: boolean;
}

export class GeminiImages {
  private readonly ai: GoogleGenAI;

  constructor(apiKey: string, ai?: GoogleGenAI) {
    this.ai = ai ?? new GoogleGenAI({ apiKey });
  }

  async generate(req: ImageRequest): Promise<GeneratedImage> {
    const response = await this.ai.models.generateContent({ model: req.model, ...toRequest(req) });
    return fromResponse(response, req.model, false);
  }

  // Envía todas las solicitudes en un solo trabajo batch (mitad de precio) y espera
  // el resultado. Todas deben usar el mismo modelo. Devuelve imagen o error por clave.
  async generateBatch(
    requests: Array<{ key: string; req: ImageRequest }>,
    opts: { displayName: string; pollSeconds?: number; onCreated?: (jobName: string) => void; log?: (msg: string) => void },
  ): Promise<Map<string, GeneratedImage | Error>> {
    const model = requests[0]?.req.model;
    if (!model) return new Map();
    if (requests.some((r) => r.req.model !== model)) throw new Error("Un batch solo admite un modelo");

    const inlined: InlinedRequest[] = requests.map(({ key, req }) => ({ ...toRequest(req), metadata: { key } }));
    const job = await this.ai.batches.create({ model, src: inlined, config: { displayName: opts.displayName } });
    if (!job.name) throw new Error("Gemini no devolvió el nombre del trabajo batch");
    opts.onCreated?.(job.name);

    const started = Date.now();
    const done = new Set<string>([JobState.JOB_STATE_SUCCEEDED, JobState.JOB_STATE_FAILED, JobState.JOB_STATE_CANCELLED, JobState.JOB_STATE_EXPIRED]);
    let current = job;
    let lastState = "";
    while (!done.has(current.state ?? "")) {
      await new Promise((r) => setTimeout(r, (opts.pollSeconds ?? 30) * 1000));
      current = await this.ai.batches.get({ name: job.name });
      if (current.state !== lastState) {
        lastState = current.state ?? "";
        opts.log?.(`  batch ${lastState} (${Math.round((Date.now() - started) / 60000)} min)`);
      }
    }
    if (current.state !== JobState.JOB_STATE_SUCCEEDED) {
      throw new Error(`El batch terminó en ${current.state}: ${current.error?.message ?? "sin detalle"}`);
    }

    const results = new Map<string, GeneratedImage | Error>();
    const responses = current.dest?.inlinedResponses ?? [];
    responses.forEach((r, i) => {
      // Las respuestas traen la metadata de la solicitud; si no, se asume el mismo orden.
      const key = r.metadata?.key ?? requests[i]?.key;
      if (!key) return;
      if (r.error || !r.response) {
        results.set(key, new Error(r.error?.message ?? "Solicitud batch sin respuesta"));
        return;
      }
      try {
        results.set(key, fromResponse(r.response, model, true));
      } catch (err) {
        results.set(key, err instanceof Error ? err : new Error(String(err)));
      }
    });
    for (const { key } of requests) if (!results.has(key)) results.set(key, new Error("Sin resultado en el batch"));
    return results;
  }
}

function toRequest(req: ImageRequest) {
  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];
  for (const ref of req.refs) {
    parts.push({ text: ref.role });
    parts.push({ inlineData: { mimeType: ref.mimeType, data: ref.data.toString("base64") } });
  }
  parts.push({ text: req.prompt });
  return {
    contents: [{ role: "user", parts }],
    config: {
      responseModalities: ["IMAGE"],
      imageConfig: { aspectRatio: req.aspectRatio, imageSize: req.imageSize },
    },
  };
}

function fromResponse(response: GenerateContentResponse, model: string, batch: boolean): GeneratedImage {
  const out = response.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  if (!out?.inlineData?.data) {
    const reason = response.candidates?.[0]?.finishReason ?? response.promptFeedback?.blockReason ?? "desconocido";
    throw new Error(`Gemini no devolvió imagen (motivo: ${reason})`);
  }
  const price = PRICE_2K[model] ?? 0;
  return {
    data: Buffer.from(out.inlineData.data, "base64"),
    mimeType: out.inlineData.mimeType ?? "image/png",
    model,
    cost_usd: batch ? price * BATCH_DISCOUNT : price,
    batch,
  };
}
