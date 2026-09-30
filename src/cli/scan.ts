import { loadScanConfig } from "../config.js";
import { readCatalog, scanDesigns, writeCatalog } from "../designs/library.js";

const config = loadScanConfig(process.env);
const previous = await readCatalog(config.DESIGNS_CATALOG);
const result = await scanDesigns(config.DESIGNS_DIR, previous);
await writeCatalog(config.DESIGNS_CATALOG, result.catalog);

console.log(`Diseños en catálogo: ${result.catalog.length}`);
console.log(`Nuevos: ${result.added.length}`);
for (const d of result.added) console.log(`  + ${d.name} (${d.photo_path})`);
if (result.moved.length) console.log(`Renombrados o movidos: ${result.moved.length}`);
if (result.restored.length) console.log(`Recuperados: ${result.restored.length}`);
if (result.missing.length) {
  console.log(`Ya no están en la carpeta: ${result.missing.length}`);
  for (const d of result.missing) console.log(`  - ${d.name}`);
}
if (result.duplicates.length) {
  console.log(`Duplicados ignorados: ${result.duplicates.length}`);
  for (const d of result.duplicates) console.log(`  = ${d.path} (igual a ${d.design_id})`);
}
