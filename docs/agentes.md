# Agentes

Cada agente recibe el JSON del anterior y deja el suyo en `output/<id>/`. Si un agente falla, el pipeline se
detiene en ese diseño y se puede reanudar desde ese paso.

LLM para razonamiento y visión: Claude (API de Anthropic). Generación de imágenes: proveedor configurable
(`imageGen.provider`); requisito: **debe aceptar imagen de referencia** (edición/composición), no solo texto.

## Orquestador (sin LLM)

- Corre programado (o con `npm run pipeline`): ejecuta Inventario, luego el Curador creativo, y encadena los agentes
  2–7 por cada diseño elegido, sin intervención manual.
- Reintenta pasos fallidos, respeta `imageGen.maxCostPerDesignUsd` y registra el resultado de cada diseño en el catálogo.

---

## 0. Curador creativo (inicia el proceso)

- **Rol:** decidir qué diseño se trabaja y darle identidad de producto antes de que actúen los demás agentes.
- **Entrada:** `data/catalog.json` (diseños `pending`), foto(s) de cada candidato, `batch` de la config,
  títulos ya usados en la tienda (`GET /product`) para no repetir.
- **Tareas:**
  1. Elegir `batch.designsPerRun` diseños priorizando: foto nítida, diseño atractivo para hoodie, con archivos de
     máquina disponibles, sin personajes/marcas registradas evidentes y variedad frente a lo ya publicado.
  2. Elegir la **imagen de partida** (principal o una de `extra_photos`), la más clara para usar como referencia.
  3. Redactar el **título del producto** (corto, memorable, en español; sin nombres con copyright).
  4. Redactar una **descripción corta creativa** (1–2 frases, voz de marca xDope).
  5. Marcar el diseño como `in_progress` y pasar el brief al Analista visual.
- **Salida:** `brief.json`.
- **Aceptación:** título único en la tienda, descripción corta ≤ 200 caracteres, imagen de partida existente.
  El Copywriter/SEO y el Publicador usan este título y esta descripción corta tal cual.

## 1. Inventario (sin LLM)

- **Rol:** mantener el catálogo de diseños disponibles.
- **Entrada:** `catalog.photoDirs`, `catalog.designDirs`, `data/catalog.json` previo.
- **Tareas:**
  1. Escanear recursivamente las carpetas de fotos (`.jpg/.jpeg/.png/.webp`).
  2. ID = número del nombre del archivo; si no es numérico, asignar el siguiente ID libre.
  3. Enlazar cada ID con su carpeta de archivos de máquina (`<id> [nombre]`) y los formatos disponibles.
  4. Marcar diseños nuevos y conservar el estado (`pending | in_progress | published | rejected`).
- **Salida:** `data/catalog.json`.
- **Aceptación:** cada foto tiene ID único; una imagen nueva aparece tras re-escanear sin perder estados previos.

## 2. Analista visual

- **Rol:** entender el bordado a partir de su foto.
- **Entrada:** `brief.json` (imagen de partida) + nombre de la carpeta de máquina (si existe).
- **Tareas:**
  1. Describir el motivo (personaje, objeto, estilo, texto visible), colores de hilo y tamaño aparente.
  2. Proponer ubicación en la prenda (pecho izquierdo, centro, espalda) y tamaño en cm.
  3. Elegir **≥3 colores de prenda** de `garment.colors` con buen contraste con los hilos, justificando cada uno.
  4. Detectar riesgos: marcas registradas / personajes con copyright, texto ilegible, foto de baja calidad.
- **Salida:** `analysis.json`.
- **Aceptación:** ≥3 colores válidos del catálogo; si el riesgo de propiedad intelectual es `likely`, el orquestador
  salta el diseño (queda `rejected` con el motivo) y el Curador elige otro.

## 3. Director de arte (prompts)

- **Rol:** escribir los prompts de generación según la imagen y el análisis.
- **Entrada:** `analysis.json`, foto del diseño, `shots` y `style` de la config.
- **Tareas:**
  1. Por cada color × toma, redactar un prompt que describa prenda, color, modelo, pose, fondo, luz y encuadre.
  2. Instruir que el bordado se reproduzca **fiel a la referencia** (forma, colores de hilo, textura de puntada),
     en la ubicación y tamaño del análisis.
  3. Mantener consistencia: mismo modelo/set dentro de un color (misma descripción de persona, fondo y luz;
     semilla fija si el proveedor la soporta).
  4. Incluir prompt negativo (texto inventado, logos extra, manos deformes, bordado impreso/plano).
