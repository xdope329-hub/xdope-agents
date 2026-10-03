import { GoogleGenAI, JobState, type GenerateContentResponse, type InlinedRequest } from "@google/genai";

// USD por imagen según resolución (specs/04; 1K de Flash es estimado, confirmar en la factura). El modo batch cuesta la mitad.
export type ImageSize = "1K" | "2K" | "4K";
const PRICE: Record<string, Partial<Record<ImageSize, number>>> = {
  "gemini-3.1-flash-image": { "1K": 0.067, "2K": 0.101, "4K": 0.151 },
  "gemini-3-pro-image": { "1K": 0.134, "2K": 0.134, "4K": 0.24 },
  // Nano Banana original: precio único (estimado), resolución fija ~1K.
  "gemini-2.5-flash-image": { "1K": 0.039, "2K": 0.039, "4K": 0.039 },
};
const BATCH_DISCOUNT = 0.5;

export function imagePrice(model: string, size: ImageSize, batch: boolean) {
  const price = PRICE[model]?.[size] ?? 0;
  return batch ? price * BATCH_DISCOUNT : price;
}

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
  imageSize: ImageSize;
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
    return fromResponse(response, req.model, false, req.imageSize);
  }

  // Pide texto (JSON) a un modelo de Gemini sobre una foto; se usa para las máscaras de segmentación del recoloreado.
  async describeImage(opts: { model: string; prompt: string; image: Buffer; mimeType: string }): Promise<string> {
    const response = await this.ai.models.generateContent({
      model: opts.model,
      contents: [{ role: "user", parts: [{ inlineData: { mimeType: opts.mimeType, data: opts.image.toString("base64") } }, { text: opts.prompt }] }],
      config: { responseMimeType: "application/json", thinkingConfig: { thinkingBudget: 0 } },
    });
    const text = response.text;
    if (!text) throw new Error(`Gemini no devolvió texto (motivo: ${response.candidates?.[0]?.finishReason ?? "desconocido"})`);
    return text;
  }

  // Envía todas las solicitudes en un solo trabajo batch (mitad de precio) y espera
  // el resultado. Todas deben usar el mismo modelo. Devuelve imagen o error por clave.
  async generateBatch(
    requests: Array<{ key: string; req: ImageRequest }>,
    opts: { displayName: string; pollSeconds?: number; onCreated?: (jobName: string) => void; log?: (msg: string) => void },
  ): Promise<Map<string, GeneratedImage | Error>> {
    const model = requests[0]?.req.model;
    if (!model) return new Map();
    const jobName = await this.submitBatch(requests, opts.displayName);
    opts.onCreated?.(jobName);

    const started = Date.now();
    let lastState = "";
    for (;;) {
      await new Promise((r) => setTimeout(r, (opts.pollSeconds ?? 30) * 1000));
      const check = await this.checkBatch(jobName, requests.map((r) => r.key), model, requests[0].req.imageSize);
      if (check.state !== lastState) {
        lastState = check.state;
        opts.log?.(`  batch ${lastState} (${Math.round((Date.now() - started) / 60000)} min)`);
      }
      if (check.results) return check.results;
      if (check.done) throw new Error(`El batch terminó en ${check.state}: ${check.error ?? "sin detalle"}`);
    }
  }

  // Envía el batch y devuelve el nombre del trabajo sin esperar. Todas las solicitudes deben usar el mismo modelo.
  async submitBatch(requests: Array<{ key: string; req: ImageRequest }>, displayName: string): Promise<string> {
    const model = requests[0]?.req.model;
    if (!model) throw new Error("Batch vacío");
    if (requests.some((r) => r.req.model !== model)) throw new Error("Un batch solo admite un modelo");
    const inlined: InlinedRequest[] = requests.map(({ key, req }) => ({ ...toRequest(req), metadata: { key } }));
    const job = await this.ai.batches.create({ model, src: inlined, config: { displayName } });
    if (!job.name) throw new Error("Gemini no devolvió el nombre del trabajo batch");
    return job.name;
  }

  // Consulta un batch una sola vez. Si terminó bien, trae la imagen o el error de cada clave.
  async checkBatch(
    jobName: string,
    keys: string[],
    model: string,
    size: ImageSize = "2K",
  ): Promise<{ state: string; done: boolean; error?: string; results?: Map<string, GeneratedImage | Error> }> {
    const current = await this.ai.batches.get({ name: jobName });
    const state = current.state ?? "JOB_STATE_UNSPECIFIED";
    const done = FINAL_STATES.has(state);
    if (state !== JobState.JOB_STATE_SUCCEEDED) return { state, done, error: current.error?.message };

    const results = new Map<string, GeneratedImage | Error>();
    const responses = current.dest?.inlinedResponses ?? [];
    responses.forEach((r, i) => {
      // Las respuestas traen la metadata de la solicitud; si no, se asume el mismo orden.
      const key = r.metadata?.key ?? keys[i];
      if (!key) return;
      if (r.error || !r.response) {
        results.set(key, new Error(r.error?.message ?? "Solicitud batch sin respuesta"));
        return;
      }
      try {
        results.set(key, fromResponse(r.response, model, true, size));
      } catch (err) {
        results.set(key, err instanceof Error ? err : new Error(String(err)));
      }
    });
    for (const key of keys) if (!results.has(key)) results.set(key, new Error("Sin resultado en el batch"));
    return { state, done, results };
  }
}

const FINAL_STATES = new Set<string>([JobState.JOB_STATE_SUCCEEDED, JobState.JOB_STATE_FAILED, JobState.JOB_STATE_CANCELLED, JobState.JOB_STATE_EXPIRED]);

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
      // gemini-2.5-flash-image no acepta imageSize (resolución fija).
      imageConfig: req.model.startsWith("gemini-2.5") ? { aspectRatio: req.aspectRatio } : { aspectRatio: req.aspectRatio, imageSize: req.imageSize },
    },
  };
}

function fromResponse(response: GenerateContentResponse, model: string, batch: boolean, size: ImageSize): GeneratedImage {
  const out = response.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  if (!out?.inlineData?.data) {
    const reason = response.candidates?.[0]?.finishReason ?? response.promptFeedback?.blockReason ?? "desconocido";
    throw new Error(`Gemini no devolvió imagen (motivo: ${reason})`);
  }
  return {
    data: Buffer.from(out.inlineData.data, "base64"),
    mimeType: out.inlineData.mimeType ?? "image/png",
    model,
    cost_usd: imagePrice(model, size, batch),
    batch,
  };
}
