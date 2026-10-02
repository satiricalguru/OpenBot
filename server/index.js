import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import cron from 'node-cron';
import { ROOT, DATA, VIDEO_DIR, all, get, run, now, uid, json, getSetting, setSetting } from './db.js';
import { sseHandler, emit } from './events.js';
import { PRESETS, getLLMConfig, listModels, ensureDefaultModel } from './llm.js';
import { TOOLS, DEFAULT_RULE, ruleFor, workspaceOf } from './agents/tools.js';
import { handleUserMessage, ensureDirectThread, createTask, decideApproval, stopRuns, expireStaleApprovals, distillSkill } from './agents/runtime.js';
import { reloadRoutines, runRoutine, startProactiveLoop } from './agents/scheduler.js';
import { enqueue, resumePending, makeClip, importFromUrl, captions, videoDir } from './video/pipeline.js';
import { createVideoRecord, serialize, deleteVideo, search, searchLibrary, askVideo } from './video/library.js';
import { seed } from './seed.js';

const app = express();
app.use(express.json({ limit: '5mb' }));
const PUBLIC = path.join(ROOT, 'public');
const upload = multer({ dest: path.join(DATA, 'uploads'), limits: { fileSize: 20 * 1024 ** 3 } });
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => { console.error(e); res.status(500).json({ error: e.message }); });

app.get('/api/events', sseHandler);

// ---------------- settings ----------------
app.get('/api/settings', wrap(async (req, res) => {
  const cfg = getLLMConfig();
  res.json({
    llm: { ...cfg, apiKey: cfg.apiKey ? '••••' + cfg.apiKey.slice(-4) : '' },
    presets: PRESETS, models: await listModels(cfg),
    whisperModel: getSetting('whisperModel', 'Xenova/whisper-base'),
  });
}));
app.put('/api/settings', wrap(async (req, res) => {
  const { llm, whisperModel } = req.body;
  if (llm) {
    const cur = getLLMConfig();
    const next = { ...cur, ...llm };
    if (!llm.apiKey || llm.apiKey.startsWith('••••')) next.apiKey = llm.provider === cur.provider && llm.baseUrl === cur.baseUrl ? cur.apiKey : (llm.apiKey?.startsWith('••••') ? cur.apiKey : '');
    setSetting('llm', next);
  }
  if (whisperModel) setSetting('whisperModel', whisperModel);
  res.json({ ok: true });
}));
app.post('/api/settings/models', wrap(async (req, res) => res.json(await listModels({ ...getLLMConfig(), ...req.body }))));

