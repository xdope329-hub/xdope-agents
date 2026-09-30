# Workflow de publicación

```
 [0] Biblioteca detecta diseños nuevos en la carpeta de fotos
              │
              ▼  (horario o `npm run start`, sin intervención)
 [1] Curador ──► elige imagen + título + descripción corta ──► CuratorPick + ProductBrief
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
 [7] Publicador ──► producto INACTIVO (status 0) en xdopestore-api + PublishResult
              │
              ▼
 ◆ ÚNICO PASO HUMANO: Diego revisa el producto (fotos, título, ficha) en el admin-dashboard
   y lo activa (status 1). Si no le gusta, lo deja inactivo o lo borra.
```

## Estados de un lote (`run.status`)
`curated` → `design_ready` → `shots_planned` → `generating` → `qa` → `publishing` → `inactive_created` → `live`
Cualquier estado puede pasar a `failed` (con `error.step` y `error.reason`). Un lote fallido no bloquea los siguientes.

## Orquestación
- Un **orquestador** (no es un agente creativo, es código) mueve el lote entre estados, guarda cada artefacto en `runs/<run_id>/` y reintenta fallas transitorias de API (3 intentos, backoff exponencial).
- Los pasos 4–5 corren por toma en paralelo. El paso 6 corre después de QA porque escribe el alt text de las fotos aprobadas.
- Implementación: `npm run pipeline`. Sin `--publish` el lote se detiene en `qa` con la ficha lista para revisar en `review.html`; con `--resume <run_id> --publish` continúa. Un lote `failed` se reintenta con `--resume`: vuelve al paso donde falló y reutiliza los artefactos ya guardados.

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
  curator.json
  review.html    resumen del lote (fotos, prompts, puntajes de QA, costo)
```

## Programación (días y horas fijas)
Diego define cuándo corre cada tarea en `schedule.json`, sin tocar código:
```json
{
  "timezone": "America/Bogota",
  "slots": [
    { "name": "Escaneo de bordados", "task": "scan", "days": ["lun", "mie", "vie"], "times": ["08:00"] },
    { "name": "Publicación", "task": "publish", "days": ["lun", "mie", "vie"], "times": ["10:00"], "products": 1 }
  ]
}
```
- `task`: `scan` (paso 0, detectar diseños nuevos) o `publish` (el Curador inicia `products` lotes y el flujo sigue solo hasta el producto inactivo).
- `days`: `lun`, `mar`, `mie`, `jue`, `vie`, `sab`, `dom`. `times`: una o varias horas `HH:MM` (24 h) en `timezone`.
- `enabled: false` pausa un horario sin borrarlo.
- Si una ejecución sigue en curso cuando toca la siguiente del mismo horario, la nueva se salta y queda registrado; nunca se solapan.
- En Windows, `npm run schedule:install -- --apply` registra los horarios en el Programador de tareas (`scan` → `npm run scan`, `publish` → `npm run pipeline -- --designs <products> --publish`).
- `npm run schedule:preview` muestra las próximas 10 ejecuciones para comprobar la configuración.

**Dónde corre:** `scan` necesita la carpeta de fotos, así que corre en el PC de Diego. `publish` no depende del PC (los diseños ya están en Cloudinary), así que corre en un servicio siempre encendido; por defecto un *background worker* en Render, donde ya vive xdopestore-api.

**Criterios de aceptación**
- Cambiar `schedule.json` y reiniciar el programador cambia las ejecuciones sin tocar código.
- Las horas se respetan en la zona horaria configurada, incluido el cambio de horario si esa zona lo tiene.
- Un horario con hora o zona horaria inválida impide arrancar con un error claro.

