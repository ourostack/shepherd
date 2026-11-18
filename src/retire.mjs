// The retire duties. The sidebar shows live jobs only. Each minute, with no model turn, two kinds of session leave it, through
// the app's archive (reversible, worktree kept), logged in the state folder:
//
// - Handed off: a session whose job has a newer owner, a later session's first message says `Succeeds: <its id>` (handoff.mjs).
//   It goes once that successor has finished its first turn and it has itself been idle for HANDOFF_QUIET_MS.
// - Finished: an idle session whose coordinator is archived or gone, with no open pull request and no automation, and no turn
//   for FINISHED_IDLE_MS.
//
// - Idle and landed: any other idle session, coordinated or not, quiet for IDLE_LANDED_MS with its work on main (nothing is
//   committed, pushed or opened for it: a session with unlanded work simply stays). Each idle session holds its MCP servers and
//   extensions, about 150 MB, so this is what frees the Mac's memory. It never takes a coordinator: a session with a working
//   child, one that created a session in the last day, or one named for the role.
//
// None of these ever goes while it runs, waits on a person, or is stuck, or while a session it coordinates still works: the app
// archives a session without its children, which keep running but can no longer report to it, so a predecessor stays until
// its children are idle, and its successor is then told which children it had. The duty does nothing until
// ~/.config/shepherd/retire.json (or SHEPHERD_RETIRE_CONFIG) says "enabled": true.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ShepherdError } from './error.mjs';
import { tellAgent } from './health-watch.mjs';
import { coordinatorOf } from './coordinator.mjs';
import { refreshSuccessions, successorOf } from './handoff.mjs';
import { plain } from './notice.mjs';
import { rows } from './rows.mjs';
import { DELIVER_MS, archiveRow, identityId } from './store.mjs';
import { deps } from './sessions.mjs';
import { sendTo } from './socket.mjs';
import { landedGate } from './landed.mjs';
import { realProbes } from './responsiveness.mjs';
import { realKill, realRuntimes, unloadIdle } from './unload.mjs';
import { noticeOversizedSessions, whereItLeftOff } from './size-watch.mjs';

export const HANDOFF_QUIET_MS = 5 * 60_000;
/** A day: an orphan quiet this long has had a full day for its coordinator's successor to pick it up. */
export const FINISHED_IDLE_MS = 24 * 3_600_000;

/** Two hours: long enough that the person is not about to come back, short enough to free memory the same day. */
export const IDLE_LANDED_MS = 2 * 3_600_000;
/** A session that made another within this long is a live coordinator, whatever its children are doing now. */
export const COORDINATOR_RECENT_MS = 24 * 3_600_000;
export const IDLE_LANDED_PER_PASS = 12;
export const SESSION_MB = 150;
const COORDINATOR_ROLE = /coordinator|ouro ui|desk epoch|orchestrat/i;
const HELD_AGAIN_MS = 30 * 60_000;
const heldUntil = new Map();

const quietSince = (row) => Math.max(Date.parse(row.lastActivity ?? '') || 0, Date.parse(row.updatedAt ?? '') || 0);
const settled = (row) => !row.isRunning && row.state === 'idle' && !row.awaiting && !row.remote;
const recordedCoordinator = (row) => row.coordinatingCreatorSessionId ?? row.parentSessionId;
const short = (id) => id.slice(0, 8);

export function childrenNote(predecessor, children) {
  const list = children.map((child) => `"${plain(child.name, 60)}" (${child.id})`).join(', ');
  return `I archived "${plain(predecessor.name, 60)}" (${predecessor.id}), the session you succeed, now that you have taken over and it is idle. It coordinated ${list}. They are idle and can no longer report to it; message them by id if their work continues. The archive is reversible from the app.`;
}

// The retire duties' config from retire.json: { enabled } for the duties, { idleLanded } for the idle-and-landed archive. No file: off. A file that is not JSON is an error.
export const retireFile = (env = process.env, home = os.homedir()) => env.SHEPHERD_RETIRE_CONFIG || path.join(home, '.config', 'shepherd', 'retire.json');

export function retireConfig(file = retireFile()) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { enabled: false, idleLanded: false };
    throw new ShepherdError({ code: 'retire-config', problem: `${file} could not be read (${e.message})`, fix: 'check the file, or delete it to turn retire off' });
  }
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    throw new ShepherdError({ code: 'retire-config', problem: `${file} is not valid JSON (${e.message})`, fix: 'fix the file, or delete it to turn retire off' });
  }
  return { enabled: obj?.enabled === true, idleLanded: obj?.idleLanded === true };
}

// The retire duties' deps: Shepherd's app deps, and the agent's notices (the health watch's tell).
export function retireDeps({ copilotHome, base = deps({ copilotHome }) } = {}) {
  return { ...base, tell: tellAgent({ state: base.state }) };
}