- **Salida:** `prompts.json`.
- **Aceptación:** ≥9 prompts (≥3 colores × ≥3 tomas), cada uno con imagen de referencia adjunta.

### Tomas mínimas (configurables)

| Toma | Descripción |
|---|---|
| `model_front` | Modelo usando el hoodie, frontal, estilo lifestyle/estudio |
| `embroidery_closeup` | Primer plano del bordado mostrando textura de hilo |
| `garment_flat` | Prenda sola (flat lay o ghost mannequin), fondo neutro |
| `model_alt` (opcional) | Modelo de perfil/espalda o en otra pose |

## 4. Generador de mockups (sin LLM)

- **Rol:** llamar a la API de imágenes.
- **Entrada:** `prompts.json` + foto del diseño (y, opcional, mockups base de `MockUps-pack/Own`).
- **Tareas:** generar cada imagen, guardar en `output/<id>/mockups/<color>_<toma>_v<n>.png`, registrar costo y semilla,
  exportar versión para tienda (webp/jpg ≤ 10 MB, 4:5 1080×1350 o 1:1 1080×1080 como mínimo).
- **Salida:** imágenes + `generation.json`.
- **Aceptación:** una imagen por prompt; errores de API reintentados con backoff.

## 5. QA visual

- **Rol:** aprobar o rechazar cada mockup comparándolo con la foto original.
- **Entrada:** mockups + foto del diseño + `analysis.json`.
- **Criterios (puntaje 1–5, aprueba con ≥4 en todos):**
  - Fidelidad del bordado (forma, colores de hilo, sin elementos inventados).
  - Aspecto de bordado real (relieve/puntada), no estampado.
  - Color de prenda correcto.
  - Anatomía y prenda sin deformaciones; sin texto ni logos extra.
  - Consistencia entre tomas del mismo color.
- **Tareas:** si rechaza, devuelve motivo concreto al Director de arte para ajustar el prompt y regenerar
  (máx. `qa.maxRetries`). Si se agota, marca el color como fallido y, si quedan <3 colores, marca el diseño para revisión manual.
- **Salida:** `qa.json`.
- **Aceptación:** ≥3 colores con ≥3 tomas aprobadas cada uno.

## 6. Copywriter / SEO

- **Rol:** textos de producto en español (Colombia), voz de marca xDope.
- **Entrada:** `brief.json`, `analysis.json`, colores aprobados, config de marca.
- **Salida (`copy.json`):** `name` y `short_description` copiados del brief, `description` (HTML: diseño, bordado, material, cuidado),
  `tags`, `meta_title` (≤60), `meta_description` (≤155), `og_title`, `og_description`, `slug` sugerido.
- **Aceptación:** sin afirmaciones falsas de material; nombres de personajes con copyright no usados si el análisis los marcó.

## 7. Publicador (sin LLM)

- **Rol:** crear el producto en xdopestore-api.
- **Tareas:**
  1. `POST /login` con el usuario de servicio → JWT.
  2. Subir cada mockup aprobado con `POST /attachment` → ids.
  3. Buscar o crear los valores de los atributos **Color** (con `hex_color`) y **Talla** (`GET/PUT /attribute`).
  4. `POST /product` con `type: "classified"`, `status: 0`, categorías/impuesto de la config,
     `product_thumbnail_id` = `model_front` del primer color, `product_images` = todas,
     `size_chart_image_id` de la config y una variación por Color × Talla con `variation_images` = mockups de ese color.
  5. SKU: `XD-HOOD-<id>-<COLOR>-<TALLA>`.
- **Salida:** `publish.json` con `product_id`, slug y enlace al dashboard; catálogo marcado `published`.
- **Aceptación:** el producto aparece en el dashboard como inactivo con todas las variantes e imágenes.
  Nunca publica con `status: 1`: activar es decisión de Diego.
