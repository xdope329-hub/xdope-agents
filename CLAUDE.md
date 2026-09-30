# xdope-agents

Agentes que publican hoodies bordados en la tienda xDope. El proyecto sigue spec-driven development.

- `specs/` es la fuente de verdad. Si un comportamiento cambia, primero se cambia la spec y después el código.
- `specs/00-constitucion.md` tiene reglas que no se rompen (fidelidad del bordado, nada se activa sin Diego, mínimo 3 colores × 3 fotos, QA antes que producción).
- Los contratos entre agentes están en `specs/03-contratos-de-datos.md` y se implementan en `src/contracts/`. Cada agente valida su entrada y su salida con ellos.
- Las fotos de `DESIGNS_DIR` son solo lectura y solo insumo: nunca se suben a la tienda.
- Todo corre contra la API de QA (`XDOPE_API_ENV=qa`) hasta que el Publicador tenga 3 lotes correctos.
- Checks locales: `npm run typecheck && npm test`.
