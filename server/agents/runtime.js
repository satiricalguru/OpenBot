import { all, get, run, now, uid, json } from '../db.js';
import { emit, logActivity } from '../events.js';
import { chat } from '../llm.js';
import { TOOLS, TOOL_MAP, ruleFor, HARD_LIMITS, workspaceOf } from './tools.js';

const MAX_STEPS = 14;
const pendingApprovals = new Map(); // approvalId -> resolve(decision)
const activeRuns = new Map(); // runId -> AbortController

// ---------------- messages & threads ----------------
export function postMessage(threadId, { role, agent_id = null, content = '', meta = null }) {
  const m = { id: uid(12), thread_id: threadId, role, agent_id, content, meta: meta ? JSON.stringify(meta) : null, created_at: now() };
  run('INSERT INTO messages(id, thread_id, role, agent_id, content, meta, created_at) VALUES(?,?,?,?,?,?,?)', m.id, threadId, role, agent_id, content, m.meta, m.created_at);
  run('UPDATE threads SET updated_at = ? WHERE id = ?', m.created_at, threadId);
  const out = { ...m, meta };
  emit('message', { message: out });
  return out;
}

export function ensureDirectThread(agentId) {
  const t = get("SELECT * FROM threads WHERE kind = 'direct' AND members = ?", JSON.stringify([agentId]));
  if (t) return t;
  const id = uid();
  run('INSERT INTO threads(id, kind, title, members, created_at, updated_at) VALUES(?,?,?,?,?,?)', id, 'direct', null, JSON.stringify([agentId]), now(), now());
  return get('SELECT * FROM threads WHERE id = ?', id);
}

function setStatus(agentId, status) {
  run('UPDATE agents SET status = ? WHERE id = ?', status, agentId);
  emit('agent_status', { agent_id: agentId, status });
}

// ---------------- prompt ----------------
function systemPrompt(agent, thread, from, multi = false) {
  const teammates = all('SELECT name, role FROM agents WHERE id != ?', agent.id);
  const memories = all('SELECT content FROM memories WHERE agent_id = ? ORDER BY created_at DESC LIMIT 40', agent.id);
  const skills = all('SELECT name, description, steps FROM skills WHERE agent_id = ? ORDER BY created_at DESC LIMIT 20', agent.id);
  const routines = all('SELECT name, cron FROM routines WHERE agent_id = ? AND enabled = 1', agent.id);
  const blocked = TOOLS.filter((t) => ruleFor(agent, t.name) === 'block').map((t) => t.name);
  const ask = TOOLS.filter((t) => ruleFor(agent, t.name) === 'ask').map((t) => t.name);

  return [
    `You are ${agent.name}, an always-on AI teammate running inside OpenBot (free, open-source, self-hosted).`,
    agent.role ? `Your role: ${agent.role}` : '',
    agent.instructions ? `Instructions from your user:\n${agent.instructions}` : '',
    `Current date/time: ${new Date().toString()}.`,
    `You have your own computer: a private workspace folder with a terminal, files and a web browser (tools). Work there; save deliverables as files when useful.`,
    `How to work: break tasks into steps, use tools to actually do the work (don't just describe it), verify results, then give a short, clear final answer with what you did and any links/files. When you learn a lasting preference or fact about the user, call remember. When you complete a repeatable procedure, consider save_skill.`,
    ask.length ? `These tools need the user's approval each time (the system will ask them; just call the tool): ${ask.join(', ')}.` : '',
    blocked.length ? `You are NOT allowed to use: ${blocked.join(', ')}.` : '',
    `Never handle passwords, payment details or 2FA codes; ask the user to do those steps themselves.`,
    teammates.length ? `Teammates you can hand work to with message_agent or assign_task:\n${teammates.map((t) => `- ${t.name}: ${t.role || ''}`).join('\n')}` : '',
    thread.kind === 'group' ? `This is a group chat with your teammates. Earlier messages from teammates are shown prefixed with [Name] for context only. Speak ONLY as ${agent.name}, in first person. Never write lines for teammates, never simulate a conversation, and never start your reply with a [Name] prefix. Only answer what's addressed to you; keep it brief.` : '',
    from ? `${from} handed this to you. Reply with the result for them.` : '',
    multi ? `Your teammates will each reply after you in their own messages. Write only your own reply, in your own voice, without explaining what you will or won't do.` : '',
    memories.length ? `What you remember:\n${memories.map((m) => `- ${m.content}`).join('\n')}` : '',
    skills.length ? `Skills you have learned (follow them when relevant):\n${skills.map((s) => `## ${s.name}\n${s.description || ''}\n${s.steps}`).join('\n\n')}` : '',
    routines.length ? `Your scheduled routines: ${routines.map((r) => `${r.name} (${r.cron})`).join('; ')}` : '',
  ].filter(Boolean).join('\n\n');
}

