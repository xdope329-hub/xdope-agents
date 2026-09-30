# API de generación de imágenes — evaluación

Requisitos del caso: usar la foto del bordado como **referencia** (no solo texto), reproducirlo fiel y con aspecto de
puntada, mantener el **mismo modelo/set** en ≥3 tomas por color y generar ≥9 imágenes por diseño a bajo costo.

Precios públicos consultados en septiembre de 2026 (verificar antes de contratar).

| Opción | Referencias | Consistencia de persona | Precio aprox. / imagen | Notas |
|---|---|---|---|---|
| **Gemini 3.1 Flash Image** ("Nano Banana 2") | hasta 14 (6 objetos alta fidelidad) | hasta 4 personas | ~$0.045 (512 px) – $0.15 (4K) | Rápido; se le puede pasar la toma ya generada para mantener el modelo |
| Gemini 3 Pro Image | hasta 14 | hasta 5 personas | $0.134 (1K/2K), $0.24 (4K) | Mayor calidad, 3× más caro |
| **FLUX.2 Pro** (BFL / fal / OpenRouter) | hasta 8 por API | buena con multirreferencia | ~$0.03 por MP de salida + $0.015 por MP de referencia | Fotorrealismo muy alto |
| FLUX.2 Flex | hasta 8 | buena | $0.06 por MP (entrada y salida) | Mejor en detalle fino/texto |
| GPT Image 2 (OpenAI) | edición con imagen | — | $0.03 (1K) – $0.08 (4K) | Fuerte en texto dentro de la imagen |

## Recomendación

1. **Principal: Gemini 3.1 Flash Image.** Acepta la foto del bordado como referencia de objeto y la primera toma
   generada como referencia de persona, que es justo lo que pide "mismo modelo en 3 fotos". Costo estimado por diseño
   (9 imágenes + ~30 % de regeneraciones por QA, a 1–2K): **~$0.6–1.0**.
2. **Alternativa / respaldo: FLUX.2 Pro**, para diseños donde Gemini no reproduzca bien la textura del bordado.
3. Implementar el Generador detrás de una interfaz `generate({ prompt, referenceImages, size, seed })` para cambiar de
   proveedor por config sin tocar los agentes.

## Prueba antes de decidir (bake-off)

- 5 diseños variados (lettering, personaje, minimalista, multicolor, detalle fino) × 3 colores × 3 tomas.
- Correr Gemini 3.1 Flash Image, FLUX.2 Pro y GPT Image 2 con los mismos prompts.
- Puntuar con el agente de QA (fidelidad, aspecto bordado, color, anatomía, consistencia) + revisión visual de Diego.
- Elegir por: % aprobado en el primer intento, costo por diseño aprobado y tiempo.

Fuentes: ai.google.dev/gemini-api/docs/image-generation, openrouter.ai/black-forest-labs/flux.2-pro,
buildmvpfast.com/api-costs/ai-image, unifically.com/blogs/gpt-image-2.
