# Plan técnico (fase Plan de SDD)

Deriva de `specs/`. Si algo aquí contradice una spec, manda la spec.

## Decisiones
| Tema | Decisión | Por qué |
|---|---|---|
| Lenguaje | TypeScript sobre Node 20+ | Mismo stack que xdopestore-api y el dashboard |
| Contratos | `zod` en `src/contracts/` | Validación en tiempo de ejecución + tipos |
| Análisis de imagen, prompts, copy y QA de visión | Claude (API de Anthropic) con entrada de imagen | Un solo proveedor de LLM para los agentes de razonamiento |
| Generación de imágenes | Adaptador `ImageProvider`; principal Nano Banana 2 (`gemini-3.1-flash-image`) a 2K, escalamiento a Nano Banana Pro en reintentos, respaldo FLUX.2 [flex] | Decisión de `specs/04`; se confirma con la prueba comparativa 8a |
| Procesamiento de imagen (recorte, máscara, paleta, SSIM, ΔE) | `sharp` + utilidades propias | Corre en Node, sin Python |
| Orquestación | Máquina de estados propia; artefactos en `runs/<run_id>/` | Estados de `specs/01`; reanudable |
| Escaneo de diseños | CLI local en el PC de Diego (`npm run scan`) | La carpeta de fotos vive en su PC |
| Arranque | `schedule.json` con días y horas por tarea (`croner`, con zona horaria); `npm run start` para correr a mano | Todo automático hasta el producto inactivo |
| Tienda | Cliente HTTP de xdopestore-api (`/login`, `/attachment`, `/product`) | Flujo real del mapeo; QA primero |

Umbrales iniciales (se ajustan con la primera corrida real): contraste color de hoodie vs. hilo ΔE ≥ 25 promedio; resto según `specs/02` QA visual.

## Prueba de punta a punta (adelanto)
`npm run trial` y el workflow "Prueba de agentes" corren una versión mínima de Curador, Director de arte, generación y QA sin preparación de diseño avanzada ni publicación, para validar calidad y costo con diseños reales antes de completar las fases.

## Tareas
Cada tarea termina con tests que prueban sus criterios de aceptación.

**Fase 1: base**
1. Contratos zod de todos los JSON de `specs/03`, incluido el mínimo 3 colores × 3 tomas. ✅
2. Configuración (`.env`) validada con zod. ✅
3. Store de lotes: crear `run_id`, guardar y leer artefactos, transiciones de estado válidas. ✅

**Fase 2: diseños**
4. Biblioteca: escaneo de `DESIGNS_DIR`, hash, `designs.json`, detección de nuevos/renombrados/duplicados/faltantes. ✅
5. Subida de diseños nuevos a Cloudinary `xdope-designs/`.
6. Preparación del diseño: recorte, fondo transparente, máscara, paleta, `low_res`.
6b. Curador: elección de diseño, título, descripción corta, `ProductBrief` desde `defaults.json`.

**Fase 3: imágenes**
7. Director de arte: análisis de imagen, elección de ≥ 3 colores con contraste, concepto, `ShotList` con prompts.
8a. Prueba comparativa de APIs: 2 diseños × 3 tomas × {Nano Banana Pro, Nano Banana 2, FLUX.2 [flex]}, puntuada con QA.
8. `ImageProvider` + adaptador Gemini: foto base, edición con referencia, identidad consistente por color.
9. QA visual: fidelidad (SSIM + embeddings), ΔE de hilo y prenda, OCR, revisión de artefactos con visión.
10. Respaldo determinístico (B2) marcado `fallback`.

**Fase 4: tienda**
11. Copywriter.
12. Cliente de xdopestore-api + Publicador (QA), con idempotencia por tag `agent-run:<run_id>`.
13. Resumen del lote `review.html` (fotos, prompts, QA, costo).
13b. Programación por días y horas (`schedule.json`, validación y vista previa). ✅
13c. Proceso programador (`npm run scheduler`) conectado al escaneo y al Curador; despliegue del worker en Render.

**Fase 5: validación**
14. Corrida de punta a punta con 3 diseños reales en QA.