function historyFor(agent, threadId, limit = 30) {
  const rows = all("SELECT * FROM messages WHERE thread_id = ? AND role IN ('user','agent') ORDER BY created_at DESC LIMIT ?", threadId, limit).reverse();
  const names = new Map(all('SELECT id, name FROM agents').map((a) => [a.id, a.name]));
  const out = [];
  for (const m of rows) {
    if (!m.content) continue;
    if (m.role === 'agent' && m.agent_id === agent.id) out.push({ role: 'assistant', content: m.content });
    else if (m.role === 'agent') out.push({ role: 'user', content: `[${names.get(m.agent_id) || 'Teammate'}]: ${m.content}` });
    else out.push({ role: 'user', content: m.content });
  }
  // Merge consecutive same-role messages (some models require alternation)
  return out.reduce((acc, m) => {
    const last = acc[acc.length - 1];
    if (last && last.role === m.role) last.content += `\n\n${m.content}`;
    else acc.push({ ...m });
    return acc;
  }, []);
}

// ---------------- approvals ----------------
function requestApproval(agent, threadId, tool, args) {
  const id = uid();
  run('INSERT INTO approvals(id, agent_id, thread_id, tool, args, status, created_at) VALUES(?,?,?,?,?,?,?)', id, agent.id, threadId, tool, JSON.stringify(args), 'pending', now());
  const approval = get('SELECT * FROM approvals WHERE id = ?', id);
  emit('approval', { approval: { ...approval, args, agent_name: agent.name } });
  emit('notify', { agent_id: agent.id, title: `${agent.name} needs approval`, message: `${TOOL_MAP[tool]?.label || tool}: ${summarizeArgs(args)}` });
  logActivity(agent.id, 'approval', `Asked to ${TOOL_MAP[tool]?.label || tool}`, { approval_id: id });
  return new Promise((resolve) => pendingApprovals.set(id, resolve));
}

export function decideApproval(id, decision) {
  const a = get('SELECT * FROM approvals WHERE id = ?', id);
  if (!a || a.status !== 'pending') return false;
  const status = decision === 'deny' ? 'denied' : 'approved';
  run('UPDATE approvals SET status = ?, decided_at = ? WHERE id = ?', status, now(), id);
  if (decision === 'always') {
    const agent = get('SELECT rules FROM agents WHERE id = ?', a.agent_id);
    const rules = json(agent.rules, {});
    rules[a.tool] = 'allow';
    run('UPDATE agents SET rules = ? WHERE id = ?', JSON.stringify(rules), a.agent_id);
  }
  emit('approval', { approval: { ...a, status } });
  const resolve = pendingApprovals.get(id);
  pendingApprovals.delete(id);
  if (resolve) resolve(decision);
  return true;
}

export function expireStaleApprovals() {
  run("UPDATE approvals SET status = 'expired' WHERE status = 'pending'");
}

const summarizeArgs = (args) => {
  const s = Object.entries(args || {}).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ');
  return s.length > 160 ? s.slice(0, 160) + '…' : s;
};

// Small local models sometimes imitate the [Name]: transcript format; keep only the bot's own voice.
function cleanReply(text, agent) {
  let t = String(text || '').trim();
  const names = all('SELECT name FROM agents').map((a) => a.name);
  const re = new RegExp(`^\\[(${names.join('|')})\\]:?\\s*`, 'i');
  if (/^\[[^\]]+\]:?/.test(t)) {
    const lines = t.split('\n');
    const own = lines.filter((l) => { const m = l.match(re); return !m || m[1].toLowerCase() === agent.name.toLowerCase(); }).map((l) => l.replace(re, ''));
    t = own.join('\n').trim();
  }
  return t.replace(re, '').trim();
}