// ---------------- agents ----------------
const agentOut = (a) => a && ({ ...a, rules: json(a.rules, {}), proactive: !!a.proactive });
app.get('/api/agents', (req, res) => res.json(all('SELECT * FROM agents ORDER BY created_at').map(agentOut)));
app.post('/api/agents', (req, res) => {
  const { name, role = '', instructions = '', avatar = null, color = '#8b6cff', model = '', proactive = false } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const id = uid();
  run('INSERT INTO agents(id, name, avatar, color, role, instructions, model, rules, proactive, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    id, name.trim(), avatar, color, role, instructions, model, '{}', proactive ? 1 : 0, now());
  const crew = get("SELECT * FROM threads WHERE kind = 'group' ORDER BY created_at LIMIT 1");
  if (crew) run('UPDATE threads SET members = ? WHERE id = ?', JSON.stringify([...json(crew.members, []), id]), crew.id);
  emit('agents', {});
  res.json(agentOut(get('SELECT * FROM agents WHERE id = ?', id)));
});
app.patch('/api/agents/:id', (req, res) => {
  const a = get('SELECT * FROM agents WHERE id = ?', req.params.id);
  if (!a) return res.status(404).end();
  const b = req.body;
  run('UPDATE agents SET name = ?, avatar = ?, color = ?, role = ?, instructions = ?, model = ?, rules = ?, proactive = ? WHERE id = ?',
    b.name ?? a.name, b.avatar ?? a.avatar, b.color ?? a.color, b.role ?? a.role, b.instructions ?? a.instructions,
    b.model ?? a.model, b.rules ? JSON.stringify(b.rules) : a.rules, b.proactive != null ? (b.proactive ? 1 : 0) : a.proactive, a.id);
  emit('agents', {});
  res.json(agentOut(get('SELECT * FROM agents WHERE id = ?', a.id)));
});
app.delete('/api/agents/:id', (req, res) => {
  const id = req.params.id;
  for (const t of all('SELECT * FROM threads')) {
    const m = json(t.members, []);
    if (m.includes(id)) {
      if (t.kind === 'group' && m.length > 1) run('UPDATE threads SET members = ? WHERE id = ?', JSON.stringify(m.filter((x) => x !== id)), t.id);
      else run('DELETE FROM threads WHERE id = ?', t.id);
    }
  }
  for (const tbl of ['memories', 'skills', 'routines', 'tasks', 'approvals']) run(`DELETE FROM ${tbl} WHERE agent_id = ?`, id);
  run('DELETE FROM agents WHERE id = ?', id);
  fs.rmSync(path.join(DATA, 'workspaces', id), { recursive: true, force: true });
  reloadRoutines();
  emit('agents', {});
  res.json({ ok: true });
});
app.get('/api/agents/:id/direct', (req, res) => res.json(ensureDirectThread(req.params.id)));

app.get('/api/tools', (req, res) => res.json(TOOLS.map(({ name, label, description, risk }) => ({ name, label, description, risk, default: DEFAULT_RULE[risk] }))));
app.get('/api/agents/:id/rules', (req, res) => {
  const a = get('SELECT * FROM agents WHERE id = ?', req.params.id);
  res.json(Object.fromEntries(TOOLS.map((t) => [t.name, ruleFor(a, t.name)])));
});

// memories / skills
app.get('/api/agents/:id/memories', (req, res) => res.json(all('SELECT * FROM memories WHERE agent_id = ? ORDER BY created_at DESC', req.params.id)));
app.post('/api/agents/:id/memories', (req, res) => {
  run('INSERT INTO memories(id, agent_id, content, created_at) VALUES(?,?,?,?)', uid(), req.params.id, req.body.content, now());
  res.json({ ok: true });
});
app.delete('/api/memories/:id', (req, res) => { run('DELETE FROM memories WHERE id = ?', req.params.id); res.json({ ok: true }); });
app.get('/api/agents/:id/skills', (req, res) => res.json(all('SELECT * FROM skills WHERE agent_id = ? ORDER BY created_at DESC', req.params.id)));
app.post('/api/agents/:id/skills', (req, res) => {
  const { name, description = '', steps } = req.body;
  run('INSERT INTO skills(id, agent_id, name, description, steps, created_at) VALUES(?,?,?,?,?,?)', uid(), req.params.id, name, description, steps, now());
  res.json({ ok: true });
});
app.delete('/api/skills/:id', (req, res) => { run('DELETE FROM skills WHERE id = ?', req.params.id); res.json({ ok: true }); });

// the agent's computer
app.get('/api/agents/:id/files', (req, res) => {
  const root = workspaceOf(req.params.id);
  const walk = (dir, rel = '') => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const r = path.join(rel, e.name);
    if (e.name.startsWith('.')) return [];
    if (e.isDirectory()) return [{ path: r, dir: true }, ...walk(path.join(dir, e.name), r)];
    const st = fs.statSync(path.join(dir, e.name));
    return [{ path: r, size: st.size, mtime: st.mtimeMs }];
  });
  res.json(walk(root).slice(0, 500));
});
app.get('/api/agents/:id/file', (req, res) => {
  const root = workspaceOf(req.params.id);
  const f = path.resolve(root, String(req.query.path || ''));
  if (!f.startsWith(root + path.sep) || !fs.existsSync(f)) return res.status(404).end();
  if (req.query.download) return res.download(f);
  res.sendFile(f);
});

