// Claude: arma solicitudes con imágenes + salida JSON (esquema Zod), en tiempo real o por Message Batches (50 % menos).
const Anthropic = require('@anthropic-ai/sdk');
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');
const sharp = require('sharp');

let client;
const getClient = () => (client ??= new Anthropic());

// Claude no necesita más de ~1568 px por lado; reducir ahorra tokens.
async function imageBlock(file, maxSide = 1568) {
  const data = await sharp(file).rotate().resize(maxSide, maxSide, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 }).toBuffer();
  return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: data.toString('base64') } };
}

/**
 * spec: { model, system, images?: [{label?, file, maxSide?}], text, schema (Zod), effort? }
 */
async function buildParams({ model, system, images = [], text, schema, effort = 'medium' }) {
  const content = [];
  for (const img of images) {
    if (img.label) content.push({ type: 'text', text: img.label });
    content.push(await imageBlock(img.file, img.maxSide));
  }
  content.push({ type: 'text', text });
  const params = {
    model,
    max_tokens: 16000,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content }],
    output_config: { format: zodOutputFormat(schema) },
  };
  // Haiku 4.5 no admite `effort`.
  if (!model.startsWith('claude-haiku')) params.output_config.effort = effort;
  return params;
}

function parseMessage(message, schema) {
  if (message.stop_reason === 'refusal') throw new Error(`Claude rechazó la solicitud (${message.stop_details?.category ?? 'sin categoría'})`);
  const text = message.content.find((b) => b.type === 'text')?.text;
  if (!text) throw new Error(`Respuesta sin texto (stop_reason=${message.stop_reason})`);
  return schema.parse(JSON.parse(text));
}

async function ask(spec) {
  const message = await getClient().messages.create(await buildParams(spec));
  return parseMessage(message, spec.schema);
}

// items: [{ id, spec }] → id del lote. Los id deben cumplir ^[a-zA-Z0-9_-]{1,64}$.
async function submitBatch(items) {
  const requests = [];
  for (const { id, spec } of items) requests.push({ custom_id: id, params: await buildParams(spec) });
  const batch = await getClient().messages.batches.create({ requests });
  return batch.id;
}

// null si el lote sigue en proceso; si terminó, Map id → { message } | { error }.
async function fetchBatch(batchId) {
  const batch = await getClient().messages.batches.retrieve(batchId);
  if (batch.processing_status !== 'ended') return null;
  const out = new Map();
  for await (const r of await getClient().messages.batches.results(batchId)) {
    out.set(r.custom_id, r.result.type === 'succeeded'
      ? { message: r.result.message }
      : { error: r.result.type === 'errored' ? `${r.result.error?.error?.type ?? 'error'}: ${r.result.error?.error?.message ?? ''}` : r.result.type });
  }
  return out;
}

module.exports = { ask, submitBatch, fetchBatch, parseMessage };