// ---------------- the agent loop ----------------
export async function runAgent({ agentId, threadId, depth = 0, from = null, multi = false }) {
  const agent = get('SELECT * FROM agents WHERE id = ?', agentId);
  const thread = get('SELECT * FROM threads WHERE id = ?', threadId);
  if (!agent || !thread) throw new Error('agent or thread not found');
  workspaceOf(agent.id);

  const runId = uid();
  const ctrl = new AbortController();
  activeRuns.set(runId, { ctrl, agentId, threadId });
  setStatus(agent.id, 'working');
  emit('run', { run_id: runId, agent_id: agent.id, thread_id: threadId, state: 'start' });

  const messages = [{ role: 'system', content: systemPrompt(agent, thread, from, multi) }, ...historyFor(agent, threadId)];
  if (messages[messages.length - 1]?.role !== 'user') messages.push({ role: 'user', content: 'Continue.' });
  const tools = TOOLS.filter((t) => ruleFor(agent, t.name) !== 'block').map(({ name, description, parameters }) => ({ name, description, parameters }));

  let final = '';
  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const res = await chat({
        messages, tools, model: agent.model || undefined, signal: ctrl.signal,
        onToken: (token) => emit('token', { run_id: runId, agent_id: agent.id, thread_id: threadId, token }),
      });
      if (!res.tool_calls.length) { final = res.content.trim(); break; }

      messages.push({ role: 'assistant', content: res.content, tool_calls: res.tool_calls });
      emit('token_reset', { run_id: runId });
      for (const call of res.tool_calls) {
        const result = await executeTool(agent, threadId, call, depth);
        messages.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: result });
      }
      if (step === MAX_STEPS - 1) {
        messages.push({ role: 'user', content: 'You have used many steps. Stop calling tools and give your final answer now.' });
        final = (await chat({ messages, model: agent.model || undefined, signal: ctrl.signal })).content.trim();
      }
    }
  } catch (e) {
    final = ctrl.signal.aborted ? '_Stopped._' : `⚠️ I hit an error: ${e.message}`;
  } finally {
    activeRuns.delete(runId);
    emit('run', { run_id: runId, agent_id: agent.id, thread_id: threadId, state: 'end' });
    setStatus(agent.id, [...activeRuns.values()].some((r) => r.agentId === agent.id) ? 'working' : 'idle');
  }
  final = cleanReply(final, agent);
  if (!final) final = 'Done.';
  postMessage(threadId, { role: 'agent', agent_id: agent.id, content: final });
  return final;
}

async function executeTool(agent, threadId, call, depth) {
  const tool = TOOL_MAP[call.name];
  const args = call.arguments || {};
  const toolMsg = postMessage(threadId, { role: 'tool', agent_id: agent.id, content: '', meta: { name: call.name, label: tool?.label, args, status: 'running' } });
  const finish = (status, result) => {
    const meta = { name: call.name, label: tool?.label, args, status, result: String(result).slice(0, 4000) };
    run('UPDATE messages SET meta = ?, content = ? WHERE id = ?', JSON.stringify(meta), status, toolMsg.id);
    emit('message_update', { id: toolMsg.id, thread_id: threadId, meta, content: status });
    return String(result);
  };

  if (!tool) return finish('error', `Unknown tool ${call.name}`);
  const flat = JSON.stringify(args);
  if (HARD_LIMITS.some((re) => re.test(flat))) return finish('blocked', 'Blocked: this action is never allowed for agents. Ask the user to do it themselves.');

  const rule = ruleFor(agent, call.name);
  if (rule === 'block') return finish('blocked', 'Blocked by your rules.');
  if (rule === 'ask') {
    finish('waiting', 'Waiting for approval…');
    setStatus(agent.id, 'waiting');
    const decision = await requestApproval(agent, threadId, call.name, args);
    setStatus(agent.id, 'working');
    if (decision === 'deny') return finish('denied', 'The user denied this action. Do not retry it; continue another way or explain.');
  }
  try {
    const result = await tool.run(args, { agent, threadId, depth });
    return finish('done', result);
  } catch (e) {
    return finish('error', `Error: ${e.message}`);
  }
}

