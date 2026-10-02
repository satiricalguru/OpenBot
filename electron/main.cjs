// OpenBot desktop app: runs the local server in-process and shows it in a
// native window. Closing the window keeps your bots running in the menu bar.
const { app, BrowserWindow, Tray, Menu, nativeTheme, shell, ipcMain, nativeImage } = require('electron');
const path = require('node:path');
const net = require('node:net');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const ICON = path.join(ROOT, 'public', 'img', 'icon-1024.png');
let win = null;
let tray = null;
let port = 0;
let quitting = false;

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => showWindow());
app.setName('OpenBot');

const freePort = (preferred) => new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', () => { const s2 = net.createServer(); s2.listen(0, '127.0.0.1', () => { const p = s2.address().port; s2.close(() => resolve(p)); }); });
  s.listen(preferred, '127.0.0.1', () => s.close(() => resolve(preferred)));
});

async function startServer() {
  port = await freePort(Number(process.env.PORT) || 4321);
  process.env.PORT = String(port);
  process.env.OPENBOT_DATA ||= app.isPackaged ? path.join(app.getPath('userData'), 'data') : path.join(ROOT, 'data');
  // Packaged apps don't inherit the shell PATH; make Homebrew tools (ffmpeg, yt-dlp) findable.
  process.env.PATH = ['/opt/homebrew/bin', '/usr/local/bin', process.env.PATH].join(path.delimiter);
  await import(pathToFileURL(path.join(ROOT, 'server', 'index.js')).href);
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/overview`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
}

function createWindow() {
  const mac = process.platform === 'darwin';
  win = new BrowserWindow({
    width: 1360, height: 880, minWidth: 920, minHeight: 600,
    title: 'OpenBot',
    icon: ICON,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors || nativeTheme.themeSource === 'dark' ? '#0a0a0a' : '#f6f6f7',
    titleBarStyle: mac ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 18, y: 19 },
    titleBarOverlay: mac ? false : { color: '#00000000', symbolColor: '#a1a1a1', height: 48 },
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  win.loadURL(`http://127.0.0.1:${port}/`);
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(`http://127.0.0.1:${port}`) && !url.startsWith(`http://localhost:${port}`)) shell.openExternal(url);
    else win.loadURL(url);
    return { action: 'deny' };
  });
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault(); // keep bots working in the background
    win.hide();
    if (process.platform === 'darwin') app.dock?.hide();
  });
}

function showWindow() {
  if (!win) return createWindow();
  if (process.platform === 'darwin') app.dock?.show();
  win.show();
  win.focus();
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(ROOT, 'public', 'img', 'trayTemplate.png'));
  img.setTemplateImage(true);
  tray = new Tray(img);
  tray.setToolTip('OpenBot: your bots are on');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open OpenBot', click: showWindow },
    { label: 'New bot…', click: () => { showWindow(); win.webContents.executeJavaScript("document.dispatchEvent(new KeyboardEvent('keydown',{key:'n',metaKey:true}))"); } },
    { type: 'separator' },
    { label: 'Bots keep working while the window is closed', enabled: false },
    { label: 'Quit OpenBot', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);
}

ipcMain.on('theme', (_e, mode) => {
  nativeTheme.themeSource = ['dark', 'light', 'system'].includes(mode) ? mode : 'dark';
  win?.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#0a0a0a' : '#f6f6f7');
});

app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark';
  if (process.platform === 'darwin') app.dock?.setIcon(ICON);
  await startServer();
  createWindow();
  createTray();
  app.on('activate', showWindow);
});
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', (e) => e.preventDefault?.());
