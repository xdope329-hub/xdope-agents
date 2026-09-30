import { createHash } from "node:crypto";
import { readFile, readdir, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { DesignCatalogEntry } from "../contracts/index.js";

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);

export const DesignCatalog = z.array(DesignCatalogEntry);

export interface ScanResult {
  catalog: DesignCatalogEntry[];
  added: DesignCatalogEntry[];
  moved: DesignCatalogEntry[];
  missing: DesignCatalogEntry[];
  restored: DesignCatalogEntry[];
  // Archivos con el mismo contenido que otro ya registrado: [ruta duplicada, design_id]
  duplicates: Array<{ path: string; design_id: string }>;
}

// Recorre la carpeta de Diego (solo lectura) y actualiza el catálogo.
// Un diseño se identifica por el hash de su contenido, así que renombrar o mover
// un archivo no crea otro diseño. Ver specs/02-agentes.md, sección 0.
export async function scanDesigns(
  designsDir: string,
  previous: DesignCatalogEntry[],
  now: () => Date = () => new Date(),
): Promise<ScanResult> {
  const files = await listImages(designsDir);
  const found = new Map<string, string>(); // sha256 → ruta relativa
  const duplicates: ScanResult["duplicates"] = [];
  const byHash = new Map(previous.map((e) => [e.sha256, e]));

  for (const rel of files) {
    const sha = await sha256(path.join(designsDir, rel));
    const first = found.get(sha);
    if (first !== undefined) {
      const id = byHash.get(sha)?.design_id ?? designId(sha);
      duplicates.push({ path: rel, design_id: id });
      continue;
    }
    found.set(sha, rel);
  }

  const added: DesignCatalogEntry[] = [];
  const moved: DesignCatalogEntry[] = [];
  const missing: DesignCatalogEntry[] = [];
  const restored: DesignCatalogEntry[] = [];
  const catalog: DesignCatalogEntry[] = [];

  for (const entry of previous) {
    const rel = found.get(entry.sha256);
    if (rel === undefined) {
      const next = { ...entry, status: "missing" as const };
      if (entry.status !== "missing") missing.push(next);
      catalog.push(next);
      continue;
    }
    let next = entry;
    if (entry.status === "missing") {
      next = { ...next, status: entry.products.length > 0 ? "published" : "new" };
      restored.push(next);
    }
    if (rel !== entry.photo_path) {
      next = { ...next, photo_path: rel, name: nameFrom(rel) };
      moved.push(next);
    }
    catalog.push(next);
  }

  for (const [sha, rel] of found) {
    if (byHash.has(sha)) continue;
    const entry = DesignCatalogEntry.parse({
      design_id: designId(sha),
      name: nameFrom(rel),
      photo_path: rel,
      sha256: sha,
      machine_file: null,
      status: "new",
      added_at: now().toISOString(),
      products: [],
    });
    added.push(entry);
    catalog.push(entry);
  }

  catalog.sort((a, b) => a.added_at.localeCompare(b.added_at) || a.name.localeCompare(b.name));
  return { catalog, added, moved, missing, restored, duplicates };
}

export async function readCatalog(file: string): Promise<DesignCatalogEntry[]> {
  try {
    await access(file);
  } catch {
    return [];
  }
  return DesignCatalog.parse(JSON.parse(await readFile(file, "utf8")));
}

export async function writeCatalog(file: string, catalog: DesignCatalogEntry[]) {
  await writeFile(file, JSON.stringify(DesignCatalog.parse(catalog), null, 2) + "\n");
}

async function listImages(root: string, rel = ""): Promise<string[]> {
  const entries = await readdir(path.join(root, rel), { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listImages(root, child)));
    else if (e.isFile() && IMAGE_EXT.has(path.extname(e.name).toLowerCase())) out.push(child);
  }
  return out.sort();
}

async function sha256(file: string) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

function designId(sha: string) {
  return `d_${sha.slice(0, 12)}`;
}

function nameFrom(rel: string) {
  return path.basename(rel, path.extname(rel)).replace(/[_-]+/g, " ").trim();
}
