// Captures README screenshots, GIFs and a demo video from a running OpenBot
// server (npm start). Usage: npx electron scripts/capture.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const BASE = process.env.OPENBOT_URL || 'http://localhost:4321';
const OUT = path.join(__dirname, '..', 'docs', 'assets');
const W = 1440, H = 900;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

app.commandLine.appendSwitch('force-device-scale-factor', '2');
app.commandLine.appendSwitch('high-dpi-support', '1');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: W, height: H, show: false, paintWhenInitiallyHidden: true, webPreferences: { offscreen: true } });
  win.webContents.setFrameRate(30);
  const js = (code) => win.webContents.executeJavaScript(code);
  const api = (p) => fetch(BASE + p).then((r) => r.json());

  const agents = await api('/api/agents');
  const id = (n) => agents.find((a) => a.name === n)?.id;
  const crew = (await api('/api/threads?kind=group'))[0];
  const video = (await api('/api/videos')).find((v) => v.title.includes('Weekly')) || (await api('/api/videos'))[0];

  async function open(url, { theme = 'dark', panel = '' } = {}) {
    await win.loadURL(BASE + '/');
    await js(`localStorage.setItem('theme', '${theme}'); localStorage.setItem('panel', '${panel}'); localStorage.removeItem('userName');`);
    await win.loadURL(BASE + url);
    await wait(1800);
    await trafficLights();
    await wait(300);
  }
  // The real app window has macOS traffic lights; draw them so captures look like the app.
  const trafficLights = () => js(`(() => {
    if (document.getElementById('tl')) return;
    const d = document.createElement('div'); d.id = 'tl';
    d.style.cssText = 'position:fixed;left:19px;top:21px;display:flex;gap:8px;z-index:200';
    for (const c of ['#ff5f57', '#febc2e', '#28c840']) { const i = document.createElement('i'); i.style.cssText = 'width:12px;height:12px;border-radius:50%;background:' + c; d.append(i); }
    document.body.append(d);
  })()`);
  async function shot(name) {
    const img = await win.webContents.capturePage();
    const { width } = img.getSize();
    fs.writeFileSync(path.join(OUT, `${name}.png`), (width > W * 1.5 ? img.resize({ width: W * 1.5 }) : img).toPNG());
    console.log('shot', name);
  }
  // Fixed-rate recording: capture frames on an interval while `script` runs.
  async function record(name, script, { fps = 15, width = 1000, crop = null, mp4 = false } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-'));
    let n = 0, on = true;
    const loop = (async () => {
      while (on) {
        const t = Date.now();
        const img = await win.webContents.capturePage(crop || undefined);
        fs.writeFileSync(path.join(dir, `${String(n++).padStart(5, '0')}.png`), img.toPNG());
        await wait(Math.max(0, 1000 / fps - (Date.now() - t)));
      }
    })();
    await script();
    on = false;
    await loop;
    const input = ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', path.join(dir, '%05d.png')];
    execFileSync('ffmpeg', [...input, '-vf', `scale=${width}:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=192:stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle`, path.join(OUT, `${name}.gif`)]);
    if (mp4) execFileSync('ffmpeg', [...input, '-vf', 'scale=1440:-2:flags=lanczos', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', path.join(OUT, `${name}.mp4`)]);
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('recorded', name, n, 'frames');
  }
  const click = (sel) => js(`(() => { const el = ${sel}; el && el.click(); return !!el; })()`);
  const byText = (tag, text) => `[...document.querySelectorAll('${tag}')].find((e) => e.textContent.trim().startsWith(${JSON.stringify(text)}))`;

  // ---------- screenshots ----------
  await open(`/agents/${id('Scout')}`, { panel: 'computer' }); await shot('chat-computer-dark');
  await open(`/agents/${id('Scout')}`, { theme: 'light', panel: 'computer' }); await shot('chat-computer-light');
  await open(`/crew/${crew.id}`); await shot('crew-dark');
  await open(`/crew/${crew.id}`, { theme: 'light' }); await shot('crew-light');
  await open('/'); await shot('home-dark');
  await open(`/agents/${id('Reel')}`); await shot('reel-dark');
  await open(`/watch/${video.id}?q=budget`); await wait(2500); await shot('video-dark');
  await open('/library'); await shot('library-dark');
  await open('/'); await click(`document.querySelector('.crew-card[href="#"]')`); await wait(500);
  await click(byText('.modal .tabs button', 'Appearance')); await wait(600); await shot('studio-dark');

  // ---------- animated bots (customizer stage) ----------
  const r = await js(`(() => { const b = document.querySelector('.studio .stage').getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) }; })()`);
  await record('bots', async () => {
    const states = ['Busy', 'Waiting', 'Talking', 'Idle'];
    for (let i = 0; i < 8; i++) {
      await click(byText('.studio .stage button', 'Randomize'));
      await wait(250);
      await click(byText('.studio .stage .seg button', states[i % 4]));
      await wait(1100);
    }
  }, { crop: r, width: 360, fps: 18 });

  // ---------- walkthrough (GIF + MP4) ----------
  await open('/');
  await trafficLights();
  await record('demo', async () => {
    await wait(1800);
    await click(`document.querySelector('.sb-switch button')`); await wait(700);
    await click(`document.querySelector('a.conv[href="/agents/${id('Scout')}"]')`); await wait(2200);
    await click(`document.querySelector('button[title="Computer"]')`); await wait(2600);
    await click(`document.querySelector('a.conv[href="/crew/${crew.id}"]')`); await wait(2600);
    await click(`document.querySelector('a.conv[href="/agents/${id('Reel')}"]')`); await wait(2400);
    await click(`document.querySelector('button[title="Light mode"]')`); await wait(2000);
    await click(`document.querySelector('button[title="Dark mode"]')`); await wait(900);
    await click(byText('.sb-switch button', 'Videos')); await wait(700);
    await click(`document.querySelector('a.vrow')`); await wait(2600);
    await js(`(() => { const i = document.querySelector('.panel-r input'); [...document.querySelectorAll('.panel-r .tabs button')].find(b => b.textContent === 'Search').click(); const s = document.querySelector('.panel-r input'); s.value = 'budget'; s.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); })()`);
    await wait(3200);
    await click(byText('.sb-switch button', 'Chats')); await wait(500);
    await js(`document.querySelectorAll('a.conv')[document.querySelectorAll('a.conv').length - 1].click()`); await wait(900);
    await click(byText('.modal .tabs button', 'Appearance')); await wait(700);
    for (let i = 0; i < 4; i++) { await click(byText('.studio .stage button', 'Randomize')); await wait(750); }
    await wait(800);
  }, { fps: 12, width: 1100, mp4: true });

  app.quit();
});
