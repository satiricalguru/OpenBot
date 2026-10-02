// Flat, expressive bot characters: a solid shape with eyes that look around,
// blink and react. Looks are stored as JSON in agents.avatar.
// States: idle (glance + blink), working (eyes dart, body bobs), waiting
// (hop + red badge), speaking (bounce), listening (tilt), still (no motion).

const NS = 'http://www.w3.org/2000/svg';

export const LOOK_OPTIONS = {
  shape: [['circle', 'Circle'], ['squircle', 'Squircle'], ['triangle', 'Triangle'], ['diamond', 'Diamond'], ['blob', 'Blob'], ['pill', 'Pill'], ['cloud', 'Cloud'], ['hex', 'Hex']],
  eyes: [['dots', 'Dots'], ['capsule', 'Capsule'], ['happy', 'Happy'], ['big', 'Big'], ['sleepy', 'Chill'], ['wink', 'Wink'], ['star', 'Star'], ['line', 'Focused']],
  mouth: [['none', 'None'], ['smile', 'Smile'], ['o', 'Ooh'], ['grin', 'Grin'], ['tongue', 'Silly']],
  acc: [['none', 'None'], ['headphones', 'Headphones'], ['glasses', 'Glasses'], ['crown', 'Crown'], ['bow', 'Bow'], ['leaf', 'Sprout'], ['party', 'Party hat'], ['antenna', 'Antenna']],
  gaze: [['up-right', '↗'], ['right', '→'], ['center', '•'], ['left', '←'], ['up-left', '↖'], ['down', '↓']],
};

export const PALETTE = ['#6cc4a6', '#f2a65a', '#8b6cff', '#4f8ff7', '#f07a4a', '#e86aa6', '#f5d04c', '#4cc9f0', '#a3d65c', '#ef5b5b', '#c9c9cf', '#ffffff'];
export const EYE_COLORS = ['#141414', '#ffffff', '#2b1a6b', '#3b1d0b'];

