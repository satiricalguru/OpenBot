import { icon } from './icons.js';
import { h, md, fmtTime, ago, bytes, toast, modal, confirmBox, barChart, esc } from './ui.js';
import { api, onPage } from './api.js';
import { navigate } from './router.js';

const statusText = (v) => (v.status === 'ready' ? null : v.status === 'error' ? `Error: ${v.error || ''}` : `${v.stage || 'Queued'} · ${Math.round((v.progress || 0) * 100)}%`);

function videoCard(v) {
  const st = statusText(v);
  return h('div.vcard', { onclick: () => navigate(`/watch/${v.id}`), 'data-vid': v.id },
    h('div.thumb', { style: { backgroundImage: v.thumb ? `url(${v.thumb})` : 'none' } },
      v.duration ? h('span.dur', {}, fmtTime(v.duration)) : null,
      st ? h('div.state', {}, h('span', {}, st), v.status !== 'error' ? h('div.progress', {}, h('i', { style: { width: `${(v.progress || 0) * 100}%` } })) : null) : null),
    h('div.title', {}, v.title),
    h('div.meta', {}, [v.views ? `${v.views} views` : null, ago(v.created_at), v.parent_id ? 'clip' : null].filter(Boolean).join(' · ')));
}

// ---------------- library ----------------
export async function libraryPage(root) {
  const grid = h('div.vgrid');
  const fileInput = h('input', { type: 'file', accept: 'video/*,audio/*', multiple: true, style: { display: 'none' }, onchange: (e) => uploadFiles(e.target.files) });
  const progress = h('div');
  const draw = async () => {
    const vids = await api.get('/api/videos');
    grid.replaceChildren(...vids.map(videoCard));
    if (!vids.length) grid.append(h('div.empty', { style: { gridColumn: '1/-1' } }, h('div.big', {}, icon('film', 34)), 'Your library is empty. Drop a video above. It will be transcribed, indexed visually and summarized, all locally and free.'));
  };
  function uploadFiles(files) {
    if (!files?.length) return;
    const fd = new FormData();
    for (const f of files) fd.append('files', f);
    const xhr = new XMLHttpRequest();
    const bar = h('i', { style: { width: '0%' } });
    progress.replaceChildren(h('div.small.muted', { style: { margin: '10px 0 4px' } }, `Uploading ${files.length} file(s)…`), h('div.progress', {}, bar));
    xhr.upload.onprogress = (e) => (bar.style.width = `${(e.loaded / e.total) * 100}%`);
    xhr.onload = () => { progress.replaceChildren(); draw(); toast('Upload complete', 'Processing started: transcript, visual index and AI chapters.'); };
    xhr.onerror = () => toast('Upload failed');
    xhr.open('POST', '/api/videos');
    xhr.send(fd);
  }
  const drop = h('div.dropzone', { onclick: () => fileInput.click() },
    h('div', { style: { fontSize: '26px' } }, icon('upload', 28)), h('b', {}, 'Drop videos or audio here, or click to upload'),
    h('div.small', {}, 'MP4, MOV, WebM, MKV, MP3… Auto-transcribed with Whisper, visually indexed with CLIP, chaptered by AI. No size limits, no fees.'));
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); uploadFiles(e.dataTransfer.files); });

  const urlIn = h('input.input', { placeholder: 'Or paste a video URL to import (direct .mp4 link, or any site yt-dlp supports, for content you have rights to)' });
  const importUrl = async () => {
    if (!urlIn.value.trim()) return;
    try { await api.post('/api/videos/import', { url: urlIn.value.trim() }); urlIn.value = ''; draw(); toast('Import started'); }
    catch (e) { toast('Import failed', e.message); }
  };
  urlIn.addEventListener('keydown', (e) => e.key === 'Enter' && importUrl());

  onPage('video', (e) => {
    const card = grid.querySelector(`[data-vid="${e.id}"]`);
    if (!card || e.thumb || e.status === 'ready' || e.status === 'error') return draw();
    const st = card.querySelector('.state span');
    if (st) st.textContent = `${e.stage} · ${Math.round(e.progress * 100)}%`;
    const bar = card.querySelector('.progress i');
    if (bar) bar.style.width = `${e.progress * 100}%`;
  });
  onPage('videos', draw);
  draw();
  root.replaceChildren(h('div.page.wide', {},
    h('div.head', {}, h('div', {}, h('h1', {}, 'Video Library'), h('p.sub', {}, 'Host, search and understand every video by what is said and what is shown.')),
      h('a.btn', { href: '/search' }, icon('search', 14), 'Search everything'), h('a.btn', { href: '/analytics' }, icon('chart', 14), 'Analytics')),
    drop, fileInput, progress,
    h('div.row', { style: { margin: '14px 0 26px' } }, urlIn, h('button.btn', { onclick: importUrl }, 'Import')),
    grid));
}

