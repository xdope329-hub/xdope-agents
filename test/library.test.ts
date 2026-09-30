import { mkdtemp, mkdir, rename, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCatalog, scanDesigns, writeCatalog } from "../src/designs/library.js";

let dir: string;
let tick = 0;
const now = () => new Date(Date.UTC(2026, 8, 30, 12, 0, tick++));

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "designs-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const put = (rel: string, content: string) =>
  mkdir(path.dirname(path.join(dir, rel)), { recursive: true }).then(() => writeFile(path.join(dir, rel), content));

describe("scanDesigns", () => {
  it("registra imágenes nuevas, incluidas subcarpetas, e ignora otros archivos", async () => {
    await put("Calcifer.jpg", "a");
    await put("Anime/Totoro_bordado.PNG", "b");
    await put("notas.txt", "x");
    const r = await scanDesigns(dir, [], now);
    expect(r.added.map((d) => d.name).sort()).toEqual(["Calcifer", "Totoro bordado"]);
    expect(r.catalog.every((d) => d.status === "new")).toBe(true);
    expect(r.added.find((d) => d.name === "Totoro bordado")?.photo_path).toBe("Anime/Totoro_bordado.PNG");
  });

  it("no duplica entradas al escanear dos veces", async () => {
    await put("Calcifer.jpg", "a");
    const first = await scanDesigns(dir, [], now);
    const second = await scanDesigns(dir, first.catalog, now);
    expect(second.added).toHaveLength(0);
    expect(second.catalog).toEqual(first.catalog);
  });

  it("detecta una imagen agregada después como nueva", async () => {
    await put("Calcifer.jpg", "a");
    const first = await scanDesigns(dir, [], now);
    await put("Dragon.webp", "c");
    const second = await scanDesigns(dir, first.catalog, now);
    expect(second.added.map((d) => d.name)).toEqual(["Dragon"]);
    expect(second.catalog).toHaveLength(2);
  });

  it("mantiene el id cuando un archivo se renombra o mueve", async () => {
    await put("Calcifer.jpg", "a");
    const first = await scanDesigns(dir, [], now);
    await mkdir(path.join(dir, "Anime"));
    await rename(path.join(dir, "Calcifer.jpg"), path.join(dir, "Anime/Calcifer fuego.jpg"));
    const second = await scanDesigns(dir, first.catalog, now);
    expect(second.added).toHaveLength(0);
    expect(second.moved).toHaveLength(1);
    expect(second.catalog[0].design_id).toBe(first.catalog[0].design_id);
    expect(second.catalog[0].photo_path).toBe("Anime/Calcifer fuego.jpg");
  });

  it("trata dos archivos iguales con distinto nombre como un solo diseño", async () => {
    await put("Calcifer.jpg", "a");
    await put("Calcifer copia.jpg", "a");
    const r = await scanDesigns(dir, [], now);
    expect(r.catalog).toHaveLength(1);
    expect(r.duplicates).toHaveLength(1);
  });

  it("marca como missing un diseño borrado y lo recupera si vuelve", async () => {
    await put("Calcifer.jpg", "a");
    const first = await scanDesigns(dir, [], now);
    await rm(path.join(dir, "Calcifer.jpg"));
    const second = await scanDesigns(dir, first.catalog, now);
    expect(second.catalog[0].status).toBe("missing");
    await put("Calcifer.jpg", "a");
    const third = await scanDesigns(dir, second.catalog, now);
    expect(third.restored).toHaveLength(1);
    expect(third.catalog[0].status).toBe("new");
  });

  it("no modifica la carpeta de diseños", async () => {
    await put("Calcifer.jpg", "a");
    const before = await readdir(dir, { recursive: true });
    await scanDesigns(dir, [], now);
    expect(await readdir(dir, { recursive: true })).toEqual(before);
  });

  it("guarda y lee el catálogo", async () => {
    await put("Calcifer.jpg", "a");
    const r = await scanDesigns(dir, [], now);
    const file = path.join(dir, "..", `${path.basename(dir)}-designs.json`);
    await writeCatalog(file, r.catalog);
    expect(await readCatalog(file)).toEqual(r.catalog);
    await rm(file);
    expect(await readCatalog(file)).toEqual([]);
  });
});
