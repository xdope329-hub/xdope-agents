# xdope-agents

Sistema de agentes que convierte una foto de un bordado en un producto listo en la tienda xDope: 3+ colores × 3+ mockups generados con IA, ficha completa y producto creado inactivo para que Diego lo active.

- Specs: [`specs/README.md`](specs/README.md)
- Plan técnico: [`plan.md`](plan.md)

## Desarrollo
```
npm install
cp .env.example .env
npm run typecheck && npm test
```

## Escanear la carpeta de bordados (en el PC de Diego)
1. Copia `.env.example` a `.env` y deja `DESIGNS_DIR` apuntando a la carpeta de fotos.
2. Corre `npm run scan`.
3. El comando lista los diseños nuevos, los renombrados, los que ya no están y los duplicados. El catálogo queda en `designs.json`. La carpeta de fotos nunca se modifica.

Para agregar un diseño nuevo basta con copiar su foto (JPG, PNG o WebP) en esa carpeta o en una subcarpeta y volver a escanear.
