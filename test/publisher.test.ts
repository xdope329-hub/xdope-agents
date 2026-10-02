import { describe, expect, it } from "vitest";
import { attributeOfValues, buildProductPayload, colorAttribute, resolveColors, runPublisher, runTag, variantSku } from "../src/agents/publisher.js";
import type { ProductBrief, ProductListing } from "../src/contracts/index.js";
import { XdopeApi, type ApiAttribute } from "../src/store/xdope.js";

const colorAttr: ApiAttribute = {
  id: "attr-color",
  name: "Color",
  style: "color",
  attribute_values: [
    { id: "c-negro", value: "Negro" },
    { id: "c-blanco", value: "Blanco" },
    { id: "c-arena", value: "Arena" },
  ],
};
const sizeAttr: ApiAttribute = { id: "attr-talla", name: "Talla", attribute_values: [{ id: "s-m", value: "M" }, { id: "s-l", value: "L" }] };

const brief: ProductBrief = {
  run_id: "r1",
  name: "Hoodie Calcifer Bordado",
  slug: "hoodie-calcifer-bordado",
  category_ids: ["cat-hoodies", "cat-anime"],
  design_id: "d_abc",
  design_number: "207",
  embroidery_placement: "chest_left",
  garment: { type: "hoodie", material: "algodón" },
  colors: [
    { name: "Negro", attribute_value_id: "c-negro", hex: "#151515" },
    { name: "Blanco", attribute_value_id: "c-blanco", hex: "#F5F5F2" },
    { name: "Arena", attribute_value_id: "c-arena", hex: "#C8B48F" },
  ],
  sizes: [
    { name: "M", attribute_value_id: "s-m" },
    { name: "L", attribute_value_id: "s-l" },
  ],
  price: { amount: 120000, sale_price: null },
  stock_per_variant: 10,
  title: "Hoodie Calcifer Bordado",
  short_description: "Fuego bordado hilo a hilo.",
};
const listing: ProductListing = {
  title: "Hoodie Calcifer Bordado",
  short_description: "Fuego bordado hilo a hilo.",
  description_html: "<p>Bordado.</p>",
  tags: ["hoodie", "bordado"],
  seo: { title: "Hoodie Calcifer", description: "Hoodie bordado" },
  image_alts: {},
  language: "es",
};
const imagesByColor = new Map([
  ["Negro", ["i1", "i2", "i3"]],
  ["Blanco", ["i4", "i5", "i6"]],
  ["Arena", ["i7", "i8", "i9"]],
]);

describe("buildProductPayload", () => {
  it("crea el producto inactivo con una variante por color × talla y las fotos de su color", () => {
    const p = buildProductPayload({ runId: "r1", brief, listing, imagesByColor, colorAttr, sizeAttr, taxId: null });
    expect(p.status).toBe(0);
    expect(p.type).toBe("classified");
    expect(p.variations).toHaveLength(6);
    expect(p.variations[0]).toMatchObject({ name: "Negro / M", attribute_value_ids: ["c-negro", "s-m"], price: 120000, variation_images: ["i1", "i2", "i3"] });
    expect(new Set(p.variations.map((v) => v.sku)).size).toBe(6);
    expect(p.variations[0].sku).toBe("XD-207-NEGRO-M");
    expect(p.tags).toContain("diseno-207");
    expect(p.product_images).toEqual(["i1", "i2", "i3", "i4", "i5", "i6", "i7", "i8", "i9"]);
    expect(p.product_thumbnail_id).toBe("i1");
    expect(p.tags).toContain(runTag("r1"));
    expect(p.attributes_ids).toEqual(["attr-color", "attr-talla"]);
  });
});

describe("atributos de la tienda", () => {
  it("resuelve colores por nombre sin importar tildes ni mayúsculas y falla si falta alguno", () => {
    expect(resolveColors(colorAttribute([sizeAttr, colorAttr]), ["negro", "ARENA"])).toEqual([
      { name: "negro", attribute_value_id: "c-negro" },
      { name: "ARENA", attribute_value_id: "c-arena" },
    ]);
    expect(() => resolveColors(colorAttr, ["Negro", "Lila"])).toThrow("Lila");
  });

  it("encuentra el atributo de tallas por sus ids", () => {
    expect(attributeOfValues([colorAttr, sizeAttr], ["s-m", "s-l"]).id).toBe("attr-talla");
    expect(() => attributeOfValues([colorAttr, sizeAttr], ["s-xxl"])).toThrow("defaults.json");
  });
});

function fakeApi(existing: Record<string, unknown> | null) {
  const calls: Array<{ method: string; url: string; body?: any }> = [];
  let product = existing;
  let n = 0;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const path = url.replace("http://api", "");
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, url: path, body });
    const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status });
    if (path.startsWith("/product/slug/")) return product ? json(200, product) : json(404, { message: "Product not found" });
    if (path === "/attachment") return json(201, { _id: `img${++n}` });
    if (method === "POST" && path === "/product") {
      product = { _id: "p1", ...body };
      return json(201, product);
    }
    if (method === "PUT") {
      product = { ...product, ...body };
      return json(200, product);
    }
    return json(500, { message: "no esperado" });
  }) as typeof fetch;
  return { api: new XdopeApi("http://api", fetchImpl), calls };
}

const images = ["Negro", "Blanco", "Arena"].flatMap((color) => [1, 2, 3].map((i) => ({ color, filename: `${color}-${i}.jpg`, data: Buffer.from("x") })));
const publish = (api: XdopeApi) =>
  runPublisher({ api, runId: "r1", environment: "qa", adminUrl: "https://admin.test/", brief, listing, images, colorAttr, sizeAttr, taxId: null, log: () => {} });

describe("runPublisher", () => {
  it("sube las fotos, crea el producto y devuelve el PublishResult", async () => {
    const { api, calls } = fakeApi(null);
    const result = await publish(api);
    expect(calls.filter((c) => c.url === "/attachment")).toHaveLength(9);
    expect(calls.some((c) => c.method === "POST" && c.url === "/product")).toBe(true);
    expect(result).toMatchObject({ product_id: "p1", status: 0, environment: "qa", admin_url: "https://admin.test/product/edit/p1" });
    expect(result.attachment_ids).toHaveLength(9);
  });

  it("si el producto ya es de este lote lo actualiza en vez de crear otro", async () => {
    const { api, calls } = fakeApi({ _id: "p1", status: 0, tags: [runTag("r1")] });
    await publish(api);
    expect(calls.some((c) => c.method === "POST" && c.url === "/product")).toBe(false);
    expect(calls.some((c) => c.method === "PUT" && c.url === "/product/p1")).toBe(true);
  });

  it("no toca un producto con el mismo slug que no es del lote", async () => {
    const { api } = fakeApi({ _id: "otro", status: 1, tags: [] });
    await expect(publish(api)).rejects.toThrow("no es de este lote");
  });
});

describe("variantSku", () => {
  it("usa el número del diseño y, si no hay, el design_id", () => {
    expect(variantSku({ design_id: "d_abc", design_number: "207" }, "Verde Oliva", "XL")).toBe("XD-207-VERDEOLIVA-XL");
    expect(variantSku({ design_id: "d_abc", design_number: null }, "Negro", "S")).toBe("XD-D_ABC-NEGRO-S");
  });
});
