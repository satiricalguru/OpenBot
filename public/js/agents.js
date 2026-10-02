import { h, md, avatar, ago, bytes, toast, modal, confirmBox, prompt, seg, toggle, clockTime, popMenu, groupAvatar } from './ui.js';
import { api, onPage, store, agentById, loadAgents } from './api.js';
import { chatView } from './chat.js';
import { navigate } from './router.js';

import { LOOK_OPTIONS, PALETTE, EYE_COLORS, lookOf, randomLook } from './bot.js';
import { icon } from './icons.js';

const ROLE_TEMPLATES = [
  ['Researcher', 'Researches topics on the web and writes cited briefs.'],
  ['Writer', 'Drafts posts, emails, scripts and docs in my voice.'],
  ['Video editor', 'Finds moments in my videos, writes show notes and suggests clips.'],
  ['Developer', 'Writes, runs and tests code and automations.'],
  ['Analyst', 'Crunches data, builds tables and spots trends.'],
  ['Assistant', 'Keeps track of my goals, follow-ups and daily briefings.'],
];

// ---------------- agent studio (create / customize) ----------------
export function editAgent(agent = null) {
  const base = agent || { name: '', role: '', instructions: '', color: PALETTE[Math.floor(Math.random() * PALETTE.length)], model: '', proactive: false };
  const state = { ...base };
  const look = agent ? lookOf(agent) : { ...randomLook(), color: state.color };
  let previewState = 'idle';

  const stage = h('div');
  const nameTag = h('b', { style: { fontSize: '16px' } });
  const paintStage = () => {
    stage.replaceChildren(avatar({ ...state, avatar: JSON.stringify(look), color: look.color, id: 'studio' }, 'xl', { state: previewState }));
    nameTag.textContent = state.name || 'New teammate';
  };
  const optSections = h('div');
  const paintOptions = () => {
    optSections.replaceChildren(
      ...[['shape', 'Shape'], ['eyes', 'Eyes'], ['mouth', 'Mouth'], ['acc', 'Accessory'], ['gaze', 'Looking']].map(([key, label]) =>
        h('div.opt-row', {}, h('span', {}, label), h('div.chips', {}, LOOK_OPTIONS[key].map(([v, l]) => h('button', {
          class: look[key] === v ? 'on' : '', title: l,
          onclick: () => { look[key] = v; paintStage(); paintOptions(); },
        }, avatar({ name: 'x', avatar: JSON.stringify({ ...look, [key]: v }), color: look.color }, 'sm', { state: 'still' }), l))))),
      h('div.opt-row', {}, h('span', {}, 'Body color'), h('div.swatches', {},
        PALETTE.map((c) => h('button', { class: look.color === c ? 'on' : '', style: { background: c }, onclick: () => { look.color = state.color = c; paintStage(); paintOptions(); } })),
        h('input', { type: 'color', value: look.color, style: { width: '28px', height: '26px', border: 0, background: 'none', cursor: 'pointer' }, onchange: (e) => { look.color = state.color = e.target.value; paintStage(); paintOptions(); } }))),
      h('div.opt-row', {}, h('span', {}, 'Eye color'), h('div.swatches', {},
        EYE_COLORS.map((c) => h('button', { class: look.eye === c ? 'on' : '', style: { background: c }, onclick: () => { look.eye = c; paintStage(); paintOptions(); } })))),
      h('label.row', { style: { gap: '10px' } }, toggle(look.cheeks, (v) => { look.cheeks = v; paintStage(); paintOptions(); }), h('span.small', {}, 'Blush cheeks')));
  };
  paintStage(); paintOptions();

  const roleIn = h('input.input', { value: state.role, placeholder: 'What is this teammate responsible for?', oninput: (e) => (state.role = e.target.value) });
  const identity = h('div', {},
    h('label.field', {}, h('span', {}, 'Name'), h('input.input', { value: state.name, placeholder: 'e.g. Atlas', oninput: (e) => { state.name = e.target.value; nameTag.textContent = state.name || 'New teammate'; } })),
    h('label.field', {}, h('span', {}, 'Role'), roleIn,
      h('div.row.wrap', { style: { gap: '6px', marginTop: '8px' } }, ROLE_TEMPLATES.map(([t, r]) => h('button.btn.sm', { onclick: () => { state.role = r; roleIn.value = r; } }, t)))),
    h('label.field', {}, h('span', {}, 'Instructions & personality'), h('textarea.input', { placeholder: 'Tone, preferences, goals… e.g. "Witty but brief. Always cite sources."', oninput: (e) => (state.instructions = e.target.value) }, state.instructions || '')),
    h('label.field', {}, h('span', {}, 'Model override (optional)'), h('input.input', { value: state.model || '', placeholder: 'Leave empty to use the default model from Settings', oninput: (e) => (state.model = e.target.value) })),
    h('div.row', { style: { marginBottom: '10px' } }, toggle(state.proactive, (v) => (state.proactive = v)),
      h('div', {}, h('b', {}, 'Proactive mode'), h('div.muted.small', {}, 'Every 3 hours it does read-only research toward your goals and pings you if it finds something.'))));

  const tabsEl = h('div.tabs');
  const pane = h('div');
  const show = (k) => {
    tabsEl.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.k === k));
    pane.replaceChildren(k === 'look' ? optSections : identity);
  };
  for (const [k, l] of [['look', 'Appearance'], ['id', 'Identity & behavior']]) tabsEl.append(h('button', { 'data-k': k, onclick: () => show(k) }, l));
  show(agent ? 'look' : 'id');

  const states = h('div.seg', {}, [['idle', 'Idle'], ['working', 'Busy'], ['waiting', 'Waiting'], ['speaking', 'Talking']].map(([v, l]) =>
    h('button', { class: v === 'idle' ? 'on' : '', 'data-v': v, onclick: (e) => { previewState = v; e.currentTarget.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.currentTarget)); paintStage(); } }, l)));

  const body = h('div.studio', {},
    h('div.stage', {}, stage, nameTag, states,
      h('button.btn.sm', { onclick: () => { Object.assign(look, randomLook(), { color: PALETTE[Math.floor(Math.random() * PALETTE.length)] }); state.color = look.color; paintStage(); paintOptions(); } }, icon('shuffle', 14), 'Randomize')),
    h('div', {}, tabsEl, pane));

  modal(agent ? `Customize ${agent.name}` : 'Create a teammate', body, [
    { label: 'Cancel', cls: 'ghost' },
    { label: agent ? 'Save' : 'Create teammate', cls: 'primary', onClick: async () => {
      if (!state.name.trim()) { toast('Give your teammate a name'); show('id'); return false; }
      const payload = { ...state, color: look.color, avatar: JSON.stringify({ ...look, color: undefined }) };
      const saved = agent ? await api.patch(`/api/agents/${agent.id}`, payload) : await api.post('/api/agents', payload);
      await loadAgents();
      if (!agent) navigate(`/agents/${saved.id}`);
      else navigate(location.pathname, { replace: true });
    } },
  ], { wide: true });
}

