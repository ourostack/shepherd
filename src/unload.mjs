// Under swap pressure, free the memory of idle sessions without archiving them. Each session runtime (one process the app
// starts per session, or one shared by a coordinator and the sessions it created) carries its own MCP servers and extensions,
// roughly 150 MB per hosted session. A runtime whose hosted sessions are all long idle, with their work on main, is stopped;
// sending the session a message makes the app load it again, so nothing is lost. A runtime that hosts any running, recent,
// waiting, automated or unlanded session, or one coordinating a session that works, is left alone. Runs inside the retire
// duty, so it does nothing until retire.json enables it.
import { execFile } from 'node:child_process';
import { landedGate } from './landed.mjs';

export const UNLOAD = { swapPct: 85, idleMs: 2 * 3600000, perPass: 2 };
const SESSION_ENV = /COPILOT_AGENT_SESSION_ID=([0-9a-f-]{36})/;

const quietSince = (row) => Math.max(Date.parse(row.lastActivity ?? '') || 0, Date.parse(row.updatedAt ?? '') || 0);

// Why a session keeps its runtime loaded, or null when it may go.
export function holdReason(row, listed, now, t = UNLOAD) {
  if (row.isRunning || row.state !== 'idle') return 'it is working';
  if (row.awaiting) return 'it waits on a person';
  if (row.remote) return 'it is remote';
  if (row.automation) return 'it has an automation';
  if (row.openPullRequest) return 'it has an open pull request';
  if (now - quietSince(row) < t.idleMs) return 'it was active in the last 2 hours';
  const kids = listed.filter((c) => (c.coordinatingCreatorSessionId ?? c.parentSessionId) === row.id);
  if (kids.some((c) => c.isRunning || c.state === 'busy')) return 'a session it coordinates is working';
  return null;
}

// Plan: which runtimes would be stopped now. `runtimes`: [{ pid, rssMb, sessions: [id] }].
export async function planUnload({ runtimes, listed, d, swapPct, now = d.now(), t = UNLOAD, apply = false }) {
  if (swapPct === null || swapPct < t.swapPct) return { pressure: false, swapPct, stop: [], keep: [] };
  const byId = new Map(listed.map((r) => [r.id, r]));
  const stop = [];
  const keep = [];
  for (const rt of [...runtimes].sort((a, b) => b.rssMb - a.rssMb)) {
    let why = null;
    if (!rt.sessions.length) why = 'no hosted session is known';
    for (const id of rt.sessions) {
      if (why) break;
      const row = byId.get(id);
      if (!row) { why = 'a hosted session is not in the sidebar'; break; }
      why = holdReason(row, listed, now, t);
      if (!why) {
        const gate = await landedGate(row, d, false, 'unload');
        if (gate) why = `its work is not on main (${gate.why})`;
      }
    }
    (why ? keep : stop).push({ pid: rt.pid, rssMb: rt.rssMb, sessions: rt.sessions.length, ...(why ? { why } : {}) });
  }
  return { pressure: true, swapPct, stop: stop.slice(0, t.perPass), keep, apply };
}

export async function unloadIdle(args, kill) {
  const plan = await planUnload(args);
  if (args.apply) for (const s of plan.stop) s.done = await kill(s.pid).catch(() => false);
  return plan;
}

const run = (cmd, argv) => new Promise((resolve, reject) => execFile(cmd, argv, { timeout: 60000, maxBuffer: 64 << 20 }, (e, out) => (e ? reject(e) : resolve(String(out)))));

// The session runtimes and the sessions each hosts, found from the environment of the processes it starts.
export async function realRuntimes() {
  const out = await run('/bin/ps', ['-axeww', '-o', 'pid=,ppid=,rss=,command=']);
  const rts = new Map();
  const kids = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const [, pid, ppid, rss, cmd] = m;
    if (/copilot-runtime\b/.test(cmd.split(' ')[0]) && /--server/.test(cmd)) rts.set(Number(pid), { pid: Number(pid), rssMb: Math.round(Number(rss) / 1024), sessions: new Set() });
    else kids.push({ ppid: Number(ppid), id: SESSION_ENV.exec(cmd)?.[1] });
  }
  for (const k of kids) if (k.id) rts.get(k.ppid)?.sessions.add(k.id);
  return [...rts.values()].map((r) => ({ ...r, sessions: [...r.sessions] }));
}

export async function realKill(pid) {
  const cmd = await run('/bin/ps', ['-o', 'command=', '-p', String(pid)]).catch(() => '');
  if (!/copilot-runtime/.test(cmd)) return false;
  process.kill(pid, 'SIGTERM');
  return true;
}
