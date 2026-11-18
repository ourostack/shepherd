// Under swap pressure, free the memory of idle sessions without archiving them. Each session runtime (one process the app
// starts per session, or one shared by a coordinator and the sessions it created) carries its own MCP servers and extensions,
// roughly 150 MB per hosted session. A runtime whose hosted sessions are all archived, or long idle with their work on main, is stopped;
// sending the session a message makes the app load it again, so nothing is lost. A runtime that hosts any running, recent,
// waiting, automated or unlanded session, or one coordinating a session that works, is left alone. Runs inside the retire
// duty, so it does nothing until retire.json enables it.
import { execFile } from 'node:child_process';
import { landedGate } from './landed.mjs';

// A runtime whose real footprint (not its resident size: the OS compresses and swaps the rest) is bloatMb or more is a heavy
// one: it goes after bloatIdleMs of quiet, and a coordinator role or a recent child no longer holds it.
export const UNLOAD = { swapPct: 85, idleMs: 2 * 3600000, perPass: 6, bloatMb: 1000, bloatIdleMs: 15 * 60000 };
/** A session that made another within this long is a live coordinator, whatever its children are doing now. */
export const COORDINATOR_RECENT_MS = 24 * 3_600_000;
export const COORDINATOR_ROLE = /coordinator|ouro ui|desk epoch|orchestrat/i;
const SESSION_ENV = /COPILOT_AGENT_SESSION_ID=([0-9a-f-]{36})/;

const quietSince = (row) => Math.max(Date.parse(row.lastActivity ?? '') || 0, Date.parse(row.updatedAt ?? '') || 0);

// Why a session keeps its runtime loaded, or null when it may go.
export function holdReason(row, listed, now, t = UNLOAD, bloated = false) {
  if (row.isRunning || row.state !== 'idle') return 'it is working';
  if (row.awaiting) return 'it waits on a person';
  if (row.remote) return 'it is remote';
  if (row.automation) return 'it has an automation';
  if (row.openPullRequest) return 'it has an open pull request';
  if (bloated) {
    if (now - quietSince(row) < t.bloatIdleMs) return 'it was active in the last 15 minutes';
  } else if (now - quietSince(row) < t.idleMs) return 'it was active in the last 2 hours';
  const kids = listed.filter((c) => (c.coordinatingCreatorSessionId ?? c.parentSessionId) === row.id || c.creatorSessionId === row.id);
  if (kids.some((c) => c.isRunning || c.state === 'busy')) return 'a session it coordinates is working';
  if (bloated) return null;
  if (COORDINATOR_ROLE.test(row.name ?? '')) return 'it is named for a coordinator role';
  if (kids.some((c) => now - (Date.parse(c.createdAt ?? '') || 0) < COORDINATOR_RECENT_MS)) return 'it created a session in the last day';
  return null;
}

// Plan: which runtimes would be stopped now. `runtimes`: [{ pid, rssMb, sessions: [id] }].
// `archived`: ids the app has archived. An archived session needs no runtime, so it does not hold one.
export async function planUnload({ runtimes, listed, d, swapPct, now = d.now(), t = UNLOAD, apply = false, archived = new Set() }) {
  if (swapPct === null || swapPct < t.swapPct) return { pressure: false, swapPct, stop: [], keep: [] };
  const byId = new Map(listed.map((r) => [r.id, r]));
  const stop = [];
  const keep = [];
  for (const rt of [...runtimes].sort((a, b) => (b.footprintMb ?? b.rssMb) - (a.footprintMb ?? a.rssMb))) {
    const bloated = (rt.footprintMb ?? 0) >= t.bloatMb;
    let why = null;
    if (!rt.sessions.length) why = 'no hosted session is known';
    for (const id of rt.sessions) {
      if (why) break;
      if (archived.has(id) && !byId.has(id)) continue;
      const row = byId.get(id);
      if (!row) { why = 'a hosted session is not in the sidebar'; break; }
      why = holdReason(row, listed, now, t, bloated);
      if (!why) {
        const gate = await landedGate(row, d, false, 'unload');
        if (gate) why = `its work is not on main (${gate.why})`;
      }
    }
    (why ? keep : stop).push({ pid: rt.pid, rssMb: rt.rssMb, ...(rt.footprintMb ? { footprintMb: rt.footprintMb } : {}), sessions: rt.sessions.length, ...(why ? { why } : {}) });
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
  const rts = parseRuntimes(await run('/bin/ps', ['eww', '-axo', 'pid=,ppid=,rss=,command=']));
  await Promise.all(rts.map(async (r) => { r.footprintMb = await realFootprintMb(r.pid).catch(() => null); }));
  return rts;
}

const UNITS = { B: 1 / 1048576, KB: 1 / 1024, MB: 1, GB: 1024, TB: 1048576 };

// The process's footprint in MB from `footprint`, which counts the compressed and swapped pages that `ps` rss leaves out.
export function parseFootprint(out) {
  const m = /Footprint:\s*([\d.]+)\s*([KMGT]?B)\b/.exec(out);
  return m ? Math.round(Number(m[1]) * UNITS[m[2]]) : null;
}

export async function realFootprintMb(pid) {
  return parseFootprint(await run('/usr/bin/footprint', [String(pid)]));
}

// `ps eww` lines: pid, ppid, rss in KB, then the command and its environment.
export function parseRuntimes(out) {
  const rts = new Map();
  const kids = [];
  const parent = new Map();
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const [, pid, ppid, rss, cmd] = m;
    if (/copilot-runtime\b/.test(cmd.split(' ')[0]) && /--server/.test(cmd)) rts.set(Number(pid), { pid: Number(pid), rssMb: Math.round(Number(rss) / 1024), sessions: new Set() });
    parent.set(Number(pid), Number(ppid));
    const id = SESSION_ENV.exec(cmd)?.[1];
    if (id) kids.push({ pid: Number(pid), id });
  }
  // An MCP server may sit under a wrapper, so walk up to the runtime that owns it.
  for (const k of kids) {
    let at = k.pid;
    for (let hops = 0; at && hops < 12; hops++) {
      if (rts.has(at)) { rts.get(at).sessions.add(k.id); break; }
      at = parent.get(at);
    }
  }
  return [...rts.values()].map((r) => ({ ...r, sessions: [...r.sessions] }));
}

export async function realKill(pid) {
  const cmd = await run('/bin/ps', ['-o', 'command=', '-p', String(pid)]).catch(() => '');
  if (!/copilot-runtime/.test(cmd)) return false;
  process.kill(pid, 'SIGTERM');
  return true;
}
