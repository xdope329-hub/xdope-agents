import { z } from "zod";

// Constitución, reglas 12 y 13: 1 color × 3 fotos; bordado pequeño a la izquierda o centrado, nunca más de 20 × 20 cm.
export const MIN_COLORS = 1;
export const MAX_COLORS = 1;
export const MAX_HOOP_CM = 20;
export const MAX_CHEST_LEFT_CM = 12;
export const MIN_SHOTS_PER_COLOR = 3;
export const MAX_SECONDARY_CATEGORIES = 2;
export const MIN_CATEGORY_CONFIDENCE = 0.6;

const hex = z.string().regex(/^#[0-9A-Fa-f]{6}$/);
const runId = z.string().min(1);

export const Placement = z.enum(["chest_left", "chest_center", "back", "sleeve_left", "sleeve_right"]);

export const DesignCatalogEntry = z.object({
  design_id: z.string().min(1),
  name: z.string().min(1),
  photo_path: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  machine_file: z.string().nullable().default(null),
  status: z.enum(["new", "prepared", "published", "missing"]),
  added_at: z.string().datetime(),
  products: z.array(z.string()).default([]),
});
export type DesignCatalogEntry = z.infer<typeof DesignCatalogEntry>;

const ColorRef = z.object({
  name: z.string().min(1),
  attribute_value_id: z.string().min(1),
  hex,
});

export const ProductBrief = z.object({
  run_id: runId,
  name: z.string().min(1),
  slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  category_ids: z.array(z.string()).min(1),
  design_id: z.string().min(1),
  embroidery_placement: Placement,
  embroidery_size_cm: z.object({ w: z.number().positive(), h: z.number().positive() }).optional(),
  garment: z.object({
    type: z.literal("hoodie"),
    material: z.string().min(1).optional(),
    weight_gsm: z.number().positive().optional(),
    fit: z.string().optional(),
  }),
  // Diego puede fijar el color; si no, lo elige el Director de arte.
  colors: z.array(ColorRef).default([]),
  sizes: z.array(z.object({ name: z.string().min(1), attribute_value_id: z.string().min(1) })).min(1),
  price: z.object({ amount: z.number().positive(), sale_price: z.number().positive().nullable().default(null) }),
  stock_per_variant: z.number().int().nonnegative(),
  title: z.string().min(1).max(60),
  short_description: z.string().min(1).max(160),
});
export type ProductBrief = z.infer<typeof ProductBrief>;

export const CuratorPick = z
  .object({
    run_id: runId,
    design_id: z.string().min(1),
    selection_reason: z.string().min(1),
    title_options: z.array(z.string().min(1).max(60)).length(3),
    title: z.string().min(1).max(60),
    title_reason: z.string().min(1),
    short_description: z.string().min(1).max(160),
    categories: z
      .array(
        z.object({
          category_id: z.string().min(1),
          name: z.string().min(1),
          role: z.enum(["primary", "secondary"]),
          confidence: z.number().min(0).max(1),
          reason: z.string().min(1),
        }),
      )
      .min(1),
    suggested_new_category: z.string().min(1).nullable().default(null),
    // Informativo: personaje o franquicia que referencia el diseño. Nunca bloquea el lote.
    franchise_reference: z.string().min(1).nullable().default(null),
  })
  .superRefine((p, ctx) => {
    if (!p.title_options.includes(p.title)) {
      ctx.addIssue({ code: "custom", path: ["title"], message: "El título elegido debe ser una de las 3 opciones" });
    }
    const primary = p.categories.filter((c) => c.role === "primary").length;
    const secondary = p.categories.filter((c) => c.role === "secondary").length;
    if (primary !== 1) {
      ctx.addIssue({ code: "custom", path: ["categories"], message: `Debe haber 1 categoría principal; hay ${primary}` });
    }
    if (secondary > MAX_SECONDARY_CATEGORIES) {
      ctx.addIssue({ code: "custom", path: ["categories"], message: `Máximo ${MAX_SECONDARY_CATEGORIES} categorías secundarias; hay ${secondary}` });
    }
    const ids = p.categories.map((c) => c.category_id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: "custom", path: ["categories"], message: "Categoría repetida" });
    }
  });
export type CuratorPick = z.infer<typeof CuratorPick>;

// Configuración fija de la que el Curador completa el ProductBrief. No la genera un agente.
export const Defaults = z.object({
  price: z.object({ amount: z.number().positive(), sale_price: z.number().positive().nullable().default(null) }),
  size_attribute_value_ids: z.array(z.string().min(1)).min(1),
  base_category_ids: z.array(z.string().min(1)).default([]),
  fallback_category_id: z.string().min(1),
  garment: z.object({
    type: z.literal("hoodie"),
    material: z.string().min(1).optional(),
    weight_gsm: z.number().positive().optional(),
    fit: z.string().optional(),
  }),
  stock_per_variant: z.number().int().nonnegative(),
  embroidery_placement: Placement,
  tax_id: z.string().min(1).nullable().default(null),
  size_chart_image_id: z.string().min(1).nullable().default(null),
});
export type Defaults = z.infer<typeof Defaults>;

