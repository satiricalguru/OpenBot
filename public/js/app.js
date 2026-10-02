import { icon } from './icons.js';
import { setBotState } from './bot.js';
import { h, avatar, toast, ago, clockTime, popMenu, groupAvatar } from './ui.js';
import { api, on, onPage, clearPage, store, loadAgents, agentById } from './api.js';
import { route, fallback, dispatch, navigate } from './router.js';
import { agentsPage, agentPage, crewPage, tasksPage, inboxPage, routinesPage, assignTask, editAgent, newGroup, activityRow } from './agents.js';
import { libraryPage, watchPage, searchPage, analyticsPage, videoCard } from './videos.js';

// ---------------- environment & theme ----------------
const isElectron = /Electron/i.test(navigator.userAgent);
if (isElectron) document.body.classList.add('electron');
if (/Mac/i.test(navigator.platform)) document.body.classList.add('mac');

const pref = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const setPref = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const media = matchMedia('(prefers-color-scheme: light)');
export function applyTheme(mode = pref('theme', 'dark')) {
  const resolved = mode === 'system' ? (media.matches ? 'light' : 'dark') : mode;
  document.documentElement.dataset.theme = resolved;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', resolved === 'light' ? '#f6f6f7' : '#0a0a0a');
  window.openbot?.setTheme?.(mode);
}
media.addEventListener('change', () => pref('theme', 'dark') === 'system' && applyTheme());
applyTheme();
const toggleTheme = () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  setPref('theme', next);
  applyTheme(next);
  drawSide();
};

// ---------------- shell ----------------
const sidebar = h('aside.sidebar');
const main = h('main.main');
document.body.append(h('div.app', {}, sidebar, main));

let section = 'chats';
let filter = '';
let pendingCount = 0;
let threadsCache = [];
let videosCache = [];

const SECTION_OF = (p) => (p.startsWith('/library') || p.startsWith('/watch') || p.startsWith('/search') || p.startsWith('/analytics') ? 'videos'
  : p.startsWith('/agents/') || p.startsWith('/crew') ? 'chats'
  : p === '/' || p.startsWith('/tasks') || p.startsWith('/inbox') || p.startsWith('/routines') || p === '/agents' ? 'work' : null);

