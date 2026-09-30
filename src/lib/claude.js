// Llamada a Claude con imágenes + salida JSON validada por un esquema Zod.
const Anthropic = require('@anthropic-ai/sdk');
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');
const sharp = require('sharp');

let client;

// Claude no necesita más de ~1568 px por lado; reducir ahorra tokens.
async function imageBlock(file, maxSide = 1568) {
  const data = await sharp(file).rotate().resize(maxSide, maxSide, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 }).toBuffer();
  return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: data.toString('base64') } };
}

/**
 * @param {object} o
 * @param {string} o.model
 * @param {string} o.system  instrucciones fijas del agente (se cachean)
 * @param {Array<{label?: string, file: string, maxSide?: number}>} [o.images]
 * @param {string} o.text
 * @param {import('zod').ZodType} o.schema
 */
async function ask({ model, system, images = [], text, schema, effort = 'medium' }) {
  client ??= new Anthropic();
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

  const res = await client.messages.parse(params);
  if (res.stop_reason === 'refusal') throw new Error(`Claude rechazó la solicitud (${res.stop_details?.category ?? 'sin categoría'})`);
  if (!res.parsed_output) throw new Error(`Respuesta sin JSON válido (stop_reason=${res.stop_reason})`);
  return res.parsed_output;
}

module.exports = { ask };
