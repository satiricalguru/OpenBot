import { all, get, run, now, uid } from './db.js';

const STARTER_CREW = [
  { name: 'Nova', avatar: '{"shape":"circle","eyes":"capsule","mouth":"none","acc":"none","gaze":"up-right","eye":"#141414","cheeks":false}', color: '#ffffff', role: 'Chief of staff. Plans work, coordinates teammates, keeps track of your goals and follows up.',
    instructions: 'Be proactive and concise. Delegate research to Scout, video work to Reel and building/automation to Forge when it helps.' },
  { name: 'Scout', avatar: '{"shape":"triangle","eyes":"dots","mouth":"none","acc":"none","gaze":"right","eye":"#141414","cheeks":false}', color: '#6cc4a6', role: 'Researcher. Searches the web, reads sources and writes cited briefs.',
    instructions: 'Always cite sources with URLs. Save longer briefs as markdown files in your workspace.' },
  { name: 'Reel', avatar: '{"shape":"squircle","eyes":"happy","mouth":"smile","acc":"headphones","gaze":"center","eye":"#141414","cheeks":true}', color: '#f2a65a', role: 'Video producer. Knows the whole video library: finds moments, writes summaries, show notes, social posts and clip ideas.',
    instructions: 'Use search_videos and ask_video. Always link moments as /watch/<id>?t=<seconds>.' },
  { name: 'Forge', avatar: '{"shape":"diamond","eyes":"line","mouth":"none","acc":"none","gaze":"up-left","eye":"#141414","cheeks":false}', color: '#8b6cff', role: 'Builder. Writes and runs code, scripts and automations on its own computer.',
    instructions: 'Prefer small, working scripts. Test what you build with run_command before reporting back.' },
];

const FLAT_SHAPES = ['circle', 'squircle', 'triangle', 'diamond', 'blob', 'pill', 'cloud', 'hex'];

// Give agents created before the bot avatars a proper look.
function migrateLooks() {
  for (const a of all('SELECT id, name, avatar FROM agents')) {
    let shape = null;
    try { shape = JSON.parse(a.avatar || '{}').shape; } catch {}
    if (FLAT_SHAPES.includes(shape)) continue;
    const preset = STARTER_CREW.find((c) => c.name === a.name);
    if (preset) run('UPDATE agents SET avatar = ?, color = ? WHERE id = ?', preset.avatar, preset.color, a.id);
    else run('UPDATE agents SET avatar = NULL WHERE id = ?', a.id);
  }
}

export function seed() {
  migrateLooks();
  if (get('SELECT count(*) AS n FROM agents').n > 0) return;
  const ids = [];
  STARTER_CREW.forEach((a, i) => {
    const id = uid();
    ids.push(id);
    run('INSERT INTO agents(id, name, avatar, color, role, instructions, model, rules, proactive, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      id, a.name, a.avatar, a.color, a.role, a.instructions, '', '{}', 0, now() + i);
  });
  run('INSERT INTO threads(id, kind, title, members, created_at, updated_at) VALUES(?,?,?,?,?,?)', uid(), 'group', 'The Crew', JSON.stringify(ids), now(), now());
}
