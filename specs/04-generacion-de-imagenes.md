# Generación de imágenes: APIs y pipeline

## El problema real
Generar una persona realista con un hoodie es fácil hoy. Lo difícil es que **el bordado salga idéntico al tuyo**: los modelos generativos tienden a "reinterpretar" logos, cambiar letras, simplificar detalles y perder la textura de hilo. Por eso el pipeline separa *la foto* de *el bordado* y mide la fidelidad antes de aceptar nada.

## Opciones comparadas
Precios: verificar en la página de cada proveedor antes de implementar; todas están en el orden de centavos de dólar por imagen.

| Opción | Qué hace bien | Riesgo con tu bordado | Encaje |
|---|---|---|---|
| **Google Gemini Image** ("Nano Banana", familia Gemini Image) | Edición con varias imágenes de referencia; buena preservación de logos y consistencia de persona entre tomas; muy fotorealista | Puede suavizar detalles finos o letras pequeñas | ★★★★★ ruta generativa principal |
| **OpenAI gpt-image** (endpoint de edits con referencias y máscara) | Buen seguimiento de instrucciones y máscaras; texto legible | Tiende a "limpiar" el diseño y verse más ilustrado; más lento | ★★★★ alternativa |
| **FLUX Kontext / FLUX (Black Forest Labs, vía API propia, fal.ai o Replicate)** | Edición con referencia muy fiel; permite entrenar un LoRA con fotos reales de tus bordados | Requiere más ajuste; LoRA implica trabajo extra | ★★★★ ideal para fase 2 (LoRA de tu marca) |
| **Seedream (ByteDance) u otros multi-referencia** | Buena calidad y precio | Menos control y documentación | ★★★ opción de respaldo |
| **Composición determinística** (OpenCV/Pillow: warp sobre la tela + mapa de desplazamiento + relieve de puntada + sombreado) | El bordado es literalmente tu archivo: fidelidad 100 % | Sin cuidado se ve "pegado" | ★★★★★ indispensable como red de seguridad y para tomas de detalle |

## Lo que ya tienes y cambia el plan
- **Fotos reales de cada bordado** (`1. JUST PHOTOS of all designs`): el recorte conserva la textura de hilo real, así que la ruta determinística no se ve como un PNG pegado. Es también la referencia contra la que QA mide la fidelidad.
- **Archivos de máquina** (DST, PES, etc. en `TOEmbroider/`), cuando existen: validan la forma y los colores exactos de hilo.
- **Nada de IA en xdopestore-api**: todo el pipeline de imágenes es nuevo y vive en el servicio de agentes, no en la API de la tienda. La API solo recibe las imágenes finales por `POST /attachment` (Cloudinary, máx. 10 MB).

## Recomendación: pipeline híbrido de dos rutas
Las fotos finales **se generan con la API de imágenes** (Gemini Image como motor principal), con el prompt que escribe el Director de arte. La composición determinística queda solo como **respaldo** para una toma cuya versión generada no pase QA de fidelidad después de los reintentos; esas imágenes se marcan `fallback` para que Diego las vea.

```
ShotList (una toma)
   │
   ▼
A. Foto base: modelo o prenda con hoodie LISO del color pedido (Gemini Image),
   usando la foto base de la primera toma como referencia de identidad para las demás
   - Se guarda también la máscara de la zona de bordado (segmentación de la prenda)
   │
   ├──► B1. Ruta generativa: edición de la foto base pasando el bordado como
   │        imagen de referencia + máscara de la zona. Prompt: "bordado de hilo
   │        en relieve, respetar exactamente forma y colores de la referencia".
   │
   └──► B2. Ruta determinística: warp del recorte de la foto del bordado sobre la zona según
            los pliegues (mapa de desplazamiento de la foto), textura de puntada,
            sombra y luz tomadas de la foto base. Opcional: pasada de
            "armonización" de baja intensidad SOLO en los bordes.
   │
   ▼
C. QA visual mide B1 contra el original. Si falla tras 2 reintentos, usa B2 marcada `fallback`
```

**Por qué así**
- La foto base sin bordado es la parte donde la IA brilla (persona, pose, luz, tela).
- B1 da el mejor realismo cuando funciona; B2 garantiza que siempre haya una opción fiel.
- Mantener la misma persona entre tomas: pasar la foto base de la toma 1 como referencia de identidad para las demás.

## Fase 2 (cuando el flujo funcione)
Entrenar un **LoRA de FLUX con 20–40 fotos reales** de tus hoodies bordados. Eso enseña al modelo cómo se ve *tu* puntada y sube mucho la tasa de aprobación de B1.

## Interfaz común (para cambiar de proveedor sin tocar agentes)
```
generate_base(shot, seed) -> Image
edit_with_reference(base, reference_png, mask, prompt, seed) -> Image
```
Cada proveedor es un adaptador. El proveedor activo se elige por configuración, no en el código de los agentes.

## Costo estimado por producto
9 tomas (3 colores × 3) × (1 base + 2 ediciones) ≈ 27 llamadas, más reintentos. Con precios del orden de centavos por imagen, el tope de USD 3 por producto de la constitución debería alcanzar holgado; se valida en la primera corrida real.
