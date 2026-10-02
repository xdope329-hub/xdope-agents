# Generación de imágenes: APIs y pipeline

## El problema real
Generar una persona realista con un hoodie es fácil hoy. Lo difícil es que **el bordado salga idéntico al tuyo**: los modelos generativos tienden a "reinterpretar" logos, cambiar letras, simplificar detalles y perder la textura de hilo. Por eso el pipeline separa *la foto* de *el bordado* y mide la fidelidad antes de aceptar nada.

## Opciones comparadas (precios consultados el 2026-09-30)

| API | Modelo | Precio por imagen | Referencias por llamada | Resolución máx. | Para nuestro caso |
|---|---|---|---|---|---|
| **Google Gemini** | Nano Banana Pro (`gemini-3-pro-image`) | ≈ USD 0.134 (1K/2K), ≈ 0.24 (4K) | 6 de objeto + 5 de personaje + 3 de estilo | 4K | **Recomendada.** Google la posiciona para consistencia de marca y de personaje: el bordado va como referencia de objeto y el modelo como referencia de personaje |
| Google Gemini | Nano Banana 2 (`gemini-3.1-flash-image`) | USD 0.101 (2K); 0.0505 en batch | 10 de objeto + 4 de personaje | 4K | Más barata; candidata si Pro no rinde lo suficiente más |
| Black Forest Labs | FLUX.2 [flex] / [pro] / [max] | USD 0.03–0.07 por megapíxel | 8 por API | 4 MP | Muy fotorealista; [flex] "preserva detalles pequeños" y acepta color exacto en hex. **Respaldo** |
| OpenAI | GPT Image 2 (alta calidad) | USD 0.165–0.211 | varias | 1536 px | Buena con texto; su formato vertical es 1024×1536, así que el lado corto queda por debajo de 1080 px y habría que ampliar. Es la más cara en calidad alta. Su API se paga aparte de ChatGPT Plus/Pro |
| ByteDance | Seedream 4.x | similar a las anteriores vía revendedores | multi-referencia | 4K | Sin API oficial directa simple; descartada por ahora |

Notas: todas las imágenes de Gemini llevan la marca de agua invisible SynthID (no se ve en la foto). Los precios cambian seguido: se vuelven a verificar antes de pasar a producción.

