# Contratos de datos

Esquemas mínimos. Se implementan como JSON Schema (o Pydantic/Zod) y cada agente valida su entrada y su salida.

## DesignCatalogEntry (`designs.json`)
```json
{
  "design_id": "d_3f9a1c",
  "name": "Calcifer",
  "photo_path": "1. JUST PHOTOS of all designs/Calcifer.jpg",
  "sha256": "…",
  "machine_file": "TOEmbroider/CALCIFER/CALCIFER.dst",
  "status": "new | prepared | published | missing",
  "added_at": "2026-09-30T18:40:00Z",
  "products": ["<product_id>"]
}
```

## CuratorPick
```json
{
  "run_id": "2026-09-30-calcifer",
  "design_id": "d_3f9a1c",
  "selection_reason": "diseño nuevo, alta resolución, estilo anime distinto a los últimos 5 lotes",
  "title_options": ["Hoodie Calcifer Bordado", "Calcifer: Fuego Bordado", "Hoodie Llama Viva"],
  "title": "Hoodie Calcifer Bordado",
  "title_reason": "…",
  "short_description": "El demonio de fuego más querido, bordado hilo a hilo para que el calor lo lleves tú.",
  "categories": [
    {"category_id": "…", "name": "Anime", "role": "primary", "confidence": 0.95, "reason": "personaje de Howl's Moving Castle (Studio Ghibli)"}
  ],
  "suggested_new_category": null
}
```

## defaults.json (configuración, no la genera un agente)
```json
{
  "price": {"amount": 0, "sale_price": null},
  "size_attribute_value_ids": ["…"],
  "base_category_ids": ["<id de Hoodies>"],
  "fallback_category_id": "<id de una categoría general>",
  "garment": {"type": "hoodie", "material": "…", "weight_gsm": 0, "fit": "…"},
  "stock_per_variant": 10,
  "embroidery_placement": "chest_left"
}
```

## ProductBrief
```json
{
  "run_id": "2026-09-30-dragon-negro",
  "name": "Dragón Negro",
  "slug": "hoodie-dragon-negro",
  "category_ids": ["<id de categoría en la API>"],
  "design_id": "d_3f9a1c",
  "embroidery_placement": "chest_left | chest_center | back | sleeve_left | sleeve_right",
  "embroidery_size_cm": {"w": 9, "h": 7},
  "garment": {"type": "hoodie", "material": "algodón 80% / poliéster 20%", "weight_gsm": 350, "fit": "oversize"},
  "colors": [{"name": "Negro", "attribute_value_id": "…", "hex": "#111111"}],
  "sizes": [{"name": "M", "attribute_value_id": "…"}],
  "price": {"amount": 0, "sale_price": null},
  "stock_per_variant": 10,
  "title": "Hoodie Calcifer Bordado",
  "short_description": "…"
}
```

## DesignAsset
```json
{
  "run_id": "...",
  "embroidery_png": "design/embroidery.png",
  "mask_png": "design/mask.png",
  "thread_palette": ["#F2C230", "#B01E23"],
  "has_text": false,
  "aspect_ratio": 1.29,
  "source": "photo | machine_file",
  "low_res": false
}
```

## ShotList
```json
{
  "run_id": "...",
  "analysis": {"subject": "Calcifer, demonio de fuego de Howl's Moving Castle", "style": "anime", "thread_palette": ["#F2C230", "#B01E23"], "has_text": false, "best_placement": "chest_left"},
  "concept": {"type": "model | flat_lay | hanging | ghost_mannequin", "description": "hombre 25-30, streetwear urbano", "identity_ref": "mockups/_identity.png"},
  "colors": [{"name": "Negro", "attribute_value_id": "…", "hex": "#111111", "contrast_ok": true}],
  "shots": [
    {
      "shot_id": "negro-front-mid",
      "prompt": "…",
      "negative_prompt": "texto extra, estampado plano, logos agregados",
      "hoodie_color": "black",
      "placement": "chest_left",
      "model": "mujer, 25-30, streetwear",
      "pose": "de pie, manos en bolsillo canguro",
      "background": "muro de concreto, luz natural suave",
      "framing": "plano medio, frontal",
      "aspect": "4:5"
    }
  ]
}
```

## MockupSet
```json
{
  "run_id": "...",
  "analysis": {"subject": "Calcifer, demonio de fuego de Howl's Moving Castle", "style": "anime", "thread_palette": ["#F2C230", "#B01E23"], "has_text": false, "best_placement": "chest_left"},
  "concept": {"type": "model | flat_lay | hanging | ghost_mannequin", "description": "hombre 25-30, streetwear urbano", "identity_ref": "mockups/_identity.png"},
  "colors": [{"name": "Negro", "attribute_value_id": "…", "hex": "#111111", "contrast_ok": true}],
  "shots": [
    {
      "shot_id": "negro-front-mid",
      "prompt": "…",
      "negative_prompt": "texto extra, estampado plano, logos agregados",
      "candidates": [
        {"path": "mockups/front-mid/candidate_1.png", "api": "…", "model": "…", "prompt": "…", "seed": 123, "cost_usd": 0.12}
      ],
      "final": "mockups/front-mid/final.png",
      "qa": {"passed": true, "scores": {"ssim": 0.86, "embed": 0.93, "thread_delta_e": 5.1}, "reasons": []}
    }
  ],
  "total_cost_usd": 1.4
}
```

## ProductListing
```json
{
  "title": "...",
  "description_html": "...",
  "tags": ["hoodie", "bordado"],
  "seo": {"title": "...", "description": "..."},
  "image_alts": {"front-mid": "..."},
  "language": "es"
}
```

## PublishResult
```json
{
  "run_id": "...",
  "platform": "xdopestore-api",
  "environment": "qa | prod",
  "product_id": "...",
  "status": 0,
  "attachment_ids": ["..."],
  "admin_url": "…/product/edit/<id> en el admin-dashboard"
}
```
