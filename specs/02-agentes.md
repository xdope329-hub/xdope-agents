# Agentes

Cada agente tiene una sola responsabilidad, entradas y salidas tipadas y criterios de aceptación que se pueden probar automáticamente.

---

## 0. Biblioteca de diseños (servicio, no agente creativo)
**Rol:** mantener el catálogo de bordados disponibles y detectar los nuevos.
**Fuente principal:** `C:\Users\Diego Benavides\Desktop\Embroidery supper pack\1. JUST PHOTOS of all designs` (fotos de todos los diseños). Se configura como `DESIGNS_DIR`, no queda escrita en el código.
**Agregar diseños nuevos:** Diego copia una o más imágenes (JPG, PNG o WebP) en esa misma carpeta, o en una subcarpeta. No hace falta nada más.
**Cómo funciona**
1. Recorre `DESIGNS_DIR` y calcula un hash del contenido de cada imagen.
2. Las imágenes con hash nuevo se registran en `designs.json` con estado `new`: id, nombre (del archivo), ruta, hash, fecha, miniatura.
3. Un archivo renombrado o movido conserva su id (mismo hash). Un archivo borrado queda como `missing`, no se elimina del catálogo.
4. Si existe un archivo de máquina con el mismo nombre en `TOEmbroider/` (DST, PES, etc.), se enlaza como `machine_file` opcional.
**Dónde corre:** la carpeta está en tu PC, así que el escaneo corre ahí (un script local). Cada diseño nuevo se sube también a Cloudinary en `xdope-designs/` para que el resto del pipeline no dependa de que tu PC esté encendida.
**Salida:** `designs.json` (catálogo) y la lista de diseños `new` para que Diego elija cuál publicar.
**Criterios de aceptación**
- Agregar una imagen a la carpeta y correr el escaneo la muestra como `new` sin tocar configuración.
- Correr el escaneo dos veces seguidas no duplica entradas.
- Imágenes duplicadas con distinto nombre se detectan como el mismo diseño.
- Nunca modifica ni borra archivos de la carpeta de Diego (solo lectura).

## 1. Curador (arranque automático)
**Rol:** iniciar cada lote sin intervención de Diego. Elige el diseño, redacta el título y la descripción corta creativa, **categoriza el producto** y arma el `ProductBrief` para el resto de los agentes.
**Cuándo corre:** en los días y horas de `schedule.json` (tarea `publish`, ver `01-workflow.md`) o con el comando `npm run start`. Cada ejecución inicia `products` lotes (por defecto 1).
**Entradas:** `designs.json`, catálogo actual de la tienda (productos, categorías, atributos), `defaults.json` y `brand-guide`.
**Qué hace**
1. **Elige una imagen** entre los diseños `new` que no tengan producto. Criterios, en orden: no es `low_res`; no se parece a un producto ya publicado (comparación de embeddings de imagen); alterna temas y estilos respecto a los últimos 5 lotes; a igualdad, el más antiguo primero. Guarda el motivo de la elección.
2. **Mira la imagen** con un modelo de visión para entender qué muestra y su estilo.
3. **Redacta el título**: corto, con gancho, ≤ 60 caracteres, que diga que es un hoodie bordado y nombre el diseño. Propone 3 opciones y elige una con su razón.
4. **Redacta la descripción corta creativa**: 1–2 frases, ≤ 160 caracteres, con el tono de marca. Es la que va en `short_description`.
5. **Categoriza el producto** según lo que muestra el diseño (Anime, Animales, Videojuegos, etc.), eligiendo **solo entre las categorías que ya existen en la tienda** (`GET /category`):
   - 1 categoría temática principal y, si aplica, hasta 2 secundarias (ej. un gato de anime: Anime + Animales).
   - Cada una con confianza (0–1) y motivo.
   - Siempre se suman las categorías base de `defaults.json` (ej. Hoodies).
   - Si ninguna categoría existente encaja con confianza ≥ 0.6, usa la categoría de respaldo de `defaults.json` y propone una **categoría nueva** (`suggested_new_category`). Al publicar, si esa categoría no existe en la tienda, el Publicador la crea (`POST /category`, activa, sin padre) y la asigna al producto en lugar del respaldo (decisión de Diego, 2026-09-30). Antes de crear, busca una existente con el mismo nombre (sin importar tildes, mayúsculas ni espacios) para no duplicarla.
