# xdope-product-agents

Agentes que convierten un diseño de bordado en un producto listo en la tienda xDope:
foto del bordado → análisis → prompts → mockups generados (≥3 colores × ≥3 fotos) → QA → textos → borrador en la tienda.

Las fotos de `1. JUST PHOTOS of all designs` son **solo el insumo**: no se suben a la tienda.
Lo que se publica son los mockups generados por una API de generación de imágenes, con prompts que
un agente escribe a partir de cada foto.

## Flujo

Un orquestador corre el pipeline de forma automática (por ejemplo, `batch.designsPerRun` diseños por ejecución
programada) hasta dejar el producto creado como inactivo:

```
[1 Inventario] → [0 Curador creativo: elige la imagen, título y descripción corta]
      → [2 Analista visual] → [3 Director de arte (prompts)] → [4 Generador de mockups]
      → [5 QA visual] ⟲ (regenera hasta N veces) → [6 Copywriter/SEO] → [7 Publicador]
      → producto en la tienda con status 0 (inactivo) → ✋ Diego lo activa en el dashboard
```

Los diseños que fallan QA o tienen riesgo de propiedad intelectual se saltan y quedan registrados en el catálogo.

Detalle de cada agente, tareas, entradas/salidas y criterios de aceptación: [`docs/agentes.md`](docs/agentes.md).
Contrato de datos entre agentes: [`docs/contratos.md`](docs/contratos.md).

## Resultado esperado por diseño

- Carpeta `output/<id>/` con `brief.json`, `analysis.json`, `prompts.json`, `mockups/`, `qa.json`, `copy.json`, `publish.json`.
- Mínimo **3 colores de prenda × 3 tomas** (modelo frontal, detalle del bordado, prenda sola) = 9 imágenes aprobadas por QA.
- Producto `classified` en xDope: variantes Color × Talla, imágenes por color, SEO completo, con el título y la descripción corta del Curador creativo.

## Fuentes de diseños

Configurables en `config/config.json` (`catalog.photoDirs`, `catalog.designDirs`). Por defecto:

- Fotos: `C:\Users\Diego Benavides\Desktop\Embroidery supper pack\1. JUST PHOTOS of all designs` (2.786 fotos, nombre = ID).
- Archivos de máquina: `...\2. Embroidery Designs` (carpetas `<id> [nombre]` con DST/PES/JEF/…).

**Agregar diseños nuevos:** copia la imagen en cualquier subcarpeta de `photoDirs` (sugerido `NUEVOS/`) o agrega
otra carpeta a `photoDirs`. En el siguiente `npm run scan` entra al catálogo; si el nombre no es numérico se le asigna
el siguiente ID libre.

## Uso

```bash
npm install
cp config/config.example.json config/config.json   # ajustar rutas, precios, colores
cp .env.example .env                               # llenar claves
npm run scan                                       # genera data/catalog.json
```


## Probar el flujo

```bash
npm install
cp .env.example .env        # ANTHROPIC_API_KEY y GEMINI_API_KEY (XDOPE_* solo para publicar)
npm run scan
npm run pipeline -- --design 10 --realtime   # prueba rápida: todo seguido, precio completo
npm run pipeline -- --designs 3              # modo batch (50 % menos): envía el lote del Curador
npm run pipeline -- --collect-only           # recoge lotes terminados y envía el paso siguiente
npm run pipeline -- --status                 # en qué paso va cada diseño y qué lotes siguen abiertos
npm run pipeline -- --publish                # crea como INACTIVOS los productos listos (usar QA primero)
```

**Modo batch** (`pipeline.mode`, por defecto): cada ejecución recoge los lotes terminados de Claude y Gemini, avanza
cada diseño y envía el lote del paso siguiente. Un diseño pasa por ~7 lotes (curador, análisis, prompts, imágenes,
QA, imágenes del resto de colores con la misma persona, QA, textos). Los lotes suelen tardar menos de 1 h (máx. 24 h),
así que con `--collect-only` programado cada 1–3 h un diseño queda listo en el día.

Resultados en `output/<id>/` (`brief.json`, `analysis.json`, `prompts.json`, `state.json`, `mockups/`, `copy.json`).
Si algo falla, repetir el comando continúa desde el último paso guardado.