const hash = (s) => [...String(s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
const pick = (arr, n) => arr[n % arr.length];

export function randomLook(seed = Math.random() * 1e9) {
  const n = typeof seed === 'number' ? Math.floor(seed) : hash(seed);
  return {
    shape: pick(LOOK_OPTIONS.shape, n)[0],
    eyes: pick(LOOK_OPTIONS.eyes, n >> 3)[0],
    mouth: (n >> 6) % 3 === 0 ? pick(LOOK_OPTIONS.mouth, n >> 8)[0] : 'none',
    acc: (n >> 10) % 3 === 0 ? pick(LOOK_OPTIONS.acc, n >> 12)[0] : 'none',
    gaze: pick(LOOK_OPTIONS.gaze, n >> 14)[0],
    eye: '#141414',
    cheeks: (n >> 16) % 4 === 0,
  };
}

/** Resolve an agent's look from its avatar field (JSON) with a stable fallback. */
export function lookOf(agent = {}) {
  let look = null;
  if (agent.avatar && String(agent.avatar).trim().startsWith('{')) { try { look = JSON.parse(agent.avatar); } catch {} }
  const base = randomLook(agent.name || agent.id || 'bot');
  const out = { ...base, ...(look || {}), color: agent.color || look?.color || '#6cc4a6' };
  // Migrate looks from the previous (3D robot) avatar format.
  if (!LOOK_OPTIONS.shape.some(([v]) => v === out.shape)) out.shape = base.shape;
  if (!LOOK_OPTIONS.eyes.some(([v]) => v === out.eyes)) out.eyes = base.eyes;
  if (!LOOK_OPTIONS.acc.some(([v]) => v === out.acc)) out.acc = 'none';
  if (!LOOK_OPTIONS.mouth.some(([v]) => v === out.mouth)) out.mouth = 'none';
  if (!EYE_COLORS.includes(out.eye)) out.eye = '#141414';
  return out;
}

const SHAPES = {
  circle: '<circle cx="50" cy="54" r="38"/>',
  squircle: '<rect x="13" y="17" width="74" height="74" rx="30"/>',
  triangle: '<path d="M43.1 20.5c3.1-5.3 10.7-5.3 13.8 0l31.6 54.8c3.1 5.3-.8 12-6.9 12H18.4c-6.1 0-10-6.7-6.9-12z"/>',
  diamond: '<rect x="22" y="26" width="56" height="56" rx="16" transform="rotate(45 50 54)"/>',
  blob: '<path d="M52 16c20 0 36 14 36 35 0 22-15 39-38 39-21 0-37-14-37-35 0-22 17-39 39-39z"/>',
  pill: '<rect x="8" y="30" width="84" height="50" rx="25"/>',
  cloud: '<path d="M30 88c-11 0-19-8-19-18 0-9 6-16 14-18-1-2-1-4-1-6 0-11 9-20 20-20 7 0 13 3 17 9 2-1 4-1 6-1 11 0 20 9 20 20 0 3-1 5-1 7 4 3 6 8 6 13 0 8-7 14-15 14z"/>',
  hex: '<path d="M44 17.5a12 12 0 0 1 12 0l23.6 13.6a12 12 0 0 1 6 10.4v27.2a12 12 0 0 1-6 10.4L56 92.7a12 12 0 0 1-12 0L20.4 79.1a12 12 0 0 1-6-10.4V41.5a12 12 0 0 1 6-10.4z"/>',
};
// Where the face sits for each shape (center x/y of the eye line)
const FACE = { circle: [50, 50], squircle: [50, 50], triangle: [50, 62], diamond: [50, 52], blob: [50, 50], pill: [50, 53], cloud: [52, 60], hex: [50, 53] };
const TOP = { circle: 16, squircle: 17, triangle: 18, diamond: 15, blob: 16, pill: 30, cloud: 26, hex: 16 };
const GAZE = { 'up-right': [5, -3], right: [5, 0], center: [0, 0], left: [-5, 0], 'up-left': [-5, -3], down: [0, 4] };

let uidN = 0;
// Very light bodies get a hairline edge so they stay visible on light backgrounds.
const light = (hex) => {
  const n = parseInt(String(hex).slice(1), 16);
  return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255 > 0.85;
};

export function botSVG(look, { state = 'idle', seed = 0, badge = false } = {}) {
  ++uidN;
  const c = look.color || '#6cc4a6';
  const ink = look.eye || '#141414';
  const [fx, fy0] = FACE[look.shape] || [50, 50];
  const [gx, gy] = GAZE[look.gaze] || [0, 0];
  const fy = fy0;
  const ex = 9; // half distance between eyes

  const eyes = {
    dots: `<ellipse cx="${fx - ex}" cy="${fy}" rx="4.6" ry="6.4"/><ellipse cx="${fx + ex}" cy="${fy}" rx="4.6" ry="6.4"/>`,
    capsule: `<rect x="${fx - ex - 3.5}" y="${fy - 9}" width="7" height="18" rx="3.5" transform="rotate(18 ${fx - ex} ${fy})"/><rect x="${fx + ex - 3.5}" y="${fy - 9}" width="7" height="18" rx="3.5" transform="rotate(-24 ${fx + ex} ${fy})"/>`,
    happy: `<path d="M${fx - ex - 6} ${fy + 3} q6 -9 12 0 M${fx + ex - 6} ${fy + 3} q6 -9 12 0" fill="none" stroke="${ink}" stroke-width="4.4" stroke-linecap="round"/>`,
    big: `<ellipse cx="${fx - ex - 1}" cy="${fy}" rx="7" ry="8.5"/><ellipse cx="${fx + ex + 1}" cy="${fy}" rx="7" ry="8.5"/><circle cx="${fx - ex + 1}" cy="${fy - 3}" r="2.4" fill="#fff"/><circle cx="${fx + ex + 3}" cy="${fy - 3}" r="2.4" fill="#fff"/>`,
    sleepy: `<path d="M${fx - ex - 5} ${fy} q5 4 10 0 M${fx + ex - 5} ${fy} q5 4 10 0" fill="none" stroke="${ink}" stroke-width="4.2" stroke-linecap="round"/>`,
    wink: `<ellipse cx="${fx - ex}" cy="${fy}" rx="4.6" ry="6.4"/><path d="M${fx + ex - 6} ${fy + 1} q6 -7 12 0" fill="none" stroke="${ink}" stroke-width="4.2" stroke-linecap="round"/>`,
    star: [fx - ex, fx + ex].map((x) => `<path d="M${x} ${fy - 7} l2.2 4.6 5 .6 -3.7 3.4 1 4.9 -4.5 -2.5 -4.5 2.5 1 -4.9 -3.7 -3.4 5 -.6z"/>`).join(''),
    line: `<rect x="${fx - ex - 6}" y="${fy - 2.6}" width="12" height="5.2" rx="2.6"/><rect x="${fx + ex - 6}" y="${fy - 2.6}" width="12" height="5.2" rx="2.6"/>`,
  }[look.eyes] || '';

  const my = fy + 13;
  const mouth = {
    none: '',
    smile: `<path d="M${fx - 6} ${my} q6 5 12 0" fill="none" stroke="${ink}" stroke-width="3.4" stroke-linecap="round"/>`,
    o: `<ellipse cx="${fx}" cy="${my + 1}" rx="3.2" ry="3.6" fill="${ink}"/>`,
    grin: `<path d="M${fx - 8} ${my - 1} h16 q-1 7 -8 7 q-7 0 -8 -7z" fill="${ink}"/>`,
    tongue: `<path d="M${fx - 7} ${my} q7 5 14 0" fill="none" stroke="${ink}" stroke-width="3.4" stroke-linecap="round"/><path d="M${fx + 1} ${my + 2} q3 6 6 0z" fill="#ff6b8b"/>`,
  }[look.mouth] || '';

  const cheeks = look.cheeks ? `<ellipse cx="${fx - ex - 9}" cy="${fy + 9}" rx="5" ry="3" fill="#ff7aa8" opacity=".55"/><ellipse cx="${fx + ex + 9}" cy="${fy + 9}" rx="5" ry="3" fill="#ff7aa8" opacity=".55"/>` : '';

  const top = TOP[look.shape] || 16;
  const acc = {
    none: '',
    headphones: `<path d="M17 56a33 33 0 0 1 66 0" fill="none" stroke="#1f1f24" stroke-width="5.5" stroke-linecap="round"/><rect x="8" y="48" width="13" height="22" rx="6.5" fill="#1f1f24"/><rect x="79" y="48" width="13" height="22" rx="6.5" fill="#1f1f24"/>`,
    glasses: `<g fill="none" stroke="${ink}" stroke-width="2.6"><circle cx="${fx - ex}" cy="${fy}" r="9.5"/><circle cx="${fx + ex}" cy="${fy}" r="9.5"/><path d="M${fx - ex + 9.5} ${fy} h${2 * ex - 19}"/></g>`,
    crown: `<path d="M35 ${top + 4} l3 -15 8 9 4 -12 4 12 8 -9 3 15z" fill="#ffc83d"/>`,
    bow: `<g transform="translate(${fx + 20} ${top + 6})"><path d="M0 0 l13 -8 v16z M0 0 l-13 -8 v16z" fill="#ff5d8f"/><circle r="3.4" fill="#ff8fb1"/></g>`,
    leaf: `<path d="M50 ${top + 2} V${top - 8}" stroke="#3aa35b" stroke-width="3" stroke-linecap="round"/><path d="M50 ${top - 6} c-10 -1 -13 -9 -12 -13 c7 0 12 4 12 13z M50 ${top - 6} c9 -2 12 -9 11 -12 c-7 0 -11 4 -11 12z" fill="#4cc46f"/>`,
    party: `<path d="M50 ${top - 18} L62 ${top + 6} H38z" fill="#8b6cff"/><path d="M44 ${top - 2} l12 -4 M41 ${top + 3} l18 -5" stroke="#f5d04c" stroke-width="2.4"/><circle cx="50" cy="${top - 19}" r="3.6" fill="#f5d04c"/>`,
    antenna: `<path d="M50 ${top + 2} V${top - 9}" stroke="${ink}" stroke-width="3" stroke-linecap="round"/><circle class="b-ant" cx="50" cy="${top - 12}" r="4.5" fill="#ff5d73"/>`,
  }[look.acc] || '';

  const delay = -((seed % 1000) / 1000) * 6;
  const svg = `
  <svg viewBox="0 0 100 100" xmlns="${NS}" class="bot ${state}" style="--d:${delay}s;--gx:${gx}px;--gy:${gy}px">
    <g class="b-body">
      <g fill="${c}" ${light(c) ? 'stroke="var(--bot-edge, rgba(0,0,0,.14))" stroke-width="2.5"' : ''}>${SHAPES[look.shape] || SHAPES.circle}</g>
      ${cheeks}
      <g class="b-face"><g class="b-eyes" fill="${ink}">${eyes}</g>${mouth}</g>
      ${acc}
    </g>
    <circle class="b-badge" cx="84" cy="20" r="9" fill="#ff4d4f" stroke="var(--bot-ring, #0b0b0b)" stroke-width="4" ${badge ? '' : 'opacity="0"'}/>
  </svg>`;
  const t = document.createElement('template');
  t.innerHTML = svg.trim();
  return t.content.firstChild;
}

/** Re-state every rendered bot of an agent without re-rendering. */
export function setBotState(agentId, state) {
  document.querySelectorAll(`[data-bot="${agentId}"] svg.bot`).forEach((s) => s.setAttribute('class', `bot ${state}`));
}
