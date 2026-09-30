# xdope-agents

Sistema de agentes que convierte una foto de un bordado en un producto listo en la tienda xDope: 1 color × 3 mockups generados con IA (bordado de tamaño real, máx. 20 × 20 cm), ficha completa y producto creado inactivo para que Diego lo active.

Las fotos de `1. JUST PHOTOS of all designs` son **solo el insumo**: nunca se suben a la tienda. Lo que se publica son los mockups generados.

- Specs (fuente de verdad): [`specs/README.md`](specs/README.md)
- Detalle del pipeline ejecutable: [`docs/agentes.md`](docs/agentes.md), [`docs/contratos.md`](docs/contratos.md)
- Plan técnico: [`plan.md`](plan.md)

## Qué hay en el repo

| Comando | Qué hace | Código |
|---|---|---|
| `npm run gui` | Panel local (http://127.0.0.1:4646): estados de los lotes, revisar batches con un clic, crear, continuar y publicar | `src/cli/gui.ts` |
| `npm run pipeline` | Pipeline completo: Curador → Director de arte → Gemini + QA → Copywriter → Publicador | `src/cli/pipeline.ts` |
| `npm run scan:library` | Catálogo de diseños por hash (`designs.json`), el que usa `npm run pipeline` | `src/designs/library.ts` |
| `npm run schedule:install` | Registra `schedule.json` en el Programador de tareas de Windows | `src/cli/schedule-install.ts` |
| `npm run schedule:preview` | Muestra las próximas ejecuciones de `schedule.json` | `src/schedule.ts` |
| `npm run trial` | Prueba rápida Curador → Director → Gemini → QA con `review.html` (también en GitHub Actions) | `src/cli/trial.ts` |
| `npm run pipeline:cjs`, `npm run scan` | Pipeline anterior en JS (viene de `xdope-product-agents`, usa `data/catalog.json` y `output/`) | `src/pipeline.cjs`, `src/catalog/scan.cjs` |

Requiere Node 22 o superior. En PowerShell, si `npm` da error de scripts deshabilitados, usa `npm.cmd`.

## Instalación (PC de Diego)

```bash
npm install
cp .env.example .env              # ANTHROPIC_API_KEY, GEMINI_API_KEY, DESIGNS_DIR (XDOPE_* solo para publicar)
npm run scan:library              # genera designs.json
npm run gui                       # abre el panel
```

**Agregar diseños nuevos:** copia la foto en `DESIGNS_DIR` (o una subcarpeta) y vuelve a correr `npm run scan:library`.

## Panel (`npm run gui`)

- **Revisar batches:** consulta a Gemini el estado de cada batch pendiente y lo muestra (en cola, procesando, terminado…). Si alguno terminó, recoge los resultados en segundo plano: QA, reintentos, Copywriter.
- **Recoger y continuar lotes:** lo mismo que `npm run pipeline -- --collect`.
- **Crear:** lanza N lotes nuevos con el diseño nuevo más antiguo del catálogo, con la calidad elegida (baja 1K, media 2K, alta 2K + reintento con Pro). Con "batch" (por defecto) todas las fotos van a Gemini Batch a mitad de precio en tres pasos (primera foto → las otras dos → reintentos); la acción termina enseguida y cada paso se recoge con "Revisar batches".
- Por lote: **Ver review**, **Continuar / Reintentar**, **Publicar (inactivo)** y **Abrir en admin**.

Nada bloquea: cada acción corre `pipeline` como proceso aparte y el panel muestra su log. Solo corre una acción a la vez (también frente a las tareas programadas).

## Correr el pipeline por consola

```bash
npm run pipeline -- --designs 1 --quality baja       # nuevo lote; envía el batch y termina (--realtime para no usar batch)
npm run pipeline -- --collect                        # recoge batches terminados y sigue los lotes en curso
npm run pipeline -- --design d_3f9a1c                # un diseño del catálogo (o una ruta a una foto)
npm run pipeline -- --resume <run_id> --publish      # crea el producto INACTIVO en XDOPE_API_URL
npm run pipeline -- --status                         # en qué paso va cada lote
```

Cada lote queda en `runs/<run_id>/` (`curator.json`, `shots.json`, `mockups/`, `qa.json`, `listing.json`, `brief.json`, `publish.json`, `review.html`). Si algo falla, `--resume` sigue desde el último paso guardado.

Para `--publish`: `XDOPE_API_URL`, `XDOPE_AGENT_EMAIL`, `XDOPE_AGENT_PASSWORD`, `XDOPE_ADMIN_URL` en `.env` y `config/defaults.json` (copia de `config/defaults.example.json`). Los colores deben existir en el atributo "Color" de la tienda; los agentes no crean colores ni categorías. Usa la API de QA primero.

## Prueba de los agentes (sin publicar)

- **En GitHub:** pestaña Actions → "Prueba de agentes" → Run workflow. Pega URLs de fotos de bordados separadas por coma, o deja vacío para usar `samples/`. Necesita los secrets `ANTHROPIC_API_KEY` y `GEMINI_API_KEY`. El resultado se descarga como artefacto `resultados-prueba`.
- **En tu PC:** `npm run trial -- [--batch] "ruta/a/bordado.jpg"`. El resultado queda en `runs/trial-.../review.html`.

## Desarrollo

```bash
npm run typecheck && npm test
```

Nunca se suben al repo (es público): `.env`, `config/config.json`, `data/`, `output/`, `runs/`, `logs/` ni imágenes.
