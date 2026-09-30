const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });

function loadConfig() {
  const custom = path.join(ROOT, 'config', 'config.json');
  const file = fs.existsSync(custom) ? custom : path.join(ROOT, 'config', 'config.example.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function requireEnv(...names) {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length) throw new Error(`Faltan variables en .env: ${missing.join(', ')}`);
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
};

module.exports = { ROOT, loadConfig, requireEnv, readJson, writeJson };
