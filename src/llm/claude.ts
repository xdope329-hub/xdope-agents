import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";

export const CLAUDE_MODEL = "claude-opus-5-5";
// USD por millón de tokens (entrada, salida) para estimar costo.
const PRICE = { input: 4, output: 20 };

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

export interface ImageInput {
  data: Buffer;
  mediaType: "image/jpeg" | "image/png" | "image/webp";
  label: string;
}

export class Claude {
  readonly usage: Usage = { input_tokens: 0, output_tokens: 0, cost_usd: 0 };

  constructor(private readonly client = new Anthropic()) {}

  // Una llamada con imágenes y salida JSON validada por el esquema.
  // Reintenta una vez si la respuesta no pasa la validación del esquema; los errores
  // de la API (red, límites) ya los reintenta el SDK.
  async ask<T>(opts: Parameters<Claude["askOnce"]>[0] & { schema: z.ZodType<T> }): Promise<T> {
    try {
      return await this.askOnce<T>(opts);
    } catch (err) {
      if (err instanceof Anthropic.APIError) throw err;
      return this.askOnce<T>(opts);
    }
  }

  private async askOnce<T>(opts: {
    system: string;
    prompt: string;
    images: ImageInput[];
    schema: z.ZodType<T>;
    effort?: "low" | "medium" | "high";
  }): Promise<T> {
    const content: Anthropic.ContentBlockParam[] = [];
    for (const img of opts.images) {
      content.push({ type: "text", text: img.label });
      content.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data.toString("base64") } });
    }
    content.push({ type: "text", text: opts.prompt });

    const response = await this.client.messages.parse({
      model: CLAUDE_MODEL,
      max_tokens: 16000,
      system: opts.system,
      output_config: { effort: opts.effort ?? "medium", format: zodOutputFormat(opts.schema) },
      messages: [{ role: "user", content }],
    });

    this.usage.input_tokens += response.usage.input_tokens;
    this.usage.output_tokens += response.usage.output_tokens;
    this.usage.cost_usd += (response.usage.input_tokens * PRICE.input + response.usage.output_tokens * PRICE.output) / 1e6;

    if (response.stop_reason === "refusal") {
      throw new Error(`Claude rechazó la solicitud: ${response.stop_details?.explanation ?? "sin detalle"}`);
    }
    if (!response.parsed_output) {
      throw new Error(`Respuesta sin JSON válido (stop_reason=${response.stop_reason})`);
    }
    return response.parsed_output as T;
  }
}
