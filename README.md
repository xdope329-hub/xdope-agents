# xdope-agents

Sistema de agentes que convierte una foto de un bordado en un producto listo en la tienda xDope: 3+ colores × 3+ mockups generados con IA, ficha completa y producto creado inactivo para que Diego lo active.

- Specs: [`specs/README.md`](specs/README.md)
- Plan técnico: [`plan.md`](plan.md)

## Desarrollo
```
npm install
cp .env.example .env
npm run typecheck && npm test
```

## Escanear la carpeta de bordados (en el PC de Diego)
1. Copia `.env.example` a `.env` y deja `DESIGNS_DIR` apuntando a la carpeta de fotos.
2. Corre `npm run scan`.
3. El comando lista los diseños nuevos, los renombrados, los que ya no están y los duplicados. El catálogo queda en `designs.json`. La carpeta de fotos nunca se modifica.

Para agregar un diseño nuevo basta con copiar su foto (JPG, PNG o WebP) en esa carpeta o en una subcarpeta y volver a escanear.

## Programar ejecuciones
1. Copia `schedule.example.json` a `schedule.json`.
2. Ajusta `timezone`, los días (`lun` a `dom`) y las horas (`HH:MM`) de cada tarea.
3. Corre `npm run schedule:preview` para ver las próximas ejecuciones.

## Prueba de los agentes (sin publicar en la tienda)
Corre Curador → Director de arte → generación con Gemini → QA y deja las fotos 1080×1350 con un `review.html`.

- **En GitHub:** pestaña Actions → "Prueba de agentes" → Run workflow. Pega URLs de fotos de bordados separadas por coma, o deja vacío para usar las fotos de `samples/`. Necesita los secrets `ANTHROPIC_API_KEY` y `GEMINI_API_KEY`. El resultado se descarga como artefacto `resultados-prueba`.
- **En tu PC:** `npm run trial -- "ruta/a/bordado.jpg"` con las claves en `.env` (`node --env-file=.env` o variables de entorno).

Costo aproximado por diseño: USD 1–1.5 en imágenes (Nano Banana 2 a 2K, reintento con Nano Banana Pro) más unos centavos de Claude.
