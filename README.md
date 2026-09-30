# xdope-product-agents

Agentes que convierten un diseño de bordado en un producto listo en la tienda xDope:
foto del bordado → análisis → prompts → mockups generados (≥3 colores × ≥3 fotos) → QA → textos → borrador en la tienda.

Las fotos de `1. JUST PHOTOS of all designs` son **solo el insumo**: no se suben a la tienda.
Lo que se publica son los mockups generados por una API de generación de imágenes, con prompts que
un agente escribe a partir de cada foto.

## Flujo

```
[1 Inventario] → [2 Analista visual] → [3 Director de arte (prompts)] → [4 Generador de mockups]
      → [5 QA visual] ⟲ (regenera hasta N veces) → [6 Copywriter/SEO] → ✋ revisión de Diego
      → [7 Publicador] → producto en la tienda con status 0 (inactivo) → ✋ Diego lo activa en el dashboard
```

Detalle de cada agente, tareas, entradas/salidas y criterios de aceptación: [`docs/agentes.md`](docs/agentes.md).
Contrato de datos entre agentes: [`docs/contratos.md`](docs/contratos.md).

## Resultado esperado por diseño

- Carpeta `output/<id>/` con `analysis.json`, `prompts.json`, `mockups/`, `qa.json`, `copy.json`, `publish.json`.
- Mínimo **3 colores de prenda × 3 tomas** (modelo frontal, detalle del bordado, prenda sola) = 9 imágenes aprobadas por QA.
- Producto `classified` en xDope: variantes Color × Talla, imágenes por color, SEO completo, `status: 0` hasta que Diego lo active.

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

Los agentes 2–7 están especificados; su implementación es el siguiente paso.