// ---------------- teammates grid ----------------
export function agentsPage(root) {
  const grid = h('div.grid.g3');
  const draw = () => {
    grid.replaceChildren(...store.agents.map((a) => h('div.card.hover.crew-card', { onclick: () => navigate(`/agents/${a.id}`) },
      h('div.row', {}, avatar(a, 'lg'), h('div', {}, h('b', {}, a.name), h('div.small.muted', {}, a.status === 'working' ? 'Working…' : a.status === 'waiting' ? 'Waiting for you' : 'Idle')), h('div.spacer'), a.proactive ? h('span.pill.accent', {}, 'proactive') : null),
      h('div.role', {}, a.role || 'No role yet'),
      h('div.row', {}, h('button.btn.sm', { onclick: (e) => { e.stopPropagation(); navigate(`/agents/${a.id}`); } }, 'Message'),
        h('button.btn.sm.ghost', { onclick: (e) => { e.stopPropagation(); navigate(`/agents/${a.id}/computer`); } }, 'Computer')))),
    h('div.card.hover.crew-card', { onclick: () => editAgent(), style: { alignItems: 'center', justifyContent: 'center', borderStyle: 'dashed', minHeight: '160px' } }, h('div', { style: { fontSize: '28px' } }, '+'), h('b', {}, 'Add a teammate')));
  };
  draw();
  onPage('agents', async () => { await loadAgents(); draw(); });
  onPage('agent_status', draw);
  root.replaceChildren(h('div.page', {},
    h('div.head', {}, h('div', {}, h('h1', {}, 'Teammates'), h('p.sub', {}, 'Always-on AI agents, each with its own computer, memory, skills and rules.')), h('button.btn.primary', { onclick: () => editAgent() }, '+ New teammate')),
    grid));
}

// ---------------- single bot conversation (Grok-style) ----------------
const PANEL_TABS = [['computer', 'Computer'], ['memory', 'Memory'], ['skills', 'Skills'], ['rules', 'Rules'], ['routines', 'Routines']];
const statusText = (s) => (s === 'working' ? 'Working…' : s === 'waiting' ? 'Waiting for you' : 'Online');

function getPanelPref() { try { return localStorage.getItem('panel') || ''; } catch { return ''; } }
function setPanelPref(v) { try { localStorage.setItem('panel', v); } catch {} }

