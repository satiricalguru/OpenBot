import fs from 'node:fs';
import path from 'node:path';
import { all, get, run, now, uid, fromBlob, json, VIDEO_DIR } from '../db.js';
import { embedTexts, clipEmbedText, cosine } from './models.js';
import { chat } from '../llm.js';
import { fmtTime, transcriptText } from './pipeline.js';

export function createVideoRecord({ title, filename, mime, source_url = null, parent_id = null, clip_start = null, clip_end = null, description = '' }) {
  const id = uid(10);
  fs.mkdirSync(path.join(VIDEO_DIR, id), { recursive: true });
  run(`INSERT INTO videos(id, title, description, filename, mime, status, stage, progress, source_url, parent_id, clip_start, clip_end, created_at, updated_at)
       VALUES(?,?,?,?,?, 'queued', 'Queued', 0, ?,?,?,?,?,?)`,
    id, title, description, filename, mime, source_url, parent_id, clip_start, clip_end, now(), now());
  return get('SELECT * FROM videos WHERE id = ?', id);
}

export function serialize(v) {
  if (!v) return null;
  return {
    ...v,
    tags: json(v.tags, []),
    chapters: json(v.chapters, []),
    thumb: fs.existsSync(path.join(VIDEO_DIR, v.id, 'thumb.jpg')) ? `/media/${v.id}/thumb.jpg?v=${v.updated_at}` : null,
    src: `/media/${v.id}/${v.filename}`,
  };
}

export function deleteVideo(id) {
  run('DELETE FROM videos WHERE id = ?', id);
  fs.rmSync(path.join(VIDEO_DIR, id), { recursive: true, force: true });
}

/**
 * Multimodal search: exact words, meaning (semantic transcript embeddings) and
 * visuals (CLIP frame embeddings). Scope to one video with videoId.
 */
export async function search(q, { videoId = null, limit = 40, modes = ['keyword', 'semantic', 'visual'] } = {}) {
  q = String(q || '').trim();
  if (!q) return [];
  const results = [];
  const where = videoId ? 'AND s.video_id = ?' : '';
  const vfilter = videoId ? [videoId] : [];

  if (modes.includes('keyword')) {
    const rows = all(`SELECT s.video_id, s.start, s.end, s.text FROM segments s JOIN videos v ON v.id = s.video_id
                      WHERE s.text LIKE ? ${where} ORDER BY s.video_id, s.start LIMIT 200`, `%${q}%`, ...vfilter);
    for (const r of rows) results.push({ video_id: r.video_id, t: r.start, end: r.end, type: 'speech', text: r.text, score: 1 });
  }

  if (modes.includes('semantic')) {
    const [qe] = await embedTexts([q]);
    const rows = all(`SELECT s.video_id, s.start, s.end, s.text, s.embedding FROM segments s WHERE s.embedding IS NOT NULL ${where}`, ...vfilter);
    const scored = rows.map((r) => ({ r, score: cosine(qe, fromBlob(r.embedding)) })).filter((x) => x.score > 0.35);
    scored.sort((a, b) => b.score - a.score);
    for (const { r, score } of scored.slice(0, limit))
      results.push({ video_id: r.video_id, t: r.start, end: r.end, type: 'speech', text: r.text, score: 0.3 + score * 0.7 });
  }

  if (modes.includes('visual')) {
    const qe = await clipEmbedText(q.length < 40 ? `a photo of ${q}` : q);
    const rows = all(`SELECT f.video_id, f.t, f.file, f.embedding FROM frames f WHERE f.embedding IS NOT NULL ${videoId ? 'AND f.video_id = ?' : ''}`, ...vfilter);
    const scored = rows.map((r) => ({ r, score: cosine(qe, fromBlob(r.embedding)) })).sort((a, b) => b.score - a.score);
    const best = scored[0]?.score || 0;
    // CLIP similarities cluster tightly; keep frames close to the best match and above an absolute floor.
    const keep = scored.filter((x) => x.score > 0.235 && x.score > best - 0.03).slice(0, limit);
    for (const { r, score } of keep)
      results.push({ video_id: r.video_id, t: r.t, type: 'visual', frame: `/media/${r.video_id}/frames/${r.file}`, score: Math.min(1, (score - 0.15) * 4) });
  }

  // Merge near-duplicate hits (same video, within 2s, same type)
  results.sort((a, b) => b.score - a.score);
  const merged = [];
  for (const r of results) {
    if (merged.some((m) => m.video_id === r.video_id && m.type === r.type && Math.abs(m.t - r.t) < 2)) continue;
    merged.push(r);
  }
  return merged.slice(0, limit * 2);
}

export async function searchLibrary(q) {
  const hits = await search(q, { limit: 60 });
  const byVideo = new Map();
  for (const h of hits) {
    if (!byVideo.has(h.video_id)) byVideo.set(h.video_id, { video: serialize(get('SELECT * FROM videos WHERE id = ?', h.video_id)), hits: [], score: 0 });
    const g = byVideo.get(h.video_id);
    g.hits.push(h);
    g.score = Math.max(g.score, h.score) + 0.02;
  }
  // Also match titles, tags and summaries.
  for (const v of all('SELECT * FROM videos WHERE title LIKE ? OR tags LIKE ? OR summary LIKE ?', `%${q}%`, `%${q}%`, `%${q}%`)) {
    if (!byVideo.has(v.id)) byVideo.set(v.id, { video: serialize(v), hits: [], score: 0.5 });
    else byVideo.get(v.id).score += 0.3;
  }
  return [...byVideo.values()].filter((g) => g.video).sort((a, b) => b.score - a.score)
    .map((g) => ({ ...g, hits: g.hits.sort((a, b) => a.t - b.t).slice(0, 12) }));
}

/** Answer a question about one video (or the whole library) grounded in transcript + visual hits. */
export async function askVideo(question, { videoId = null, history = [], onToken } = {}) {
  const hits = await search(question, { videoId, limit: 12, modes: ['semantic', 'keyword', 'visual'] });
  let context = '';
  if (videoId) {
    const v = get('SELECT title, summary, duration FROM videos WHERE id = ?', videoId);
    context += `Video: "${v.title}" (${fmtTime(v.duration)})\nSummary: ${v.summary || 'n/a'}\n\nTranscript:\n${transcriptText(videoId, 10000)}\n`;
  } else {
    const titles = new Map(all('SELECT id, title FROM videos').map((v) => [v.id, v.title]));
    context += 'Relevant moments from the video library:\n' + hits.filter((h) => h.type === 'speech')
      .map((h) => `- [video:${h.video_id} "${titles.get(h.video_id)}" @ ${fmtTime(h.t)}] ${h.text}`).join('\n');
  }
  const visual = hits.filter((h) => h.type === 'visual').slice(0, 5);
  if (visual.length) context += `\nFrames that visually match the question appear at: ${visual.map((h) => fmtTime(h.t) + (videoId ? '' : ` (video:${h.video_id})`)).join(', ')}\n`;

  const messages = [
    { role: 'system', content: 'You answer questions about videos using only the provided transcript and visual-match context. Cite moments as [mm:ss] timestamps so the user can jump there. Be concise. If the answer is not in the context, say so.' },
    ...history.slice(-6),
    { role: 'user', content: `${context}\n\nQuestion: ${question}` },
  ];
  const { content } = await chat({ messages, onToken });
  return { answer: content, hits: hits.slice(0, 8) };
}