// ---------------- watch ----------------
export async function watchPage(root, id, query) {
  let v;
  try { v = await api.get(`/api/videos/${id}`); } catch { return root.replaceChildren(h('div.page', {}, h('div.empty', {}, 'Video not found'))); }
  const video = h('video', { src: v.src, controls: true, playsinline: true, preload: 'metadata', poster: v.thumb || undefined },
    v.segments.length ? h('track', { kind: 'captions', src: `/api/videos/${id}/captions.vtt`, srclang: v.language || 'en', label: 'Captions' }) : null);
  const seek = (t, play = true) => { video.currentTime = t; if (play) video.play().catch(() => {}); };
  if (query.t) video.addEventListener('loadedmetadata', () => seek(Number(query.t), false), { once: true });

  // ---- chapters
  const chapters = v.chapters || [];
  const chapBar = h('div.chapbar');
  const chapList = h('div.chapters');
  const markers = h('div.markers');
  const drawChapters = () => {
    chapBar.replaceChildren(...chapters.map((c, i) => {
      const end = chapters[i + 1]?.start ?? v.duration;
      return h('div', { style: { flex: Math.max(0.5, end - c.start) }, title: `${fmtTime(c.start)} ${c.title}`, onclick: () => seek(c.start) });
    }));
    chapList.replaceChildren(...chapters.map((c) => h('div.ch', { onclick: () => seek(c.start) }, h('span.ts', {}, fmtTime(c.start)), h('span', {}, c.title))));
  };
  drawChapters();

  // ---- transcript
  const tfilter = h('input.input', { placeholder: 'Filter transcript…', style: { margin: '8px 0' } });
  const tlist = h('div');
  let editMode = false;
  const drawTranscript = () => {
    const q = tfilter.value.trim().toLowerCase();
    const re = q ? new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi') : null;
    tlist.replaceChildren(...v.segments.filter((s) => !q || s.text.toLowerCase().includes(q)).map((s) => {
      const text = h('span', { html: re ? esc(s.text).replace(re, '<mark>$1</mark>') : esc(s.text), contenteditable: editMode ? 'true' : null });
      if (editMode) text.addEventListener('blur', async () => { s.text = text.textContent; await api.patch(`/api/segments/${s.id}`, { text: s.text }); });
      return h('div.seg-line', { 'data-start': s.start, onclick: () => !editMode && seek(s.start) }, h('span.tt', {}, fmtTime(s.start)), text);
    }));
    if (!v.segments.length) tlist.append(h('div.muted.small', { style: { padding: '14px' } }, v.status === 'ready' ? 'No speech detected.' : 'Transcript will appear when processing finishes.'));
  };
  tfilter.addEventListener('input', drawTranscript);
  drawTranscript();

  let lastActive = null;
  video.addEventListener('timeupdate', () => {
    const t = video.currentTime;
    const lines = tlist.querySelectorAll('.seg-line');
    let active = null;
    for (const l of lines) if (Number(l.dataset.start) <= t + 0.2) active = l;
    if (active !== lastActive) {
      lastActive?.classList.remove('on');
      active?.classList.add('on');
      if (active && autoScroll && tabs.current === 'transcript') active.scrollIntoView({ block: 'center', behavior: 'smooth' });
      lastActive = active;
    }
    const ci = chapters.findLastIndex((c) => c.start <= t);
    chapBar.querySelectorAll('div').forEach((d, i) => d.classList.toggle('on', i === ci));
    chapList.querySelectorAll('.ch').forEach((d, i) => d.classList.toggle('on', i === ci));
  });
  let autoScroll = true;

  // ---- in-video search
  const sInput = h('input.input', { placeholder: 'Search words, topics or things you see…', style: { margin: '8px 0' } });
  const sResults = h('div');
  const runSearch = async () => {
    const q = sInput.value.trim();
    if (!q) return;
    sResults.replaceChildren(h('div.muted.small', { style: { padding: '10px' } }, 'Searching speech and visuals…'));
    const hits = await api.get(`/api/videos/${id}/search?q=${encodeURIComponent(q)}`);
    markers.replaceChildren(...hits.map((x) => h(`i${x.type === 'visual' ? '.visual' : ''}`, { style: { left: `${(x.t / (v.duration || 1)) * 100}%` }, title: fmtTime(x.t), onclick: () => seek(x.t) })));
    sResults.replaceChildren(...(hits.length ? hits.sort((a, b) => a.t - b.t).map((x) => h('div.hit', { onclick: () => seek(x.t) },
      x.frame ? h('img', { src: x.frame, loading: 'lazy' }) : null,
      h('div', {}, h('div.row', {}, h('span.tt', {}, fmtTime(x.t)), h('span.pill', {}, x.type === 'visual' ? [icon('eye', 12), 'seen'] : [icon('mic', 12), 'said'])), x.text ? h('div.small', {}, x.text) : null))) : [h('div.muted.small', { style: { padding: '10px' } }, 'No moments found.')]));
  };
  sInput.addEventListener('keydown', (e) => e.key === 'Enter' && runSearch());

  // ---- ask AI
  const askLog = h('div');
  const askIn = h('input.input', { placeholder: 'Ask anything about this video…' });
  const history = [];
  askLog.addEventListener('click', (e) => { const ts = e.target.closest('.ts'); if (ts) seek(ts.dataset.t.split(':').map(Number).reduce((a, b) => a * 60 + b, 0)); });
  const ask = async () => {
    const q = askIn.value.trim();
    if (!q) return;
    askIn.value = '';
    askLog.append(h('div.msg.user', { style: { padding: '4px 0' } }, h('div.bubble', {}, q)));
    const reqId = Math.random().toString(36).slice(2);
    const out = h('div.md.small', { style: { padding: '8px 4px 14px' } }, h('span.typing', {}, h('span'), h('span'), h('span')));
    askLog.append(out);
    let txt = '';
    const off = onPage('ask_token', (e) => { if (e.req_id === reqId) { txt += e.token; out.innerHTML = md(txt, { timestamps: true }); } });
    try {
      const r = await api.post(`/api/videos/${id}/ask`, { question: q, history, req_id: reqId });
      out.innerHTML = md(r.answer, { timestamps: true });
      history.push({ role: 'user', content: q }, { role: 'assistant', content: r.answer });
    } catch (e) { out.textContent = `Error: ${e.message}`; }
    askLog.parentElement.scrollTop = 1e9;
  };
  askIn.addEventListener('keydown', (e) => e.key === 'Enter' && ask());

  const tabs = { current: query.q ? 'search' : 'transcript' };
  const panes = {
    transcript: h('div', {}, h('div.row', {}, tfilter, h('button.btn.sm.ghost', { title: 'Edit transcript', onclick: (e) => { editMode = !editMode; e.target.textContent = editMode ? 'Done' : 'Edit'; drawTranscript(); } }, 'Edit')), tlist),
    search: h('div', {}, sInput, h('div.faint.small', { style: { padding: '0 4px 6px' } }, 'Finds what is said (exact words + meaning) and what is seen (objects, scenes, text on screen).'), sResults),
    chapters: h('div', { style: { paddingTop: '8px' } }, chapList, !chapters.length ? h('div.muted.small', { style: { padding: '10px' } }, 'No chapters yet.') : null),
    ask: h('div', {}, h('div.muted.small', { style: { padding: '8px 4px' } }, 'Answers come from the transcript and visual index, with clickable timestamps.'), askLog),
  };
  const scroll = h('div.scroll');
  const tabBar = h('div.tabs');
  const askFoot = h('div', { style: { padding: '10px', borderTop: '1px solid var(--line)', display: 'none' } }, h('div.row', {}, askIn, h('button.btn.primary', { onclick: ask }, icon('send', 17))));
  const setTab = (k) => {
    tabs.current = k;
    tabBar.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.k === k));
    scroll.replaceChildren(panes[k]);
    askFoot.style.display = k === 'ask' ? '' : 'none';
    if (k === 'ask') askIn.focus();
  };
  for (const [k, l] of [['transcript', 'Transcript'], ['search', 'Search'], ['chapters', 'Chapters'], ['ask', 'Ask AI']]) tabBar.append(h('button', { 'data-k': k, onclick: () => setTab(k) }, l));
  setTab(tabs.current);
  if (query.q) { sInput.value = query.q; runSearch(); }

  // ---- analytics heartbeat
  const session = Math.random().toString(36).slice(2);
  let watched = 0, lastTick = null;
  video.addEventListener('play', () => (lastTick = performance.now()));
  const flush = () => {
    if (lastTick != null && !video.paused) { watched += (performance.now() - lastTick) / 1000; lastTick = performance.now(); }
    if (watched < 1) return;
    navigator.sendBeacon?.(`/api/videos/${id}/view`, new Blob([JSON.stringify({ session, seconds: watched, t: video.currentTime, referrer: document.referrer })], { type: 'application/json' }));
    watched = 0;
  };
  video.addEventListener('pause', flush);
  const hb = setInterval(flush, 10000);

  // ---- actions
  const titleEl = h('h1', { style: { fontSize: '22px', marginTop: '16px' } }, v.title);
  const actions = h('div.row.wrap', { style: { margin: '12px 0' } },
    h('button.btn.sm', { onclick: () => shareModal(v) }, icon('share', 14), 'Share / Embed'),
    h('button.btn.sm', { onclick: () => clipModal(v, video) }, icon('scissors', 14), 'Clip'),
    h('div', { style: { position: 'relative' } }, h('select.btn.sm', { onchange: (e) => { if (e.target.value) window.open(`/api/videos/${id}/captions.${e.target.value}?download=1`); e.target.value = ''; } },
      h('option', { value: '' }, 'Captions ▾'), h('option', { value: 'vtt' }, 'WebVTT (.vtt)'), h('option', { value: 'srt' }, 'SubRip (.srt)'), h('option', { value: 'txt' }, 'Transcript (.txt)'))),
    h('a.btn.sm', { href: v.src, download: `${v.title}.mp4` }, icon('download', 14), 'Download'),
    h('button.btn.sm', { onclick: async () => {
      const r = await import('./agents.js');
      r.assignTask({ agent_id: (await api.get('/api/agents')).find((a) => a.name === 'Reel')?.id, prompt: `Watch video "${v.title}" (video_id=${id}) and write: show notes with timestamps, 3 social posts, and 3 short clip ideas with start/end times. Save to a markdown file.` });
    } }, icon('bot', 14), 'Ask an agent'),
    h('div.spacer'),
    h('button.btn.sm.ghost', { onclick: async () => { const t = window.prompt('Title', v.title); if (t) { await api.patch(`/api/videos/${id}`, { title: t }); titleEl.textContent = t; v.title = t; } } }, 'Rename'),
    h('button.btn.sm.ghost', { onclick: async () => { await api.post(`/api/videos/${id}/reprocess`); toast('Reprocessing'); } }, icon('refresh', 14), 'Reprocess'),
    h('button.btn.sm.ghost.danger', { onclick: async () => { if (await confirmBox('Delete video?', 'This removes the file, transcript and index.')) { await api.del(`/api/videos/${id}`); navigate('/library'); } } }, 'Delete'));

  const status = statusText(v);
  const statusBox = status ? h('div.card', { style: { marginTop: '12px' } }, h('div.row', {}, h('b', {}, status)), v.status !== 'error' ? h('div.progress', { style: { marginTop: '8px' } }, h('i', { style: { width: `${(v.progress || 0) * 100}%` } })) : null) : null;
  onPage('video', (e) => {
    if (e.id !== id) return;
    if (e.status === 'ready') return watchPage(root, id, { t: video.currentTime });
    if (statusBox && e.stage) { statusBox.querySelector('b').textContent = `${e.stage} · ${Math.round(e.progress * 100)}%`; const bar = statusBox.querySelector('.progress i'); if (bar) bar.style.width = `${e.progress * 100}%`; }
  });

  root.replaceChildren(h('div.page.wide', {}, h('div.watch', {},
    h('div', {},
      h('div.player', {}, video),
      chapters.length ? chapBar : null, markers,
      titleEl,
      h('div.muted.small', {}, [`${v.views || 0} views`, fmtTime(v.duration), v.width ? `${v.width}×${v.height}` : null, bytes(v.size), v.language?.toUpperCase(), ago(v.created_at)].filter(Boolean).join('  ·  ')),
      actions, statusBox,
      v.summary ? h('div.card', { style: { marginTop: '12px' } }, h('h3', {}, icon('sparkles', 15), ' AI summary'), h('p', { style: { margin: 0 } }, v.summary),
        v.tags?.length ? h('div.row.wrap', { style: { marginTop: '12px', gap: '6px' } }, v.tags.map((t) => h('a.pill', { href: `/search?q=${encodeURIComponent(t)}` }, `#${t}`))) : null) : null,
      chapters.length ? h('div.card', { style: { marginTop: '12px' } }, h('h3', {}, 'Chapters'), chapList.cloneNode(true)) : null),
    h('div.panel-r', {}, tabBar, scroll, askFoot))));
  root.querySelectorAll('.card .ch').forEach((el, i) => el.addEventListener('click', () => seek(chapters[i].start)));
  return () => { flush(); clearInterval(hb); };
}

