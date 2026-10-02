// REST helpers + a single shared Server-Sent Events stream.
async function req(method, url, body) {
  const opts = { method, headers: {} };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const r = await fetch(url, opts);
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error(data?.error || r.statusText);
  return data;
}

export const api = {
  get: (u) => req('GET', u),
  post: (u, b = {}) => req('POST', u, b),
  put: (u, b = {}) => req('PUT', u, b),
  patch: (u, b = {}) => req('PATCH', u, b),
  del: (u) => req('DELETE', u),
};

const listeners = new Map();
export function on(type, fn) {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type).add(fn);
  return () => listeners.get(type)?.delete(fn);
}
const es = new EventSource('/api/events');
es.onmessage = (e) => {
  const d = JSON.parse(e.data);
  for (const fn of listeners.get(d.type) || []) fn(d);
  for (const fn of listeners.get('*') || []) fn(d);
};

// Listeners registered by a page are removed automatically when the route changes.
let scoped = [];
export function onPage(type, fn) { scoped.push(on(type, fn)); }
export function clearPage() { scoped.forEach((off) => off()); scoped = []; }

export const store = { agents: [], tools: [] };
export async function loadAgents() {
  store.agents = await api.get('/api/agents');
  return store.agents;
}
export const agentById = (id) => store.agents.find((a) => a.id === id);
