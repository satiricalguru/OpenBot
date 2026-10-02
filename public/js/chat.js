import { icon } from './icons.js';
import { h, md, avatar, clockTime, toast, esc, popMenu } from './ui.js';
import { api, onPage, store, agentById } from './api.js';
import { navigate } from './router.js';

const TOOL_VERB = {
  web_search: 'Searching the web', browse: 'Reading a page', run_command: 'Running a command', list_files: 'Looking at files',
  read_file: 'Reading a file', write_file: 'Writing a file', delete_file: 'Deleting a file', http_request: 'Calling an API',
  remember: 'Saving a memory', recall: 'Remembering', search_videos: 'Searching videos', ask_video: 'Watching a video',
  list_videos: 'Checking the library', message_agent: 'Talking to a teammate', assign_task: 'Assigning a task',
  schedule_routine: 'Scheduling a routine', save_skill: 'Learning a skill', notify_user: 'Sending you a note',
};
export const toolVerb = (name) => TOOL_VERB[name] || 'Working';

const dayLabel = (ts) => {
  const d = new Date(ts), now = new Date();
  const time = clockTime(ts);
  if (d.toDateString() === now.toDateString()) return time;
  const y = new Date(now - 86400000);
  if (d.toDateString() === y.toDateString()) return `Yesterday ${time}`;
  return `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} · ${time}`;
};

/**
 * Live conversation view shared by bot chats, crew group chats and task logs.
 * Grok-style: grey bubbles, centered timestamps, compact action lines,
 * bot-colored typing dots, inline approvals, pill composer with + and mic.
 */
