// Generación de imágenes con Gemini (tiempo real). Devuelve un PNG ya ajustado al tamaño de tienda.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { GoogleGenAI } = require('@google/genai');

let ai;

async function inlinePart(file) {
  const data = await sharp(file).rotate().resize(1536, 1536, { fit: 'inside', withoutEnlargement: true })
    .png().toBuffer();
  return { inlineData: { mimeType: 'image/png', data: data.toString('base64') } };
}

/**
 * @param {object} o
 * @param {string} o.model           p. ej. gemini-3.1-flash-image
 * @param {string} o.prompt
 * @param {string[]} o.referenceImages rutas locales
 * @param {string} o.outFile         .png de salida
 * @param {[number, number]} o.size  [ancho, alto] final
 */
async function generateImage({ model, prompt, referenceImages = [], outFile, size = [1080, 1350] }) {
  ai ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const parts = [{ text: prompt }];
  for (const f of referenceImages) parts.push(await inlinePart(f));

  const res = await ai.models.generateContent({
    model,
    contents: [{ role: 'user', parts }],
    config: {
      responseModalities: ['IMAGE'],
      imageConfig: { aspectRatio: '4:5', imageSize: '2K' },
    },
  });
  const img = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  if (!img) {
    const reason = res.candidates?.[0]?.finishReason ?? res.promptFeedback?.blockReason ?? 'desconocido';
    throw new Error(`Gemini no devolvió imagen (motivo: ${reason})`);
  }
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  await sharp(Buffer.from(img.inlineData.data, 'base64')).resize(size[0], size[1], { fit: 'cover' }).png().toFile(outFile);
  return { outFile, usage: res.usageMetadata ?? null };
}

module.exports = { generateImage };
