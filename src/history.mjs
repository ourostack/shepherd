// Reads one session's history (its events.jsonl lines) and says what the session's agent loop was doing. Pure, except readTail.
import fs from 'node:fs';

export const TAIL_BYTES = 4 * 1024 * 1024;
export const READY = 'READY-TO-RESTART';
export const DEFER = 'DEFER';

const LOOP = new Set(['user.message', 'assistant.turn_start', 'assistant.message', 'assistant.turn_end', 'abort', 'session.task_complete',
  'tool.execution_start', 'tool.execution_complete', 'subagent.started', 'subagent.completed', 'external_tool.requested', 'external_tool.completed']);
const textOf = (r) => (typeof r === 'string' ? r : r?.content != null ? String(r.content) : JSON.stringify(r ?? ''));
const parse = (l) => { try { return JSON.parse(l); } catch { return null; } };

// The last `bytes` of a file as lines, without a partial first line (keepPartial keeps it, for a scan of plain text that
// a cut line cannot break). Missing file: no lines.
export function readTail(f, bytes = TAIL_BYTES, { keepPartial = false } = {}) {
  let fd;
  try {
    fd = fs.openSync(f, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    return len < size && !keepPartial ? lines.slice(1) : lines;
  } catch { return []; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

// What `derive` reads off (kept per `kind`) a session's history, computed again only when the file changed. The resident watch asks about
// every session each pass, and reading and parsing megabytes of an idle one every minute burned a core. `d.historyStamp(id)`
// is { key, mtime } (a file's mtime and size); without it, or when the file is newer than `now`, nothing is kept. The
// stamp is taken before the read, so a write in between only makes the next pass read again.
const derived = new WeakMap();
export function derivedFromHistory(d, id, now, kind, derive) {
  const stamp = d.historyStamp?.(id);
  let cache = derived.get(d);
  if (!cache) derived.set(d, (cache = new Map()));
  const hit = stamp && cache.get(`${kind}:${id}`);
  if (hit && hit.key === stamp.key) return hit.value;
  const value = derive(d.history(id));
  if (stamp && stamp.mtime <= now) cache.set(`${kind}:${id}`, { key: stamp.key, value });
  return value;
}

const MAX_LINE_BYTES = 8 * 1024 * 1024;

// The complete lines of a file from byte `from` on, about `maxBytes` of them at most (the line that crosses it is read
// whole), and the byte offset they end at. A line over MAX_LINE_BYTES is cut short and its rest is skipped. Missing file:
// no lines, offset 0.
export function readFrom(f, from, maxBytes, chunkBytes = 256 * 1024) {
  let fd;
  try { fd = fs.openSync(f, 'r'); } catch { return { lines: [], offset: 0 }; }
  try {
    const size = fs.fstatSync(fd).size;
    const lines = [];
    let offset = Math.min(from, size);
    let pos = offset;
    let carry = Buffer.alloc(0);
    while (pos < size && offset - from < maxBytes) {
      const buf = Buffer.alloc(Math.min(chunkBytes, size - pos));
      fs.readSync(fd, buf, 0, buf.length, pos);
      pos += buf.length;
      const data = Buffer.concat([carry, buf]);
      const base = pos - data.length;
      let start = 0;
      let nl;
      while ((nl = data.indexOf(10, start)) >= 0) {
        lines.push(data.subarray(start, nl).toString('utf8'));
        start = nl + 1;
        offset = base + start;
        if (offset - from >= maxBytes) return { lines, offset };
      }
      carry = data.subarray(start);
      if (carry.length > MAX_LINE_BYTES) { carry = Buffer.alloc(0); offset = pos; }
    }
    return { lines, offset };
  } finally { fs.closeSync(fd); }
}

// When the session's agent loop last did something (the time of its last loop event in these lines), or null.
export function lastTurnAt(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l) continue;
    const e = parse(l);
    if (e && LOOP.has(e.type) && Date.parse(e.timestamp || '') > 0) return Date.parse(e.timestamp);
  }
  return null;
}

// Was this session's agent loop working when its history ended? Mid-turn, between turns that asked for tools, with a
// subagent running, or waiting on an async shell or background agent that never reported back. A person's stop, a
// finished task and a plain finished turn are not work.
export function loopState(lines) {
  let last = null, lastMsg = null, running = 0, finished = false;
  let shells = new Map(), agents = new Map();
  const starts = new Map();
  for (const l of lines) {
    if (!l) continue;
    const e = parse(l);
    if (!e) continue;
    const d = e.data || {};
    if (e.type === 'session.start' || e.type === 'session.resume') { shells = new Map(); agents = new Map(); running = 0; }
    if (e.type === 'tool.execution_start') starts.set(d.toolCallId, d);
    if (e.type === 'tool.execution_complete') {
      const s = starts.get(d.toolCallId);
      const out = textOf(d.result);
      if (s?.toolName === 'bash' && s.arguments?.mode === 'async') {
        const id = (out.match(/shellId:\s*([^\s>"\\]+)/) || [])[1] || s.arguments?.shellId;
        if (id && !/completed with exit code|has completed/i.test(out)) shells.set(String(id), s.arguments?.description || 'shell');
      }
      if (s && (s.toolName === 'read_bash' || s.toolName === 'stop_bash') && s.arguments?.shellId != null) {
        if (s.toolName === 'stop_bash' || /completed with exit code|has completed|no (such )?shell|not found|stopped/i.test(out)) shells.delete(String(s.arguments.shellId));
      }
    }
    if (e.type === 'system.notification') {
      const k = d.kind || {};
      if (k.shellId != null) shells.delete(String(k.shellId));
      if (k.agentId) agents.delete(k.agentId);
    }
    if (e.type === 'subagent.started' && d.executionMode === 'background') { agents.set(e.agentId || d.toolCallId, d.agentDisplayName || d.agentName || 'agent'); continue; }
    if ((e.type === 'subagent.completed' || e.type === 'subagent.failed') && agents.has(e.agentId || d.toolCallId)) { agents.delete(e.agentId || d.toolCallId); continue; }
    if (!LOOP.has(e.type)) continue;
    if (e.type === 'abort' && d.reason && d.reason !== 'user_initiated') continue;
    if (e.type === 'subagent.started') running++;
    if (e.type === 'subagent.completed') running = Math.max(0, running - 1);
    if (e.type === 'assistant.message') { lastMsg = e; finished = false; }
    if (e.type === 'session.task_complete') finished = true;
    if (e.type === 'user.message') { lastMsg = null; running = 0; finished = false; }
    last = e.type;
  }
  const owed = [...[...shells.values()].map((x) => `shell "${x}"`), ...[...agents.values()].map((x) => `background agent ${x}`)];
  if (last === 'abort') return { working: false, why: 'stopped by the person' };
  if (last === 'session.task_complete' || (last === 'assistant.turn_end' && finished)) return { working: false, why: 'task complete' };
  if (last === 'assistant.turn_end') {
    const asked = (lastMsg?.data?.toolRequests || []).length > 0;
    if (asked) return { working: true, why: 'between turns (its last turn called tools and no next turn started)' };
    if (running > 0) return { working: true, why: `${running} subagent(s) still running` };
    if (owed.length) return { working: true, why: `waiting on ${owed.slice(0, 3).join(', ')}` };
    return { working: false, why: 'its turn had ended' };
  }
  return last ? { working: true, why: `mid-turn (last ${last})` } : { working: false, why: 'no agent activity' };
}

// The background work a session had running when its history stops: sub-agents started and not completed, and async shell
// jobs started and not completed or stopped, counting only since its last start or resume (what an earlier run left is long
// dead). Each is { name, what } so a resume message can name it.
export function deadWork(lines) {
  let subagents = new Map(), shells = new Map();
  for (const l of lines) {
    if (!l || !/"type":"(subagent\.|tool\.execution_start|system\.notification|session\.(start|resume))/.test(l.slice(0, 60))) continue;
    const e = parse(l);
    const d = e?.data;
    if (!d) continue;
    if (e.type === 'session.start' || e.type === 'session.resume') { subagents = new Map(); shells = new Map(); }
    else if (e.type === 'subagent.started' && d.executionMode === 'background') subagents.set(d.toolCallId, { name: d.agentDisplayName || d.agentName || 'a subagent', what: d.agentDescription || null });
    else if (e.type === 'subagent.completed' || e.type === 'subagent.failed') subagents.delete(d.toolCallId);
    else if (e.type === 'tool.execution_start' && d.toolName === 'bash' && d.arguments?.mode === 'async') shells.set(d.arguments.shellId || d.toolCallId, { name: d.arguments.shellId || 'a shell job', what: d.arguments.description || null });
    else if (e.type === 'tool.execution_start' && d.toolName === 'stop_bash') shells.delete(d.arguments?.shellId);
    else if (e.type === 'system.notification' && d.kind?.type === 'shell_completed') shells.delete(d.kind.shellId);
  }
  return { subagents: [...subagents.values()], shells: [...shells.values()] };
}

// Did anything (a person, a resumer, a queue) send the session a message after `since`?
export function continuedSince(lines, since) {
  for (const l of lines) {
    if (!l || !/"type":"user\.message"/.test(l.slice(0, 80))) continue;
    const e = parse(l);
    if (e && Date.parse(e.timestamp || '') > since) return true;
  }
  return false;
}

// Did the session start a new agent turn after `since`?
export function tookTurnSince(lines, since) {
  for (const l of lines) {
    if (!l || !/"type":"assistant\.turn_start"/.test(l.slice(0, 80))) continue;
    const e = parse(l);
    if (e && Date.parse(e.timestamp || '') > since) return true;
  }
  return false;
}

// The history as it stood at `at` (ms): the lines stamped at or before it. A line with no timestamp is left out.
export function linesUntil(lines, at) {
  return lines.filter((l) => {
    const e = parse(l);
    return Boolean(e) && Date.parse(e.timestamp || '') <= at;
  });
}

// What the session last answered after `since`: { kind: 'ready', at } or { kind: 'defer', at, lanes, minutes }, or null.
// An answer is a line of its own: READY-TO-RESTART, or DEFER: <n> lanes running, optionally with about <m> min.
export function lastReply(lines, since) {
  let out = null;
  for (const l of lines) {
    if (!l || !l.includes('assistant.message')) continue;
    const e = parse(l);
    const at = Date.parse(e?.timestamp || '');
    if (e?.type !== 'assistant.message' || !(at > since)) continue;
    for (const raw of String(e.data?.content ?? '').split('\n')) {
      const line = raw.replace(/[`*_]/g, '').trim();
      if (line.replace(/[\s.]/g, '') === READY) out = { kind: 'ready', at };
      const d = line.match(new RegExp(`^${DEFER}\\s*:\\s*(\\d+)\\s+lanes?\\s+running(?:\\s*,?\\s*about\\s+(\\d+)\\s*min)?`, 'i'));
      if (d) out = { kind: 'defer', at, lanes: Number(d[1]), minutes: d[2] == null ? null : Number(d[2]) };
    }
  }
  return out;
}

export const MESSAGE_MAX_CHARS = 4000;

// The top-level user and assistant messages among these parsed events, oldest first. Text past MESSAGE_MAX_CHARS is cut and marked.
export function messagesIn(events) {
  const messages = [];
  for (const event of events) {
    if (!event || event.agentId !== undefined) continue;
    const data = event.data && typeof event.data === 'object' ? event.data : {};
    const text = typeof data.content === 'string' ? data.content : '';
    if ((event.type === 'user.message' || event.type === 'assistant.message') && text.trim()) {
      messages.push({ at: typeof event.timestamp === 'string' ? event.timestamp : null, role: event.type === 'user.message' ? 'user' : 'assistant', text: text.slice(0, MESSAGE_MAX_CHARS), ...(text.length > MESSAGE_MAX_CHARS ? { truncated: true } : {}) });
    }
  }
  return messages;
}