export async function agentPage(root, id, tab) {
  const agent = agentById(id) || (await loadAgents(), agentById(id));
  if (!agent) return root.replaceChildren(h('div.page', {}, h('div.empty', {}, 'Bot not found')));
  const thread = await api.get(`/api/agents/${id}/direct`);
  let panelTab = tab || getPanelPref();
  const layout = h('div.chat-layout');
  const subt = h('div.subt', {}, statusText(agent.status));
  onPage('agent_status', (e) => { if (e.agent_id === id) subt.textContent = statusText(e.status); });

  const panelBtn = h('button.icon-btn', { title: 'Computer', onclick: () => togglePanel(panelTab && panelTab !== '' ? '' : 'computer') }, icon('monitor', 18));
  const moreMenu = (e) => popMenu(e.currentTarget, [
    { icon: 'wand', label: 'Customize bot', onClick: () => editAgent(agent) },
    { icon: 'brain', label: 'Memory', onClick: () => togglePanel('memory') },
    { icon: 'sparkles', label: 'Skills', onClick: () => togglePanel('skills') },
    { icon: 'shield', label: 'Rules & permissions', onClick: () => togglePanel('rules') },
    { icon: 'clock', label: 'Routines', onClick: () => togglePanel('routines') },
    '-',
    { icon: 'sparkles', label: 'Save chat as a skill', onClick: () => learnSkill() },
    { icon: 'clear', label: 'Clear conversation', onClick: async () => { if (await confirmBox('Clear conversation?', 'Memories and skills are kept.', 'Clear')) { await api.del(`/api/threads/${thread.id}/messages`); chat.reload(); } } },
    { icon: 'trash', label: `Delete ${agent.name}`, danger: true, onClick: async () => { if (await confirmBox(`Delete ${agent.name}?`, 'Its chats, memory, skills, routines and computer are removed.')) { await api.del(`/api/agents/${id}`); await loadAgents(); navigate('/'); } } },
  ], { align: 'right' });

  const learnSkill = async () => {
    toast('Learning…', `${agent.name} is turning this chat into a skill`);
    try { const s = await api.post(`/api/threads/${thread.id}/skill`, { agent_id: id }); toast('Skill learned', s.name, () => togglePanel('skills')); }
    catch (e) { toast('Could not learn a skill', e.message); }
  };

  const head = h('div.chat-head', {},
    h('button.icon-btn.mobile-only', { onclick: () => document.querySelector('.sidebar')?.classList.add('open') }, icon('menu', 18)),
    avatar(agent, 'md'),
    h('div', { style: { minWidth: 0, cursor: 'pointer' }, onclick: () => editAgent(agent) }, h('div.title', {}, agent.name), subt),
    h('div.spacer'),
    h('button.icon-btn', { title: 'Call', onclick: () => voiceCall(agent, thread.id) }, icon('phone', 17)),
    panelBtn,
    h('button.icon-btn', { title: 'More', onclick: moreMenu }, icon('more', 18)));

  const chat = chatView({ threadId: thread.id, members: [id], placeholder: `Message ${agent.name}`, onCall: () => voiceCall(agent, thread.id),
    extraMenu: [{ icon: 'sparkles', label: 'Save chat as a skill', onClick: learnSkill }] });
  const chatCol = h('div.chat', {}, head, ...chat.el);

  function togglePanel(t) {
    panelTab = t;
    setPanelPref(t);
    layout.classList.toggle('panel-open', !!t);
    panelBtn.classList.toggle('on', !!t);
    layout.replaceChildren(chatCol, ...(t ? [botPanel(agent, t, togglePanel)] : []));
  }
  togglePanel(panelTab);
  root.replaceChildren(layout);
}

function botPanel(agent, tab, setTab) {
  const body = h('div.panel-body');
  const el = h('aside.panel', {},
    h('div.panel-head', {}, h('b', {}, PANEL_TABS.find((t) => t[0] === tab)?.[1] || ''), h('div.spacer'), h('button.icon-btn', { title: 'Close', onclick: () => setTab('') }, icon('x', 16))),
    h('div.tabs', {}, PANEL_TABS.map(([k, l]) => h('button', { class: k === tab ? 'active' : '', onclick: () => setTab(k) }, l))),
    body);
  ({ computer: computerTab, memory: memoryTab, skills: skillsTab, rules: rulesTab, routines: routinesTab })[tab]?.(body, agent);
  return el;
}

async function computerTab(root, agent) {
  const files = h('div.files');
  const preview = h('div');
  const term = h('div.terminal');
  const screenTb = h('span', {}, 'workspace');
  const screenContent = h('div.content');
  const what = h('div.what');
  const statusPill = h('span.pill');
  const paintStatus = () => {
    const a = agentById(agent.id) || agent;
    statusPill.className = `pill ${a.status === 'working' ? 'ok' : a.status === 'waiting' ? 'warn' : ''}`;
    statusPill.replaceChildren(h('i.dotc'), a.status === 'working' ? 'Working' : a.status === 'waiting' ? 'Needs you' : 'Idle');
  };
  paintStatus();
  onPage('agent_status', (e) => e.agent_id === agent.id && paintStatus());

  const drawFiles = async () => {
    const list = await api.get(`/api/agents/${agent.id}/files`);
    files.replaceChildren(...(list.length ? list.map((f) => h('div.f', { style: { paddingLeft: `${9 + (f.path.split('/').length - 1) * 14}px` }, onclick: () => !f.dir && open(f) },
      f.dir ? icon('folder', 15) : icon('file', 15), h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, f.path.split('/').pop()), f.dir ? null : h('span.faint.small', {}, bytes(f.size)))) : [h('div.muted.small', { style: { padding: '8px' } }, 'No files yet.')]));
  };
  const open = async (f) => {
    const url = `/api/agents/${agent.id}/file?path=${encodeURIComponent(f.path)}`;
    const headRow = h('div.row', { style: { margin: '12px 0 8px' } }, h('b.small', {}, f.path), h('div.spacer'), h('a.btn.sm', { href: url + '&download=1', download: true }, icon('download', 13)), h('button.btn.sm.ghost', { onclick: () => preview.replaceChildren() }, icon('x', 13)));
    if (/\.(png|jpe?g|gif|webp|svg)$/i.test(f.path)) return preview.replaceChildren(headRow, h('img', { src: url, style: { maxWidth: '100%', borderRadius: '12px' } }));
    if (/\.html?$/i.test(f.path)) return preview.replaceChildren(headRow, h('iframe', { src: url, sandbox: '', style: { width: '100%', height: '320px', border: '1px solid var(--line)', borderRadius: '12px', background: '#fff' } }));
    const text = await fetch(url).then((r) => r.text());
    preview.replaceChildren(headRow, /\.md$/i.test(f.path) ? h('div.card.md', { html: md(text), style: { padding: '14px' } }) : h('pre.terminal', {}, text.slice(0, 50000)));
  };
  const drawTerm = async () => {
    const acts = (await api.get(`/api/activity?agent=${agent.id}`)).filter((a) => ['terminal', 'browse', 'file'].includes(a.kind)).reverse();
    term.replaceChildren(...(acts.length ? acts.map((a) => h('div', {}, h('span.faint', {}, `${clockTime(a.created_at)} `),
      a.kind === 'terminal' ? [h('span.p', {}, '$ '), a.text] : a.kind === 'browse' ? ['↗ ', a.text] : ['✎ ', a.text])) : [h('span.faint', {}, 'Commands, pages and files will show up here.')]));
    term.scrollTop = term.scrollHeight;
    const lastAct = acts[acts.length - 1];
    if (lastAct) {
      screenTb.textContent = lastAct.kind === 'browse' ? (lastAct.meta?.url || lastAct.text) : lastAct.kind === 'terminal' ? 'zsh — workspace' : 'Files';
      what.textContent = lastAct.kind === 'browse' ? `Reading “${lastAct.text}”` : lastAct.kind === 'terminal' ? 'Running commands in the terminal' : lastAct.text;
      screenContent.replaceChildren(...acts.slice(-7).map((a) => h('div', {}, a.kind === 'terminal' ? `$ ${a.text}` : a.kind === 'browse' ? `↗ ${a.text}` : `✎ ${a.text}`)), h('div', {}, '$ ', h('span.cursor')));
    } else {
      what.textContent = `${agent.name}'s private, sandboxed computer.`;
      screenContent.replaceChildren(h('div.idle', {}, 'Idle. Give me a task and watch me work here.'));
    }
  };
  drawFiles(); drawTerm();
  onPage('files', (e) => e.agent_id === agent.id && drawFiles());
  onPage('activity', (e) => e.agent_id === agent.id && drawTerm());
  root.replaceChildren(
    h('div.computer', {},
      h('div.bar', {}, h('b', {}, 'Computer'), h('div.spacer'), statusPill),
      what,
      h('div.screen', {}, h('div.win', {}, h('div.tb', {}, h('i'), h('i'), h('i'), h('span', { style: { marginLeft: '6px', overflow: 'hidden', textOverflow: 'ellipsis' } }, screenTb)), screenContent))),
    h('div.row', { style: { margin: '4px 2px 6px' } }, h('b.small', {}, 'Files'), h('div.spacer'), h('button.icon-btn', { onclick: drawFiles, title: 'Refresh' }, icon('refresh', 14))),
    files, preview,
    h('div', { style: { margin: '16px 2px 6px' } }, h('b.small', {}, 'Activity log')), term);
}