export function stopRuns(threadId) {
  for (const [, r] of activeRuns) if (!threadId || r.threadId === threadId) r.ctrl.abort();
  for (const a of all("SELECT * FROM approvals WHERE status = 'pending'" + (threadId ? ' AND thread_id = ?' : ''), ...(threadId ? [threadId] : [])))
    decideApproval(a.id, 'deny');
}

// ---------------- user entry points ----------------
export async function handleUserMessage(threadId, content) {
  const thread = get('SELECT * FROM threads WHERE id = ?', threadId);
  postMessage(threadId, { role: 'user', content });
  const members = json(thread.members, []);
  const agents = members.map((id) => get('SELECT * FROM agents WHERE id = ?', id)).filter(Boolean);
  let targets = agents.filter((a) => new RegExp(`@${a.name}\\b`, 'i').test(content));
  if (!targets.length && /@(all|everyone|team)\b/i.test(content)) targets = agents;
  if (!targets.length) targets = agents.slice(0, 1); // the lead answers by default
  for (const a of targets) await runAgent({ agentId: a.id, threadId, multi: targets.length > 1 });
}

export function createTask({ agentId, title, prompt, routineId = null }) {
  const agent = get('SELECT * FROM agents WHERE id = ?', agentId);
  const threadId = uid();
  run('INSERT INTO threads(id, kind, title, members, created_at, updated_at) VALUES(?,?,?,?,?,?)', threadId, 'task', title, JSON.stringify([agentId]), now(), now());
  const id = uid();
  run('INSERT INTO tasks(id, agent_id, thread_id, title, prompt, status, routine_id, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)', id, agentId, threadId, title, prompt, 'running', routineId, now(), now());
  emit('task', { id, status: 'running' });
  logActivity(agentId, 'task', `Started: ${title}`, { task_id: id });
  postMessage(threadId, { role: 'user', content: prompt });
  runAgent({ agentId, threadId })
    .then((result) => {
      run("UPDATE tasks SET status = 'done', result = ?, updated_at = ? WHERE id = ?", result, now(), id);
      emit('task', { id, status: 'done' });
      emit('notify', { agent_id: agentId, title: `${agent.name} finished a task`, message: title });
      logActivity(agentId, 'task_done', `Finished: ${title}`, { task_id: id });
    })
    .catch((e) => {
      run("UPDATE tasks SET status = 'failed', result = ?, updated_at = ? WHERE id = ?", e.message, now(), id);
      emit('task', { id, status: 'failed' });
    });
  return get('SELECT * FROM tasks WHERE id = ?', id);
}

/** Turn a finished conversation into a reusable skill ("show it once, it learns"). */
export async function distillSkill(agentId, threadId) {
  const msgs = all('SELECT role, content, meta FROM messages WHERE thread_id = ? ORDER BY created_at', threadId);
  const transcript = msgs.map((m) => {
    if (m.role === 'tool') { const meta = json(m.meta, {}); return `TOOL ${meta.name}(${JSON.stringify(meta.args)}) -> ${String(meta.result || '').slice(0, 300)}`; }
    return `${m.role.toUpperCase()}: ${m.content}`;
  }).join('\n').slice(-12000);
  const { chatJSON } = await import('../llm.js');
  const s = await chatJSON(`From this work session, write a reusable skill (procedure) so the same job can be repeated later with different inputs.\n\n${transcript}\n\nReturn JSON {"name": "...", "description": "when to use it", "steps": "numbered steps, mention which tools to use"}`);
  if (!s?.name) throw new Error('Could not extract a skill from this conversation');
  const id = uid();
  run('INSERT INTO skills(id, agent_id, name, description, steps, created_at) VALUES(?,?,?,?,?,?)', id, agentId, s.name, s.description || '', String(s.steps), now());
  emit('skills', { agent_id: agentId });
  return get('SELECT * FROM skills WHERE id = ?', id);
}
