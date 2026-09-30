# Mapeo del proyecto xDope (solo lectura)

## 1. Stack y estructura
Hay tres repos separados en `Desktop\xDope`. No es un monorepo.

- **xdopestore-api**: Express 4 y Mongoose 8 sobre MongoDB, con Node 20–22.
  - Está alojado en Render. La "API de render" es este backend.
- **admin-dashboard**: Next 15 y React 19, con Formik, react-query y axios.
  - El formulario de producto está organizado en pestañas: General, Imágenes, Opciones, Inventario, SEO, Setup y Bundle.
- **xdopestore-ui**: la tienda, en Next 15 y React 19 (Vercel).
- **Imágenes**: Cloudinary, carpeta `xdope-store`.
  - Formatos aceptados: jpg, png, webp, gif, pdf y zip.
  - Tamaño máximo por archivo: 10 MB.
- **Otros servicios**: MercadoPago, Brevo y Meta Pixel/CAPI.

## 2. Modelo de producto y cómo se crea
Campos del modelo `Product`:

- **Básicos**: name, slug (se genera solo), short_description, description (HTML) y sku.
- **Precio y stock**: price, sale_price, discount, quantity y stock_status.
- **Tipo**: `type` puede ser `simple`, `classified` (con variantes) o `bundle`.
- **Clasificación**: categories[], tags[], brand_id y tax_id.
- **SEO**: meta_*, og_*, canonical y robots.
- **Imágenes** (referencias a `Attachment`): product_thumbnail_id, product_images[], size_chart_image_id y product_meta_image_id.
- **Destacados**: is_featured e is_trending.
- **Variantes** (`variations[]`): name, attribute_value_ids, price, sale_price, quantity, sku, stock_status, status y variation_images[].

Colores y tallas:

- Son documentos `Attribute` con `attribute_values` de la forma `{value, hex_color, slug}`.
- El estilo puede ser `color`, `rectangle`, etc.
- El producto los enlaza con `attributes_ids`.

Estados:

- No existe estado de borrador.
- Solo existe `status`: 1 activo, 0 inactivo. La tienda filtra por `status: 1`.
- `is_approved` vale `true` por defecto.

En los productos `classified`, el precio y el stock del padre se calculan a partir de las variantes.

Flujo actual para crear un producto:

1. Iniciar sesión con `POST /login`, que devuelve un JWT Bearer. El usuario tiene que ser admin o tener el permiso de rol.
2. Subir las imágenes con `POST /attachment` (multipart). Devuelve los ids de `Attachment`.
3. Crear el producto con `POST /product`.
4. Editarlo con `PUT /product/:id`.

También existen `POST /attribute` y `POST /category`.

El payload mínimo está en el test e2e `admin-dashboard/e2e/01-create-product-api.spec.js`.

## 3. API de render
No hay composición de bordados ni proveedores de IA. Busqué openai, replicate, gemini, fal, stability, anthropic, mockup, bordado y embroider, y no aparece ninguno.

La API es la REST de la tienda. El mockup del bordado sobre el hoodie habría que construirlo desde cero.

## 4. Archivos de bordados (en el Escritorio, fuera de xDope)
- **`TOEmbroider/`**: una carpeta por diseño (CALCIFER, Perro/MOPS en varios tamaños).
  - Formatos de máquina: DST, EXP, HUS, JEF, PES, SEW, VP3, XXX y VIP.
  - Cada diseño trae previews en JPG o PNG.
- **Wilcom**: `EMB/Embf/League of Legends collection` y `Dragon.EMB`.
- **`CatEmbroidery.png`**: suelto en el Escritorio.
- **`MockUps-pack/`**: unos 500 mockups JPG, más `Own/` con PNG de hoodies Gildan.
- **`EmbStore/`**: contiene AdminDashboard y xDopeWeb. No la revisé; puede ser una copia antigua.

## 5. Git y variables de entorno (solo nombres)
Remotos en GitHub:

- `xdope329-hub/admin-dashboard`
- `xdope329-hub/xdopestore-api`
- `xdope329-hub/xdopestore-ui`

Variables de la API:

- **Servidor y base de datos**: NODE_ENV, PORT, MONGODB_URI
- **Autenticación**: JWT_SECRET, JWT_EXPIRES_IN, JWT_REFRESH_SECRET, JWT_REFRESH_EXPIRES
- **URLs y CORS**: FRONTEND_URL, CORS_ORIGINS, STORE_URL, BASE_URL
- **Cloudinary**: CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
- **MercadoPago**: MP_ACCESS_TOKEN, MP_SANDBOX
- **Brevo**: BREVO_API_KEY, BREVO_SENDER_EMAIL, BREVO_SENDER_NAME, BREVO_NEWSLETTER_LIST_ID
- **Meta**: META_PIXEL_ID, META_CAPI_ACCESS_TOKEN, META_TEST_EVENT_CODE, META_GRAPH_VERSION
- **Seed**: ADMIN_EMAIL, ADMIN_PASSWORD

Variables del dashboard: API_PROD_URL y NEXT_PUBLIC_API_URL.

Variables de la tienda: API_PROD_URL, NEXT_PUBLIC_SITE_URL, PAYMENT_RETURN_URL, PAYMENT_CANCEL_URL, NEXT_PUBLIC_GA_MEASUREMENT_ID y NEXT_PUBLIC_META_PIXEL_ID.

Hay entornos QA y e2e (`.env.qa` y `.env.e2e`). La base de datos de QA termina en `_qa`.