6. **Completa el `ProductBrief`** con los valores de `defaults.json` (precio, tallas, categoría, material, stock por variante, ubicación del bordado sugerida) y un `slug` único.
**Salida:** `CuratorPick` (diseño elegido, motivo, opciones de título, título elegido, descripción corta) + `ProductBrief`.
**Criterios de aceptación**
- Nunca elige un diseño que ya tiene producto, ni uno `low_res`.
- Título ≤ 60 caracteres y descripción corta ≤ 160; ninguno inventa materiales, medidas ni licencias que no estén en `defaults.json` o la imagen.
- `slug` único frente al catálogo existente.
- Toda categoría asignada existe en la API; hay exactamente 1 principal y como máximo 2 secundarias.
- Con 10 diseños de ejemplo etiquetados por Diego, la categoría principal coincide en al menos 9.
- Tallas y categoría existen en la API. Si `defaults.json` falta o tiene un id que no existe, el lote falla con un error claro; no inventa valores.
- Si no hay diseños `new` elegibles, termina sin crear lote y lo deja registrado.
- **No descarta diseños por propiedad intelectual.** Muchos diseños son de personajes o franquicias (anime, videojuegos); decidir si se venden es de Diego, no del agente. Si el diseño hace referencia a un personaje o franquicia, lo registra en `franchise_reference` (solo informativo, aparece en el resumen del lote) y sigue normalmente. Lo mismo aplica al Director de arte y a QA.

## 2. Preparación del diseño
**Rol:** dejar el bordado listo para componer sobre una prenda.
**Entradas:** un diseño del catálogo (`design_id`): su foto de `DESIGNS_DIR` y, si existe, su archivo de máquina.
**Fuente principal:** la foto del bordado. Se recorta el bordado, se corrige la perspectiva si la foto está inclinada, se quita el fondo (tela o papel) y se conserva la textura real de hilo, que es la que da realismo al componer.
**Mejora opcional:** si el diseño tiene archivo de máquina (DST, PES, etc.), se renderiza con `pyembroidery` y se usa para validar la forma y la paleta exacta de hilos. Los `.EMB` de Wilcom no se leen fuera de Wilcom.
**Salida:** `DesignAsset`: PNG con fondo transparente ≥ 2000 px (o la resolución máxima de la foto, con upscale), máscara binaria, paleta de hilos (hex), relación de aspecto y tamaño real en cm si se conoce.
**Herramientas:** segmentación y remoción de fondo, corrección de perspectiva, upscale, extracción de paleta, `pyembroidery` opcional.
**Criterios de aceptación**
- Fondo 100 % transparente fuera de la máscara; sin restos de tela o sombra de la foto original.
- Paleta con ≤ 12 colores, cada uno con su hex.
- El PNG recortado, reescalado a 512 px, tiene SSIM ≥ 0.95 con la misma zona de la foto original.
- Si la foto es de baja resolución (< 1000 px en el lado del bordado), se marca `low_res` y se avisa a Diego.