async function memoryTab(root, agent) {
  const list = h('div');
  const draw = async () => {
    const mems = await api.get(`/api/agents/${agent.id}/memories`);
    list.replaceChildren(...(mems.length ? mems.map((m) => h('div.card', { style: { padding: '12px 14px', marginBottom: '8px', display: 'flex', gap: '10px' } }, h('div', { style: { flex: 1, fontSize: '13.5px' } }, m.content, h('div.faint.small', {}, ago(m.created_at))),
      h('button.icon-btn', { onclick: async () => { await api.del(`/api/memories/${m.id}`); draw(); } }, icon('x', 14)))) : [h('div.empty', {}, h('div.big', {}, icon('brain', 30)), 'Nothing yet. Tell me about you, your goals and preferences.')]));
  };
  draw();
  root.replaceChildren(h('p.muted.small', { style: { marginTop: 0 } }, `What ${agent.name} knows about you. Read before every task.`),
    h('button.btn.sm', { style: { marginBottom: '12px' }, onclick: async () => { const c = await prompt('Add a memory', { label: 'Fact', placeholder: 'e.g. I run a cooking channel on YouTube', multiline: true }); if (c) { await api.post(`/api/agents/${agent.id}/memories`, { content: c }); draw(); } } }, icon('plus', 14), 'Add memory'), list);
}

async function skillsTab(root, agent) {
  const list = h('div');
  const draw = async () => {
    const skills = await api.get(`/api/agents/${agent.id}/skills`);
    list.replaceChildren(...(skills.length ? skills.map((s) => h('details.card', { style: { padding: '12px 14px', marginBottom: '8px' } },
      h('summary', { style: { cursor: 'pointer', display: 'flex', gap: '8px', alignItems: 'center' } }, icon('sparkles', 14), h('b', { style: { flex: 1 } }, s.name), h('button.icon-btn', { onclick: async (e) => { e.preventDefault(); await api.del(`/api/skills/${s.id}`); draw(); } }, icon('x', 14))),
      s.description ? h('p.muted.small', {}, s.description) : null, h('div.md.small', { html: md(s.steps) }))) : [h('div.empty', {}, h('div.big', {}, icon('sparkles', 30)), 'No skills yet.', h('p.small', {}, 'Show me once in chat, then choose “Save chat as a skill”.'))]));
  };
  draw();
  onPage('skills', (e) => e.agent_id === agent.id && draw());
  root.replaceChildren(h('p.muted.small', { style: { marginTop: 0 } }, 'Reusable procedures learned from you.'),
    h('button.btn.sm', { style: { marginBottom: '12px' }, onclick: () => {
      const s = { name: '', description: '', steps: '' };
      modal('Teach a skill', h('div', {}, h('label.field', {}, h('span', {}, 'Name'), h('input.input', { oninput: (e) => (s.name = e.target.value), placeholder: 'Weekly competitor scan' })),
        h('label.field', {}, h('span', {}, 'When to use'), h('input.input', { oninput: (e) => (s.description = e.target.value) })),
        h('label.field', {}, h('span', {}, 'Steps'), h('textarea.input', { oninput: (e) => (s.steps = e.target.value), placeholder: '1. Search the web for …\n2. Open the top results…\n3. Write a summary to briefs/date.md' }))),
        [{ label: 'Cancel', cls: 'ghost' }, { label: 'Save', cls: 'primary', onClick: async () => { await api.post(`/api/agents/${agent.id}/skills`, s); draw(); } }]);
    } }, icon('plus', 14), 'Teach a skill'), list);
}