Fuentes: [precios Gemini API](https://ai.google.dev/gemini-api/docs/pricing), [modelos de imagen Gemini](https://ai.google.dev/gemini-api/docs/image-generation), [precio Nano Banana Pro](https://www.pixmind.io/posts/nano-banana-pro-pricing-guide-2026), [FLUX.2](https://docs.bfl.ai/flux_2/flux2_overview), [OpenAI imágenes](https://costgoat.com/pricing/openai-images), [comparativa julio 2026](https://www.buildmvpfast.com/api-costs/ai-image).

## Decisión
Diego pidió (2026-09-30): fotos verticales 1080×1350, calidad decente sin ser la máxima, y modelos que parezcan personas reales.
- **Principal: Nano Banana 2 (`gemini-3.1-flash-image`) a 2K.** Calidad suficiente para 1080×1350 a ≈ USD 0.10 por imagen, con referencias de objeto (bordado) y de personaje (modelo).
- **Modelo y reintento según la calidad del lote** (económica por defecto, ver "Reducción de costo"). Nano Banana Pro solo entra en la calidad alta.
- **Respaldo de proveedor: FLUX.2 [flex]**, con el mismo adaptador `ImageProvider`, si Gemini falla o no convence en la prueba.
- **La decisión se confirma con una prueba comparativa** (tarea 8a del plan): 2 diseños reales × 3 tomas × {Nano Banana Pro, Nano Banana 2, FLUX.2 [flex]}, medidos con los umbrales del QA visual. Gana la de mayor tasa de aprobación; a igualdad, la más barata.

## Flujo por llamada con multi-referencia
Con estos modelos ya no hace falta generar primero un hoodie liso y después editarlo: cada toma se genera en una sola llamada con
1. la foto del bordado recortada (referencia de objeto),
2. la imagen de identidad del modelo o prenda (referencia de personaje), generada una vez por producto,
3. el prompt y el prompt negativo del Director de arte.
La edición con máscara queda para los reintentos cuando QA detecta que el bordado salió mal.

## Lo que ya tienes y cambia el plan
- **Fotos reales de cada bordado** (`1. JUST PHOTOS of all designs`): el recorte conserva la textura de hilo real, así que la ruta determinística no se ve como un PNG pegado. Es también la referencia contra la que QA mide la fidelidad.
- **Archivos de máquina** (DST, PES, etc. en `TOEmbroider/`), cuando existen: validan la forma y los colores exactos de hilo.
- **Nada de IA en xdopestore-api**: todo el pipeline de imágenes es nuevo y vive en el servicio de agentes, no en la API de la tienda. La API solo recibe las imágenes finales por `POST /attachment` (Cloudinary, máx. 10 MB).

## Pipeline por producto
Las fotos finales **se generan con la API de imágenes** (Nano Banana 2, con escalamiento a Pro), con el prompt del Director de arte. La composición determinística queda solo como **respaldo** para una toma que no pase QA de fidelidad después de los reintentos; esas imágenes se marcan `fallback`.

```
Producto
   │
   ▼
A. Imagen de identidad: el modelo (o la prenda) definido en el concepto, generado una vez
   │
   ▼  por cada toma (1 color × 3 tomas), en paralelo
B. Generación multi-referencia: bordado recortado (objeto) + identidad (personaje)
   + prompt y prompt negativo → 2 candidatas
   │
   ▼
C. QA visual mide cada candidata contra el bordado original
   ├─ pasa → final
   └─ falla → reintento: edición con máscara sobre la zona del bordado, con el
      motivo del rechazo en el prompt (máx. 2)
             └─ sigue fallando → B2 determinística (warp del recorte de la foto
                del bordado sobre la prenda), marcada `fallback`
```

**Por qué así**
- Una sola llamada por toma es más barata y rápida que generar una base y luego editarla.
- La referencia de personaje mantiene el mismo modelo en las fotos de cada color y entre colores.
- El respaldo B2 garantiza que nunca falte una foto fiel, aunque la IA falle.

## Fase 2 (cuando el flujo funcione)
Entrenar un **LoRA de FLUX con 20–40 fotos reales** de tus hoodies bordados. Eso enseña al modelo cómo se ve *tu* puntada y sube la tasa de aprobación en el primer intento.

## Interfaz común (para cambiar de proveedor sin tocar agentes)
```
generate(prompt, negative_prompt, object_refs[], character_refs[], size, seed) -> Image
edit(image, mask, prompt, object_refs[], seed) -> Image
```
Cada proveedor es un adaptador. El proveedor activo se elige por configuración, no en el código de los agentes.

## Costo estimado por producto
1 imagen de identidad + 9 tomas + ~30 % de reintentos ≈ 13 llamadas, a 2K, reducidas a 1080×1350.
- Solo Nano Banana 2: ≈ USD 1.30 por producto.
- Con escalamiento a Pro en ~1 de cada 9 tomas: ≈ USD 1.40.
- Solo Nano Banana Pro: ≈ USD 1.75.
Todas quedan bajo el tope de USD 3 de la constitución; se confirma con la prueba comparativa.

## Reducción de costo (aprobada por Diego el 2026-09-30)
1. **Batch API de Gemini (50 % menos), para todo.** Todas las imágenes van en batch, también la primera foto y los reintentos: primero la foto que fija a la persona modelo, luego las otras dos con esa identidad y, si QA rechaza alguna, un batch de reintentos (1 por foto). Nano Banana 2 a 2K baja a ≈ USD 0.05 por imagen. Los resultados llegan en minutos u horas; el lote espera en estado `generating` y se recoge con `--collect` o con el panel.
   Calidad por lote: **económica** (por defecto desde 2026-10-02, aprobada por Diego en pruebas) Nano Banana original `gemini-2.5-flash-image`, ~1K, ≈ USD 0.02 por imagen en batch, más débil en fidelidad del bordado y en mantener la persona; **baja** 1K con reintento Flash; **media** 2K con reintento Flash; **alta** 2K con reintento Nano Banana Pro.
   Los agentes de Claude usan Claude Sonnet 5.5 por costo (`CLAUDE_MODEL` lo cambia).
2. **Modelos de la casa.** En vez de inventar un modelo por producto, se mantiene un elenco fijo de 3–4 personas (`models/` con su imagen de identidad aprobada por Diego). El Director de arte elige uno según el estilo del diseño. Ahorra la imagen de identidad por producto y da una cara de marca consistente.
3. **Menos reintentos.** Antes de generar, el Director de arte valida el prompt contra una lista de errores conocidos, y QA corre primero los chequeos baratos (OCR, color, SSIM) y solo después el modelo de visión. Meta: bajar reintentos de ~30 % a ~15 %.
Estimado con las tres: ≈ 10–11 imágenes × USD 0.05 ≈ **USD 0.55 por producto** (≈ USD 16 por 30 productos), más el escalamiento a Pro cuando haga falta (también en batch).

5. **Ahorros en Claude (aprobados por Diego el 2026-10-02).** Con la calidad económica, Claude pasó a ser la mayor parte del costo por producto.
   - **Claude en batch** (Message Batches, 50 % menos): Curador, Director, QA y Copywriter envían su llamada en batch y el lote espera hasta la siguiente corrida (`--collect` o "Revisar batches" en el panel). Cada llamada queda en `runs/<lote>/claude/<key>.json`. Se apaga con `--realtime` o `CLAUDE_USE_BATCH=false`. Un producto necesita más rondas de recogida (≈ 7), cada una de minutos a pocas horas.
   - **QA por etapa en una sola llamada:** las fotos de la misma etapa (primera foto, las 2 restantes, los reintentos) se revisan juntas; la referencia del bordado, la identidad y la guía van una sola vez.
   - **Director en esfuerzo `medium`** en vez de `high`.
   - No se usa caché de prompts: con batch las llamadas quedan separadas por minutos u horas y el caché (5 min) casi nunca se aprovecharía; escribirlo cuesta 25 % más.

4. **Generar a 1K (aprobado por Diego el 2026-10-02).** Nano Banana 2 a 1K cuesta USD 0.067 (0.0335 en batch) contra 0.101 a 2K; en 4:5 sale de unos 928×1152 y se amplía a 1080×1350. Es la calidad **baja**; la **económica** también sale a ~1K.

## Experimento: recoloreado sin IA (aprobado para prueba el 2026-10-02)
Objetivo: poder ofrecer más de un color (la regla 12 fija 1 color generado) sin pagar más fotos. Las 3 fotos se generan en el color del producto; Gemini devuelve una máscara de la tela (1 imagen por foto) y el código tiñe la tela a otros colores conservando luces y sombras (`src/images/recolor.ts`). Solo se tiñen píxeles dentro de la máscara y con croma cercano al color base, para no tocar el bordado.
- En el panel, **Recolorear (preview)** en un lote ya generado tiñe sus fotos finales a los colores de la tienda elegidos y deja `recolor.html` para comparar (`npm run recolor -- <lote> [--colors A,B]`). Las máscaras se guardan y se reutilizan.
- Diego elige en el panel qué colores teñidos se publican (`extra-colors.json`). El Publicador los agrega como variantes extra (todas las tallas) con sus fotos teñidas, después del color generado; si el producto ya existe, lo actualiza (mismo producto, tag `agent-run`).
- Se prueba con `npm run trial -- --recolor [Color1,Color2] <fotos>` (sin lista, usa los 2 colores de la paleta más distintos al generado): `review.html` muestra cada foto generada y al lado sus versiones teñidas, con su puntaje de QA.
- Costo si se adopta: 3 máscaras por producto (≈ USD 0.06 en económica en batch), sin importar cuántos colores extra tenga.
- Riesgo: teñir desde un hoodie oscuro sale peor que desde uno claro; colores oscuros teñidos desde uno claro pueden verse menos reales, y un bordado de hilos grises o blancos puede quedar dentro de la máscara. Solo pasa al pipeline si Diego aprueba el resultado de la prueba; las fotos teñidas pasan por el mismo QA.

**Opción a evaluar en la prueba:** FLUX.2 [pro] (≈ USD 0.03 por megapíxel) queda en un rango parecido. **Descartado:** FLUX.2 [klein] local, porque la GPU de Diego no alcanza (2026-09-30).
