import { getSetting, setSetting } from './db.js';

// Free model backends. Ollama runs fully local; the others are OpenAI-compatible
// endpoints that offer free tiers. Users can point at any OpenAI-compatible server.
export const PRESETS = [
  { id: 'ollama', label: 'Ollama (local, 100% free & private)', provider: 'ollama', baseUrl: 'http://localhost:11434', needsKey: false },
  { id: 'lmstudio', label: 'LM Studio (local)', provider: 'openai', baseUrl: 'http://localhost:1234/v1', needsKey: false },
  { id: 'groq', label: 'Groq (free tier)', provider: 'openai', baseUrl: 'https://api.groq.com/openai/v1', needsKey: true, model: 'llama-3.3-70b-versatile' },
  { id: 'openrouter', label: 'OpenRouter (":free" models)', provider: 'openai', baseUrl: 'https://openrouter.ai/api/v1', needsKey: true, model: 'meta-llama/llama-3.3-70b-instruct:free' },
  { id: 'gemini', label: 'Google Gemini (free tier)', provider: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', needsKey: true, model: 'gemini-2.5-flash' },
];

export function getLLMConfig() {
  return { provider: 'ollama', baseUrl: 'http://localhost:11434', apiKey: '', model: '', think: false, ...getSetting('llm', {}) };
}

export async function listModels(cfg = getLLMConfig()) {
  try {
    if (cfg.provider === 'ollama') {
      const r = await fetch(`${cfg.baseUrl}/api/tags`);
      const j = await r.json();
      return (j.models || []).map((m) => ({ id: m.name, tools: (m.capabilities || []).includes('tools'), size: m.size }));
    }
    const r = await fetch(`${cfg.baseUrl}/models`, { headers: authHeaders(cfg) });
    const j = await r.json();
    return (j.data || []).map((m) => ({ id: m.id, tools: true }));
  } catch {
    return [];
  }
}

// Pick a sensible default model on first boot so the app works with zero setup.
export async function ensureDefaultModel() {
  const cfg = getLLMConfig();
  if (cfg.model) return cfg;
  const models = await listModels(cfg);
  const pick = models.find((m) => m.tools) || models[0];
  if (pick) setSetting('llm', { ...cfg, model: pick.id });
  return getLLMConfig();
}

function authHeaders(cfg) {
  const h = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) h.Authorization = `Bearer ${cfg.apiKey}`;
  if (cfg.baseUrl.includes('openrouter')) { h['HTTP-Referer'] = 'https://github.com/openbot'; h['X-Title'] = 'OpenBot'; }
  return h;
}

const parseArgs = (a) => {
  if (a == null) return {};
  if (typeof a === 'object') return a;
  try { return JSON.parse(a); } catch { return {}; }
};

/**
 * messages: OpenAI-style [{role, content, tool_calls?, tool_call_id?, name?}]
 * returns { content, tool_calls: [{id, name, arguments}] }
 */
export async function chat({ messages, tools = [], model, onToken, signal, json = false }) {
  const cfg = getLLMConfig();
  const m = model || cfg.model;
  if (!m) throw new Error('No model configured. Open Settings and pick a free model (e.g. install Ollama and run `ollama pull qwen3`).');
  return cfg.provider === 'ollama'
    ? chatOllama(cfg, m, messages, tools, onToken, signal, json)
    : chatOpenAI(cfg, m, messages, tools, signal, json);
}

async function chatOllama(cfg, model, messages, tools, onToken, signal, json) {
  const msgs = messages.map((x) => {
    if (x.role === 'assistant' && x.tool_calls?.length)
      return { role: 'assistant', content: x.content || '', tool_calls: x.tool_calls.map((t) => ({ function: { name: t.name, arguments: t.arguments } })) };
    if (x.role === 'tool') return { role: 'tool', content: x.content, tool_name: x.name };
    return { role: x.role, content: x.content ?? '' };
  });
  const body = { model, messages: msgs, stream: true, think: !!cfg.think, options: { num_ctx: 16384 } };
  if (json) body.format = 'json';
  if (tools.length) body.tools = tools.map((t) => ({ type: 'function', function: t }));

  let res = await fetch(`${cfg.baseUrl}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  if (!res.ok) {
    const err = await res.text();
    // Some models reject tools or thinking; retry in the simplest mode.
    if (/does not support (tools|thinking)/i.test(err)) {
      if (/tools/i.test(err)) delete body.tools;
      if (/thinking/i.test(err)) delete body.think;
      res = await fetch(`${cfg.baseUrl}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
      if (!res.ok) throw new Error(`Ollama: ${await res.text()}`);
    } else throw new Error(`Ollama: ${err}`);
  }

  let content = '';
  const toolCalls = [];
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const j = JSON.parse(line);
      if (j.error) throw new Error(`Ollama: ${j.error}`);
      const piece = j.message?.content;
      if (piece) { content += piece; onToken?.(piece); }
      for (const t of j.message?.tool_calls || [])
        toolCalls.push({ id: t.id || `call_${toolCalls.length}`, name: t.function.name, arguments: parseArgs(t.function.arguments) });
    }
  }
  return { content, tool_calls: toolCalls };
}

async function chatOpenAI(cfg, model, messages, tools, signal, json) {
  const msgs = messages.map((x) => {
    if (x.role === 'assistant' && x.tool_calls?.length)
      return { role: 'assistant', content: x.content || null, tool_calls: x.tool_calls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.arguments || {}) } })) };
    if (x.role === 'tool') return { role: 'tool', tool_call_id: x.tool_call_id, content: x.content };
    return { role: x.role, content: x.content ?? '' };
  });
  const body = { model, messages: msgs };
  if (tools.length) body.tools = tools.map((t) => ({ type: 'function', function: t }));
  if (json) body.response_format = { type: 'json_object' };
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, { method: 'POST', headers: authHeaders(cfg), body: JSON.stringify(body), signal });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const j = await res.json();
  const msg = j.choices?.[0]?.message || {};
  return {
    content: msg.content || '',
    tool_calls: (msg.tool_calls || []).map((t) => ({ id: t.id, name: t.function.name, arguments: parseArgs(t.function.arguments) })),
  };
}

// Convenience: ask for JSON and parse it leniently.
export async function chatJSON(prompt, system = 'You output only valid JSON.') {
  const { content } = await chat({ messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }], json: true });
  const m = content.match(/[\[{][\s\S]*[\]}]/);
  try { return JSON.parse(m ? m[0] : content); } catch { return null; }
}
