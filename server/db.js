import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const DATA = process.env.OPENBOT_DATA || path.join(ROOT, 'data');
export const VIDEO_DIR = path.join(DATA, 'videos');
export const WORKSPACE_DIR = path.join(DATA, 'workspaces');
for (const d of [DATA, VIDEO_DIR, WORKSPACE_DIR]) fs.mkdirSync(d, { recursive: true });

// Databases created before the rename to OpenBot are picked up automatically.
for (const ext of ['', '-wal', '-shm']) {
  const old = path.join(DATA, `openmuse.db${ext}`), cur = path.join(DATA, `openbot.db${ext}`);
  if (fs.existsSync(old) && !fs.existsSync(cur)) fs.renameSync(old, cur);
}
export const db = new DatabaseSync(path.join(DATA, 'openbot.db'));
db.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;`);

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, avatar TEXT, color TEXT,
  role TEXT, instructions TEXT, model TEXT,
  rules TEXT DEFAULT '{}', proactive INTEGER DEFAULT 0,
  status TEXT DEFAULT 'idle', created_at INTEGER
);
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT,
  members TEXT DEFAULT '[]', created_at INTEGER, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  role TEXT NOT NULL, agent_id TEXT, content TEXT, meta TEXT, created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, created_at);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, agent_id TEXT, thread_id TEXT, title TEXT, prompt TEXT,
  status TEXT DEFAULT 'queued', result TEXT, routine_id TEXT,
  created_at INTEGER, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, agent_id TEXT, thread_id TEXT, tool TEXT, args TEXT,
  reason TEXT, status TEXT DEFAULT 'pending', created_at INTEGER, decided_at INTEGER
);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY, agent_id TEXT, content TEXT, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY, agent_id TEXT, name TEXT, description TEXT, steps TEXT, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS routines (
  id TEXT PRIMARY KEY, agent_id TEXT, name TEXT, cron TEXT, prompt TEXT,
  enabled INTEGER DEFAULT 1, last_run INTEGER, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, kind TEXT, text TEXT, meta TEXT, created_at INTEGER
);

CREATE TABLE IF NOT EXISTS videos (
  id TEXT PRIMARY KEY, title TEXT, description TEXT, filename TEXT, mime TEXT,
  duration REAL, width INTEGER, height INTEGER, size INTEGER,
  status TEXT DEFAULT 'queued', progress REAL DEFAULT 0, stage TEXT, error TEXT,
  summary TEXT, tags TEXT DEFAULT '[]', chapters TEXT DEFAULT '[]',
  language TEXT, visibility TEXT DEFAULT 'unlisted', source_url TEXT, parent_id TEXT, clip_start REAL, clip_end REAL,
  views INTEGER DEFAULT 0, watch_seconds REAL DEFAULT 0,
  created_at INTEGER, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  start REAL, end REAL, text TEXT, embedding BLOB
);
CREATE INDEX IF NOT EXISTS idx_segments_video ON segments(video_id, start);
CREATE TABLE IF NOT EXISTS frames (
  id INTEGER PRIMARY KEY AUTOINCREMENT, video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  t REAL, file TEXT, embedding BLOB
);
CREATE INDEX IF NOT EXISTS idx_frames_video ON frames(video_id, t);
CREATE TABLE IF NOT EXISTS views (
  id INTEGER PRIMARY KEY AUTOINCREMENT, video_id TEXT, session TEXT, seconds REAL DEFAULT 0,
  max_t REAL DEFAULT 0, referrer TEXT, created_at INTEGER, updated_at INTEGER
);
`);

export const now = () => Date.now();
export const uid = (n = 10) => crypto.randomBytes(16).toString('base64url').replace(/[-_]/g, '').slice(0, n);

export const all = (sql, ...p) => db.prepare(sql).all(...p);
export const get = (sql, ...p) => db.prepare(sql).get(...p);
export const run = (sql, ...p) => db.prepare(sql).run(...p);

export const toBlob = (arr) => Buffer.from(new Float32Array(arr).buffer);
export const fromBlob = (b) => (b ? new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4) : null);

export function getSetting(key, fallback = null) {
  const r = get('SELECT value FROM settings WHERE key = ?', key);
  if (!r) return fallback;
  try { return JSON.parse(r.value); } catch { return r.value; }
}
export function setSetting(key, value) {
  run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
}

export function json(v, fallback) {
  if (v == null) return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
}
