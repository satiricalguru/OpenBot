import cron from 'node-cron';
import { all, run, now, get } from '../db.js';
import { createTask } from './runtime.js';

let jobs = [];

export function reloadRoutines() {
  for (const j of jobs) j.stop();
  jobs = [];
  for (const r of all('SELECT * FROM routines WHERE enabled = 1')) {
    if (!cron.validate(r.cron)) continue;
    jobs.push(cron.schedule(r.cron, () => runRoutine(r.id)));
  }
}

export function runRoutine(id) {
  const r = get('SELECT * FROM routines WHERE id = ?', id);
  if (!r) return null;
  run('UPDATE routines SET last_run = ? WHERE id = ?', now(), id);
  return createTask({ agentId: r.agent_id, title: r.name, prompt: r.prompt, routineId: r.id });
}

// Proactive mode: agents that opt in periodically look for useful read-only work,
// like OpenAI's dots doing background research while you're away.
const PROACTIVE_PROMPT = `Proactive check-in. Review what you remember about the user's goals and open projects.
If there is something genuinely useful you can do right now using read-only research (web search, reading files, searching videos), do it and report findings in under 120 words, then call notify_user.
If nothing is worth doing, reply exactly: NOTHING.`;

export function startProactiveLoop() {
  cron.schedule('0 */3 * * *', () => {
    for (const a of all('SELECT * FROM agents WHERE proactive = 1')) {
      createTask({ agentId: a.id, title: 'Proactive check-in', prompt: PROACTIVE_PROMPT });
    }
  });
}