function shareModal(v) {
  const origin = location.origin;
  const link = `${origin}/watch/${v.id}`;
  const embed = `<iframe src="${origin}/embed/${v.id}" width="640" height="360" frameborder="0" allow="autoplay; fullscreen" allowfullscreen></iframe>`;
  const copy = (txt) => { navigator.clipboard.writeText(txt); toast('Copied'); };
  modal('Share & embed', h('div', {},
    h('label.field', {}, h('span', {}, 'Link'), h('div.row', {}, h('input.input', { value: link, readonly: true }), h('button.btn', { onclick: () => copy(link) }, 'Copy'))),
    h('label.field', {}, h('span', {}, 'Embed code (responsive player with captions)'), h('textarea.input.mono', { readonly: true }, embed), h('button.btn.sm', { style: { marginTop: '6px' }, onclick: () => copy(embed) }, 'Copy embed')),
    h('p.small.muted', {}, 'OpenBot runs on your machine. To share outside your network, start it with OPENBOT_HOST=0.0.0.0 or put it behind a free tunnel (e.g. Cloudflare Tunnel).')),
  [{ label: 'Done', cls: 'primary' }]);
}

function clipModal(v, video) {
  const s = { start: Math.floor(video.currentTime), end: Math.min(v.duration, Math.floor(video.currentTime) + 30), title: '' };
  const startIn = h('input.input.mono', { value: fmtTime(s.start) });
  const endIn = h('input.input.mono', { value: fmtTime(s.end) });
  const parse = (x) => x.split(':').map(Number).reduce((a, b) => a * 60 + b, 0);
  modal('Create a clip', h('div', {},
    h('div.grid.g2', {},
      h('label.field', {}, h('span', {}, 'Start'), h('div.row', {}, startIn, h('button.btn.sm', { onclick: () => (startIn.value = fmtTime(video.currentTime)) }, 'Now'))),
      h('label.field', {}, h('span', {}, 'End'), h('div.row', {}, endIn, h('button.btn.sm', { onclick: () => (endIn.value = fmtTime(video.currentTime)) }, 'Now')))),
    h('label.field', {}, h('span', {}, 'Title (optional)'), h('input.input', { oninput: (e) => (s.title = e.target.value) }))),
  [{ label: 'Cancel', cls: 'ghost' }, { label: 'Create clip', cls: 'primary', onClick: async () => {
    try { const c = await api.post(`/api/videos/${v.id}/clip`, { start: parse(startIn.value), end: parse(endIn.value), title: s.title }); toast('Clip created', 'Processing…', () => navigate(`/watch/${c.id}`)); }
    catch (e) { toast('Clip failed', e.message); return false; }
  } }]);
}