// ---------------- threads & messages ----------------
app.get('/api/threads', (req, res) => {
  const kind = req.query.kind;
  const rows = kind ? all('SELECT * FROM threads WHERE kind = ? ORDER BY updated_at DESC', kind) : all('SELECT * FROM threads ORDER BY updated_at DESC');
  res.json(rows.map((t) => ({ ...t, members: json(t.members, []), last: get("SELECT content, role, agent_id, created_at FROM messages WHERE thread_id = ? AND role != 'tool' ORDER BY created_at DESC LIMIT 1", t.id) })));
});
app.post('/api/threads', (req, res) => {
  const { title = 'New group', members = [] } = req.body;
  const id = uid();
  run('INSERT INTO threads(id, kind, title, members, created_at, updated_at) VALUES(?,?,?,?,?,?)', id, 'group', title, JSON.stringify(members), now(), now());
  emit('threads', {});
  res.json(get('SELECT * FROM threads WHERE id = ?', id));
});
app.patch('/api/threads/:id', (req, res) => {
  const t = get('SELECT * FROM threads WHERE id = ?', req.params.id);
  run('UPDATE threads SET title = ?, members = ? WHERE id = ?', req.body.title ?? t.title, JSON.stringify(req.body.members ?? json(t.members, [])), t.id);
  emit('threads', {});
  res.json({ ok: true });
});
app.delete('/api/threads/:id', (req, res) => { stopRuns(req.params.id); run('DELETE FROM threads WHERE id = ?', req.params.id); emit('threads', {}); res.json({ ok: true }); });
app.get('/api/threads/:id', (req, res) => {
  const t = get('SELECT * FROM threads WHERE id = ?', req.params.id);
  if (!t) return res.status(404).end();
  res.json({ ...t, members: json(t.members, []) });
});
app.get('/api/threads/:id/messages', (req, res) => {
  res.json(all('SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at', req.params.id).map((m) => ({ ...m, meta: json(m.meta, null) })));
});
app.post('/api/threads/:id/messages', (req, res) => {
  const content = String(req.body.content || '').trim();
  if (!content) return res.status(400).json({ error: 'empty' });
  handleUserMessage(req.params.id, content).catch((e) => console.error('[agent]', e));
  res.json({ ok: true });
});
app.post('/api/threads/:id/stop', (req, res) => { stopRuns(req.params.id); res.json({ ok: true }); });
app.post('/api/threads/:id/skill', wrap(async (req, res) => res.json(await distillSkill(req.body.agent_id, req.params.id))));
app.delete('/api/threads/:id/messages', (req, res) => { run('DELETE FROM messages WHERE thread_id = ?', req.params.id); emit('threads', {}); res.json({ ok: true }); });

// ---------------- tasks, approvals, routines, activity ----------------
app.get('/api/tasks', (req, res) => res.json(all('SELECT * FROM tasks ORDER BY created_at DESC LIMIT 200')));
app.post('/api/tasks', (req, res) => {
  const { agent_id, title, prompt } = req.body;
  if (!agent_id || !prompt) return res.status(400).json({ error: 'agent_id and prompt required' });
  res.json(createTask({ agentId: agent_id, title: title || prompt.slice(0, 70), prompt }));
});
app.delete('/api/tasks/:id', (req, res) => {
  const t = get('SELECT * FROM tasks WHERE id = ?', req.params.id);
  if (t) { stopRuns(t.thread_id); run('DELETE FROM threads WHERE id = ?', t.thread_id); run('DELETE FROM tasks WHERE id = ?', t.id); }
  emit('task', {});
  res.json({ ok: true });
});

app.get('/api/approvals', (req, res) => {
  const rows = req.query.status ? all('SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC', req.query.status) : all('SELECT * FROM approvals ORDER BY created_at DESC LIMIT 100');
  const names = new Map(all('SELECT id, name FROM agents').map((a) => [a.id, a.name]));
  res.json(rows.map((a) => ({ ...a, args: json(a.args, {}), agent_name: names.get(a.agent_id) })));
});
app.post('/api/approvals/:id', (req, res) => res.json({ ok: decideApproval(req.params.id, req.body.decision) }));

app.get('/api/routines', (req, res) => res.json(all('SELECT * FROM routines ORDER BY created_at DESC')));
app.post('/api/routines', (req, res) => {
  const { agent_id, name, cron: expr, prompt } = req.body;
  if (!cron.validate(expr)) return res.status(400).json({ error: 'Invalid cron expression' });
  run('INSERT INTO routines(id, agent_id, name, cron, prompt, enabled, created_at) VALUES(?,?,?,?,?,1,?)', uid(), agent_id, name, expr, prompt, now());
  reloadRoutines();
  res.json({ ok: true });
});
app.patch('/api/routines/:id', (req, res) => {
  const r = get('SELECT * FROM routines WHERE id = ?', req.params.id);
  const b = req.body;
  if (b.cron && !cron.validate(b.cron)) return res.status(400).json({ error: 'Invalid cron expression' });
  run('UPDATE routines SET name = ?, cron = ?, prompt = ?, enabled = ? WHERE id = ?', b.name ?? r.name, b.cron ?? r.cron, b.prompt ?? r.prompt, b.enabled != null ? (b.enabled ? 1 : 0) : r.enabled, r.id);
  reloadRoutines();
  res.json({ ok: true });
});
app.delete('/api/routines/:id', (req, res) => { run('DELETE FROM routines WHERE id = ?', req.params.id); reloadRoutines(); res.json({ ok: true }); });
app.post('/api/routines/:id/run', (req, res) => res.json(runRoutine(req.params.id)));