export const DesignAsset = z.object({
  run_id: runId,
  embroidery_png: z.string(),
  mask_png: z.string(),
  thread_palette: z.array(hex).min(1).max(12),
  has_text: z.boolean(),
  aspect_ratio: z.number().positive(),
  source: z.enum(["photo", "machine_file"]),
  low_res: z.boolean(),
});
export type DesignAsset = z.infer<typeof DesignAsset>;

export const Shot = z.object({
  shot_id: z.string().min(1),
  color: z.string().min(1),
  placement: Placement,
  framing: z.enum(["front_mid", "three_quarter", "side", "back", "detail", "lifestyle"]),
  pose: z.string().optional(),
  background: z.string().min(1),
  lighting: z.string().min(1),
  aspect: z.string().regex(/^\d+:\d+$/),
  prompt: z.string().min(1),
  negative_prompt: z.string().min(1),
});
export type Shot = z.infer<typeof Shot>;

export const ShotList = z
  .object({
    run_id: runId,
    analysis: z.object({
      subject: z.string().min(1),
      style: z.string().min(1),
      thread_palette: z.array(hex).min(1),
      has_text: z.boolean(),
      best_placement: Placement,
      embroidery_size_cm: z.object({ w: z.number().positive(), h: z.number().positive() }).optional(),
    }),
    concept: z.object({
      type: z.enum(["model", "flat_lay", "hanging", "ghost_mannequin"]),
      description: z.string().min(1),
      identity_ref: z.string().nullable().default(null),
    }),
    colors: z.array(ColorRef.extend({ contrast_ok: z.boolean() })).min(MIN_COLORS).max(MAX_COLORS),
    shots: z.array(Shot),
  })
  .superRefine((list, ctx) => {
    const { best_placement: placement, embroidery_size_cm: size } = list.analysis;
    if (placement !== "chest_left" && placement !== "chest_center") {
      ctx.addIssue({ code: "custom", path: ["analysis", "best_placement"], message: "El bordado va en chest_left o chest_center" });
    }
    if (size) {
      const max = placement === "chest_left" ? MAX_CHEST_LEFT_CM : MAX_HOOP_CM;
      if (size.w > max || size.h > max) {
        ctx.addIssue({ code: "custom", path: ["analysis", "embroidery_size_cm"], message: `Bordado de ${size.w}×${size.h} cm; en ${placement} el máximo es ${max}×${max} cm` });
      }
    }
    const colorNames = new Set(list.colors.map((c) => c.name));
    list.colors.forEach((c, i) => {
      if (!c.contrast_ok) {
        ctx.addIssue({ code: "custom", path: ["colors", i], message: `El color ${c.name} no tiene contraste suficiente con el bordado` });
      }
    });
    for (const s of list.shots) {
      if (!colorNames.has(s.color)) {
        ctx.addIssue({ code: "custom", path: ["shots"], message: `La toma ${s.shot_id} usa el color ${s.color}, que no está en colors` });
      }
    }
    for (const c of colorNames) {
      const perColor = list.shots.filter((s) => s.color === c);
      if (perColor.length < MIN_SHOTS_PER_COLOR) {
        ctx.addIssue({ code: "custom", path: ["shots"], message: `El color ${c} tiene ${perColor.length} tomas; mínimo ${MIN_SHOTS_PER_COLOR}` });
      }
      if (!perColor.some((s) => s.framing === "detail")) {
        ctx.addIssue({ code: "custom", path: ["shots"], message: `El color ${c} no tiene toma de detalle del bordado` });
      }
    }
    const ids = list.shots.map((s) => s.shot_id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: "custom", path: ["shots"], message: "shot_id repetido" });
    }
  });
export type ShotList = z.infer<typeof ShotList>;

export const Candidate = z.object({
  path: z.string(),
  api: z.string(),
  model: z.string(),
  prompt: z.string(),
  seed: z.number().int().nullable(),
  cost_usd: z.number().nonnegative(),
  fallback: z.boolean().default(false),
});

export const MockupSet = z.object({
  run_id: runId,
  shots: z.array(
    z.object({
      shot_id: z.string(),
      candidates: z.array(Candidate).min(1),
      final: z.string().nullable(),
      qa: z.object({
        passed: z.boolean(),
        scores: z.record(z.string(), z.number()),
        reasons: z.array(z.string()),
      }),
    }),
  ),
  total_cost_usd: z.number().nonnegative(),
});
export type MockupSet = z.infer<typeof MockupSet>;

export const ProductListing = z.object({
  title: z.string().min(1).max(70),
  short_description: z.string().min(1),
  description_html: z.string().min(1),
  tags: z.array(z.string()).min(1),
  seo: z.object({ title: z.string().min(1).max(70), description: z.string().min(1).max(155) }),
  image_alts: z.record(z.string(), z.string().min(1)),
  language: z.string().default("es"),
});
export type ProductListing = z.infer<typeof ProductListing>;

export const PublishResult = z.object({
  run_id: runId,
  platform: z.literal("xdopestore-api"),
  environment: z.enum(["qa", "prod"]),
  product_id: z.string().min(1),
  status: z.literal(0),
  attachment_ids: z.array(z.string()).min(MIN_COLORS * MIN_SHOTS_PER_COLOR),
  admin_url: z.string().url(),
});
export type PublishResult = z.infer<typeof PublishResult>;