const fmtWhen = (ts) => {
  if (!ts) return '';
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString()) return clockTime(ts);
  if (now - d < 7 * 86400000) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
};
const plain = (s) => String(s || '').replace(/```[\s\S]*?```/g, '[code]').replace(/[*_`#>|]/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\s+/g, ' ').trim();

async function refreshData() {
  [threadsCache, videosCache] = await Promise.all([api.get('/api/threads'), api.get('/api/videos')]);
}

function conversations() {
  const out = [];
  for (const t of threadsCache.filter((t) => t.kind === 'group')) out.push({ kind: 'group', id: t.id, href: `/crew/${t.id}`, name: t.title, members: t.members.map(agentById).filter(Boolean), last: t.last, ts: t.last?.created_at || t.updated_at });
  for (const a of store.agents) {
    const t = threadsCache.find((x) => x.kind === 'direct' && x.members[0] === a.id);
    out.push({ kind: 'agent', id: a.id, href: `/agents/${a.id}`, name: a.name, agent: a, last: t?.last, ts: t?.last?.created_at || a.created_at });
  }
  return out.sort((x, y) => (y.ts || 0) - (x.ts || 0));
}

function convRow(c) {
  const path = location.pathname;
  const on = path === c.href || path.startsWith(c.href + '/');
  let prev, cls = '';
  const working = c.kind === 'agent' ? c.agent.status : c.members.find((m) => m.status !== 'idle')?.status;
  if (working === 'waiting') { prev = 'Needs your approval'; cls = 'need'; }
  else if (working === 'working') { prev = c.kind === 'agent' ? 'Working…' : `${c.members.find((m) => m.status === 'working')?.name} is working…`; cls = 'live'; }
  else if (c.last) {
    const who = c.last.role === 'user' ? 'You: ' : c.kind === 'group' ? `${agentById(c.last.agent_id)?.name || ''}: ` : '';
    prev = who + plain(c.last.content);
  } else prev = c.kind === 'agent' ? (c.agent.role || 'Say hi') : `${c.members.length} bots`;
  return h('a.conv', { href: c.href, class: on ? 'on' : '' },
    c.kind === 'agent' ? avatar(c.agent, 'md') : groupAvatar(c.members),
    h('div.meta', {}, h('div.top', {}, h('span.name', {}, c.name), h('span.time', {}, c.last ? fmtWhen(c.ts) : '')), h(`div.prev${cls ? '.' + cls : ''}`, {}, prev)));
}

function navRow(href, ic, label, extra) {
  const p = location.pathname;
  const on = href === '/' ? p === '/' : p === href || p.startsWith(href + '/');
  return h('a.nav-row', { href, class: on ? 'on' : '' }, icon(ic, 18), label, extra);
}

function drawSide() {
  const q = filter.toLowerCase();
  const list = h('div.sb-list');
  if (section === 'chats') {
    const convs = conversations().filter((c) => !q || c.name.toLowerCase().includes(q) || plain(c.last?.content).toLowerCase().includes(q));
    list.append(...convs.map(convRow));
    if (!convs.length) list.append(h('div.empty.small', {}, 'No chats match.'));
    if (!q) list.append(h('a.conv', { href: '#', onclick: (e) => { e.preventDefault(); editAgent(); } }, h('div.avatar.md', { style: { borderRadius: '50%', border: '1.5px dashed var(--line-2)', color: 'var(--muted)' } }, icon('plus', 18)), h('div.meta', {}, h('div.name', {}, 'New bot'), h('div.prev', {}, 'Create and customize a teammate'))));
  } else if (section === 'work') {
    list.append(
      navRow('/', 'home', 'Overview'),
      navRow('/inbox', 'inbox', 'Approvals', pendingCount ? h('span.count', {}, pendingCount) : null),
      navRow('/tasks', 'tasks', 'Tasks'),
      navRow('/routines', 'clock', 'Routines'),
      navRow('/agents', 'bot', 'All bots'));
  } else {
    list.append(navRow('/library', 'film', 'Library'), navRow('/search', 'search', 'Search moments'), navRow('/analytics', 'chart', 'Analytics'));
    const vids = videosCache.filter((v) => !q || v.title.toLowerCase().includes(q)).slice(0, 30);
    if (vids.length) list.append(h('div.sb-label', {}, 'Recent'), ...vids.map((v) => h('a.vrow', { href: `/watch/${v.id}`, class: location.pathname === `/watch/${v.id}` ? 'on' : '' },
      h('div.th', { style: { backgroundImage: v.thumb ? `url(${v.thumb})` : 'none' } }), h('div', { style: { minWidth: 0 } }, h('div.tt', {}, v.title), h('div.faint.small', {}, v.status === 'ready' ? ago(v.created_at) : v.stage || v.status)))));
  }

  const searchIn = h('input', { placeholder: section === 'videos' ? 'Search videos' : 'Search', value: filter, oninput: (e) => { filter = e.target.value; drawSide(); const i = sidebar.querySelector('.sb-search input'); i.focus(); i.setSelectionRange(filter.length, filter.length); } });
  const sw = (k, ic, label, extra) => h('button', { class: section === k ? 'on' : '', onclick: () => { section = k; filter = ''; drawSide(); } }, icon(ic, 14), label, extra);
  const name = pref('userName', 'You');
  const initials = name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  const light = document.documentElement.dataset.theme === 'light';

  sidebar.replaceChildren(
    h('div.sb-top', {},
      h('a.brand', { href: '/' }, h('img', { src: '/img/logo.svg', alt: '' }), h('span', {}, 'OpenBot')),
      h('div.spacer'),
      h('button.icon-btn', { title: 'New', onclick: (e) => popMenu(e.currentTarget, [
        { icon: 'bot', label: 'New bot', onClick: () => editAgent() },
        { icon: 'users', label: 'New group chat', onClick: () => newGroup() },
        { icon: 'zap', label: 'Assign a task', onClick: () => assignTask() },
        { icon: 'upload', label: 'Upload a video', onClick: () => navigate('/library') },
      ], { align: 'right' }) }, icon('compose', 18))),
    h('div.sb-search', {}, icon('search', 15), searchIn),
    h('div.sb-switch', {}, sw('chats', 'message', 'Chats'), sw('work', 'tasks', 'Work', pendingCount ? h('span.n', {}, pendingCount) : null), sw('videos', 'film', 'Videos')),
    list,
    h('div.sb-foot', {},
      h('div.me', {}, initials || 'Y'), h('div', { style: { flex: 1, fontWeight: 600, fontSize: '13.5px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, name),
      h('button.icon-btn', { title: light ? 'Dark mode' : 'Light mode', onclick: toggleTheme }, icon(light ? 'moon' : 'sun', 17)),
      h('a.icon-btn', { href: '/settings', title: 'Settings', class: location.pathname === '/settings' ? 'on' : '' }, icon('settings', 17))));
}

async function refreshPending() {
  pendingCount = (await api.get('/api/approvals?status=pending')).length;
  drawSide();
}
let sideTimer;
const redrawSoon = () => { clearTimeout(sideTimer); sideTimer = setTimeout(async () => { await refreshData(); drawSide(); }, 250); };

// ---------------- global live updates ----------------
on('agent_status', ({ agent_id, status }) => {
  const a = agentById(agent_id);
  if (a) a.status = status;
  setBotState(agent_id, status);
  redrawSoon();
});
on('agents', async () => { await loadAgents(); redrawSoon(); });
on('threads', redrawSoon);
on('message', ({ message }) => message.role !== 'tool' && redrawSoon());
on('videos', redrawSoon);
on('video', (e) => (e.status === 'ready' || e.thumb) && redrawSoon());
on('approval', refreshPending);
on('notify', ({ title, message, agent_id }) => {
  toast(title, message, () => navigate(agent_id ? `/agents/${agent_id}` : '/inbox'));
  if (document.hidden && window.Notification?.permission === 'granted') new Notification(title, { body: message, icon: '/img/icon-192.png' });
});

// ---------------- pages ----------------
function page(fn, { chat = false } = {}) {
  return (params, query) => {
    clearPage();
    const sec = SECTION_OF(location.pathname);
    if (sec && sec !== section) { section = sec; filter = ''; }
    drawSide();
    sidebar.classList.remove('open');
    const root = h(chat ? 'div' : 'div.scroll-page', chat ? { style: { height: '100%', minHeight: 0 } } : {});
    main.replaceChildren(...(chat ? [] : [h('div.mobile-top', {}, h('button.icon-btn', { onclick: () => sidebar.classList.add('open') }, icon('menu', 18)), h('b', {}, 'OpenBot'))]), ...(chat || !isElectron ? [] : [h('div.drag-strip')]), root);
    const cleanup = fn(root, params, query);
    return () => { if (typeof cleanup === 'function') cleanup(); else cleanup?.then?.((c) => typeof c === 'function' && c()); };
  };
}

async function homePage(root) {
  const ov = await api.get('/api/overview');
  const sel = h('select', {}, store.agents.map((a) => h('option', { value: a.id }, a.name)));
  const input = h('input', { placeholder: 'Give a bot real work…' });
  const go = async () => {
    if (!input.value.trim()) return;
    await api.post('/api/tasks', { agent_id: sel.value, prompt: input.value.trim() });
    input.value = '';
    toast('On it', 'Running in the background. You’ll get a ping when it’s done.', () => navigate('/tasks'));
    drawTasks();
  };
  input.addEventListener('keydown', (e) => e.key === 'Enter' && go());
  const mascot = store.agents[0];

  const crew = h('div.grid.g4');
  const drawCrew = () => crew.replaceChildren(...store.agents.map((a) => h('a.card.hover.crew-card', { href: `/agents/${a.id}` },
    h('div.row', {}, avatar(a, 'lg'), h('div', {}, h('b', {}, a.name), h('div.small.muted', {}, a.status === 'working' ? 'Working…' : a.status === 'waiting' ? 'Needs you' : 'Online'))),
    h('div.role', {}, a.role))),
    h('a.card.hover.crew-card', { href: '#', onclick: (e) => { e.preventDefault(); editAgent(); }, style: { alignItems: 'center', justifyContent: 'center', borderStyle: 'dashed', color: 'var(--muted)' } }, icon('plus', 26), h('b', {}, 'New bot')));
  drawCrew();
  onPage('agent_status', drawCrew);

  const tasks = h('div.card.pad-0.list');
  const drawTasks = async () => {
    const list = (await api.get('/api/tasks')).slice(0, 6);
    tasks.replaceChildren(...(list.length ? list.map((t) => { const a = agentById(t.agent_id); return h('a.item', { href: `/tasks/${t.id}` }, a ? avatar(a, 'sm') : null, h('div', { style: { flex: 1, minWidth: 0 } }, h('div', { style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontWeight: 550 } }, t.title), h('div.small.faint', {}, ago(t.updated_at))), h(`span.pill.${t.status === 'done' ? 'ok' : t.status === 'failed' ? 'bad' : 'warn'}`, {}, h('i.dotc'), t.status === 'running' ? 'working' : t.status)); }) : [h('div.empty.small', {}, 'No tasks yet. Hand one off above.')]));
  };
  drawTasks();
  onPage('task', drawTasks);

  const feed = h('div.feed');
  const drawFeed = async () => {
    const acts = (await api.get('/api/activity')).slice(0, 10);
    feed.replaceChildren(...(acts.length ? acts.map(activityRow) : [h('div.muted.small', {}, 'Your bots’ actions show up here.')]));
  };
  drawFeed();
  onPage('activity', drawFeed);
  const vids = videosCache.slice(0, 3);

  root.append(h('div.page', {},
    !ov.llm.model ? h('div.card', { style: { borderColor: 'var(--warn)', marginBottom: '16px' } }, h('b', {}, 'No AI model connected. '), 'Install Ollama (free), run ', h('code', {}, 'ollama pull qwen3'), ', or add a free key in ', h('a', { href: '/settings', style: { textDecoration: 'underline' } }, 'Settings'), '.') : null,
    h('div.hero', {},
      h('h1', {}, 'Meet', mascot ? avatar(mascot, 'lg') : null, 'your crew'),
      h('p.sub', {}, `AI teammates you can give real work to. ${ov.tasks ? `${ov.tasks} task${ov.tasks > 1 ? 's' : ''} running. ` : ''}${ov.pending ? `${ov.pending} waiting for your OK.` : 'Nothing needs you right now.'}`),
      h('div.handoff', {}, sel, input, h('button.btn.primary', { onclick: go }, 'Hand off')),
      h('div.small.faint', { style: { marginTop: '12px' } }, `${ov.llm.provider} · ${ov.llm.model || 'no model'} · free & private`)),
    h('div.row', { style: { margin: '18px 0 12px' } }, h('h2', { style: { margin: 0 } }, 'Bots'), h('div.spacer'), h('a.btn.sm.ghost', { href: '/agents' }, 'Manage')),
    crew,
    h('div.grid', { style: { gridTemplateColumns: 'minmax(0,1.25fr) minmax(0,1fr)', marginTop: '26px' } },
      h('div', {},
        h('div.row', { style: { marginBottom: '12px' } }, h('h2', { style: { margin: 0 } }, 'Recent tasks'), h('div.spacer'), h('a.btn.sm.ghost', { href: '/tasks' }, 'All tasks')), tasks,
        h('div.row', { style: { margin: '26px 0 12px' } }, h('h2', { style: { margin: 0 } }, 'Latest videos'), h('div.spacer'), h('a.btn.sm.ghost', { href: '/library' }, 'Library')),
        vids.length ? h('div.grid.g3', {}, vids.map(videoCard)) : h('a.card.hover.empty', { href: '/library', style: { display: 'block' } }, h('div.big', {}, icon('film', 30)), 'Upload a video to make it searchable')),
      h('div.feature', {}, h('h2', {}, 'Activity'), feed))));
}

async function settingsPage(root) {
  const s = await api.get('/api/settings');
  const cfg = { ...s.llm };
  const modelSel = h('select.input');
  const modelIn = h('input.input', { value: cfg.model, placeholder: 'model id', oninput: (e) => (cfg.model = e.target.value) });
  const drawModels = (models) => {
    modelSel.replaceChildren(h('option', { value: '' }, models.length ? 'Pick a model' : 'No models found (check URL / key)'), ...models.map((m) => h('option', { value: m.id, selected: m.id === cfg.model }, `${m.id}${m.tools ? '' : '  (no tool support)'}`)));
  };
  drawModels(s.models);
  modelSel.addEventListener('change', () => { cfg.model = modelSel.value; modelIn.value = modelSel.value; });
  const urlIn = h('input.input', { value: cfg.baseUrl, oninput: (e) => (cfg.baseUrl = e.target.value) });
  const keyIn = h('input.input', { type: 'password', value: cfg.apiKey, placeholder: 'Not needed for local models', oninput: (e) => (cfg.apiKey = e.target.value) });
  const refresh = async () => drawModels(await api.post('/api/settings/models', { provider: cfg.provider, baseUrl: cfg.baseUrl, apiKey: cfg.apiKey.startsWith('••••') ? undefined : cfg.apiKey }));
  const presets = h('div.row.wrap', { style: { gap: '6px', marginBottom: '18px' } }, s.presets.map((p) => h('button.btn.sm', { class: cfg.baseUrl === p.baseUrl ? 'primary' : '', onclick: (e) => {
    cfg.provider = p.provider; cfg.baseUrl = p.baseUrl; urlIn.value = p.baseUrl;
    if (p.model) { cfg.model = p.model; modelIn.value = p.model; }
    if (!p.needsKey) { cfg.apiKey = ''; keyIn.value = ''; }
    presets.querySelectorAll('button').forEach((b) => b.classList.remove('primary'));
    e.currentTarget.classList.add('primary');
    refresh();
  } }, p.label)));
  let whisper = s.whisperModel;
  const save = async () => { await api.put('/api/settings', { llm: cfg, whisperModel: whisper }); toast('Settings saved'); };
  const themeSeg = h('div.seg', {}, [['dark', 'Dark'], ['light', 'Light'], ['system', 'System']].map(([v, l]) => h('button', { class: pref('theme', 'dark') === v ? 'on' : '', onclick: (e) => {
    setPref('theme', v); applyTheme(v); drawSide();
    themeSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.currentTarget));
  } }, l)));
  const section = (title, sub, ...kids) => h('div.card', { style: { marginBottom: '16px', padding: '24px' } }, h('h2', { style: { marginBottom: '4px' } }, title), sub ? h('p.small.muted', { style: { margin: '0 0 18px' } }, sub) : null, ...kids);

  root.append(h('div.page', { style: { maxWidth: '760px' } },
    h('h1', {}, 'Settings'), h('p.sub', {}, 'OpenBot is free and open source. No subscriptions, no seats, no tracking.'),
    section('Appearance', 'Dark is the default.',
      h('div.row', {}, h('span', { style: { flex: 1 } }, 'Theme'), themeSeg),
      h('div.row', { style: { marginTop: '16px' } }, h('span', { style: { flex: 1 } }, 'Your name'), h('input.input', { style: { maxWidth: '240px' }, value: pref('userName', 'You'), onchange: (e) => { setPref('userName', e.target.value || 'You'); drawSide(); } }))),
    section('Brain', 'Pick a free model provider. Ollama keeps everything on your machine.',
      presets,
      h('label.field', {}, h('span', {}, 'Base URL'), urlIn),
      h('label.field', {}, h('span', {}, 'API key'), keyIn),
      h('label.field', {}, h('span', {}, 'Model'), h('div.row', {}, modelSel, h('button.icon-btn.solid', { onclick: refresh, title: 'Refresh models' }, icon('refresh', 15))), h('div', { style: { marginTop: '8px' } }, modelIn)),
      h('label.row', { style: { marginBottom: '6px' } }, h('input', { type: 'checkbox', checked: cfg.think, onchange: (e) => (cfg.think = e.target.checked) }), h('span', {}, 'Thinking mode (slower, smarter)')),
      h('p.small.faint', { style: { margin: '10px 0 0' } }, 'Bots need a model with tool support: qwen3, llama3.1/3.3, gemma4, mistral-small, gpt-oss…')),
    section('Video intelligence', 'Speech-to-text (Whisper) and visual search (CLIP) run locally. Models download once.',
      h('label.field', {}, h('span', {}, 'Whisper model'), h('select.input', { onchange: (e) => (whisper = e.target.value) },
        [['Xenova/whisper-tiny', 'Tiny: fastest'], ['Xenova/whisper-base', 'Base: balanced (default)'], ['Xenova/whisper-small', 'Small: most accurate'], ['distil-whisper/distil-small.en', 'Distil small (English, fast)']]
          .map(([v, l]) => h('option', { value: v, selected: v === whisper }, l))))),
    section('Notifications', null, h('div.row', {}, h('span', { style: { flex: 1 } }, 'Desktop notifications when bots finish or need you'), h('button.btn.sm', { onclick: () => window.Notification?.requestPermission().then((p) => toast(`Notifications ${p}`)) }, 'Enable'))),
    h('div.row', {}, h('button.btn.primary', { onclick: save }, 'Save changes'), h('div.spacer'), h('span.faint.small', {}, 'OpenBot · MIT'))));
}

// ---------------- routes ----------------
route('/', page(homePage));
route('/agents', page((root) => agentsPage(root)));
route('/agents/:id/:tab?', page((root, { id, tab }) => agentPage(root, id, tab), { chat: true }));
route('/crew/:id?', page((root, { id }) => crewPage(root, id), { chat: true }));
route('/tasks', page((root) => tasksPage(root)));
route('/tasks/:id', page((root, { id }) => tasksPage(root, id), { chat: true }));
route('/inbox', page((root) => inboxPage(root)));
route('/routines', page((root) => routinesPage(root)));
route('/library', page((root) => libraryPage(root)));
route('/watch/:id', page((root, { id }, q) => watchPage(root, id, q)));
route('/search', page((root, _, q) => searchPage(root, q)));
route('/analytics', page((root) => analyticsPage(root)));
route('/settings', page(settingsPage));
fallback(() => navigate('/', { replace: true }));

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); sidebar.querySelector('.sb-search input')?.focus(); }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); editAgent(); }
});

(async () => {
  await loadAgents();
  store.tools = await api.get('/api/tools');
  await refreshData();
  await refreshPending();
  dispatch();
})();