## 3. Director de arte y prompts
**Rol:** mirar el bordado y decidir qué fotos generar y con qué prompt. Es el agente que "establece el prompt de acuerdo a la imagen".
**Entradas:** `ProductBrief`, `DesignAsset` (incluida la foto original del bordado), colores disponibles en la API, `brand-guide`.
**Qué hace**
1. **Analiza la imagen** con un modelo de visión: qué representa el diseño, estilo (anime, gamer, minimalista…), paleta de hilos, tamaño relativo, si tiene texto y dónde va mejor (pecho izquierdo, centro, espalda).
2. **Elige 1 color de hoodie** que contraste bien con la paleta del bordado (contraste de luminancia y ΔE suficientes para que el hilo se lea) y que exista como `attribute_value` en la API. Si Diego ya indicó un color en el brief, se respeta.
2b. **Define ubicación y tamaño del bordado** (constitución, regla 13): `chest_left` pequeño (≤ 12 cm de ancho, típico 8–10 cm) por defecto; `chest_center` solo si el diseño necesita más tamaño (detalle fino, texto o composición ancha), hasta 20 × 20 cm. Guarda `embroidery_size_cm` en el análisis y lo escribe en cada prompt.
3. **Define el concepto visual**: por defecto un **modelo humano realista** (edad, estilo, rasgos, peinado) coherente con el estilo del diseño; flat lay o prenda colgada solo como toma extra, nunca como las 3 fotos de un color. El mismo modelo se usa en todas las fotos del producto.
4. **Arma la `ShotList`**: por cada color, ≥ 3 tomas. Mínimo obligatorio por color: frontal plano medio, 3/4 o lateral, y detalle cercano del bordado.
5. **Escribe el prompt de cada toma** a partir de una plantilla fija más lo que describe la imagen: sujeto, prenda y color, ubicación y tamaño del bordado, descripción del bordado ("bordado de hilo en relieve de <descripción>, respetar exactamente la referencia"), pose, fondo, luz, cámara, y un prompt negativo (sin letras extra, sin estampado plano, sin logos agregados).
   Para que parezca foto real, la plantilla siempre pide: fotografía de producto tomada con cámara real (lente 50–85 mm), luz natural o de estudio suave, textura de piel natural con poros e imperfecciones leves, pelo con mechones sueltos, pliegues reales de la tela de algodón afelpado, poses relajadas; y el negativo excluye: piel de plástico o aerógrafo, estética de render 3D o ilustración, simetría perfecta, manos deformes, ojos vidriosos, fondos borrosos artificiales.
**Salida:** `ShotList` con `concept`, `colors[]` y `shots[]`, cada toma con su `prompt` y `negative_prompt`.
**Criterios de aceptación**
- 1 color y 3 tomas (constitución, regla 12).
- Ubicación `chest_left` o `chest_center` con `embroidery_size_cm` dentro de los límites de la regla 13; cada prompt pide textura de bordado visible (puntadas, brillo del hilo, relieve).
- Cada color elegido tiene contraste suficiente con la paleta del bordado (umbral en el plan técnico).
- Cada prompt menciona el color de la prenda, la ubicación del bordado y la descripción del diseño obtenida del análisis; ninguno inventa elementos que no están en la imagen.
- La ubicación del bordado es visible en el encuadre de cada toma.
- Los prompts se guardan versionados en el lote, para poder repetir o ajustar una toma.

## 4. Generador de mockups
**Rol:** producir las fotos finales con la API de generación de imágenes, usando el prompt del Director de arte y la foto del bordado como referencia. Pipeline detallado en `04-generacion-de-imagenes.md`.
**Entradas:** `ShotList` (una toma, con su prompt), `DesignAsset`, y la imagen de referencia de identidad (modelo o prenda) del color para mantener consistencia.
**Salida:** 2–3 candidatas por toma dentro de `MockupSet`, con metadatos (API, modelo, prompt, semilla, costo).
**Criterios de aceptación**
- Formato de tienda 1080×1350 (4:5). Calidad por lote que elige Diego: **media** y **alta** generan a 2K y se reducen; **baja** (por defecto) genera a 1K y se amplía a 1080×1350 para ahorrar, con menos nitidez (decisión de Diego, 2026-09-30).
- Archivo final JPG o WebP de menos de 10 MB (límite de `POST /attachment`).
- Respeta el tope de costo del lote.
- Nunca devuelve una imagen sin su `meta.json`.
- Las 3+ fotos de un mismo color muestran el mismo modelo o la misma prenda.

