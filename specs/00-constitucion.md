# Constitución del sistema

Reglas que ninguna spec, agente ni tarea puede romper.

1. **Fidelidad del diseño por encima de todo.** El bordado que aparece en una foto debe ser reconocible como el archivo original: misma forma, mismos colores de hilo, sin letras inventadas ni elementos agregados. Una foto bonita con el bordado alterado se descarta.
2. **Todo es automático hasta la activación.** El proceso arranca solo y llega sin pausas hasta el producto creado. **Nada queda visible sin aprobación humana:** xdopestore-api no tiene estado borrador, así que los agentes crean el producto con `status: 0` (inactivo, invisible en la tienda). Solo Diego lo pasa a `status: 1` desde el admin-dashboard.
3. **Contratos explícitos.** Los agentes solo se comunican con los JSON definidos en `03-contratos-de-datos.md`. Si falta un campo requerido, el agente falla con un error claro; no inventa.
4. **Trazabilidad.** Cada imagen y cada texto guarda de dónde salió: diseño fuente, modelo/API usada, prompt, semilla y fecha. Todo lote tiene un `run_id`.
5. **Idempotencia.** Correr el flujo dos veces con el mismo `run_id` no duplica productos. Cada producto creado por agentes lleva el tag `agent-run:<run_id>` y el Publicador lo busca antes de crear.
6. **Costo acotado.** Cada lote tiene un tope de gasto en generación de imágenes (por defecto USD 3 por producto). Superarlo detiene el flujo y pide confirmación.
7. **Marca consistente.** Tono, idioma y estilo visual salen de un único `brand-guide` y no se improvisan por producto.
8. **Derechos de imagen.** Solo se usan personas generadas sintéticamente o fotos con licencia/consentimiento. No se usan caras de personas reales identificables sin permiso.
9. **QA antes que producción.** Todo agente nuevo o modificado corre primero contra el entorno QA de la API (base de datos `_qa`). Producción solo después de 3 lotes correctos en QA.
10. **Usuario propio y mínimo.** Los agentes se autentican con un usuario dedicado con permiso solo para attachments, productos y lectura de atributos/categorías. Nunca con las credenciales del admin seed.
11. **Las fotos de la carpeta son insumo, no producto.** Las imágenes de `1. JUST PHOTOS of all designs` solo sirven como referencia del bordado. Nunca se suben a la tienda; todo lo que se publica son mockups generados.
12. **Por producto: 1 color × 3 fotos.** Cada producto sale con 1 color de hoodie y 3 fotos (frontal, 3/4 o lateral, y detalle del bordado), con el mismo modelo en las 3. Generar más fotos sube el costo sin necesidad (decisión de Diego, 2026-09-30).
13. **Bordado de tamaño real.** El bordado va pequeño en el pecho izquierdo (por defecto, unos 8–10 cm de ancho) o, si el diseño lo pide, centrado en el pecho y más grande, sin pasar nunca de 20 × 20 cm (el bastidor máximo de Diego). En todas las fotos se ve la textura de bordado: puntadas, brillo del hilo y relieve sobre la tela, nunca un estampado plano.