// ---------------- library search ----------------
export async function searchPage(root, query) {
  const input = h('input', { placeholder: 'Search every video by what is said or shown: "pricing", "whiteboard", "a dog on a beach"…', value: query.q || '' });
  const out = h('div', { style: { marginTop: '22px' } });
  const answer = h('div');
  const run = async () => {
    const q = input.value.trim();
    if (!q) return;
    history.replaceState({}, '', `/search?q=${encodeURIComponent(q)}`);
    out.replaceChildren(h('div.muted', {}, 'Searching speech, meaning and visuals across your library…'));
    answer.replaceChildren();
    const groups = await api.get(`/api/search?q=${encodeURIComponent(q)}`);
    out.replaceChildren(h('div.muted.small', { style: { marginBottom: '10px' } }, `${groups.length} video(s) matched`),
      ...(groups.length ? [h('div.card.pad-0.list', {}, groups.map((g) => h('div.result-group', {},
        h('div.vcard', { onclick: () => navigate(`/watch/${g.video.id}`) }, h('div.thumb', { style: { backgroundImage: g.video.thumb ? `url(${g.video.thumb})` : 'none' } }, g.video.duration ? h('span.dur', {}, fmtTime(g.video.duration)) : null), h('div.title', {}, g.video.title)),
        h('div.chips', {}, g.hits.length ? g.hits.map((x) => h('div.chip-hit', { onclick: () => navigate(`/watch/${g.video.id}?t=${Math.floor(x.t)}&q=${encodeURIComponent(q)}`) },
          x.frame ? h('img', { src: x.frame, loading: 'lazy' }) : null, h('span.tt', {}, fmtTime(x.t)), x.text ? h('span.tx', {}, x.text) : h('span.tx.muted', {}, 'visual match'))) : h('div.muted.small', {}, g.video.summary || 'Matched title/tags')))))] : [h('div.empty', {}, 'No matches.')]));
  };
  const askAll = async () => {
    const q = input.value.trim();
    if (!q) return;
    const reqId = Math.random().toString(36).slice(2);
    const box = h('div.md', {}, h('span.typing', {}, h('span'), h('span'), h('span')));
    answer.replaceChildren(h('div.card', { style: { marginTop: '16px' } }, h('h3', {}, icon('sparkles', 15), ' Answer from your library'), box));
    let txt = '';
    onPage('ask_token', (e) => { if (e.req_id === reqId) { txt += e.token; box.innerHTML = md(txt); } });
    const r = await api.post('/api/ask', { question: q, req_id: reqId });
    box.innerHTML = md(r.answer.replace(/\[?video:(\w+)[^\]@]*@ ?(\d+:\d+)\]?/g, (m, vid, t) => `[${t}](/watch/${vid}?t=${t.split(':').reduce((a, b) => a * 60 + Number(b), 0)})`));
    box.addEventListener('click', (e) => { const a = e.target.closest('a[data-link]'); if (a) { e.preventDefault(); navigate(a.getAttribute('href')); } });
  };
  input.addEventListener('keydown', (e) => e.key === 'Enter' && run());
  root.replaceChildren(h('div.page', {},
    h('h1', {}, 'Search'), h('p.sub', {}, 'Multimodal search across your whole library: exact words, meaning and visuals.'),
    h('div.searchbar', {}, h('span.muted', {}, icon('search', 18)), input, h('button.btn', { onclick: askAll }, icon('sparkles', 14), 'Ask AI'), h('button.btn.primary', { onclick: run }, 'Search')),
    answer, out));
  if (query.q) run();
  input.focus();
}

