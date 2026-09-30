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

Prioridad definida por Diego: vertical 4:5 (1080×1350), calidad decente (no la máxima) y **modelos que parezcan
personas reales**.

1. **Principal: FLUX.2 Pro.** Es el más fuerte en fotorrealismo de personas y de los más baratos a 1080×1350
   (~$0.05–0.07 por imagen con la foto del bordado como referencia; ~$0.60–0.80 por diseño). Hasta 8 referencias:
   foto del bordado + primera toma generada para mantener el mismo modelo.
2. **Respaldo: Gemini 3.1 Flash Image**, cuando FLUX no reproduzca bien el bordado (~$0.10 por imagen).
3. Se descartan Gemini 3 Pro Image (más caro de lo necesario) y GPT Image 2 queda solo en la prueba comparativa.
3. Implementar el Generador detrás de una interfaz `generate({ prompt, referenceImages, size, seed })` para cambiar de
   proveedor por config sin tocar los agentes.

## Prueba antes de decidir (bake-off)

- 5 diseños variados (lettering, personaje, minimalista, multicolor, detalle fino) × 3 colores × 3 tomas.
- Correr Gemini 3.1 Flash Image, FLUX.2 Pro y GPT Image 2 con los mismos prompts.
- Puntuar con el agente de QA (fidelidad, aspecto bordado, color, anatomía, consistencia) + revisión visual de Diego.
- Elegir por: % aprobado en el primer intento, costo por diseño aprobado y tiempo.

Fuentes: ai.google.dev/gemini-api/docs/image-generation, openrouter.ai/black-forest-labs/flux.2-pro,
buildmvpfast.com/api-costs/ai-image, unifically.com/blogs/gpt-image-2.
