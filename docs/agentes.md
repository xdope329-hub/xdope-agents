# Agentes

Cada agente recibe el JSON del anterior y deja el suyo en `output/<id>/`. Si un agente falla, el pipeline se
detiene en ese diseño y se puede reanudar desde ese paso.

LLM para razonamiento y visión: Claude (API de Anthropic). Generación de imágenes: proveedor configurable
(`imageGen.provider`); requisito: **debe aceptar imagen de referencia** (edición/composición), no solo texto.

## Orquestador (sin LLM)

- Corre programado (o con `npm run pipeline`): ejecuta Inventario, luego el Curador creativo, y encadena los agentes
  2–7 por cada diseño elegido, sin intervención manual.
- Reintenta pasos fallidos, respeta `imageGen.maxCostPerDesignUsd` y registra el resultado de cada diseño en el catálogo.
- **Programación:** `schedule.runs` define días (`lun…dom`), horas y cuántos diseños por ejecución; además una tarea de
  recolección cada `schedule.collectEveryHours` horas para los lotes. `npm run schedule:install` muestra las tareas;
  `-- --apply` las registra en el Programador de tareas de Windows y `npm run schedule:remove` las borra. El PC debe
  estar encendido (las fotos de diseños son locales); logs en `logs/scheduler.log`.
- **Modo batch (ahorro ~50 %):** los pasos con LLM y la generación de imágenes se envían por lotes (Anthropic Message
  Batches y Gemini Batch API). Cada ejecución: (a) recoge los lotes terminados y avanza esos diseños al siguiente paso,
  (b) envía los lotes nuevos. Un diseño tarda horas en completarse (hasta 24 h por lote), no minutos.
- **Modelos Claude por costo:** Haiku para Copywriter y primer filtro de QA; Sonnet para Curador, Analista, Director de
  arte y QA final. Instrucciones fijas de cada agente con prompt caching.

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
  5. **Categorizar** el producto mirando la imagen:
     - Categoría de prenda fija (`store.categorySlugs`, p. ej. Hoodies).
     - **Una categoría temática principal** de `taxonomy.themes` (Anime, Animales, Videojuegos, …) y hasta una
       secundaria si aplica claramente (p. ej. un gato samurái: Animales + Anime).
     - Tags específicos (tema, estilo, colores del bordado; nombres de franquicia solo como tag interno si el
       riesgo de IP lo permite).
     - Si ningún tema encaja con confianza ≥ 0.7, usar `taxonomy.fallback` y dejarlo anotado.
  6. Marcar el diseño como `in_progress` y pasar el brief al Analista visual.
- **Salida:** `brief.json`.
- **Aceptación:** título único en la tienda, descripción corta ≤ 200 caracteres, imagen de partida existente,
  categoría temática de `taxonomy.themes` con su confianza y justificación.
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
- **Aceptación:** ≥3 colores válidos del catálogo. El riesgo de propiedad intelectual queda registrado; solo descarta
  el diseño si `ipPolicy` es `"reject"` (por defecto `"flag"`: se registra y se continúa).

## 3. Director de arte (prompts)

- **Rol:** escribir los prompts de generación según la imagen y el análisis.
- **Entrada:** `analysis.json`, foto del diseño, `shots` y `style` de la config.
- **Tareas:**
  1. Por cada color × toma, redactar un prompt que describa prenda, color, modelo, pose, fondo, luz y encuadre.
  2. Instruir que el bordado se reproduzca **fiel a la referencia** (forma, colores de hilo, textura de puntada),
     en la ubicación y tamaño del análisis.
  3. Mantener consistencia: mismo modelo/set dentro de un color (misma descripción de persona, fondo y luz;
     semilla fija si el proveedor la soporta).
  4. Incluir prompt negativo (texto inventado, logos extra, manos deformes, bordado impreso/plano, piel de plástico,
     look de render 3D o ilustración).
  5. **Fotorrealismo:** describir la toma como fotografía real (cámara y lente, p. ej. "35 mm, f/2.8", luz natural o de
     estudio, textura de piel natural con poros, cabello con mechones sueltos, pliegues reales de la tela), modelos
     diversos y creíbles de 20–35 años con pose y expresión naturales. Formato vertical 4:5.
  6. Usar uno de los **modelos de la casa** (`houseModels`: fotos de referencia de 4–6 personas generadas y aprobadas
     una sola vez) como referencia de persona, rotándolos entre productos.
- **Salida:** `prompts.json`.
- **Aceptación:** un prompt por color para cada toma con IA (≥3), cada uno con la foto del bordado y el modelo de la
  casa como referencias.