const doSend = async (d, id, text) => (d.send ? d.send(id, text) : sendTo(d, id, text, DELIVER_MS));
const doArchive = async (d, row, reason, note) => {
  try { return (await (d.archive ? d.archive(row, reason, note) : archiveRow(d, row, reason, note))) === true; } catch { return false; }
};

// Archives the handed-off and the finished sessions among `listed`. Returns one entry per decision: { what: 'archive' |
// 'hold', id, name, reason, why, done }. apply: false decides the same and changes nothing.
export async function retireSessions(listed, d, { apply = false, idleLanded = false } = {}) {
  const now = d.now();
  const successions = refreshSuccessions(d, listed.map((row) => row.id), { write: apply });
  const byId = new Map(listed.map((row) => [row.id, row]));
  const childrenOf = (id) => listed.filter((row) => recordedCoordinator(row) === id);
  const busyChildren = (id, except) => childrenOf(id).filter((child) => child.id !== except && !(settled(child) || (child.remote && !child.isRunning)));
  const entries = [];
  const gone = new Set();
  const gated = new Set();

  for (const row of listed) {
    if (!settled(row) || now - quietSince(row) < HANDOFF_QUIET_MS) continue;
    const direct = Object.entries(successions).find(([, entry]) => entry.predecessor === row.id && entry.turned)?.[0];
    if (!direct) continue;
    const successor = successorOf(row.id, successions);
    if (!successor) continue;
    const busy = busyChildren(row.id, direct);
    if (busy.length) {
      entries.push({ what: 'hold', id: row.id, name: row.name, reason: 'handed-off', done: false, why: `held while sessions it coordinates still work: ${busy.map((c) => short(c.id)).join(', ')}` });
      continue;
    }
    const gate = await landedGate(row, d, apply, 'handed-off');
    if (gate) { entries.push(gate); gated.add(row.id); continue; }
    const heir = byId.get(successor);
    // The app deletes an archived session's automation, and restoring it does not bring it back.
    const why = `succeeded by ${heir ? `"${plain(heir.name, 60)}" ` : ''}(${short(successor)}); ${whereItLeftOff(row, d)}${row.automation ? '; its automation was removed with it' : ''}`;
    if (apply && !(await doArchive(d, row, 'handed-off', why))) continue;
    gone.add(row.id);
    entries.push({ what: 'archive', id: row.id, name: row.name, reason: 'handed-off', done: apply, why });
    const orphans = childrenOf(row.id).filter((child) => child.id !== direct && child.id !== successor);
    if (apply && orphans.length && heir) await doSend(d, successor, childrenNote(row, orphans)).catch(() => undefined);
  }

  for (const row of listed) {
    if (gone.has(row.id) || gated.has(row.id) || !settled(row) || row.openPullRequest || row.automation) continue;
    const coordinator = recordedCoordinator(row);
    if (!coordinator || (byId.has(coordinator) && !gone.has(coordinator))) continue;
    // The recorded coordinator may have handed off: a lane that a live successor or the session it reports to still
    // coordinates is not finished.
    const live = coordinatorOf(row, listed, { d, successorOf: (id) => successorOf(id, successions) });
    if (live && 'id' in live && !gone.has(live.id)) continue;
    if (now - quietSince(row) < FINISHED_IDLE_MS || busyChildren(row.id, null).length) continue;
    const gate = await landedGate(row, d, apply, 'finished');
    if (gate) { entries.push(gate); continue; }
    const why = `${row.detail || 'idle'}; ${whereItLeftOff(row, d)}`;
    if (apply && !(await doArchive(d, row, 'finished', why))) continue;
    gone.add(row.id);
    entries.push({ what: 'archive', id: row.id, name: row.name, reason: 'finished', done: apply, why });
  }

  // Idle and landed. A plan looks at every candidate; a pass that applies looks at a few, oldest first, and does not re-check a
  // held one for half an hour, so a minute's pass does not fetch from GitHub for the whole sidebar.
  const kidsOf = (id) => listed.filter((row) => recordedCoordinator(row) === id || row.creatorSessionId === id);
  const candidates = listed
    .filter((row) => !gone.has(row.id) && !gated.has(row.id) && settled(row) && !row.openPullRequest && !row.automation)
    .filter((row) => now - quietSince(row) >= IDLE_LANDED_MS && !COORDINATOR_ROLE.test(row.name ?? ''))
    .filter((row) => !kidsOf(row.id).some((kid) => !settled(kid) && !(kid.remote && !kid.isRunning)) && !kidsOf(row.id).some((kid) => now - (Date.parse(kid.createdAt ?? '') || 0) < COORDINATOR_RECENT_MS))
    .filter((row) => !apply || (heldUntil.get(row.id) ?? 0) <= now)
    .sort((a, b) => quietSince(a) - quietSince(b));
  let looked = 0;
  for (const row of idleLanded ? candidates : []) {
    if (apply && looked >= IDLE_LANDED_PER_PASS) break;
    looked += 1;
    const gate = await landedGate(row, d, apply, 'idle-landed', { land: false });
    if (gate) { heldUntil.set(row.id, now + HELD_AGAIN_MS); entries.push(gate); continue; }
    const why = `idle ${Math.round((now - quietSince(row)) / 3_600_000)} h${recordedCoordinator(row) ? '' : ', no coordinator'}; ${whereItLeftOff(row, d)}`;
    if (apply && !(await doArchive(d, row, 'idle-landed', why))) continue;
    gone.add(row.id);
    entries.push({ what: 'archive', id: row.id, name: row.name, reason: 'idle-landed', done: apply, why });
  }
  return entries;
}

