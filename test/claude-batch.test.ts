import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { Claude, ClaudePending, pendingClaudeBatches } from "../src/llm/claude.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "claude-batch-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const schema = z.object({ title: z.string() });

// Cliente falso de Message Batches: `answers` es lo que devuelve cada batch al terminar, en orden.
function fakeClient(answers: string[]) {
  const state = { status: "in_progress" as "in_progress" | "ended", created: [] as Array<{ custom_id: string; params: Record<string, unknown> }> };
  const client = {
    messages: {
      batches: {
        create: async ({ requests }: { requests: Array<{ custom_id: string; params: Record<string, unknown> }> }) => {
          state.created.push(requests[0]);
          return { id: `msgbatch_${state.created.length}`, processing_status: "in_progress" };
        },
        retrieve: async () => ({ processing_status: state.status }),
        results: async (id: string) =>
          (async function* () {
            const i = Number(id.split("_")[1]) - 1;
            yield {
              custom_id: state.created[i].custom_id,
              result: { type: "succeeded", message: { usage: { input_tokens: 1000, output_tokens: 100 }, stop_reason: "end_turn", content: [{ type: "text", text: answers[i] }] } },
            };
          })(),
      },
    },
  } as unknown as Anthropic;
  return { client, state };
}

const ask = (claude: Claude) => claude.ask({ system: "s", prompt: "p", images: [], schema, key: "curador-1" });

describe("Claude en batch", () => {
  it("envía, espera, devuelve la respuesta y la guarda; cobra la mitad", async () => {
    const { client, state } = fakeClient(['{"title":"Hoodie"}']);
    const claude = new Claude(client, "claude-sonnet-5-5").withBatch(dir);

    await expect(ask(claude)).rejects.toBeInstanceOf(ClaudePending);
    expect(state.created[0].custom_id).toBe("curador-1");
    expect(state.created[0].params).toMatchObject({ model: "claude-sonnet-5-5", output_config: { format: { type: "json_schema" } } });
    expect(await pendingClaudeBatches(dir)).toMatchObject([{ key: "curador-1", batch_id: "msgbatch_1" }]);

    await expect(ask(claude)).rejects.toBeInstanceOf(ClaudePending);
    state.status = "ended";
    expect(await ask(claude)).toEqual({ title: "Hoodie" });
    expect(claude.usage.cost_usd).toBeCloseTo(((1000 * 2 + 100 * 10) / 1e6) * 0.5);
    expect(await pendingClaudeBatches(dir)).toEqual([]);

    // Ya guardada: no vuelve a llamar ni a cobrar.
    expect(await ask(claude)).toEqual({ title: "Hoodie" });
    expect(state.created).toHaveLength(1);
  });

  it("si la respuesta no es JSON válido la reenvía una vez", async () => {
    const { client, state } = fakeClient(["no es json", '{"title":"Otra"}']);
    const claude = new Claude(client, "claude-sonnet-5-5").withBatch(dir);
    await expect(ask(claude)).rejects.toBeInstanceOf(ClaudePending);
    state.status = "ended";
    await expect(ask(claude)).rejects.toBeInstanceOf(ClaudePending);
    expect(state.created).toHaveLength(2);
    expect(await ask(claude)).toEqual({ title: "Otra" });
  });

  it("sin key la llamada no va en batch", async () => {
    let parsed = 0;
    const client = { messages: { parse: async () => (parsed++, { usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: "end_turn", parsed_output: { title: "x" } }) } } as unknown as Anthropic;
    const claude = new Claude(client, "claude-sonnet-5-5").withBatch(dir);
    expect(await claude.ask({ system: "s", prompt: "p", images: [], schema })).toEqual({ title: "x" });
    expect(parsed).toBe(1);
  });
});