// ---------------- analytics ----------------
export async function analyticsPage(root) {
  const a = await api.get('/api/analytics');
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const row = a.daily.find((x) => x.day === key);
    days.push({ day: key.slice(5), views: row?.views || 0, seconds: row?.seconds || 0 });
  }
  const t = a.totals || {};
  const kpi = (n, l) => h('div.card.kpi', {}, h('div.n', {}, n), h('div.l', {}, l));
  root.replaceChildren(h('div.page', {},
    h('h1', {}, 'Analytics'), h('p.sub', {}, 'Private, first-party analytics. No third-party trackers.'),
    h('div.grid.g4', { style: { marginBottom: '16px' } }, kpi(t.videos || 0, 'Videos'), kpi(t.views || 0, 'Views'), kpi(`${((t.watch_seconds || 0) / 3600).toFixed(1)} h`, 'Watch time'), kpi(bytes(t.size || 0), 'Storage used')),
    h('div.card', { style: { marginBottom: '16px' } }, h('h2', {}, 'Views, last 30 days'), barChart(days, { valueKey: 'views', labelKey: 'day' }),
      h('div.row.faint.small', { style: { marginTop: '6px' } }, days[0].day, h('div.spacer'), days[29].day)),
    h('div.card.pad-0', {}, h('h2', { style: { padding: '16px 16px 0' } }, 'Top videos'),
      h('table.t', {}, h('tr', {}, h('th', {}, 'Video'), h('th', {}, 'Views'), h('th', {}, 'Watch time'), h('th', {}, 'Avg. watched')),
        a.top.map((v) => h('tr', { style: { cursor: 'pointer' }, onclick: () => navigate(`/watch/${v.id}`) }, h('td', {}, v.title), h('td', {}, v.views), h('td', {}, fmtTime(v.watch_seconds)),
          h('td', {}, v.views && v.duration ? `${Math.min(100, Math.round((v.watch_seconds / v.views / v.duration) * 100))}%` : '—')))))));
}

export { videoCard };