### Tomas mínimas (configurables) y cómo se producen

Solo las fotos con modelo usan la API de imágenes; el resto se hace localmente, sin costo.

| Toma | Descripción | Fuente |
|---|---|---|
| `model_front` | Modelo usando el hoodie, frontal, estilo lifestyle/estudio | API de imágenes (batch) |
| `embroidery_closeup` | Primer plano del bordado mostrando textura de hilo | Recorte de la foto original (es un bordado real) |
| `garment_flat` | Prenda sola, fondo neutro | API de imágenes, con la foto base del color como referencia si existe (`garment.flatBases`); un compositor local queda pendiente porque requiere recortar el fondo del bordado |
| `model_alt` (opcional) | Modelo de perfil/espalda o en otra pose | API de imágenes (batch) |

## 4. Generador de mockups (sin LLM)

- **Rol:** producir las imágenes de cada color.
- **Entrada:** `prompts.json`, foto del diseño, `houseModels`, bases de prenda por color (`garment.flatBases`, p. ej.
  de `MockUps-pack/Own` o fotos propias tomadas una vez por color).
- **Tareas:**
  1. **Tomas con modelo:** enviarlas en lote a `imageGen.provider` (Gemini Batch). Las que QA rechace se regeneran una
     sola vez en tiempo real con `imageGen.fallback` (FLUX.2 Pro).
  2. **Primer plano:** recortar y ajustar el bordado de la foto original a 1080×1350.
  3. **Prenda sola:** componer localmente (Sharp) el bordado recortado sobre la base del color, con máscara, sombra
     suave y relieve para simular puntada, en la ubicación y tamaño del análisis. Es liviano; corre en cualquier PC.
  4. Guardar en `output/<id>/mockups/<color>_<toma>_v<n>.png`, registrar costo y exportar versión para tienda
     (webp/jpg ≤ 10 MB, 4:5 1080×1350 como mínimo).
- **Salida:** imágenes + `generation.json`.
- **Aceptación:** ≥3 tomas por color; errores de API reintentados con backoff.

## 5. QA visual

- **Rol:** aprobar o rechazar cada mockup comparándolo con la foto original.
- **Entrada:** mockups + foto del diseño + `analysis.json`.
- **Criterios (puntaje 1–5, aprueba con ≥4 en todos):**
  - Fidelidad del bordado (forma, colores de hilo, sin elementos inventados).
  - Aspecto de bordado real (relieve/puntada), no estampado.
  - Color de prenda correcto.
  - Anatomía y prenda sin deformaciones; sin texto ni logos extra.
  - **Realismo del modelo:** debe parecer una foto de una persona real. Rechazar si hay piel plastificada o demasiado
    lisa, ojos o dientes raros, manos con dedos de más o fusionados, cabello "pintado", iluminación incoherente o fondo
    que se funde con la persona. El QA revisa la imagen a resolución completa y hace zoom a cara, manos y bordado.
  - Consistencia entre tomas del mismo color.
- **Tareas:** si rechaza, devuelve motivo concreto al Director de arte para ajustar el prompt y regenerar
  (máx. `qa.maxRetries`). Si se agota, marca el color como fallido y, si quedan <3 colores, el diseño queda `rejected`
  y el Curador elige otro (hay más de 2.700 diseños; no vale la pena insistir con uno difícil).
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
  4. Resolver las categorías del brief contra `GET /category` (por slug). Si una categoría temática de
     `taxonomy.themes` aún no existe en la tienda, crearla con `POST /category` como hija de la categoría de prenda.
     Solo se crean categorías de esa lista; nunca nombres inventados.
  5. `POST /product` con `type: "classified"`, `status: 0`, `categories` = prenda + temáticas, `tags` del brief,
     impuesto de la config,
     `product_thumbnail_id` = `model_front` del primer color, `product_images` = todas,
     `size_chart_image_id` de la config y una variación por Color × Talla con `variation_images` = mockups de ese color.
  6. SKU: `XD-HOOD-<id>-<COLOR>-<TALLA>` en el pipeline anterior; el pipeline actual usa `XD-<número>-<COLOR>-<TALLA>` (ver specs/02-agentes.md).
- **Salida:** `publish.json` con `product_id`, slug y enlace al dashboard; catálogo marcado `published`.
- **Aceptación:** el producto aparece en el dashboard como inactivo con todas las variantes e imágenes.
  Nunca publica con `status: 1`: activar es decisión de Diego.
