# xdope-agents

Sistema de agentes que convierte una foto de un bordado en un producto listo en la tienda xDope: 3+ colores × 3+ mockups generados con IA, ficha completa y producto creado inactivo para que Diego lo active.

Las fotos de `1. JUST PHOTOS of all designs` son **solo el insumo**: nunca se suben a la tienda. Lo que se publica son los mockups generados.

- Specs (fuente de verdad): [`specs/README.md`](specs/README.md)
- Detalle del pipeline ejecutable: [`docs/agentes.md`](docs/agentes.md), [`docs/contratos.md`](docs/contratos.md)
- Plan técnico: [`plan.md`](plan.md)

## Qué hay en el repo

| Comando | Qué hace | Código |
|---|---|---|
| `npm run pipeline` | Pipeline completo: Curador → Analista → Director de arte → Generador (Gemini) → QA → Copywriter → Publicador | `src/pipeline.cjs`, `src/agents/*.cjs`, `src/lib/*.cjs` |
| `npm run scan` | Inventario de fotos de bordados para el pipeline (`data/catalog.json`) | `src/catalog/scan.cjs` |
| `npm run schedule:install` | Crea las tareas programadas de Windows que corren el pipeline | `src/scheduler/install.cjs`, `scripts/run-pipeline.cmd` |
| `npm run trial` | Prueba rápida de Curador → Director → Gemini → QA con `review.html` (también en GitHub Actions) | `src/cli/trial.ts` |
| `npm run scan:library` | Biblioteca de diseños por hash de contenido (`designs.json`) | `src/designs/library.ts` |
| `npm run schedule:preview` | Muestra las próximas ejecuciones de `schedule.json` | `src/schedule.ts` |

El pipeline (`.cjs`) viene de la carpeta `xdope-product-agents` y es lo que se usa hoy. Los módulos TypeScript tienen los contratos de las specs y la prueba; se irán uniendo en un solo pipeline.

## Instalación (PC de Diego)

```bash
npm install
cp config/config.example.json config/config.json   # rutas, precios, colores
cp .env.example .env                               # ANTHROPIC_API_KEY y GEMINI_API_KEY (XDOPE_* solo para publicar)
npm run scan                                       # genera data/catalog.json
```

**Agregar diseños nuevos:** copia la imagen en cualquier subcarpeta de `catalog.photoDirs` (sugerido `NUEVOS/`). En el siguiente `npm run scan` entra al catálogo; si el nombre no es numérico se le asigna el siguiente ID libre.

## Correr el pipeline

```bash
npm run pipeline -- --design 207 --realtime   # prueba rápida: todo seguido, precio completo
npm run pipeline -- --design 207              # modo batch (50 % menos), avanza un paso por ejecución
npm run pipeline -- --designs 3               # el Curador elige 3 diseños pendientes
npm run pipeline -- --collect-only            # recoge lotes terminados y envía el paso siguiente
npm run pipeline -- --status                  # en qué paso va cada diseño y qué lotes siguen abiertos
npm run pipeline -- --publish                 # crea como INACTIVOS los productos listos (usar la API de QA primero)
```

**Modo batch** (`pipeline.mode`, por defecto): cada ejecución recoge los lotes terminados de Claude y Gemini, avanza cada diseño y envía el lote del paso siguiente. Un diseño pasa por unos 7 lotes. Los lotes suelen tardar menos de 1 h (máx. 24 h), así que con `--collect-only` programado cada 1–3 h un diseño queda listo en el día.

Resultados en `output/<id>/` (`brief.json`, `analysis.json`, `prompts.json`, `state.json`, `mockups/`, `copy.json`, `publish.json`). Si algo falla, repetir el comando continúa desde el último paso guardado.

Propiedad intelectual: con `ipPolicy: "flag"` (por defecto) el riesgo solo se registra; ningún diseño se descarta por eso.

Para publicar se usa el usuario dedicado de los agentes (`XDOPE_AGENT_EMAIL` / `XDOPE_AGENT_PASSWORD`). Si tu `.env` todavía tiene `XDOPE_ADMIN_EMAIL` / `XDOPE_ADMIN_PASSWORD`, siguen funcionando.

## Prueba de los agentes (sin publicar)

- **En GitHub:** pestaña Actions → "Prueba de agentes" → Run workflow. Pega URLs de fotos de bordados separadas por coma, o deja vacío para usar `samples/`. Necesita los secrets `ANTHROPIC_API_KEY` y `GEMINI_API_KEY`. El resultado se descarga como artefacto `resultados-prueba`.
- **En tu PC:** `npm run trial -- [--batch] [--recolor] "ruta/a/bordado.jpg"`. El resultado queda en `runs/trial-.../review.html`. Con `--recolor` cada toma generada aparece junto a su versión teñida por código, para comparar (experimento para bajar el costo de los colores extra).

## Desarrollo

```bash
npm run typecheck && npm test
```

Nunca se suben al repo (es público): `.env`, `config/config.json`, `data/`, `output/`, `runs/`, `logs/` ni imágenes.