## 5. QA visual
**Rol:** filtrar. Es el guardián de la regla 1 de la constitución.
**Entradas:** candidatas de `MockupSet`, `DesignAsset`, `ShotList`.
**Salida:** una imagen `final` por toma + `qa.json` con puntaje y motivos de rechazo.
**Chequeos**
| Chequeo | Método | Umbral |
|---|---|---|
| Fidelidad del bordado | Recorte de la zona del bordado, corrección de perspectiva, comparación con el original (SSIM + distancia de embeddings) | SSIM ≥ 0.80 y embedding ≥ 0.90 |
| Colores de hilo | ΔE entre paleta detectada y paleta del `DesignAsset` | ΔE promedio ≤ 8 |
| Color de hoodie | ΔE contra el color pedido | ≤ 10 |
| Texto inventado | OCR en la zona del bordado; si el original no tiene texto, no debe aparecer texto | 0 caracteres extra |
| Anatomía y artefactos | Revisión con modelo de visión (manos, dedos, cara, ojos, dientes, costuras, cordones, bolsillo canguro) | sin fallas graves |
| **Realismo del modelo** | El modelo de visión puntúa de 1 a 10 "¿pasaría por una foto real de catálogo?" con una rúbrica fija: piel, ojos, pelo, manos, caída de la tela, luz y sombras coherentes, fondo. Justifica cada punto bajo 7 | ≥ 7 |
| Consistencia del modelo | Misma persona que la imagen de identidad (comparación de rostro con el modelo de visión) | misma persona |
| Ubicación | Bordado en la zona pedida | coincide |
| Tamaño | Bordado del tamaño pedido, no gigante (regla 13). El prompt lo da en cm y como % del ancho del pecho | coincide (estricto) |
| Fidelidad (visión) | Puntaje 1–10 del modelo de visión; pequeñas diferencias de tono o detalle fino se toleran (decisión de Diego, 2026-09-30), pero no una cara del diseño deformada o con otra expresión | ≥ 7 |
| Textura de bordado | Se ven puntadas, brillo del hilo y relieve; no parece estampado | visible |

**Criterios de aceptación**
- Rechaza con motivo concreto; si ninguna candidata pasa, pide reintento al paso 4 con el motivo en el prompt (máx. 2 reintentos por toma), luego marca la toma para revisión humana.

## 6. Copywriter
**Rol:** escribir la ficha de producto.
**Entradas:** `CuratorPick` (título y descripción corta ya definidos), `ProductBrief`, `DesignAsset`, `brand-guide`, 2–3 fichas existentes de la tienda como ejemplo de tono.
**Salida:** `ProductListing` (descripción larga en HTML, tags, SEO, alt text). Respeta el título y la descripción corta del Curador; no los reescribe.
**Criterios de aceptación**
- Título ≤ 70 caracteres, meta description ≤ 155.
- Menciona que el diseño es bordado (no estampado) y el material/gramaje del `ProductBrief`.
- No afirma nada que no esté en el brief (materiales, origen, cuidados).
- Idioma(s) según el `brand-guide`.
- Alt text para cada imagen final.

## 7. Publicador
**Rol:** crear el producto en xdopestore-api, inactivo, listo para que Diego lo active.
**Entradas:** `ProductListing`, imágenes finales, `ProductBrief`.
**Salida:** `PublishResult` (id del producto, URL de edición en el admin-dashboard).
**Pasos**
1. `POST /login` con el usuario dedicado de agentes → JWT.
2. Buscar un producto con el tag `agent-run:<run_id>`. Si existe, se actualiza con `PUT /product/:id` en vez de crear otro.
3. `POST /attachment` (multipart) por cada imagen final → ids de `Attachment`.
4. `POST /product` con `type: "classified"`, `status: 0`, `attributes_ids`, `variations[]` (una por color × talla, con `attribute_value_ids`, precio, `sku`, `quantity`, `variation_images[]` del color), `product_thumbnail_id`, `product_images[]`, `categories`, `tags`, y los campos SEO (`meta_*`, `og_*`, `product_meta_image_id`).
5. Leer el producto creado y verificar cada campo contra lo enviado.
El payload se basa en el test e2e `admin-dashboard/e2e/01-create-product-api.spec.js`.

**Criterios de aceptación**
- `status` = 0 al terminar; el producto no aparece en la tienda.
- Variantes = colores × tallas del brief, cada una con precio, SKU único y las fotos de su color.
- Imágenes en el orden de la `ShotList`; la primera es el thumbnail.
- Una segunda corrida con el mismo `run_id` no crea un producto nuevo.
- Corre contra QA mientras el Publicador no tenga 3 lotes correctos (constitución, regla 9).