app.get('/api/activity', (req, res) => {
  const rows = req.query.agent ? all('SELECT * FROM activity WHERE agent_id = ? ORDER BY id DESC LIMIT 100', req.query.agent) : all('SELECT * FROM activity ORDER BY id DESC LIMIT 100');
  res.json(rows.map((r) => ({ ...r, meta: json(r.meta, null) })));
});

// ---------------- videos ----------------
app.get('/api/videos', (req, res) => res.json(all('SELECT * FROM videos ORDER BY created_at DESC').map(serialize)));
app.post('/api/videos', upload.array('files', 50), (req, res) => {
  const out = [];
  for (const f of req.files || []) {
    const ext = path.extname(f.originalname).toLowerCase() || '.mp4';
    const rec = createVideoRecord({ title: path.basename(f.originalname, ext), filename: `source${ext}`, mime: f.mimetype });
    fs.renameSync(f.path, path.join(videoDir(rec.id), `source${ext}`));
    enqueue(rec.id);
    out.push(serialize(rec));
  }
  emit('videos', {});
  res.json(out);
});
app.post('/api/videos/import', wrap(async (req, res) => {
  const url = String(req.body.url || '').trim();
  if (!/^https?:\/\//.test(url)) return res.status(400).json({ error: 'Enter an http(s) URL' });
  const rec = createVideoRecord({ title: url.split('/').pop().slice(0, 80) || 'Imported video', filename: 'source.mp4', mime: 'video/mp4', source_url: url });
  run("UPDATE videos SET stage = 'Downloading', status = 'processing' WHERE id = ?", rec.id);
  emit('videos', {});
  importFromUrl(rec, url).catch((e) => {
    run("UPDATE videos SET status = 'error', error = ? WHERE id = ?", e.message, rec.id);
    emit('video', { id: rec.id, status: 'error', error: e.message });
  });
  res.json(serialize(rec));
}));
app.get('/api/videos/:id', (req, res) => {
  const v = get('SELECT * FROM videos WHERE id = ?', req.params.id);
  if (!v) return res.status(404).json({ error: 'not found' });
  res.json({ ...serialize(v), segments: all('SELECT id, start, end, text FROM segments WHERE video_id = ? ORDER BY start', v.id) });
});
app.patch('/api/videos/:id', (req, res) => {
  const v = get('SELECT * FROM videos WHERE id = ?', req.params.id);
  if (!v) return res.status(404).end();
  const b = req.body;
  run('UPDATE videos SET title = ?, description = ?, visibility = ?, chapters = ?, tags = ?, updated_at = ? WHERE id = ?',
    b.title ?? v.title, b.description ?? v.description, b.visibility ?? v.visibility,
    b.chapters ? JSON.stringify(b.chapters) : v.chapters, b.tags ? JSON.stringify(b.tags) : v.tags, now(), v.id);
  emit('videos', {});
  res.json(serialize(get('SELECT * FROM videos WHERE id = ?', v.id)));
});
app.delete('/api/videos/:id', (req, res) => { deleteVideo(req.params.id); emit('videos', {}); res.json({ ok: true }); });
app.post('/api/videos/:id/reprocess', (req, res) => {
  run("UPDATE videos SET status = 'queued', stage = 'Queued', progress = 0, error = NULL WHERE id = ?", req.params.id);
  enqueue(req.params.id);
  res.json({ ok: true });
});
app.get('/api/videos/:id/search', wrap(async (req, res) => res.json(await search(req.query.q, { videoId: req.params.id, limit: 30 }))));
app.post('/api/videos/:id/ask', wrap(async (req, res) => {
  const reqId = req.body.req_id;
  res.json(await askVideo(req.body.question, { videoId: req.params.id, history: req.body.history || [], onToken: (t) => emit('ask_token', { req_id: reqId, token: t }) }));
}));
app.post('/api/videos/:id/clip', wrap(async (req, res) => {
  const { start, end, title } = req.body;
  if (!(end > start)) return res.status(400).json({ error: 'end must be after start' });
  res.json(serialize(await makeClip(req.params.id, Number(start), Number(end), title)));
}));
app.get('/api/videos/:id/captions.:fmt', (req, res) => {
  const v = get('SELECT title FROM videos WHERE id = ?', req.params.id);
  const fmt = req.params.fmt;
  res.type(fmt === 'vtt' ? 'text/vtt' : 'text/plain');
  if (req.query.download) res.attachment(`${(v?.title || 'captions').replace(/[^\w\- ]/g, '')}.${fmt}`);
  res.send(captions(req.params.id, fmt));
});
app.patch('/api/segments/:id', (req, res) => {
  run('UPDATE segments SET text = ? WHERE id = ?', String(req.body.text || ''), req.params.id);
  res.json({ ok: true });
});
app.post('/api/videos/:id/view', (req, res) => {
  const { session, seconds = 0, t = 0, referrer = '' } = req.body;
  const vid = req.params.id;
  const existing = get('SELECT * FROM views WHERE video_id = ? AND session = ?', vid, session);
  if (!existing) {
    run('INSERT INTO views(video_id, session, seconds, max_t, referrer, created_at, updated_at) VALUES(?,?,?,?,?,?,?)', vid, session, seconds, t, referrer, now(), now());
    run('UPDATE videos SET views = views + 1, watch_seconds = watch_seconds + ? WHERE id = ?', seconds, vid);
  } else {
    run('UPDATE views SET seconds = seconds + ?, max_t = max(max_t, ?), updated_at = ? WHERE id = ?', seconds, t, now(), existing.id);
    run('UPDATE videos SET watch_seconds = watch_seconds + ? WHERE id = ?', seconds, vid);
  }
  res.json({ ok: true });
});
app.get('/api/analytics', (req, res) => {
  const since = now() - 30 * 86400000;
  const daily = all(`SELECT date(created_at/1000, 'unixepoch', 'localtime') AS day, count(*) AS views, sum(seconds) AS seconds
                     FROM views WHERE created_at > ? ${req.query.video ? 'AND video_id = ?' : ''} GROUP BY day ORDER BY day`, since, ...(req.query.video ? [req.query.video] : []));
  const top = all('SELECT id, title, views, watch_seconds, duration FROM videos ORDER BY views DESC LIMIT 10');
  const totals = get('SELECT count(*) AS videos, sum(views) AS views, sum(watch_seconds) AS watch_seconds, sum(duration) AS duration, sum(size) AS size FROM videos');
  let retention = null;
  if (req.query.video) {
    const v = get('SELECT duration FROM videos WHERE id = ?', req.query.video);
    const rows = all('SELECT max_t FROM views WHERE video_id = ?', req.query.video);
    if (v?.duration && rows.length) retention = Array.from({ length: 20 }, (_, i) => rows.filter((r) => r.max_t >= (v.duration * i) / 20).length / rows.length);
  }
  res.json({ daily, top, totals, retention });
});
app.get('/api/search', wrap(async (req, res) => res.json(await searchLibrary(req.query.q))));
app.post('/api/ask', wrap(async (req, res) => {
  const reqId = req.body.req_id;
  res.json(await askVideo(req.body.question, { history: req.body.history || [], onToken: (t) => emit('ask_token', { req_id: reqId, token: t }) }));
}));

app.get('/api/overview', (req, res) => {
  res.json({
    agents: all('SELECT * FROM agents ORDER BY created_at').map(agentOut),
    pending: get("SELECT count(*) AS n FROM approvals WHERE status = 'pending'").n,
    tasks: get("SELECT count(*) AS n FROM tasks WHERE status = 'running'").n,
    videos: get('SELECT count(*) AS n FROM videos').n,
    routines: get('SELECT count(*) AS n FROM routines WHERE enabled = 1').n,
    llm: { provider: getLLMConfig().provider, model: getLLMConfig().model },
  });
});

// ---------------- static ----------------
app.use('/media', express.static(VIDEO_DIR, { maxAge: '1h' }));
app.get('/embed/:id', (req, res) => res.sendFile(path.join(PUBLIC, 'embed.html')));
app.use(express.static(PUBLIC));
app.get('/*splat', (req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));

// ---------------- boot ----------------
const PORT = Number(process.env.PORT || 4321);
const HOST = process.env.OPENBOT_HOST || '127.0.0.1';
expireStaleApprovals();
run("UPDATE agents SET status = 'idle'");
run("UPDATE tasks SET status = 'failed', result = 'Interrupted by restart' WHERE status = 'running'");
seed();
await ensureDefaultModel();
reloadRoutines();
startProactiveLoop();
resumePending();
app.listen(PORT, HOST, () => {
  const cfg = getLLMConfig();
  console.log(`\n  ◉ OpenBot is running → http://localhost:${PORT}\n    model: ${cfg.provider}/${cfg.model || '(none — open Settings)'}\n`);
});