async function rulesTab(root, agent) {
  const rules = await api.get(`/api/agents/${agent.id}/rules`);
  const custom = { ...(agentById(agent.id) || agent).rules };
  const save = async () => { await api.patch(`/api/agents/${agent.id}`, { rules: custom }); await loadAgents(); };
  root.replaceChildren(
    h('p.muted.small', { style: { marginTop: 0 } }, 'Allow it, ask you first, or block it. Passwords, payments and 2FA always need you.'),
    ...store.tools.map((t) => h('div', { style: { padding: '10px 2px', borderBottom: '1px solid var(--line)' } },
      h('div.row', {}, h('b.small', { style: { flex: 1 } }, t.label), seg([['allow', 'Allow'], ['ask', 'Ask'], ['block', 'Block']], rules[t.name], (v) => { custom[t.name] = v; save(); })),
      h('div.faint.small', { style: { marginTop: '3px' } }, t.description))),
    h('button.btn.sm.ghost', { style: { marginTop: '12px' }, onclick: async () => { for (const k of Object.keys(custom)) delete custom[k]; await save(); rulesTab(root, agentById(agent.id)); toast('Rules reset'); } }, 'Reset to defaults'));
}

async function routinesTab(root, agent) {
  root.replaceChildren(h('p.muted.small', { style: { marginTop: 0 } }, `Jobs ${agent.name} runs on a schedule.`),
    h('button.btn.sm', { style: { marginBottom: '12px' }, onclick: () => editRoutine({ agent_id: agent.id }, () => routinesTab(root, agent)) }, icon('plus', 14), 'New routine'),
    await routineList((r) => r.agent_id === agent.id, () => routinesTab(root, agent), true));
}

// ---------------- routines ----------------
const CRON_PRESETS = [['0 9 * * *', 'Every day 9:00'], ['0 9 * * 1-5', 'Weekdays 9:00'], ['0 * * * *', 'Every hour'], ['*/15 * * * *', 'Every 15 min'], ['0 17 * * 5', 'Fridays 17:00'], ['0 8 1 * *', 'Monthly, 1st 8:00']];
const cronLabel = (c) => CRON_PRESETS.find((p) => p[0] === c)?.[1] || c;

export function editRoutine(r = {}, done) {
  const s = { name: '', cron: '0 9 * * *', prompt: '', agent_id: store.agents[0]?.id, ...r };
  const cronInput = h('input.input.mono', { value: s.cron, oninput: (e) => (s.cron = e.target.value) });
  modal(r.id ? 'Edit routine' : 'New routine', h('div', {},
    h('label.field', {}, h('span', {}, 'Teammate'), h('select.input', { onchange: (e) => (s.agent_id = e.target.value) }, store.agents.map((a) => h('option', { value: a.id, selected: a.id === s.agent_id }, a.name)))),
    h('label.field', {}, h('span', {}, 'Name'), h('input.input', { value: s.name, placeholder: 'Morning briefing', oninput: (e) => (s.name = e.target.value) })),
    h('label.field', {}, h('span', {}, 'Schedule (cron)'), cronInput, h('div.row.wrap', { style: { marginTop: '8px', gap: '6px' } }, CRON_PRESETS.map(([c, l]) => h('button.btn.sm', { onclick: () => { s.cron = c; cronInput.value = c; } }, l)))),
    h('label.field', {}, h('span', {}, 'Instructions'), h('textarea.input', { placeholder: 'Search for news about… summarize in 5 bullets, save to briefs/ and notify me.', oninput: (e) => (s.prompt = e.target.value) }, s.prompt))),
    [{ label: 'Cancel', cls: 'ghost' }, { label: 'Save', cls: 'primary', onClick: async () => {
      try { r.id ? await api.patch(`/api/routines/${r.id}`, s) : await api.post('/api/routines', s); done?.(); }
      catch (e) { toast('Could not save', e.message); return false; }
    } }]);
}

