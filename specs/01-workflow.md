# Workflow de publicación

```
 [0] Biblioteca detecta diseños nuevos en la carpeta de fotos
              │
              ▼
 Diego elige un diseño + datos mínimos (colores, precio)
              │
              ▼
 [1] Intake ──► ProductBrief
              │
              ▼
 [2] Preparación del diseño ──► DesignAsset (bordado recortado, máscara, paleta de hilos)
              │
              ▼
 [3] Director de arte y prompts ──► ShotList (≥3 colores × ≥3 tomas, con prompt por toma)
              │
              ▼
 [4] Generador de mockups ──► MockupSet (candidatas por toma)
              │
              ▼
 [5] QA visual ──► MockupSet aprobado (o reintento de [4], máx. 2 por toma)
              │
              ├──────────────┐
              ▼              ▼
 [6] Copywriter        (en paralelo con 4–5)
     ──► ProductListing
              │
              ▼
 ◆ GATE HUMANO 1: Diego revisa fotos + ficha en una sola vista
              │  aprobar / pedir cambios (vuelve al paso indicado)
              ▼
 [7] Publicador ──► producto INACTIVO (status 0) en xdopestore-api + PublishResult
              │
              ▼
 ◆ GATE HUMANO 2: Diego activa el producto en el admin-dashboard (status 1)
```

## Estados de un lote (`run.status`)
`intake` → `design_ready` → `shots_planned` → `generating` → `qa` → `awaiting_review` → `publishing` → `inactive_created` → `live`
Cualquier estado puede pasar a `failed` (con `error.step` y `error.reason`) o `changes_requested` (con el paso al que se vuelve).

## Orquestación
- Un **orquestador** (no es un agente creativo, es código) mueve el lote entre estados, guarda cada artefacto en `runs/<run_id>/` y reintenta fallas transitorias de API (3 intentos, backoff exponencial).
- Los pasos 4–5 corren por toma en paralelo. El paso 6 corre en paralelo con 4–5 porque solo depende de `ProductBrief` y `DesignAsset`.

## Estructura de carpetas de un lote
```
runs/<run_id>/
  brief.json
  design/        original.*, embroidery.png, mask.png, design.json
  shots.json
  mockups/       <shot_id>/candidate_<n>.png, final.png, meta.json
  qa.json
  listing.json
  publish.json
  review.html    vista única para el Gate 1
```
