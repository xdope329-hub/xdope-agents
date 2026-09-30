import { PublishResult, type ProductBrief, type ProductListing } from "../contracts/index.js";
import type { ApiAttribute, XdopeApi } from "../store/xdope.js";

// Crea (o actualiza, si es del mismo lote) el producto INACTIVO en xdopestore-api. Ver specs/02-agentes.md, sección 7.

export const runTag = (runId: string) => `agent-run:${runId}`;

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();

// Atributo de color de la tienda: el que se llama "Color" o, si no hay, el de estilo color.
export function colorAttribute(attrs: ApiAttribute[]): ApiAttribute {
  const found = attrs.find((a) => norm(a.name) === "color") ?? attrs.find((a) => a.style === "color");
  if (!found) throw new Error('No existe el atributo "Color" en la tienda; créalo en el admin-dashboard');
  return found;
}

// Nombre de color de la paleta → attribute_value de la tienda. Los agentes no crean valores.
export function resolveColors(attr: ApiAttribute, names: string[]) {
  const missing: string[] = [];
  const out = names.flatMap((name) => {
    const v = attr.attribute_values.find((x) => norm(x.value) === norm(name));
    if (!v) missing.push(name);
    return v ? [{ name, attribute_value_id: v.id }] : [];
  });
  if (missing.length) throw new Error(`Faltan colores en el atributo "${attr.name}" de la tienda: ${missing.join(", ")}. Créalos en el admin-dashboard`);
  return out;
}

// Atributo que contiene todos los valores dados (p. ej. las tallas de defaults.json).
export function attributeOfValues(attrs: ApiAttribute[], valueIds: string[]): ApiAttribute {
  const found = attrs.find((a) => valueIds.every((id) => a.attribute_values.some((v) => v.id === id)));
  if (!found) throw new Error(`Ningún atributo de la tienda tiene los valores ${valueIds.join(", ")} (revisa size_attribute_value_ids en defaults.json)`);
  return found;
}

export function buildProductPayload(opts: {
  runId: string;
  brief: ProductBrief;
  listing: ProductListing;
  imagesByColor: Map<string, string[]>; // nombre de color → attachment ids en el orden de la ShotList
  colorAttr: ApiAttribute;
  sizeAttr: ApiAttribute;
  taxId: string | null;
  sizeChartImageId?: string | null;
  descriptionTemplate?: string; // bloque fijo de la marca: reemplaza la descripción del Copywriter
}) {
  const { brief, listing, colorAttr, sizeAttr } = opts;
  const value = (attr: ApiAttribute, id: string) => {
    const v = attr.attribute_values.find((x) => x.id === id);
    if (!v) throw new Error(`El valor ${id} no está en el atributo ${attr.name}`);
    return v;
  };
  const colors = brief.colors.filter((c) => opts.imagesByColor.get(c.name)?.length);
  const variations = colors.flatMap((c) => {
    const cv = value(colorAttr, c.attribute_value_id);
    return brief.sizes.map((s) => {
      const sv = value(sizeAttr, s.attribute_value_id);
      return {
        name: `${sv.value}/${cv.value}`,
        attribute_value_ids: [cv.id, sv.id],
        attribute_values: [
          { name: colorAttr.name, value: cv.value, id: cv.id, attribute_id: colorAttr.id },
          { name: sizeAttr.name, value: sv.value, id: sv.id, attribute_id: sizeAttr.id },
        ],
        price: brief.price.amount,
        sale_price: brief.price.sale_price ?? brief.price.amount,
        quantity: brief.stock_per_variant,
        sku: `${brief.slug}_${sv.value}/${cv.value}`,
        stock_status: brief.stock_per_variant > 0 ? "in_stock" : "out_of_stock",
        status: 1,
        variation_images: opts.imagesByColor.get(c.name)!,
      };
    });
  });
  const images = colors.flatMap((c) => opts.imagesByColor.get(c.name)!);
  return {
    name: listing.title,
    slug: brief.slug,
    short_description: listing.short_description,
    // La descripción es el bloque fijo de la marca (config/description-template.html); el texto del Copywriter solo si no hay bloque.
    description: opts.descriptionTemplate ?? listing.description_html,
    type: "classified",
    product_type: "physical",
    status: 0,
    categories: brief.category_ids,
    tags: [...new Set([...listing.tags, runTag(opts.runId)])],
    tax_id: opts.taxId,
    size_chart_image_id: opts.sizeChartImageId ?? null,
    attributes_ids: [colorAttr.id, sizeAttr.id],
    product_thumbnail_id: images[0],
    product_images: images,
    product_meta_image_id: images[0],
    meta_title: listing.seo.title,
    meta_description: listing.seo.description,
    og_title: listing.seo.title,
    og_description: listing.seo.description,
    variations,
  };
}

export async function runPublisher(opts: {
  api: XdopeApi;
  runId: string;
  environment: "qa" | "prod";
  adminUrl: string;
  brief: ProductBrief;
  listing: ProductListing;
  images: Array<{ color: string; filename: string; data: Buffer }>; // aprobadas, en el orden de la ShotList
  colorAttr: ApiAttribute;
  sizeAttr: ApiAttribute;
  taxId: string | null;
  sizeChartImageId?: string | null;
  descriptionTemplate?: string;
  log: (msg: string) => void;
}): Promise<PublishResult> {
  const { api, brief } = opts;
  const existing = await api.productBySlug(brief.slug);
  if (existing && !existing.tags?.includes(runTag(opts.runId))) {
    throw new Error(`Ya existe un producto con el slug ${brief.slug} que no es de este lote`);
  }

  opts.log(`Subiendo ${opts.images.length} fotos…`);
  const imagesByColor = new Map<string, string[]>();
  for (const img of opts.images) {
    const id = await api.uploadImage(img.data, img.filename);
    imagesByColor.set(img.color, [...(imagesByColor.get(img.color) ?? []), id]);
  }

  const payload = buildProductPayload({ runId: opts.runId, brief, listing: opts.listing, imagesByColor, colorAttr: opts.colorAttr, sizeAttr: opts.sizeAttr, taxId: opts.taxId, sizeChartImageId: opts.sizeChartImageId, descriptionTemplate: opts.descriptionTemplate });
  const saved = existing
    ? await api.request("PUT", `/product/${existing.id}`, payload)
    : await api.request("POST", "/product", payload);
  const productId = String(saved?.id ?? saved?._id ?? existing?.id);
  opts.log(`${existing ? "Actualizado" : "Creado"} producto ${productId} (inactivo)`);

  // Verificación: el producto quedó inactivo y con todas sus variantes.
  const check = await api.productBySlug(brief.slug);
  const c = check as { status?: number; variations?: unknown[] } | null;
  if (!c || c.status !== 0 || (c.variations?.length ?? 0) !== payload.variations.length) {
    throw new Error(`El producto ${productId} no quedó como se envió (status ${c?.status}, ${c?.variations?.length ?? 0}/${payload.variations.length} variantes)`);
  }

  return PublishResult.parse({
    run_id: opts.runId,
    platform: "xdopestore-api",
    environment: opts.environment,
    product_id: productId,
    status: 0,
    attachment_ids: payload.product_images,
    admin_url: `${opts.adminUrl.replace(/\/$/, "")}/product/edit/${productId}`,
  });
}
