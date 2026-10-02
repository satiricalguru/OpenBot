import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import cron from 'node-cron';
import { all, get, run, now, uid, WORKSPACE_DIR } from '../db.js';
import { emit, logActivity } from '../events.js';
import { search, askVideo } from '../video/library.js';
import { fmtTime } from '../video/pipeline.js';

export const workspaceOf = (agentId) => {
  const d = path.join(WORKSPACE_DIR, agentId);
  fs.mkdirSync(d, { recursive: true });
  return d;
};

// Resolve a path inside the agent's own computer; never let it escape.
function safePath(agentId, p = '.') {
  const root = workspaceOf(agentId);
  const full = path.resolve(root, String(p).replace(/^\/+/, ''));
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error('Path is outside your workspace');
  return full;
}

const clip = (s, n = 6000) => (s.length > n ? s.slice(0, n) + `\n…[truncated ${s.length - n} chars]` : s);

function htmlToText(html) {
  return html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36';

async function webSearch(query) {
  const r = await fetch('https://html.duckduckgo.com/html/', {
    method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ q: query }),
  });
  const html = await r.text();
  const results = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) && results.length < 8) {
    let url = m[1];
    const u = url.match(/uddg=([^&]+)/);
    if (u) url = decodeURIComponent(u[1]);
    results.push({ title: htmlToText(m[2]), url, snippet: htmlToText(m[3]) });
  }
  return results;
}

// macOS: run commands inside a Seatbelt profile that only allows writes to the agent workspace.
function sandboxed(cmd, cwd) {
  if (process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec')) {
    const profile = `(version 1)(allow default)(deny file-write*)
      (allow file-write* (subpath "${cwd}") (subpath "/private/tmp") (subpath "/private/var/folders") (subpath "/dev"))`;
    return ['/usr/bin/sandbox-exec', ['-p', profile, '/bin/zsh', '-c', cmd]];
  }
  return ['/bin/sh', ['-c', cmd]];
}

function runCommand(agentId, command, timeoutMs = 60000) {
  const cwd = workspaceOf(agentId);
  const [bin, args] = sandboxed(command, cwd);
  return new Promise((resolve) => {
    const p = spawn(bin, args, { cwd, env: { ...process.env, HOME: cwd } });
    let out = '';
    const t = setTimeout(() => { p.kill('SIGKILL'); out += '\n[killed: timeout]'; }, timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => { clearTimeout(t); resolve(`exit ${code}\n${clip(out, 8000)}`); });
    p.on('error', (e) => { clearTimeout(t); resolve(`error: ${e.message}`); });
  });
}

/**
 * risk drives the default rule:  read → allow, write (inside own computer) → allow,
 * external side effects / shell → ask. Users can override per agent.
 */
