import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";

// Modelo de los agentes (Curador, Director, QA, Copywriter). Sonnet 5.5 por costo; CLAUDE_MODEL lo cambia.
export const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5-5";
// USD por millón de tokens (entrada, salida) para estimar costo.
const PRICES: Record<string, { input: number; output: number }> = {
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

const BATCH_DISCOUNT = 0.5;

// La respuesta de Claude va en un batch que todavía no termina; el lote se retoma con --collect.
export class ClaudePending extends Error {
  constructor(
    readonly key: string,
    readonly batchId: string,
    readonly state: string,
  ) {
    super(`Claude batch ${batchId} (${key}) ${state}`);
  }
}

// Una solicitud en batch guardada en <dir>/<key>.json hasta que llega su respuesta.
interface BatchRecord {
  key: string;
  batch_id: string;
  submitted_at: string;
  state: string;
  resubmits: number;
  result?: unknown;
}

type AskOptions<T> = {
  system: string;
  prompt: string;
  images: ImageInput[];
  schema: z.ZodType<T>;
  effort?: "low" | "medium" | "high";
  // Identifica la llamada dentro del lote (p. ej. "curador-1"). Con batchDir y key, la llamada va en batch.
  key?: string;
};

export interface ImageInput {
  data: Buffer;
  mediaType: "image/jpeg" | "image/png" | "image/webp";
  label: string;
}

export class Claude {
  readonly usage: Usage = { input_tokens: 0, output_tokens: 0, cost_usd: 0 };

  constructor(
    private readonly client = new Anthropic(),
    readonly model = CLAUDE_MODEL,
    // Con carpeta, las llamadas con key van por Message Batches (mitad de precio) y no esperan: lanzan ClaudePending.
    readonly batchDir: string | null = null,
    usage?: Usage,
  ) {
    if (usage) this.usage = usage;
  }

  // La misma instancia (y el mismo contador de costo) mandando sus llamadas en batch, guardadas en dir.
  withBatch(dir: string): Claude {
    return new Claude(this.client, this.model, dir, this.usage);
  }

  // Una llamada con imágenes y salida JSON validada por el esquema.
  // Reintenta una vez si la respuesta no pasa la validación del esquema; los errores
  // de la API (red, límites) ya los reintenta el SDK.
  async ask<T>(opts: AskOptions<T>): Promise<T> {
    if (this.batchDir && opts.key) return this.askBatched(opts as AskOptions<T> & { key: string });
    try {
      return await this.askOnce<T>(opts);
    } catch (err) {
      if (err instanceof Anthropic.APIError) throw err;
      return this.askOnce<T>(opts);
    }
  }

  private params<T>(opts: AskOptions<T>) {
    const content: Anthropic.ContentBlockParam[] = [];
    for (const img of opts.images) {
      content.push({ type: "text", text: img.label });
      content.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data.toString("base64") } });
    }
    content.push({ type: "text", text: opts.prompt });
    const { type, schema } = zodOutputFormat(opts.schema);
    return {
      model: this.model,
      max_tokens: 16000,
      system: opts.system,
      // Haiku 4.5 no acepta effort.
      output_config: this.model.startsWith("claude-haiku") ? { format: { type, schema } } : { effort: opts.effort ?? "medium", format: { type, schema } },
      messages: [{ role: "user" as const, content }],
    };
  }

  private addUsage(usage: { input_tokens: number; output_tokens: number }, batch: boolean) {
    this.usage.input_tokens += usage.input_tokens;
    this.usage.output_tokens += usage.output_tokens;
    const price = PRICES[this.model] ?? PRICES["claude-opus-5-5"];
    this.usage.cost_usd += ((usage.input_tokens * price.input + usage.output_tokens * price.output) / 1e6) * (batch ? BATCH_DISCOUNT : 1);
  }

  private async askOnce<T>(opts: AskOptions<T>): Promise<T> {
    const response = await this.client.messages.parse({ ...this.params(opts), output_config: { ...this.params(opts).output_config, format: zodOutputFormat(opts.schema) } });
    this.addUsage(response.usage, false);

    if (response.stop_reason === "refusal") {
      throw new Error(`Claude rechazó la solicitud: ${response.stop_details?.explanation ?? "sin detalle"}`);
    }
    if (!response.parsed_output) {
      throw new Error(`Respuesta sin JSON válido (stop_reason=${response.stop_reason})`);
    }
    return response.parsed_output as T;
  }

  // Llamada por Message Batches: la primera vez envía el batch y lanza ClaudePending; las siguientes revisan el batch
  // una sola vez y, cuando terminó, devuelven (y guardan) la respuesta. Si la respuesta no sirve, reenvía una vez.
  private async askBatched<T>(opts: AskOptions<T> & { key: string }): Promise<T> {
    const file = path.join(this.batchDir!, `${opts.key}.json`);
    const record: BatchRecord | null = await readFile(file, "utf8").then((t) => JSON.parse(t), () => null);
    if (record?.result !== undefined) return opts.schema.parse(record.result);

    const submit = async (resubmits: number): Promise<never> => {
      const batch = await this.client.messages.batches.create({ requests: [{ custom_id: customId(opts.key), params: this.params(opts) }] });
      const next: BatchRecord = { key: opts.key, batch_id: batch.id, submitted_at: new Date().toISOString(), state: batch.processing_status, resubmits };
      await mkdir(this.batchDir!, { recursive: true });
      await writeFile(file, JSON.stringify(next, null, 2) + "\n");
      throw new ClaudePending(opts.key, batch.id, batch.processing_status);
    };
    if (!record) return submit(0);

    const batch = await this.client.messages.batches.retrieve(record.batch_id);
    if (batch.processing_status !== "ended") {
      await writeFile(file, JSON.stringify({ ...record, state: batch.processing_status }, null, 2) + "\n");
      throw new ClaudePending(opts.key, record.batch_id, batch.processing_status);
    }
    let problem = "el batch terminó sin respuesta";
    for await (const item of await this.client.messages.batches.results(record.batch_id)) {
      if (item.custom_id !== customId(opts.key)) continue;
      if (item.result.type !== "succeeded") {
        problem = `resultado ${item.result.type}`;
        break;
      }
      const message = item.result.message;
      this.addUsage(message.usage, true);
      if (message.stop_reason === "refusal") throw new Error(`Claude rechazó la solicitud: ${message.stop_details?.explanation ?? "sin detalle"}`);
      const text = message.content.find((b) => b.type === "text")?.text ?? "";
      try {
        const parsed = opts.schema.parse(JSON.parse(text));
        await writeFile(file, JSON.stringify({ ...record, state: "ended", result: parsed }, null, 2) + "\n");
        return parsed;
      } catch (err) {
        problem = `respuesta sin JSON válido (${err instanceof Error ? err.message.slice(0, 200) : String(err)})`;
      }
      break;
    }
    if (record.resubmits >= 1) {
      await rm(file, { force: true });
      throw new Error(`Claude batch (${opts.key}): ${problem}`);
    }
    return submit(record.resubmits + 1);
  }
}

// custom_id de Message Batches: hasta 64 caracteres [a-zA-Z0-9_-].
function customId(key: string) {
  const clean = key.replace(/[^a-zA-Z0-9_-]+/g, "_");
  return clean.length <= 64 ? clean : `${clean.slice(0, 50)}_${createHash("sha1").update(key).digest("hex").slice(0, 12)}`;
}

// Llamadas en batch que siguen esperando respuesta en <dir>.
export async function pendingClaudeBatches(dir: string): Promise<Array<{ key: string; batch_id: string; state: string; submitted_at: string }>> {
  const files = await readdir(dir).catch(() => [] as string[]);
  const out = [];
  for (const f of files.filter((x) => x.endsWith(".json"))) {
    const r: BatchRecord = JSON.parse(await readFile(path.join(dir, f), "utf8"));
    if (r.result === undefined) out.push({ key: r.key, batch_id: r.batch_id, state: r.state, submitted_at: r.submitted_at });
  }
  return out;
}

// Estado actual de un batch de Claude (para el panel): in_progress, canceling o ended.
export async function claudeBatchState(batchId: string, client = new Anthropic()): Promise<string> {
  return (await client.messages.batches.retrieve(batchId)).processing_status;
}