// What the app holds: its unarchived sessions by state and age, and the memory the idle local ones keep loaded.
export function census(listed, now) {
  const by = { running: 0, idleUnder2h: 0, idle2to24h: 0, idleOver24h: 0 };
  const ids = new Set(listed.map((row) => row.id));
  let coordinated = 0, remote = 0;
  for (const row of listed) {
    if (recordedCoordinator(row) && ids.has(recordedCoordinator(row))) coordinated += 1;
    if (row.isRunning || row.state !== 'idle') { by.running += 1; continue; }
    if (row.remote) { remote += 1; continue; }
    const age = now - quietSince(row);
    if (age < IDLE_LANDED_MS) by.idleUnder2h += 1;
    else if (age < 24 * 3_600_000) by.idle2to24h += 1;
    else by.idleOver24h += 1;
  }
  const idle = by.idleUnder2h + by.idle2to24h + by.idleOver24h;
  return { total: listed.length, ...by, coordinated, orphans: listed.length - coordinated, remote, idleMemoryMb: idle * SESSION_MB };
}

// One pass of both duties over the sidebar: retire, then the size watch, as Ouroboros orders them. A failure in one does not stop
// the other; a failure to list the sidebar stops both.
export async function watchRetire(d, { apply = false, idleLanded = false } = {}) {
  const out = { retire: [], size: [], unload: null, census: null, errors: [] };
  if (idleLanded === 'plan') { idleLanded = true; out.idleLandedOff = true; }
  let listed;
  try {
    const mine = identityId(d);
    listed = (await rows(d)).filter((row) => row.id !== mine);
  } catch (e) {
    out.errors.push(`could not list the app's sessions: ${e.message}`);
    return out;
  }
  out.census = census(listed, d.now());
  try { out.retire = await retireSessions(listed, d, { apply, idleLanded }); } catch (e) { out.errors.push(`retire: ${e.message}`); }
  try { out.size = (await noticeOversizedSessions(listed, d, { apply })).actions; } catch (e) { out.errors.push(`size watch: ${e.message}`); }
  try {
    const swapPct = await (d.swapPct ? d.swapPct() : realProbes(d).swapPct());
    out.unload = await unloadIdle({ runtimes: await (d.runtimes ? d.runtimes() : realRuntimes()), listed, d, swapPct, apply }, d.kill ?? realKill);
  } catch (e) { out.errors.push(`idle runtimes: ${e.message}`); }
  return out;
}

// One line per action, for the CLI and the watch's log. A plan says what would happen; an applied one says what did.
export function actionLine(e) {
  const verb = e.done ? 'done' : 'plan';
  const reason = e.reason ? ` (${e.reason})` : '';
  return `[${verb}] ${e.what} ${short(e.id)} "${plain(e.name ?? short(e.id), 60)}"${reason}: ${e.why}`;
}

export function renderRetire(r) {
  const lines = [...r.retire, ...r.size].map(actionLine);
  if (r.census && lines.length) {
    const c = r.census;
    lines.unshift(`${c.total} sessions: ${c.running} working, ${c.idleUnder2h} idle under 2 h, ${c.idle2to24h} idle 2-24 h, ${c.idleOver24h} idle over 24 h, ${c.remote} remote; ${c.coordinated} coordinated, ${c.orphans} not; idle ones hold about ${c.idleMemoryMb} MB`);
  }
  if (r.idleLandedOff) lines.push('note: the idle-and-landed archive is off in retire.json ("idleLanded": true turns it on); apply would not archive the idle-landed sessions above');
  for (const err of r.errors) lines.push(`error: ${err}`);
  return lines.length ? lines.join('\n') : 'nothing to archive, flag or ask';
}
