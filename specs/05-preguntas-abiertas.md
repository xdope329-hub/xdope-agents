# Preguntas abiertas para Diego

Resueltas (2026-09-30, ver `contexto-xdope.md`): la tienda es propia (xdopestore-api + admin-dashboard + xdopestore-ui). La fuente de bordados es la carpeta de fotos `Embroidery supper pack\1. JUST PHOTOS of all designs`, y los diseños nuevos se agregan copiando imágenes ahí.

Pendientes (entre paréntesis el default que asumen las specs):

1. **¿Dónde vive el código de los agentes?** (Repo nuevo `xdope329-hub/xdope-agents`, separado de la tienda. Para trabajarlo desde aquí hay que instalar la app de Claude en GitHub para la organización `xdope329-hub`).
2. **Usuario de agentes en la API.** (Crear un rol con permisos solo de attachments, productos y lectura de atributos/categorías, y un usuario con ese rol, primero en QA).
3. **Diseños en Wilcom `.EMB`.** Ya no bloquea: la fuente son las fotos. Exportarlos a DST o PES solo mejora la validación de forma y colores.
4. **Licencia de `MockUps-pack`.** (Solo se usan como base las fotos de `Own/`; el resto no se publica sin confirmar su licencia).
5. **Tono e idioma de las fichas.** (Español, tono streetwear; el Copywriter toma 2–3 fichas actuales de la tienda como ejemplo).
6. **Primer diseño para la prueba de punta a punta.** (CALCIFER, porque tiene archivos de máquina y previews).
