// Agente 1 — Inventario: escanea las carpetas de fotos y de archivos de máquina
// y actualiza data/catalog.json sin perder el estado de los diseños existentes.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const MACHINE_EXT = new Set(['dst', 'exp', 'hus', 'jef', 'pes', 'sew', 'vp3', 'xxx', 'vip', 'emb']);

function loadConfig() {
  const custom = path.join(ROOT, 'config', 'config.json');
  const file = fs.existsSync(custom) ? custom : path.join(ROOT, 'config', 'config.example.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function walk(dir, onFile) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, onFile);
    else onFile(full, entry.name);
  }
}

// Carpetas "<id> [nombre]" dentro de carpetas de rango ("1-100", "800-1200/801-900", ...).
function indexMachineDirs(designDirs) {
  const byId = new Map();
  const visit = (rangeDir) => {
    for (const d of fs.readdirSync(rangeDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const dir = path.join(rangeDir, d.name);
      if (/^\d+\s*-\s*\d+$/.test(d.name)) { visit(dir); continue; }
      const m = /^(\d+)(?:[ _]+(.*))?$/.exec(d.name);
      if (!m || byId.has(Number(m[1]))) continue;
      const formats = new Set();
      walk(dir, (_f, name) => {
        const ext = path.extname(name).slice(1).toLowerCase();
        if (MACHINE_EXT.has(ext)) formats.add(ext.toUpperCase());
      });
      byId.set(Number(m[1]), { dir, name: m[2] || null, formats: [...formats].sort() });
    }
  };
  for (const base of designDirs) {
    if (!fs.existsSync(base)) { console.warn(`[scan] no existe: ${base}`); continue; }
    visit(base);
  }
  return byId;
}

function main() {
  const config = loadConfig();
  const outFile = path.join(ROOT, config.catalog.output);
  const previous = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')).designs : [];
  const byPhoto = new Map(previous.map((d) => [d.photo, d]));
  const known = new Set(previous.flatMap((d) => [d.photo, ...(d.extra_photos || [])]));
  const usedIds = new Set(previous.map((d) => d.id));
  const now = new Date().toISOString();

  const photos = [];
  for (const base of config.catalog.photoDirs) {
    if (!fs.existsSync(base)) { console.warn(`[scan] no existe: ${base}`); continue; }
    walk(base, (full, name) => {
      if (IMAGE_EXT.has(path.extname(name).toLowerCase())) photos.push(full.split(path.sep).join('/'));
    });
  }
  photos.sort();

  const machine = indexMachineDirs(config.catalog.designDirs);
  const designs = [];
  const unnumbered = [];
  let added = 0;

  // "134.jpg" es la foto principal; "134_1.jpg" / "134 (2).jpg" son fotos extra del mismo diseño.
  const extras = [];
  for (const photo of photos) {
    const prev = byPhoto.get(photo);
    if (prev) { designs.push(prev); continue; }
    if (known.has(photo)) continue;
    const base = path.parse(photo).name;
    if (/^\d+[ _(]/.test(base)) { extras.push(photo); continue; }
    const m = /^(\d+)$/.exec(base);
    const id = m ? Number(m[1]) : null;
    if (id === null || usedIds.has(id)) { unnumbered.push(photo); continue; }
    usedIds.add(id);
    designs.push({ id, photo, status: 'pending', added_at: now });
    added++;
  }

  const byId = new Map(designs.map((d) => [d.id, d]));
  for (const photo of extras) {
    const target = byId.get(Number(/^\d+/.exec(path.parse(photo).name)[0]));
    if (!target) { unnumbered.push(photo); continue; }
    target.extra_photos = [...(target.extra_photos || []), photo];
  }

  // Imágenes sin número (o con ID repetido): siguiente ID libre.
  let next = Math.max(0, ...usedIds) + 1;
  for (const photo of unnumbered) {
    designs.push({ id: next, photo, status: 'pending', added_at: now });
    usedIds.add(next++);
    added++;
  }

  for (const d of designs) {
    const mach = machine.get(d.id);
    d.name = d.name ?? mach?.name ?? null;
    d.machine_dir = mach ? mach.dir.split(path.sep).join('/') : null;
    d.machine_formats = mach ? mach.formats : [];
  }
  designs.sort((a, b) => a.id - b.id);

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify({ updated_at: now, designs }, null, 2));
  const withMachine = designs.filter((d) => d.machine_dir).length;
  console.log(`[scan] ${designs.length} diseños (${added} nuevos, ${withMachine} con archivos de máquina) → ${config.catalog.output}`);
}

main();
