// Cliente mínimo de xdopestore-api para el Publicador.
const fs = require('fs');
const path = require('path');

const base = () => process.env.XDOPE_API_URL.replace(/\/$/, '');
let token = null;

async function call(method, url, body, { form } = {}) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  if (body && !form) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${base()}${url}`, { method, headers, body: form ?? (body ? JSON.stringify(body) : undefined) });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status}: ${data?.message ?? text.slice(0, 200)}`);
  return data;
}

async function login() {
  const data = await call('POST', '/login', {
    // Usuario dedicado de los agentes (constitución, regla 10); XDOPE_ADMIN_* queda por compatibilidad con .env viejos.
    email: process.env.XDOPE_AGENT_EMAIL ?? process.env.XDOPE_ADMIN_EMAIL,
    password: process.env.XDOPE_AGENT_PASSWORD ?? process.env.XDOPE_ADMIN_PASSWORD,
  });
  token = data.access_token;
}

async function uploadImage(file) {
  const form = new FormData();
  form.append('attachments', new Blob([fs.readFileSync(file)], { type: 'image/jpeg' }), path.basename(file));
  const res = await call('POST', '/attachment', null, { form });
  return (res.data ? res.data[0] : res).id;
}

const list = async (url) => (await call('GET', url)).data;

module.exports = { call, login, uploadImage, list };