async function routineList(filter, refresh, compact = false) {
  const rows = (await api.get('/api/routines')).filter(filter);
  if (!rows.length) return h('div.card.empty', {}, h('div.big', {}, icon('clock', 30)), 'No routines yet.', h('p.small', {}, 'Or just ask: “every weekday at 9, brief me on…”'));
  const runNow = async (r) => { await api.post(`/api/routines/${r.id}/run`); toast('Routine started', r.name, () => navigate('/tasks')); };
  if (compact) return h('div', {}, rows.map((r) => h('div.card', { style: { padding: '12px 14px', marginBottom: '8px' } },
    h('div.row', {}, h('b', { style: { flex: 1 } }, r.name), toggle(!!r.enabled, (v) => api.patch(`/api/routines/${r.id}`, { enabled: v }))),
    h('div.small.muted', {}, cronLabel(r.cron), r.last_run ? ` · ran ${ago(r.last_run)}` : ''),
    h('div.row', { style: { marginTop: '8px', gap: '6px' } }, h('button.btn.sm', { onclick: () => runNow(r) }, icon('play', 11), 'Run'), h('button.btn.sm.ghost', { onclick: () => editRoutine(r, refresh) }, 'Edit'),
      h('button.btn.sm.ghost', { onclick: async () => { if (await confirmBox('Delete routine?', r.name)) { await api.del(`/api/routines/${r.id}`); refresh(); } } }, icon('trash', 13))))));
  return h('div.card.pad-0.list', {}, rows.map((r) => {
    const a = agentById(r.agent_id);
    return h('div.item', {}, a ? avatar(a, 'md') : null,
      h('div', { style: { flex: 1, minWidth: 0 } }, h('b', {}, r.name), h('div.small.muted', {}, `${cronLabel(r.cron)} · ${a?.name || ''}${r.last_run ? ` · last run ${ago(r.last_run)}` : ''}`), h('div.small.faint', { style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, r.prompt)),
      toggle(!!r.enabled, (v) => api.patch(`/api/routines/${r.id}`, { enabled: v })),
      h('button.btn.sm', { onclick: () => runNow(r) }, icon('play', 11), 'Run now'),
      h('button.btn.sm.ghost', { onclick: () => editRoutine(r, refresh) }, 'Edit'),
      h('button.icon-btn', { onclick: async () => { if (await confirmBox('Delete routine?', r.name)) { await api.del(`/api/routines/${r.id}`); refresh(); } } }, icon('trash', 15)));
  }));
}

export async function routinesPage(root) {
  const refresh = () => routinesPage(root);
  root.replaceChildren(h('div.page', {},
    h('div.head', {}, h('div', {}, h('h1', {}, 'Routines'), h('p.sub', {}, 'Recurring work your teammates do on a schedule, without being asked.')), h('button.btn.primary', { onclick: () => editRoutine({}, refresh) }, '+ New routine')),
    await routineList(() => true, refresh)));
}

// ---------------- crew (group chats) ----------------
export async function crewPage(root, threadId) {
  const threads = await api.get('/api/threads?kind=group');
  if (!threadId) {
    if (threads[0]) return navigate(`/crew/${threads[0].id}`, { replace: true });
    return newGroup();
  }
  const t = threads.find((x) => x.id === threadId) || (await api.get(`/api/threads/${threadId}`));
  const members = t.members.map((id) => agentById(id)).filter(Boolean);
  const chat = chatView({ threadId, members: t.members, placeholder: `Message ${t.title}` });
  const layout = h('div.chat-layout');
  let open = false;
  const membersPanel = () => h('aside.panel', {},
    h('div.panel-head', {}, h('b', {}, 'Members'), h('div.spacer'), h('button.icon-btn', { onclick: () => toggle() }, icon('x', 16))),
    h('div.panel-body', {},
      ...members.map((a) => h('div.conv', { onclick: () => navigate(`/agents/${a.id}`) }, avatar(a, 'md'), h('div.meta', {}, h('div.name', {}, a.name), h('div.prev', {}, a.role)))),
      h('button.btn.sm', { style: { margin: '10px 0 0 8px' }, onclick: () => editMembers(t) }, icon('users', 14), 'Edit members'),
      h('div.card', { style: { marginTop: '20px', padding: '14px' } }, h('b.small', {}, 'How crews work'),
        h('p.small.muted', { style: { margin: '6px 0 0' } }, 'The first member leads and answers by default. Bots pass work between themselves, assign background tasks, and only pull you in for approvals.'))));
  const panelBtn = h('button.icon-btn', { title: 'Members', onclick: () => toggle() }, icon('users', 18));
  const head = h('div.chat-head', {},
    h('button.icon-btn.mobile-only', { onclick: () => document.querySelector('.sidebar')?.classList.add('open') }, icon('menu', 18)),
    groupAvatar(members),
    h('div', { style: { minWidth: 0 } }, h('div.title', {}, t.title), h('div.subt', {}, members.map((a) => a.name).join(', '))),
    h('div.spacer'), panelBtn,
    h('button.icon-btn', { title: 'More', onclick: (e) => popMenu(e.currentTarget, [
      { icon: 'edit', label: 'Rename', onClick: async () => { const n = await prompt('Rename group', { value: t.title }); if (n) { await api.patch(`/api/threads/${t.id}`, { title: n }); crewPage(root, threadId); } } },
      { icon: 'users', label: 'Edit members', onClick: () => editMembers(t) },
      { icon: 'clear', label: 'Clear conversation', onClick: async () => { if (await confirmBox('Clear conversation?', '', 'Clear')) { await api.del(`/api/threads/${t.id}/messages`); chat.reload(); } } },
      ...(threads.length > 1 ? ['-', { icon: 'trash', label: 'Delete group', danger: true, onClick: async () => { if (await confirmBox('Delete this group chat?', t.title)) { await api.del(`/api/threads/${t.id}`); navigate('/crew'); } } }] : []),
    ], { align: 'right' }) }, icon('more', 18)));
  const chatCol = h('div.chat', {}, head, ...chat.el);
  function toggle() {
    open = !open;
    layout.classList.toggle('panel-open', open);
    panelBtn.classList.toggle('on', open);
    layout.replaceChildren(chatCol, ...(open ? [membersPanel()] : []));
  }
  layout.append(chatCol);
  root.replaceChildren(layout);
}

function editMembers(t) {
  const sel = new Set(t.members);
  modal('Group members', h('div', {}, store.agents.map((a) => h('label.row', { style: { padding: '6px 0', cursor: 'pointer' } },
    h('input', { type: 'checkbox', checked: sel.has(a.id), onchange: (e) => (e.target.checked ? sel.add(a.id) : sel.delete(a.id)) }), avatar(a, 'sm'), a.name))),
  [{ label: 'Cancel', cls: 'ghost' }, { label: 'Save', cls: 'primary', onClick: async () => { await api.patch(`/api/threads/${t.id}`, { members: [...t.members.filter((m) => sel.has(m)), ...[...sel].filter((m) => !t.members.includes(m))] }); navigate(`/crew/${t.id}`); } }]);
}

export function newGroup() {
  const sel = new Set(store.agents.map((a) => a.id));
  let title = 'New project';
  modal('New group chat', h('div', {},
    h('label.field', {}, h('span', {}, 'Name'), h('input.input', { value: title, oninput: (e) => (title = e.target.value) })),
    h('div.small.muted', { style: { marginBottom: '6px' } }, 'Members (first selected leads)'),
    store.agents.map((a) => h('label.row', { style: { padding: '5px 0' } }, h('input', { type: 'checkbox', checked: true, onchange: (e) => (e.target.checked ? sel.add(a.id) : sel.delete(a.id)) }), avatar(a, 'sm'), a.name))),
  [{ label: 'Cancel', cls: 'ghost' }, { label: 'Create', cls: 'primary', onClick: async () => { const t = await api.post('/api/threads', { title, members: store.agents.map((a) => a.id).filter((id) => sel.has(id)) }); navigate(`/crew/${t.id}`); } }]);
}

// ---------------- tasks ----------------
export function assignTask(preset = {}) {
  const s = { agent_id: preset.agent_id || store.agents[0]?.id, title: '', prompt: preset.prompt || '' };
  modal('Assign a task', h('div', {},
    h('label.field', {}, h('span', {}, 'Teammate'), h('select.input', { onchange: (e) => (s.agent_id = e.target.value) }, store.agents.map((a) => h('option', { value: a.id, selected: a.id === s.agent_id }, `${a.name} — ${a.role?.split('.')[0] || ''}`)))),
    h('label.field', {}, h('span', {}, 'What should it do?'), h('textarea.input', { style: { minHeight: '120px' }, placeholder: 'Research…, draft…, watch my latest video and write show notes…', oninput: (e) => (s.prompt = e.target.value) }, s.prompt))),
  [{ label: 'Cancel', cls: 'ghost' }, { label: 'Assign', cls: 'primary', onClick: async () => {
    if (!s.prompt.trim()) return false;
    await api.post('/api/tasks', s);
    toast('Task assigned', 'It runs in the background. You will be notified.', () => navigate('/tasks'));
  } }]);
}

export async function tasksPage(root, taskId) {
  if (taskId) {
    const t = (await api.get('/api/tasks')).find((x) => x.id === taskId);
    if (!t) return navigate('/tasks');
    const a = agentById(t.agent_id);
    const chat = chatView({ threadId: t.thread_id, members: [t.agent_id], placeholder: `Follow up with ${a?.name}…` });
    return root.replaceChildren(h('div.chat', {}, h('div.chat-head', {}, h('a.btn.sm.ghost', { href: '/tasks' }, icon('back', 15)), a ? avatar(a, 'sm') : null, h('div', {}, h('div.title', {}, t.title), h('div.small.muted', {}, `${a?.name} · ${ago(t.created_at)}`))), ...chat.el));
  }
  const cols = { running: h('div'), done: h('div'), failed: h('div') };
  const draw = async () => {
    const tasks = await api.get('/api/tasks');
    for (const k of Object.keys(cols)) cols[k].replaceChildren();
    for (const t of tasks) {
      const a = agentById(t.agent_id);
      const col = cols[t.status] || cols.running;
      col.append(h('div.task', { onclick: () => navigate(`/tasks/${t.id}`) },
        h('div.row', {}, a ? avatar(a, 'sm') : null, h('b', { style: { flex: 1 } }, t.title), h('span.faint.small', {}, ago(t.updated_at))),
        t.result ? h('div.small.muted', { style: { marginTop: '8px', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' } }, t.result) : null,
        t.routine_id ? h('span.pill', { style: { marginTop: '8px' } }, icon('clock', 12), 'routine') : null));
    }
    for (const k of Object.keys(cols)) if (!cols[k].children.length) cols[k].append(h('div.faint.small', { style: { padding: '10px' } }, 'Nothing here'));
  };
  draw();
  onPage('task', draw);
  root.replaceChildren(h('div.page.wide', {},
    h('div.head', {}, h('div', {}, h('h1', {}, 'Tasks'), h('p.sub', {}, 'Hand off a job and let it run. Teammates work in parallel in the background.')), h('button.btn.primary', { onclick: () => assignTask() }, '+ Assign task')),
    h('div.grid.g3', {},
      h('div.task-col', {}, h('h3', {}, 'In progress'), cols.running),
      h('div.task-col', {}, h('h3', {}, 'Done'), cols.done),
      h('div.task-col', {}, h('h3', {}, 'Failed'), cols.failed))));
}

// ---------------- inbox (approvals + activity) ----------------
export async function inboxPage(root) {
  const pend = h('div');
  const feed = h('div.feed');
  const draw = async () => {
    const list = await api.get('/api/approvals?status=pending');
    pend.replaceChildren(...(list.length ? list.map((ap) => {
      const a = agentById(ap.agent_id);
      const tool = store.tools.find((t) => t.name === ap.tool);
      const decide = async (d) => { await api.post(`/api/approvals/${ap.id}`, { decision: d }); draw(); };
      return h('div.card', { style: { marginBottom: '12px' } },
        h('div.row', {}, a ? avatar(a, 'sm') : null, h('b', {}, `${a?.name} wants to ${tool?.label?.toLowerCase() || ap.tool}`), h('div.spacer'), h('span.faint.small', {}, ago(ap.created_at))),
        h('pre.mono', { style: { whiteSpace: 'pre-wrap', color: 'var(--muted)', background: 'var(--bg-2)', padding: '10px', borderRadius: '8px' } }, Object.entries(ap.args).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n')),
        h('div.row', {}, h('button.btn.ok.sm', { onclick: () => decide('once') }, 'Allow once'), h('button.btn.sm', { onclick: () => decide('always') }, 'Always allow'), h('button.btn.sm.danger', { onclick: () => decide('deny') }, 'Deny'), h('div.spacer'),
          h('a.btn.sm.ghost', { href: '#', onclick: async (e) => { e.preventDefault(); const th = await api.get(`/api/threads/${ap.thread_id}`); if (th.kind === 'group') navigate(`/crew/${th.id}`); else if (th.kind === 'task') { const t = (await api.get('/api/tasks')).find((x) => x.thread_id === th.id); navigate(t ? `/tasks/${t.id}` : '/tasks'); } else navigate(`/agents/${ap.agent_id}`); } }, 'Open conversation →')));
    }) : [h('div.card.empty', {}, h('div.big', {}, icon('check', 34)), 'All clear. Nothing needs your approval.')]));
    const acts = await api.get('/api/activity');
    feed.replaceChildren(...acts.slice(0, 60).map(activityRow));
  };
  draw();
  onPage('approval', draw);
  onPage('activity', draw);
  root.replaceChildren(h('div.page', {}, h('h1', {}, 'Inbox'), h('p.sub', {}, 'Approvals your teammates need, and everything they have been doing.'),
    h('div.grid', { style: { gridTemplateColumns: '1.3fr 1fr' } }, h('div', {}, h('h2', {}, 'Needs your approval'), pend), h('div.card', {}, h('h2', {}, 'Activity'), feed))));
}

const KIND_ICON = { terminal: 'terminal', browse: 'globe', file: 'file', memory: 'brain', skill: 'sparkles', task: 'zap', task_done: 'check', approval: 'shield', notify: 'bell' };
export function activityRow(ev) {
  const a = agentById(ev.agent_id);
  return h('div.ev', {}, a ? avatar(a, 'sm') : null,
    h('div', { style: { minWidth: 0 } }, h('b', {}, a?.name || ''), ' ', h('span.muted', {}, icon(KIND_ICON[ev.kind] || 'zap', 13), ' ', ev.text)),
    h('span.t', {}, ago(ev.created_at)));
}

// ---------------- voice call (free: Web Speech API in the browser) ----------------
export function voiceCall(agent, threadId) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return toast('Voice not supported in this browser', 'Use Chrome, Edge or Safari for free in-browser speech recognition.');
  const orb = h('div.orb', { style: { display: 'none' } });
  const face = avatar(agent, 'xxl', { state: 'listening' });
  const setFace = (st) => face.querySelector('svg.bot').setAttribute('class', `bot ${st}`);
  const cap = h('div.cap', {}, 'Listening…');
  let active = true, speaking = false;
  const rec = new SR();
  rec.lang = navigator.language || 'en-US';
  rec.interimResults = true;
  rec.continuous = false;
  const listen = () => { if (!active || speaking) return; orb.className = 'orb listening'; setFace('listening'); cap.textContent = 'Listening…'; try { rec.start(); } catch {} };
  rec.onresult = (e) => {
    const r = e.results[e.results.length - 1];
    cap.textContent = r[0].transcript;
    if (r.isFinal) { orb.className = 'orb'; setFace('working'); cap.textContent = `“${r[0].transcript}” — thinking…`; api.post(`/api/threads/${threadId}/messages`, { content: r[0].transcript }); }
  };
  rec.onend = () => { if (active && !speaking && !cap.textContent.includes('thinking')) setTimeout(listen, 300); };
  const off = onPage('message', ({ message: m }) => {
    if (!active || m.thread_id !== threadId || m.role !== 'agent' || m.agent_id !== agent.id) return;
    const text = m.content.replace(/```[\s\S]*?```/g, ' (code omitted) ').replace(/[*_#`>|]/g, '').replace(/\]\([^)]*\)/g, ']');
    cap.textContent = text.slice(0, 400);
    speaking = true;
    orb.className = 'orb speaking'; setFace('speaking');
    const u = new SpeechSynthesisUtterance(text);
    u.onend = () => { speaking = false; listen(); };
    speechSynthesis.speak(u);
  });
  const end = () => { active = false; try { rec.abort(); } catch {} speechSynthesis.cancel(); el.remove(); };
  const el = h('div.call', {}, face, h('h2', { style: { color: '#fff' } }, `On a call with ${agent.name}`), orb, cap, h('button.btn', { style: { background: 'var(--bad)', color: '#fff', border: 0 }, onclick: end }, 'End call'));
  document.body.append(el);
  listen();
}

export { md };