export function chatView({ threadId, members = [], placeholder = 'Message…', onCall, extraMenu = [] }) {
  const msgsEl = h('div.msgs');
  const live = new Map(); // run_id -> { el, textEl, label, text, agent_id }
  const approvals = new Map();
  const isGroup = members.length > 1;
  let last = null; // { role, agent_id, created_at } of the last rendered bubble
  let atBottom = true;

  msgsEl.addEventListener('scroll', () => { atBottom = msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight < 90; });
  const scroll = (force) => { if (force || atBottom) requestAnimationFrame(() => (msgsEl.scrollTop = msgsEl.scrollHeight)); };
  msgsEl.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-link]');
    if (a) { e.preventDefault(); navigate(a.getAttribute('href')); }
  });

  function timeDivider(m) {
    if (!last || m.created_at - last.created_at > 15 * 60000) return h('div.when', {}, dayLabel(m.created_at));
    return null;
  }

  function renderMessage(m) {
    const frag = document.createDocumentFragment();
    const div = timeDivider(m);
    if (div) frag.append(div);
    if (m.role === 'tool') { frag.append(renderStep(m)); return frag; }

    if (m.role === 'user') {
      const first = !last || last.role !== 'user' || div;
      frag.append(h(`div.msg.user${first ? '.first' : ''}`, { 'data-id': m.id }, h('div.body', {}, h('div.bubble', {}, m.content))));
    } else {
      const a = agentById(m.agent_id) || { name: 'Bot', color: '#888' };
      if (m.meta?.handoff) {
        frag.append(h('div.sys', { 'data-id': m.id }, `${a.name} → ${m.content.split(' ')[0].replace('@', '')}: `, h('span.faint', {}, m.content.split(' ').slice(1).join(' ').slice(0, 140))));
        last = { ...m, role: 'sys' };
        return frag;
      }
      const first = !last || last.role !== 'agent' || last.agent_id !== m.agent_id || div;
      frag.append(h(`div.msg${first ? '.first' : ''}`, { 'data-id': m.id },
        h('div.av-slot', {}, first ? avatar(a, 'sm') : null),
        h('div.body', {},
          first && isGroup ? h('div.who', {}, a.name) : null,
          h('div.bubble.md', { html: md(m.content) }))));
    }
    last = m;
    return frag;
  }

  function renderStep(m) {
    const meta = m.meta || {};
    const argStr = Object.values(meta.args || {}).map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(' · ');
    const a = agentById(m.agent_id);
    const label = meta.status === 'running' ? `${toolVerb(meta.name)}…` : meta.label || meta.name;
    const det = h('details', {},
      h('summary', {}, h(`i.st.${meta.status || 'running'}`), isGroup && a ? h('span.faint', {}, a.name) : null, h('span.lbl', {}, label), h('span.arg', {}, argStr)),
      h('pre', {}, `${meta.name}(${JSON.stringify(meta.args || {}, null, 2)})\n\n${meta.result || '…'}`));
    const wrap = h('div.step', { 'data-id': m.id, 'data-agent': m.agent_id }, det);
    if (meta.status === 'waiting') attachApproval(wrap, m);
    return wrap;
  }

  async function attachApproval(wrap, m) {
    const pending = await api.get('/api/approvals?status=pending');
    const ap = pending.find((p) => p.thread_id === threadId && p.tool === m.meta?.name);
    if (!ap || approvals.has(ap.id)) return;
    const box = approvalBox(ap);
    approvals.set(ap.id, box);
    wrap.append(box);
    scroll();
  }

  function insert(el) {
    const firstLive = msgsEl.querySelector('.typing-line-wrap');
    firstLive ? msgsEl.insertBefore(el, firstLive) : msgsEl.append(el);
  }

  async function load() {
    const msgs = await api.get(`/api/threads/${threadId}/messages`);
    msgsEl.replaceChildren();
    last = null;
    if (!msgs.length) msgsEl.append(emptyState());
    for (const m of msgs) msgsEl.append(renderMessage(m));
    scroll(true);
  }

  function emptyState() {
    const bots = members.map((id) => agentById(id)).filter(Boolean);
    const sug = isGroup
      ? ['@all introduce yourselves in one line', '@Scout research the best free open-source LLMs and brief the team', '@Reel what videos do we have?']
      : ['What can you do?', 'Summarize today’s top AI news', 'Remember that I prefer short answers', 'Every weekday at 9am, send me a briefing'];
    return h('div.intro', {},
      h('div.bots', {}, bots.slice(0, 5).map((a) => avatar(a, isGroup ? 'lg' : 'xl'))),
      h('h2', { style: { fontSize: '22px' } }, isGroup ? 'Your crew is ready' : `Hey, I’m ${bots[0]?.name || 'your bot'}`),
      h('p.muted', { style: { maxWidth: '440px', margin: '0 auto' } }, isGroup ? 'Mention @name to talk to someone, or @all. The lead picks it up by default and hands work off.' : bots[0]?.role || 'Give me real work. I’ll come back with finished results.'),
      h('div.sug', {}, sug.map((s) => h('button', { onclick: () => send(s) }, s))));
  }

  // ---------- live events ----------
  onPage('message', ({ message: m }) => {
    if (m.thread_id !== threadId) return;
    msgsEl.querySelector('.intro')?.remove();
    if (msgsEl.querySelector(`[data-id="${m.id}"]`)) return;
    if (m.role === 'agent') for (const [rid, l] of live) if (l.agent_id === m.agent_id) { l.el.remove(); live.delete(rid); }
    insert(renderMessage(m));
    if (m.role === 'tool') {
      for (const l of live.values()) if (l.agent_id === m.agent_id) setLiveLabel(l, `${toolVerb(m.meta?.name)}…`);
    }
    scroll();
  });
  onPage('message_update', ({ id, meta, thread_id }) => {
    if (thread_id !== threadId) return;
    const old = msgsEl.querySelector(`[data-id="${id}"]`);
    if (!old) return;
    const wasOpen = old.querySelector('details')?.open;
    const el = renderStep({ id, meta, agent_id: old.dataset.agent });
    if (wasOpen) el.querySelector('details').open = true;
    old.replaceWith(el);
    scroll();
  });
  function setLiveLabel(l, label) { l.label.textContent = label; }
  onPage('run', ({ run_id, agent_id, thread_id, state }) => {
    if (thread_id !== threadId) return;
    if (state === 'start') {
      const a = agentById(agent_id) || {};
      const label = h('span', {}, isGroup ? `${a.name} is thinking…` : 'Thinking…');
      const textEl = h('div.bubble.md', { style: { display: 'none' } });
      const el = h('div', {},
        h('div.typing-line', {}, h('span.typing', { style: { '--c': a.color } }, h('span'), h('span'), h('span')), label),
        h('div.msg', {}, h('div.av-slot', {}, avatar({ ...a, status: 'working' }, 'sm')), h('div.body', {}, textEl)));
      el.className = 'typing-line-wrap';
      el.querySelector('.msg').style.display = 'none';
      live.set(run_id, { el, textEl, label, text: '', agent_id });
      msgsEl.append(el);
      setComposerBusy(true);
      scroll();
    } else {
      const l = live.get(run_id);
      if (l) { l.el.remove(); live.delete(run_id); }
      if (!live.size) setComposerBusy(false);
    }
  });
  onPage('token', ({ run_id, token }) => {
    const l = live.get(run_id);
    if (!l) return;
    l.text += token;
    l.el.querySelector('.msg').style.display = '';
    l.textEl.style.display = '';
    l.textEl.innerHTML = md(l.text);
    scroll();
  });
  onPage('token_reset', ({ run_id }) => {
    const l = live.get(run_id);
    if (!l) return;
    l.text = '';
    l.el.querySelector('.msg').style.display = 'none';
    msgsEl.append(l.el);
  });
  onPage('approval', ({ approval }) => {
    if (approval.thread_id !== threadId) return;
    if (approval.status === 'pending') {
      const steps = [...msgsEl.querySelectorAll('.step')].reverse();
      const target = steps.find((s) => s.querySelector('.st.waiting'));
      if (target && !approvals.has(approval.id)) {
        const box = approvalBox(approval);
        approvals.set(approval.id, box);
        target.append(box);
        scroll();
      }
    } else approvals.get(approval.id)?.remove();
  });

  function approvalBox(ap) {
    const a = agentById(ap.agent_id) || { name: ap.agent_name };
    const tool = store.tools.find((t) => t.name === ap.tool);
    const decide = async (decision) => { await api.post(`/api/approvals/${ap.id}`, { decision }); box.remove(); };
    const box = h('div.approve-box', {},
      h('div.q', {}, icon('shield', 15), `${a.name} wants to ${tool?.label?.toLowerCase() || ap.tool}`),
      h('pre', {}, Object.entries(ap.args || {}).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n')),
      h('div.row', {},
        h('button.btn.primary.sm', { onclick: () => decide('once') }, 'Allow once'),
        h('button.btn.sm', { onclick: () => decide('always') }, 'Always allow'),
        h('button.btn.sm.ghost', { onclick: () => decide('deny') }, 'Deny')));
    return box;
  }

  // ---------- composer ----------
  const ta = h('textarea', { rows: 1, placeholder });
  const pop = h('div.mention-pop', { style: { display: 'none' } });
  let popIdx = 0;
  const autosize = () => { ta.style.height = 'auto'; ta.style.height = Math.min(200, ta.scrollHeight) + 'px'; };
  function mentionState() {
    const before = ta.value.slice(0, ta.selectionStart);
    const m = before.match(/@(\w*)$/);
    if (!m || !isGroup) return null;
    const opts = [...members.map(agentById).filter(Boolean), { name: 'all', color: '#888' }].filter((a) => a.name.toLowerCase().startsWith(m[1].toLowerCase()));
    return opts.length ? { opts } : null;
  }
  function renderPop() {
    const st = mentionState();
    if (!st) { pop.style.display = 'none'; return; }
    popIdx = Math.min(popIdx, st.opts.length - 1);
    pop.replaceChildren(...st.opts.map((a, i) => h('div', { class: i === popIdx ? 'on' : '', onmousedown: (e) => { e.preventDefault(); pick(a); } }, a.name === 'all' ? icon('users', 18) : avatar(a, 'xs'), a.name)));
    pop.style.display = '';
  }
  function pick(a) {
    const pos = ta.selectionStart;
    const before = ta.value.slice(0, pos).replace(/@(\w*)$/, `@${a.name} `);
    ta.value = before + ta.value.slice(pos);
    ta.selectionStart = ta.selectionEnd = before.length;
    pop.style.display = 'none';
    ta.focus();
    syncAction();
  }
  ta.addEventListener('input', () => { autosize(); renderPop(); syncAction(); });
  ta.addEventListener('keydown', (e) => {
    const st = pop.style.display !== 'none' && mentionState();
    if (st) {
      if (e.key === 'ArrowDown') { popIdx = (popIdx + 1) % st.opts.length; renderPop(); e.preventDefault(); return; }
      if (e.key === 'ArrowUp') { popIdx = (popIdx - 1 + st.opts.length) % st.opts.length; renderPop(); e.preventDefault(); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { pick(st.opts[popIdx]); e.preventDefault(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });

  async function send(text) {
    const content = (text ?? ta.value).trim();
    if (!content) return;
    ta.value = '';
    autosize();
    syncAction();
    try { await api.post(`/api/threads/${threadId}/messages`, { content }); }
    catch (e) { toast('Could not send', e.message); }
  }

  let busy = false;
  const actionBtn = h('button.round', { title: 'Voice' });
  function syncAction() {
    const hasText = ta.value.trim().length > 0;
    actionBtn.className = `round${hasText ? ' go' : busy ? ' stop' : ''}`;
    actionBtn.replaceChildren(icon(hasText ? 'send' : busy ? 'stop' : 'mic', hasText ? 17 : 16));
    actionBtn.title = hasText ? 'Send' : busy ? 'Stop' : onCall ? 'Voice call' : 'Voice';
  }
  function setComposerBusy(b) { busy = b; syncAction(); }
  actionBtn.addEventListener('click', () => {
    if (ta.value.trim()) return send();
    if (busy) return api.post(`/api/threads/${threadId}/stop`);
    if (onCall) return onCall();
    dictate();
  });
  syncAction();

  function dictate() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return toast('Voice input not available', 'Your browser does not support speech recognition.');
    const rec = new SR();
    rec.interimResults = true;
    rec.onresult = (e) => { ta.value = [...e.results].map((r) => r[0].transcript).join(''); autosize(); syncAction(); };
    rec.start();
    toast('Listening…', 'Speak now');
  }

  const plusBtn = h('button.round', { title: 'More', onclick: (e) => popMenu(e.currentTarget, [
    { icon: 'zap', label: 'Run as background task', onClick: async () => {
      const prompt = ta.value.trim();
      if (!prompt) return toast('Type the task first', 'Then choose "Run as background task".');
      await api.post('/api/tasks', { agent_id: members[0], prompt });
      ta.value = ''; autosize(); syncAction();
      toast('Task started', 'It runs in the background. You’ll be notified.', () => navigate('/tasks'));
    } },
    { icon: 'upload', label: 'Upload a video', onClick: () => navigate('/library') },
    ...extraMenu,
  ], { up: true }) }, icon('plus', 18));

  const composer = h('div.composer', {},
    h('div.box', {}, pop, plusBtn, ta, actionBtn),
    h('div.hint', {}, isGroup ? '@mention a teammate or @all · Shift+Enter for a new line' : 'Runs on your free model · Shift+Enter for a new line'));

  load();
  return { el: [msgsEl, composer], send, reload: load, textarea: ta };
}

export { esc };
