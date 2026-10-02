import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { VIDEO_DIR, get, run, all, now, toBlob, json } from '../db.js';
import { emit } from '../events.js';
import { getWhisper, embedTexts, clipEmbedImages } from './models.js';
import { chatJSON } from '../llm.js';

export const videoDir = (id) => path.join(VIDEO_DIR, id);

function sh(cmd, args, { binary = false } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    const out = [];
    let err = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => { err += d; if (err.length > 20000) err = err.slice(-10000); });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`${cmd} failed: ${err.slice(-600)}`));
      const buf = Buffer.concat(out);
      resolve(binary ? buf : buf.toString());
    });
  });
}

export async function probe(file) {
  const out = JSON.parse(await sh('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]));
  const v = out.streams.find((s) => s.codec_type === 'video');
  const a = out.streams.find((s) => s.codec_type === 'audio');
  return {
    duration: parseFloat(out.format.duration) || 0,
    width: v?.width || 0, height: v?.height || 0,
    hasVideo: !!v, hasAudio: !!a, size: parseInt(out.format.size) || 0,
  };
}

function setStage(id, stage, progress) {
  run('UPDATE videos SET stage = ?, progress = ?, status = ?, updated_at = ? WHERE id = ?', stage, progress, 'processing', now(), id);
  emit('video', { id, stage, progress, status: 'processing' });
}

// ---- Queue: one video at a time keeps CPU usage predictable on a laptop ----
const queue = [];
let busy = false;
export function enqueue(id) {
  if (!queue.includes(id)) queue.push(id);
  pump();
}
async function pump() {
  if (busy) return;
  const id = queue.shift();
  if (!id) return;
  busy = true;
  try { await processVideo(id); }
  catch (e) {
    console.error('[video]', id, e);
    run("UPDATE videos SET status = 'error', error = ?, updated_at = ? WHERE id = ?", String(e.message || e), now(), id);
    emit('video', { id, status: 'error', error: String(e.message || e) });
  } finally { busy = false; pump(); }
}

export function resumePending() {
  for (const v of all("SELECT id FROM videos WHERE status IN ('queued','processing') ORDER BY created_at")) enqueue(v.id);
}

async function processVideo(id) {
  const v = get('SELECT * FROM videos WHERE id = ?', id);
  if (!v) return;
  const dir = videoDir(id);
  const src = path.join(dir, v.filename);

  // 1. Probe + thumbnail
  setStage(id, 'Analyzing file', 0.02);
  const info = await probe(src);
  run('UPDATE videos SET duration = ?, width = ?, height = ?, size = ? WHERE id = ?', info.duration, info.width, info.height, info.size, id);
  if (info.hasVideo) {
    await sh('ffmpeg', ['-y', '-ss', String(Math.min(info.duration * 0.1, 5)), '-i', src, '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '3', path.join(dir, 'thumb.jpg')]).catch(() => {});
  }
  emit('video', { id, thumb: true });

  // 2. Transcribe speech with Whisper (local)
  run('DELETE FROM segments WHERE video_id = ?', id);
  let segments = [];
  if (info.hasAudio) {
    setStage(id, 'Extracting audio', 0.05);
    const raw = await sh('ffmpeg', ['-i', src, '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'], { binary: true });
    const audio = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4));
    setStage(id, 'Loading speech model', 0.08);
    const whisper = await getWhisper();
    const WINDOW = 16000 * 120; // transcribe in 2-minute windows so we can report progress
    let language = null;
    for (let off = 0; off < audio.length; off += WINDOW) {
      const slice = audio.subarray(off, Math.min(off + WINDOW, audio.length));
      if (slice.length < 16000 * 0.5) break;
      const res = await whisper(slice, { return_timestamps: true, chunk_length_s: 30, stride_length_s: 5 });
      const base = off / 16000;
      for (const c of res.chunks || []) {
        const text = (c.text || '').trim();
        if (!text || /^\[.*\]$|^\(.*\)$/.test(text)) continue;
        const s = base + (c.timestamp[0] ?? 0);
        const e = base + (c.timestamp[1] ?? (c.timestamp[0] ?? 0) + 3);
        segments.push({ start: s, end: Math.max(e, s + 0.5), text });
      }
      language ||= res.language || null;
      setStage(id, 'Transcribing speech', 0.1 + 0.45 * Math.min(1, (off + WINDOW) / audio.length));
    }
    segments = dedupe(segments);
    setStage(id, 'Indexing transcript', 0.56);
    const embs = await embedTexts(segments.map((s) => s.text));
    const ins = 'INSERT INTO segments(video_id, start, end, text, embedding) VALUES(?,?,?,?,?)';
    segments.forEach((s, i) => run(ins, id, s.start, s.end, s.text, toBlob(embs[i])));
    if (language) run('UPDATE videos SET language = ? WHERE id = ?', language, id);
  }

  // 3. Visual index: sample frames, embed with CLIP so you can search "red car", "whiteboard", "dog"...
  run('DELETE FROM frames WHERE video_id = ?', id);
  if (info.hasVideo && info.duration > 0) {
    setStage(id, 'Sampling frames', 0.6);
    const fdir = path.join(dir, 'frames');
    fs.rmSync(fdir, { recursive: true, force: true });
    fs.mkdirSync(fdir, { recursive: true });
    const step = Math.max(2, Math.ceil(info.duration / 400));
    await sh('ffmpeg', ['-i', src, '-vf', `fps=1/${step},scale=320:-2`, '-q:v', '5', path.join(fdir, '%05d.jpg')]);
    const files = fs.readdirSync(fdir).filter((f) => f.endsWith('.jpg')).sort();
    setStage(id, 'Understanding visuals', 0.65);
    const BATCH = 32;
    for (let i = 0; i < files.length; i += BATCH) {
      const batch = files.slice(i, i + BATCH);
      const embs = await clipEmbedImages(batch.map((f) => path.join(fdir, f)));
      batch.forEach((f, j) => {
        const t = (i + j) * step + step / 2;
        run('INSERT INTO frames(video_id, t, file, embedding) VALUES(?,?,?,?)', id, Math.min(t, info.duration), f, toBlob(embs[j]));
      });
      setStage(id, 'Understanding visuals', 0.65 + 0.2 * Math.min(1, (i + BATCH) / files.length));
    }
  }

  // 4. AI summary, chapters and tags with the configured free LLM
  setStage(id, 'Writing summary & chapters', 0.88);
  try { await summarize(id); } catch (e) { console.warn('[video] summary skipped:', e.message); }

  run("UPDATE videos SET status = 'ready', stage = 'Ready', progress = 1, error = NULL, updated_at = ? WHERE id = ?", now(), id);
  emit('video', { id, status: 'ready', progress: 1, stage: 'Ready' });
}

// Whisper windows overlap slightly; drop repeated lines.
function dedupe(segs) {
  const out = [];
  for (const s of segs.sort((a, b) => a.start - b.start)) {
    const prev = out[out.length - 1];
    if (prev && prev.text === s.text && s.start - prev.end < 5) { prev.end = Math.max(prev.end, s.end); continue; }
    out.push(s);
  }
  return out;
}

export const fmtTime = (t) => {
  t = Math.max(0, Math.floor(t));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(s).padStart(2, '0')}`;
};

export function transcriptText(id, maxChars = 14000) {
  const segs = all('SELECT start, text FROM segments WHERE video_id = ? ORDER BY start', id);
  let lines = segs.map((s) => `[${fmtTime(s.start)}] ${s.text}`);
  const total = lines.join('\n').length;
  if (total > maxChars) {
    const keep = Math.ceil(lines.length * (maxChars / total));
    const stride = lines.length / keep;
    lines = Array.from({ length: keep }, (_, i) => lines[Math.floor(i * stride)]);
  }
  return lines.join('\n');
}

async function summarize(id) {
  const v = get('SELECT * FROM videos WHERE id = ?', id);
  const transcript = transcriptText(id);
  if (!transcript.trim()) {
    run('UPDATE videos SET summary = ? WHERE id = ?', 'No speech detected. Use visual search to find moments in this video.', id);
    return;
  }
  const out = await chatJSON(
    `Video title: "${v.title}"\nDuration: ${fmtTime(v.duration)}\n\nTimestamped transcript:\n${transcript}\n\n` +
    `Return JSON: {"summary": "3-5 sentence summary", "tags": ["5-8 short topical tags"], ` +
    `"chapters": [{"start": seconds_number, "title": "short chapter title"}], "title": "a better short title if the current one looks like a filename, else empty"}. ` +
    `Chapters must start at 0, be in order, use timestamps from the transcript, and number between 3 and 12 for long videos (fewer for short ones).`
  );
  if (!out) return;
  const chapters = (Array.isArray(out.chapters) ? out.chapters : [])
    .map((c) => ({ start: Math.max(0, Math.min(Number(c.start) || 0, v.duration || 0)), title: String(c.title || '').slice(0, 80) }))
    .filter((c) => c.title)
    .sort((a, b) => a.start - b.start);
  if (chapters.length) chapters[0].start = 0;
  const looksLikeFile = /\.(mp4|mov|mkv|webm|m4v|avi)$|^[\w\-]+$/i.test(v.title || '');
  const title = looksLikeFile && out.title ? String(out.title).slice(0, 120) : v.title;
  run('UPDATE videos SET summary = ?, tags = ?, chapters = ?, title = ? WHERE id = ?',
    String(out.summary || ''), JSON.stringify((out.tags || []).slice(0, 10).map(String)), JSON.stringify(chapters), title, id);
}

export async function makeClip(srcId, start, end, title) {
  const v = get('SELECT * FROM videos WHERE id = ?', srcId);
  if (!v) throw new Error('video not found');
  const { createVideoRecord } = await import('./library.js');
  const rec = createVideoRecord({ title: title || `${v.title} (clip ${fmtTime(start)}–${fmtTime(end)})`, filename: 'source.mp4', mime: 'video/mp4', parent_id: srcId, clip_start: start, clip_end: end });
  await sh('ffmpeg', ['-y', '-ss', String(start), '-i', path.join(videoDir(srcId), v.filename), '-t', String(end - start),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-movflags', '+faststart', path.join(videoDir(rec.id), 'source.mp4')]);
  enqueue(rec.id);
  return rec;
}

export async function importFromUrl(rec, url) {
  const dir = videoDir(rec.id);
  const direct = /\.(mp4|webm|mov|m4v|mkv)(\?|$)/i.test(url);
  if (direct) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`download failed: ${r.status}`);
    const ext = path.extname(new URL(url).pathname) || '.mp4';
    const name = `source${ext}`;
    fs.writeFileSync(path.join(dir, name), Buffer.from(await r.arrayBuffer()));
    run('UPDATE videos SET filename = ? WHERE id = ?', name, rec.id);
  } else {
    // yt-dlp is optional; only used for URLs you have the right to download.
    await sh('yt-dlp', ['-f', 'bv*[ext=mp4][height<=1080]+ba[ext=m4a]/b[ext=mp4]/b', '--merge-output-format', 'mp4', '-o', path.join(dir, 'source.%(ext)s'), '--no-playlist', url]);
    const f = fs.readdirSync(dir).find((x) => x.startsWith('source.'));
    if (!f) throw new Error('download produced no file');
    run('UPDATE videos SET filename = ? WHERE id = ?', f, rec.id);
    try {
      const t = (await sh('yt-dlp', ['--get-title', '--no-playlist', url])).trim();
      if (t) run('UPDATE videos SET title = ? WHERE id = ?', t, rec.id);
    } catch {}
  }
  enqueue(rec.id);
}

export function captions(id, format = 'vtt') {
  const segs = all('SELECT start, end, text FROM segments WHERE video_id = ? ORDER BY start', id);
  const ts = (t, sep) => {
    const ms = Math.round(t * 1000);
    const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000), r = ms % 1000;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${sep}${String(r).padStart(3, '0')}`;
  };
  if (format === 'srt') return segs.map((s, i) => `${i + 1}\n${ts(s.start, ',')} --> ${ts(s.end, ',')}\n${s.text}\n`).join('\n');
  if (format === 'txt') return segs.map((s) => `[${fmtTime(s.start)}] ${s.text}`).join('\n');
  return 'WEBVTT\n\n' + segs.map((s) => `${ts(s.start, '.')} --> ${ts(s.end, '.')}\n${s.text}\n`).join('\n');
}

export { json };
