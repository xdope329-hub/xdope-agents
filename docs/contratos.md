# Contratos de datos

## data/catalog.json

```json
{
  "updated_at": "2026-09-30T18:40:00Z",
  "designs": [
    {
      "id": 10,
      "photo": "C:/.../1. JUST PHOTOS of all designs/1-500/10.jpg",
      "name": null,
      "machine_dir": "C:/.../2. Embroidery Designs/1-100/10",
      "machine_formats": ["DST", "EXP", "HUS", "JEF", "PES", "SEW", "VP3", "XXX"],
      "status": "pending",
      "added_at": "2026-09-30T18:40:00Z"
    }
  ]
}
```

## output/<id>/brief.json

```json
{
  "id": 10,
  "start_image": "C:/.../1-500/10.jpg",
  "title": "Hoodie Sensei Bordado",
  "short_description": "Disciplina, calma y actitud: un bordado que se lleva con orgullo.",
  "selection_reason": "Foto nítida, diseño limpio, archivos DST/PES disponibles, sin marcas visibles",
  "categories": {
    "garment": ["hoodies"],
    "themes": [{ "slug": "anime", "confidence": 0.92, "reason": "Personaje estilo anime con katana" }]
  },
  "tags": ["samurai", "anime", "bordado rojo"],
  "created_at": "2026-09-30T18:40:00Z"
}
```

## output/<id>/analysis.json

```json
{
  "id": 10,
  "motif": "Descripción del diseño",
  "style": "anime | minimal | realista | lettering | ...",
  "thread_colors": [{ "name": "rojo", "hex": "#C62828" }],
  "visible_text": null,
  "placement": { "area": "chest_left", "width_cm": 9 },
  "garment_colors": [
    { "key": "negro", "reason": "máximo contraste con hilos claros" },
    { "key": "blanco", "reason": "..." },
    { "key": "gris_jaspeado", "reason": "..." }
  ],
  "risks": { "ip": "none | possible | likely", "notes": "", "quality": "ok | low" }
}
```

## output/<id>/prompts.json

```json
{
  "reference_image": "ruta a la foto",
  "consistency": { "model_description": "...", "set": "...", "seed": 1234 },
  "items": [
    { "color": "negro", "shot": "model_front", "prompt": "...", "negative": "...", "size": "1024x1280" }
  ]
}
```

## output/<id>/qa.json

```json
{
  "items": [
    { "file": "mockups/negro_model_front_v1.png", "scores": { "fidelity": 5, "embroidery_look": 4, "color": 5, "anatomy": 5, "consistency": 4 }, "approved": true, "notes": "" }
  ],
  "approved_colors": ["negro", "blanco", "gris_jaspeado"],
  "needs_manual_review": false
}
```

## output/<id>/publish.json

```json
{ "product_id": "...", "slug": "...", "status": 0, "attachment_ids": ["..."], "variations": 12 }
```
