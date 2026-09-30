// Generación de imágenes con Gemini, en tiempo real o por Batch API (50 % menos).
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { GoogleGenAI } = require('@google/genai');

let ai;
const getAi = () => (ai ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }));
const STORE_SIZE = [1080, 1350];
const INLINE_BATCH_LIMIT = 15 * 1024 * 1024; // la Batch API acepta ~20 MB de solicitudes en línea

async function inlinePart(file) {
  const data = await sharp(file).rotate().resize(1280, 1280, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 88 }).toBuffer();
  return { inlineData: { mimeType: 'image/jpeg', data: data.toString('base64') } };
}

async function buildRequest({ prompt, referenceImages = [] }) {
  const parts = [{ text: prompt }];
  for (const f of referenceImages) parts.push(await inlinePart(f));
  return {
    contents: [{ role: 'user', parts }],
    config: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '4:5', imageSize: '2K' } },
  };
}

function imageFrom(response) {
  const img = response?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  if (img) return img.inlineData.data;
  const reason = response?.candidates?.[0]?.finishReason ?? response?.promptFeedback?.blockReason ?? 'desconocido';
  throw new Error(`Gemini no devolvió imagen (motivo: ${reason})`);
}

async function saveImage(b64, outFile) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  await sharp(Buffer.from(b64, 'base64')).resize(STORE_SIZE[0], STORE_SIZE[1], { fit: 'cover' }).png().toFile(outFile);
  return outFile;
}

async function generateImage({ model, prompt, referenceImages, outFile }) {
  const res = await getAi().models.generateContent({ model, ...await buildRequest({ prompt, referenceImages }) });
  return saveImage(imageFrom(res), outFile);
}

// items: [{ id, prompt, referenceImages }] → nombres de los lotes creados (se parten para no pasar el límite en línea).
async function submitImageBatch(model, items) {
  const chunks = [[]];
  let size = 0;
  for (const it of items) {
    const req = { ...await buildRequest(it), metadata: { id: it.id } };
    const bytes = JSON.stringify(req).length;
    if (size + bytes > INLINE_BATCH_LIMIT && chunks.at(-1).length) { chunks.push([]); size = 0; }
    chunks.at(-1).push(req);
    size += bytes;
  }
  const names = [];
  for (const [i, src] of chunks.entries()) {
    const job = await getAi().batches.create({ model, src, config: { displayName: `xdope-${Date.now()}-${i}` } });
    names.push({ name: job.name, ids: src.map((r) => r.metadata.id) });
  }
  return names;
}

const DONE = new Set(['JOB_STATE_SUCCEEDED', 'JOB_STATE_FAILED', 'JOB_STATE_CANCELLED', 'JOB_STATE_EXPIRED']);

// null si sigue en proceso; si terminó, Map id → { b64 } | { error }. Las respuestas vienen en el orden de envío.
async function fetchImageBatch(name, ids) {
  const job = await getAi().batches.get({ name });
  if (!DONE.has(job.state)) return null;
  const out = new Map();
  const responses = job.dest?.inlinedResponses ?? [];
  ids.forEach((id, i) => {
    const r = responses[i];
    if (!r) return out.set(id, { error: `lote ${job.state}${job.error?.message ? `: ${job.error.message}` : ''}` });
    if (r.error) return out.set(id, { error: r.error.message ?? 'error' });
    try { out.set(id, { b64: imageFrom(r.response) }); } catch (e) { out.set(id, { error: e.message }); }
  });
  return out;
}

module.exports = { generateImage, submitImageBatch, fetchImageBatch, saveImage };
