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

## Flujo completo (hasta el producto inactivo)
Requiere Node 22 o superior.

```
npm run scan                                         # actualiza designs.json
npm run pipeline -- --designs 1                      # el diseño nuevo más antiguo: Curador → Director → fotos + QA → Copywriter
npm run pipeline -- --design d_3f9a1c                # un diseño del catálogo (o una ruta a una foto)
npm run pipeline -- --resume <run_id> --publish      # crea el producto INACTIVO en XDOPE_API_URL
npm run pipeline -- --status                         # en qué paso va cada lote
```

Cada lote queda en `runs/<run_id>/` (`curator.json`, `shots.json`, `mockups/`, `mockups.json`, `qa.json`, `listing.json`, `brief.json`, `publish.json`, `review.html`). Si algo falla, `--resume` sigue desde el último paso guardado. `--batch` manda las fotos a Gemini Batch (mitad de precio).

Para `--publish`: `XDOPE_API_URL`, `XDOPE_AGENT_EMAIL`, `XDOPE_AGENT_PASSWORD`, `XDOPE_ADMIN_URL` en `.env` y `config/defaults.json` (copia de `config/defaults.example.json` con los ids de la tienda). Los colores elegidos deben existir en el atributo "Color" de la tienda; los agentes no crean colores ni categorías. Usa la API de QA primero.

## Programar ejecuciones
1. Copia `schedule.example.json` a `schedule.json`.
2. Ajusta `timezone`, los días (`lun` a `dom`) y las horas (`HH:MM`) de cada tarea.
3. Corre `npm run schedule:preview` para ver las próximas ejecuciones.
4. En el PC con Windows, `npm run schedule:install` muestra las tareas del Programador de tareas y `npm run schedule:install -- --apply` las crea (`-- --remove` las borra). `scan` corre `npm run scan` y `publish` corre `npm run pipeline -- --designs <products> --publish`; el log queda en `logs/scheduler.log`.

## Prueba de los agentes (sin publicar en la tienda)
Corre Curador → Director de arte → generación con Gemini → QA y deja las fotos 1080×1350 con un `review.html`.

- **En GitHub:** pestaña Actions → "Prueba de agentes" → Run workflow. Pega URLs de fotos de bordados separadas por coma, o deja vacío para usar las fotos de `samples/`. Necesita los secrets `ANTHROPIC_API_KEY` y `GEMINI_API_KEY`. El resultado se descarga como artefacto `resultados-prueba`.
- **En tu PC:** pon `ANTHROPIC_API_KEY` y `GEMINI_API_KEY` en `.env` y corre `npm run trial -- "ruta/a/bordado.jpg"`. El resultado queda en `runs/trial-.../review.html`.

Con `--batch` (`npm run trial -- --batch "ruta.jpg"`) la primera foto sale al momento y las demás van en un batch de Gemini a mitad de precio: el comando se queda esperando y muestra el estado cada vez que cambia. Puede tardar desde minutos hasta horas.

Costo aproximado por diseño: USD 1–1.5 en modo normal, ≈ USD 0.60–0.80 con batch en imágenes (Nano Banana 2 a 2K, reintento con Nano Banana Pro) más unos centavos de Claude.