export const TOOLS = [
  {
    name: 'web_search', risk: 'read', label: 'Search the web',
    description: 'Search the web (DuckDuckGo). Returns titles, URLs and snippets.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    run: async ({ query }) => JSON.stringify(await webSearch(query), null, 1),
  },
  {
    name: 'browse', risk: 'read', label: 'Open web pages',
    description: 'Open a URL in your browser and read its text content.',
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    run: async ({ url }, ctx) => {
      const r = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
      const html = await r.text();
      const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]?.trim() || url;
      logActivity(ctx.agent.id, 'browse', title, { url });
      return `# ${htmlToText(title)}\nURL: ${r.url}\nStatus: ${r.status}\n\n${clip(htmlToText(html), 7000)}`;
    },
  },
  {
    name: 'run_command', risk: 'dangerous', label: 'Run terminal commands',
    description: "Run a shell command on your own computer (cwd = your workspace). Use for scripts, data processing, git, curl, python, node. Writes outside the workspace are blocked.",
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    run: async ({ command }, ctx) => {
      logActivity(ctx.agent.id, 'terminal', command);
      return runCommand(ctx.agent.id, command);
    },
  },
  {
    name: 'list_files', risk: 'read', label: 'List files',
    description: 'List files in a folder of your workspace.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'folder, default "."' } } },
    run: async ({ path: p = '.' }, ctx) => {
      const d = safePath(ctx.agent.id, p);
      if (!fs.existsSync(d)) return 'Folder does not exist';
      return fs.readdirSync(d, { withFileTypes: true }).map((e) => (e.isDirectory() ? `${e.name}/` : `${e.name} (${fs.statSync(path.join(d, e.name)).size} B)`)).join('\n') || '(empty)';
    },
  },
  {
    name: 'read_file', risk: 'read', label: 'Read files',
    description: 'Read a text file from your workspace.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    run: async ({ path: p }, ctx) => clip(fs.readFileSync(safePath(ctx.agent.id, p), 'utf8'), 12000),
  },
  {
    name: 'write_file', risk: 'write', label: 'Write files',
    description: 'Create or overwrite a file in your workspace (reports, drafts, code, notes).',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    run: async ({ path: p, content }, ctx) => {
      const f = safePath(ctx.agent.id, p);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, content ?? '');
      logActivity(ctx.agent.id, 'file', `Wrote ${p}`, { path: p });
      emit('files', { agent_id: ctx.agent.id });
      return `Saved ${p} (${Buffer.byteLength(content ?? '')} bytes)`;
    },
  },
  {
    name: 'delete_file', risk: 'dangerous', label: 'Delete files',
    description: 'Delete a file from your workspace.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    run: async ({ path: p }, ctx) => { fs.rmSync(safePath(ctx.agent.id, p), { recursive: true, force: true }); emit('files', { agent_id: ctx.agent.id }); return `Deleted ${p}`; },
  },
  {
    name: 'http_request', risk: 'dangerous', label: 'Call external APIs',
    description: 'Make an HTTP request (GET/POST/PUT/DELETE) to an API or webhook. Use for integrations.',
    parameters: { type: 'object', properties: { method: { type: 'string' }, url: { type: 'string' }, headers: { type: 'object' }, body: { type: 'string' } }, required: ['url'] },
    run: async ({ method = 'GET', url, headers = {}, body }) => {
      const r = await fetch(url, { method, headers, body: ['GET', 'HEAD'].includes(method.toUpperCase()) ? undefined : body, signal: AbortSignal.timeout(30000) });
      return `HTTP ${r.status}\n${clip(await r.text(), 6000)}`;
    },
  },
  {
    name: 'remember', risk: 'write', label: 'Save memories',
    description: "Save a durable fact about the user, their preferences, goals or ongoing projects so you remember it next time.",
    parameters: { type: 'object', properties: { fact: { type: 'string' } }, required: ['fact'] },
    run: async ({ fact }, ctx) => {
      run('INSERT INTO memories(id, agent_id, content, created_at) VALUES(?,?,?,?)', uid(), ctx.agent.id, fact, now());
      logActivity(ctx.agent.id, 'memory', fact);
      return 'Remembered.';
    },
  },
  {
    name: 'recall', risk: 'read', label: 'Search memories',
    description: 'Search your long-term memory.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    run: async ({ query }, ctx) => {
      const words = String(query).toLowerCase().split(/\W+/).filter((w) => w.length > 2);
      const mems = all('SELECT content, created_at FROM memories WHERE agent_id = ? ORDER BY created_at DESC', ctx.agent.id);
      const hits = mems.filter((m) => words.some((w) => m.content.toLowerCase().includes(w)));
      return (hits.length ? hits : mems.slice(0, 10)).map((m) => `- ${m.content}`).join('\n') || 'No memories yet.';
    },
  },
  {
    name: 'search_videos', risk: 'read', label: 'Search video library',
    description: 'Search the OpenBot video library by spoken words, meaning, or visuals (objects, scenes, people). Returns video ids and timestamps.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    run: async ({ query }) => {
      const hits = await search(query, { limit: 10 });
      const titles = new Map(all('SELECT id, title FROM videos').map((v) => [v.id, v.title]));
      return hits.slice(0, 15).map((h) => `- ${titles.get(h.video_id)} [video_id=${h.video_id}] @ ${fmtTime(h.t)} (${h.type}${h.text ? `: "${h.text}"` : ''}) link: /watch/${h.video_id}?t=${Math.floor(h.t)}`).join('\n') || 'No matches.';
    },
  },
  {
    name: 'ask_video', risk: 'read', label: 'Ask questions about videos',
    description: 'Answer a question using the transcript of a video (pass video_id) or the whole library (omit video_id).',
    parameters: { type: 'object', properties: { question: { type: 'string' }, video_id: { type: 'string' } }, required: ['question'] },
    run: async ({ question, video_id }) => (await askVideo(question, { videoId: video_id || null })).answer,
  },
  {
    name: 'list_videos', risk: 'read', label: 'List videos',
    description: 'List videos in the library with ids, titles, durations and summaries.',
    parameters: { type: 'object', properties: {} },
    run: async () => all("SELECT id, title, duration, summary FROM videos WHERE status = 'ready' ORDER BY created_at DESC LIMIT 30")
      .map((v) => `- [${v.id}] ${v.title} (${fmtTime(v.duration)}): ${(v.summary || '').slice(0, 200)}`).join('\n') || 'Library is empty.',
  },
  {
    name: 'message_agent', risk: 'read', label: 'Talk to teammates',
    description: 'Hand off work to or ask a question of another teammate agent and wait for their reply.',
    parameters: { type: 'object', properties: { agent: { type: 'string', description: 'teammate name' }, message: { type: 'string' } }, required: ['agent', 'message'] },
    run: async ({ agent, message }, ctx) => {
      const other = get('SELECT * FROM agents WHERE lower(name) = lower(?)', String(agent).replace(/^@/, ''));
      if (!other) return `No teammate named ${agent}. Teammates: ${all('SELECT name FROM agents').map((a) => a.name).join(', ')}`;
      if (other.id === ctx.agent.id) return 'That is you.';
      if (ctx.depth >= 2) return 'Handoff depth limit reached; finish the work yourself.';
      const { runAgent, postMessage } = await import('./runtime.js');
      postMessage(ctx.threadId, { role: 'agent', agent_id: ctx.agent.id, content: `@${other.name} ${message}`, meta: { handoff: true } });
      const reply = await runAgent({ agentId: other.id, threadId: ctx.threadId, depth: ctx.depth + 1, from: ctx.agent.name });
      return `${other.name} replied: ${reply}`;
    },
  },
  {
    name: 'assign_task', risk: 'write', label: 'Assign background tasks',
    description: 'Assign a background task to a teammate (or yourself) that runs on its own without waiting.',
    parameters: { type: 'object', properties: { agent: { type: 'string' }, title: { type: 'string' }, instructions: { type: 'string' } }, required: ['agent', 'instructions'] },
    run: async ({ agent, title, instructions }, ctx) => {
      const other = get('SELECT * FROM agents WHERE lower(name) = lower(?)', String(agent).replace(/^@/, '')) || ctx.agent;
      const { createTask } = await import('./runtime.js');
      const t = createTask({ agentId: other.id, title: title || instructions.slice(0, 60), prompt: `${instructions}\n\n(Assigned by ${ctx.agent.name})` });
      return `Task ${t.id} assigned to ${other.name}.`;
    },
  },
  {
    name: 'schedule_routine', risk: 'dangerous', label: 'Create scheduled routines',
    description: 'Create a recurring routine for yourself, e.g. a daily briefing. cron uses 5 fields: "0 9 * * 1-5" = weekdays 9:00.',
    parameters: { type: 'object', properties: { name: { type: 'string' }, cron: { type: 'string' }, instructions: { type: 'string' } }, required: ['name', 'cron', 'instructions'] },
    run: async ({ name, cron: expr, instructions }, ctx) => {
      if (!cron.validate(expr)) return `Invalid cron expression: ${expr}`;
      const id = uid();
      run('INSERT INTO routines(id, agent_id, name, cron, prompt, enabled, created_at) VALUES(?,?,?,?,?,1,?)', id, ctx.agent.id, name, expr, instructions, now());
      const { reloadRoutines } = await import('./scheduler.js');
      reloadRoutines();
      emit('routines', {});
      return `Routine "${name}" scheduled (${expr}).`;
    },
  },
  {
    name: 'save_skill', risk: 'write', label: 'Learn skills',
    description: 'Save a reusable step-by-step procedure (a skill) you or the user figured out, so you can repeat it later.',
    parameters: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, steps: { type: 'string' } }, required: ['name', 'steps'] },
    run: async ({ name, description = '', steps }, ctx) => {
      run('INSERT INTO skills(id, agent_id, name, description, steps, created_at) VALUES(?,?,?,?,?,?)', uid(), ctx.agent.id, name, description, steps, now());
      emit('skills', { agent_id: ctx.agent.id });
      logActivity(ctx.agent.id, 'skill', `Learned skill: ${name}`);
      return `Skill "${name}" saved.`;
    },
  },
  {
    name: 'notify_user', risk: 'read', label: 'Send notifications',
    description: 'Send the user a notification (desktop + inbox). Use for finished work or things needing their judgment.',
    parameters: { type: 'object', properties: { title: { type: 'string' }, message: { type: 'string' } }, required: ['message'] },
    run: async ({ title = 'Update', message }, ctx) => {
      emit('notify', { agent_id: ctx.agent.id, title: `${ctx.agent.name}: ${title}`, message });
      logActivity(ctx.agent.id, 'notify', `${title}: ${message}`);
      return 'Notification sent.';
    },
  },
];

export const TOOL_MAP = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
export const DEFAULT_RULE = { read: 'allow', write: 'allow', dangerous: 'ask' };

// Things no agent may ever do on its own, regardless of rules.
export const HARD_LIMITS = [
  /\b(passwd|sudo|security\s+(add|delete|find)-|keychain)/i,
  /\brm\s+-rf\s+[\/~]/i,
  /\b(mkfs|diskutil\s+erase|shutdown|reboot)\b/i,
];

export function ruleFor(agent, toolName) {
  const tool = TOOL_MAP[toolName];
  const rules = typeof agent.rules === 'string' ? JSON.parse(agent.rules || '{}') : agent.rules || {};
  return rules[toolName] || DEFAULT_RULE[tool?.risk] || 'ask';
}
