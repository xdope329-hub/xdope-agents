# xdope · Spec-Driven Development del flujo de publicación de productos

Estos documentos son la **fuente de verdad**. El código de los agentes se escribe *desde* las specs y se valida *contra* ellas: si el comportamiento cambia, primero cambia la spec.

| Archivo | Qué define |
|---|---|
| [00-constitucion.md](00-constitucion.md) | Principios no negociables del sistema |
| [01-workflow.md](01-workflow.md) | Flujo de punta a punta, estados, puntos de aprobación humana |
| [02-agentes.md](02-agentes.md) | Cada agente: responsabilidad, entradas, salidas, criterios de aceptación |
| [03-contratos-de-datos.md](03-contratos-de-datos.md) | Esquemas JSON que se pasan entre agentes |
| [04-generacion-de-imagenes.md](04-generacion-de-imagenes.md) | Comparativa de APIs y pipeline recomendado para mockups con bordado |
| [05-preguntas-abiertas.md](05-preguntas-abiertas.md) | Decisiones pendientes de Diego |
| [contexto-xdope.md](contexto-xdope.md) | Mapeo del stack real de xDope (API, dashboard, tienda, bordados) |

## Ciclo SDD que seguimos
1. **Specify**: se escribe o ajusta la spec (qué y por qué, criterios medibles).
2. **Plan**: decisiones técnicas (lenguaje, APIs, almacenamiento) en un `plan.md` por fase.
3. **Tasks**: la spec se parte en tareas pequeñas con criterio de "hecho" verificable.
4. **Implement**: cada tarea se implementa con tests que prueban sus criterios de aceptación.
5. **Validate**: se corre el flujo con 3 diseños reales; lo que falle vuelve a la spec.

## Resultado esperado (definición de "hecho" del sistema)
Sin intervención de Diego, el sistema elige un diseño de la carpeta, le pone título y descripción corta, y entrega **en un solo lote**:
- 1 color × 3 fotos (3 mockups generados con API) del mismo modelo o prenda, con el bordado fiel al original,
- ficha de producto completa (título, descripción, variantes, tags, SEO),
- un producto inactivo creado en xdopestore-api, listo para que Diego lo active con un clic desde el admin-dashboard.

## Implementación actual
El pipeline que corre hoy es `npm run pipeline` (`src/pipeline.cjs`, traído de `xdope-product-agents`), documentado en `docs/agentes.md`. Donde ese pipeline y estas specs no coincidan, mandan las specs y la diferencia se corrige en el código.
