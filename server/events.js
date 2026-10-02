import { run, now } from './db.js';

// Single in-process event bus fanned out to every connected browser over SSE.
const clients = new Set();

export function sseHandler(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('retry: 2000\n\n');
  clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => { clearInterval(ping); clients.delete(res); });
}

export function emit(type, data = {}) {
  const payload = `data: ${JSON.stringify({ type, ...data })}\n\n`;
  for (const c of clients) c.write(payload);
}

export function logActivity(agentId, kind, text, meta = null) {
  run('INSERT INTO activity(agent_id, kind, text, meta, created_at) VALUES(?,?,?,?,?)',
    agentId, kind, text, meta ? JSON.stringify(meta) : null, now());
  emit('activity', { agent_id: agentId, kind, text, meta, created_at: now() });
}
