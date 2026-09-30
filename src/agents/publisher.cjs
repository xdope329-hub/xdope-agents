// Agente 7 — Publicador: crea el producto en xdopestore-api como INACTIVO (status 0).
const path = require('path');
const sharp = require('sharp');
const api = require('../lib/xdope.cjs');

async function ensureAttribute(name, values) {
  const found = (await api.list(`/attribute?search=${encodeURIComponent(name)}&paginate=50`))
    .find((a) => a.name.toLowerCase() === name.toLowerCase());
  if (!found) throw new Error(`No existe el atributo "${name}" en la tienda; créalo en el dashboard`);
  const missing = values.filter((v) => !found.attribute_values.some((x) => x.value.toLowerCase() === v.value.toLowerCase()));
  if (!missing.length) return found;
  const attribute_values = [...found.attribute_values.map(({ _id, id, value, hex_color, slug }) => ({ _id: _id ?? id, value, hex_color, slug })), ...missing];
  return api.call('PUT', `/attribute/${found.id ?? found._id}`, { attribute_values });
}

async function resolveCategories(config, brief) {
  const all = await api.list('/category?paginate=500');
  const bySlug = (slug) => all.find((c) => c.slug === slug);
  const garment = brief.categories.garment.map((slug) => {
    const c = bySlug(slug);
    if (!c) throw new Error(`No existe la categoría "${slug}" en la tienda`);
    return c;
  });
  const parent = bySlug(config.taxonomy.createMissingAsChildOf);
  const themes = [];
  for (const t of brief.categories.themes) {
    let c = bySlug(t.slug);
    if (!c) {
      const def = config.taxonomy.themes.find((x) => x.slug === t.slug);
      c = await api.call('POST', '/category', { name: def.name, slug: def.slug, parent_id: parent?.id ?? parent?._id ?? null, status: 1 });
    }
    themes.push(c);
  }
  return [...garment, ...themes].map((c) => c.id ?? c._id);
}

async function toJpeg(file, outDir) {
  const out = path.join(outDir, `${path.parse(file).name}.jpg`);
  await sharp(file).jpeg({ quality: 88, mozjpeg: true }).toFile(out);
  return out;
}

async function publish({ config, brief, copy, approved, outDir }) {
  const { store, garment } = config;
  if (!(store.price > 0)) throw new Error('Configura store.price (> 0) antes de publicar');
  await api.login();

  const colorAttr = await ensureAttribute('Color', approved.map((a) => {
    const c = garment.colors.find((x) => x.key === a.color);
    return { value: c.label, hex_color: c.hex };
  }));
  const sizeAttr = await ensureAttribute('Talla', garment.sizes.map((s) => ({ value: s })));
  const valueOf = (attr, v) => attr.attribute_values.find((x) => x.value.toLowerCase() === v.toLowerCase());

  // Subir imágenes por color.
  const imagesByColor = {};
  for (const a of approved) {
    imagesByColor[a.color] = [];
    for (const f of a.files) imagesByColor[a.color].push(await api.uploadImage(await toJpeg(f, outDir)));
  }

  const taxes = await api.list(`/tax?search=${encodeURIComponent(store.taxName)}`);
  const variations = [];
  for (const a of approved) {
    const label = garment.colors.find((x) => x.key === a.color).label;
    const cv = valueOf(colorAttr, label);
    for (const size of garment.sizes) {
      const sv = valueOf(sizeAttr, size);
      variations.push({
        name: `${label} / ${size}`,
        attribute_value_ids: [cv.id ?? cv._id, sv.id ?? sv._id],
        attribute_values: [
          { name: colorAttr.name, value: cv.value, id: cv.id ?? cv._id, attribute_id: colorAttr.id ?? colorAttr._id },
          { name: sizeAttr.name, value: sv.value, id: sv.id ?? sv._id, attribute_id: sizeAttr.id ?? sizeAttr._id },
        ],
        price: store.price,
        quantity: store.stockPerVariant ?? 0,
        sku: `XD-HOOD-${brief.id}-${a.color.toUpperCase()}-${size}`,
        stock_status: (store.stockPerVariant ?? 0) > 0 ? 'in_stock' : 'out_of_stock',
        status: 1,
        variation_images: imagesByColor[a.color],
      });
    }
  }

  const allImages = Object.values(imagesByColor).flat();
  const product = await api.call('POST', '/product', {
    name: copy.name, slug: copy.slug, short_description: copy.short_description, description: copy.description,
    type: 'classified', product_type: 'physical', status: 0,
    categories: await resolveCategories(config, brief), tags: brief.tags,
    tax_id: taxes[0]?.id ?? taxes[0]?._id ?? null,
    attributes_ids: [colorAttr.id ?? colorAttr._id, sizeAttr.id ?? sizeAttr._id],
    product_thumbnail_id: allImages[0], product_images: allImages, product_meta_image_id: allImages[0],
    size_chart_image_id: store.sizeChartAttachmentId || null,
    meta_title: copy.meta_title, meta_description: copy.meta_description,
    og_title: copy.og_title, og_description: copy.og_description,
    variations,
  });
  return { product_id: product.id ?? product._id, slug: product.slug, status: 0, attachment_ids: allImages, variations: variations.length };
}

module.exports = { publish };
