import { botSVG, lookOf } from './bot.js';
import { icon } from './icons.js';
export { icon };

// Tiny DOM toolkit: h() builds elements, plus toasts, modals, markdown and formatting helpers.
export function h(tag, attrs = {}, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className += (el.className ? ' ' : '') + v;
    else if (k === 'style' && typeof v === 'object') for (const [sk, sv] of Object.entries(v)) sk.startsWith('--') ? el.style.setProperty(sk, sv) : (el.style[sk] = sv);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'selected' || k === 'disabled') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const $ = (s, root = document) => root.querySelector(s);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function fmtTime(t) {
  t = Math.max(0, Math.floor(t || 0));
  const hh = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return (hh ? `${hh}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(s).padStart(2, '0')}`;
}
export function parseTime(s) {
  const p = String(s).split(':').map(Number);
  return p.reduce((a, b) => a * 60 + b, 0);
}
export function ago(ts) {
  if (!ts) return '';
  const d = (Date.now() - ts) / 1000;
  if (d < 45) return 'just now';
  if (d < 3600) return `${Math.round(d / 60)}m ago`;
  if (d < 86400) return `${Math.round(d / 3600)}h ago`;
  if (d < 86400 * 7) return `${Math.round(d / 86400)}d ago`;
  return new Date(ts).toLocaleDateString();
}
export const bytes = (n) => (n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round((n || 0) / 1e3)} KB`);
export const clockTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

// ---- toasts ----
let toastBox;
export function toast(title, message = '', onClick) {
  toastBox ||= document.body.appendChild(h('div.toasts'));
  const t = h('div.toast', { onclick: () => { onClick?.(); t.remove(); } }, h('b', {}, title), message ? h('div.muted.small', {}, message) : null);
  toastBox.append(t);
  setTimeout(() => t.remove(), 6000);
}

// ---- modal ----
export function modal(title, body, actions = [], { wide = false } = {}) {
  const bg = h('div.modal-bg');
  const close = () => bg.remove();
  const box = h(wide ? 'div.modal.wide' : 'div.modal', {}, h('h2', {}, title), body, actions.length ? h('div.actions', {}, actions.map((a) => h(`button.btn${a.cls ? '.' + a.cls : ''}`, { onclick: async () => { if ((await a.onClick?.(close)) !== false) close(); } }, a.label))) : null);
  bg.append(box);
  bg.addEventListener('mousedown', (e) => e.target === bg && close());
  document.body.append(bg);
  setTimeout(() => box.querySelector('input,textarea')?.focus(), 30);
  return close;
}

export function prompt(title, { label = '', value = '', multiline = false, placeholder = '' } = {}) {
  return new Promise((resolve) => {
    const input = multiline ? h('textarea.input', { placeholder }, value) : h('input.input', { value, placeholder });
    modal(title, h('label.field', {}, label ? h('span', {}, label) : null, input), [
      { label: 'Cancel', cls: 'ghost', onClick: () => resolve(null) },
      { label: 'Save', cls: 'primary', onClick: () => resolve(input.value) },
    ]);
  });
}

export const confirmBox = (title, msg, okLabel = 'Delete') => new Promise((resolve) => {
  modal(title, h('p.muted', {}, msg), [
    { label: 'Cancel', cls: 'ghost', onClick: () => resolve(false) },
    { label: okLabel, cls: 'primary', onClick: () => resolve(true) },
  ]);
});

// ---- markdown (small, safe: escapes first) ----
export function md(src, { timestamps = false } = {}) {
  let s = esc(src || '');
  const blocks = [];
  s = s.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => { blocks.push(`<pre><code>${code}</code></pre>`); return `\u0000${blocks.length - 1}\u0000`; });
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]]+)\]\(((?:https?:\/\/|\/)[^)\s]+)\)/g, (_, t, u) => `<a href="${u}" ${u.startsWith('/') ? 'data-link' : 'target="_blank" rel="noopener"'}>${t}</a>`);
  s = s.replace(/(^|[\s(])((?:https?:\/\/)[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  s = s.replace(/(^|[\s(])(\/watch\/[\w]+(?:\?t=\d+)?)/g, '$1<a href="$2" data-link>$2</a>');
  if (timestamps) s = s.replace(/\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?/g, '<span class="ts" data-t="$1">$1</span>');
  const lines = s.split('\n');
  const out = [];
  let list = null;
  let para = [];
  const flush = () => { if (para.length) { out.push(`<p>${para.join('<br>')}</p>`); para = []; } };
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const line of lines) {
    let m;
    if ((m = line.match(/^(#{1,3})\s+(.*)/))) { flush(); closeList(); out.push(`<h3>${m[2]}</h3>`); }
    else if ((m = line.match(/^\s*[-*•]\s+(.*)/))) { flush(); if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${m[1]}</li>`); }
    else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) { flush(); if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${m[1]}</li>`); }
    else if ((m = line.match(/^&gt;\s?(.*)/))) { flush(); closeList(); out.push(`<blockquote>${m[1]}</blockquote>`); }
    else if (/^\s*\|.*\|\s*$/.test(line)) {
      flush(); closeList();
      if (/^\s*\|[\s\-:|]+\|\s*$/.test(line)) continue;
      out.push(`<table><tr>${line.trim().slice(1, -1).split('|').map((c) => `<td>${c.trim()}</td>`).join('')}</tr></table>`);
    }
    else if (!line.trim()) { flush(); closeList(); }
    else { closeList(); para.push(line); }
  }
  flush(); closeList();
  return out.join('').replace(/<\/table><table>/g, '').replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[i]);
}

export function avatar(agent, size = '', { state } = {}) {
  const look = lookOf(agent || {});
  const st = state || agent?.status || 'idle';
  const seed = [...String(agent?.id || agent?.name || '')].reduce((a, c) => a + c.charCodeAt(0) * 17, 0);
  return h(`div.avatar${size ? '.' + size : ''}`, { 'data-bot': agent?.id, title: agent?.name || '' },
    h('i.tile', { style: { '--tile': look.color } }),
    botSVG(look, { state: st, seed, badge: st === 'waiting' }),
    h(`i.status-pip.${st}`, { 'data-pip': agent?.id }));
}

export function seg(options, value, onChange) {
  const el = h('div.seg');
  for (const [v, label] of options) {
    el.append(h('button', { 'data-v': v, class: v === value ? 'on' : '', onclick: () => { el.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === v)); onChange(v); } }, label));
  }
  return el;
}

export const toggle = (checked, onChange) => h('label.toggle', {}, h('input', { type: 'checkbox', checked, onchange: (e) => onChange(e.target.checked) }), h('i'));

export function barChart(rows, { valueKey, labelKey, fmt = (v) => v }) {
  const max = Math.max(1, ...rows.map((r) => r[valueKey] || 0));
  return h('div.bars', {}, rows.map((r) => h('div', { style: { height: `${((r[valueKey] || 0) / max) * 100}%` }, 'data-tip': `${r[labelKey]}: ${fmt(r[valueKey] || 0)}` })));
}

// ---- popover menu ----
let openMenu = null;
export function popMenu(anchor, items, { up = false, align = 'left' } = {}) {
  openMenu?.remove();
  const menu = h('div.menu', {}, items.map((it) => it === '-' ? h('hr') : h(`button${it.danger ? '.danger' : ''}`, { onclick: () => { close(); it.onClick?.(); } }, it.icon ? icon(it.icon, 16) : null, it.label)));
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let left = align === 'right' ? r.right - mw : r.left;
  left = Math.max(8, Math.min(left, innerWidth - mw - 8));
  let top = up ? r.top - mh - 8 : r.bottom + 6;
  if (top + mh > innerHeight - 8) top = r.top - mh - 8;
  menu.style.left = `${left}px`;
  menu.style.top = `${Math.max(8, top)}px`;
  openMenu = menu;
  const close = () => { menu.remove(); document.removeEventListener('mousedown', outside, true); if (openMenu === menu) openMenu = null; };
  const outside = (e) => { if (!menu.contains(e.target)) close(); };
  setTimeout(() => document.addEventListener('mousedown', outside, true));
  return close;
}

export function groupAvatar(agents) {
  return h('div.group-av', {}, agents.slice(0, 3).map((a) => avatar(a, 'xs')));
}
