// Resume the app's sessions after a restart or crash: one resume message each, through the socket, then a check that each
// took a turn. The caller takes the snapshot (after its grace wait and its skip list) and passes pickTargets' result in.
import fs from 'node:fs';
import path from 'node:path';
import { continuedSince, deadWork, tookTurnSince } from './history.mjs';
import { sendTo } from './socket.mjs';
import { stateDir } from './sessions.mjs';

// grace: the wait the caller takes after the app is back, before its snapshot. The rest are used by resume().
export const RESUME_T = { grace: 25000, delivery: 120000, retry: 90000, tries: 3, concurrency: 4, backoff: [2000, 6000, 15000] };

export const hhmm = (ms) => new Date(ms).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
export const short = (id) => String(id).slice(0, 8);

const lanesNote = (l) => (l ? ` You had said ${l.lanes ?? 'some'} lane${l.lanes === 1 ? ' was' : 's were'} still running${l.minutes != null ? ` (about ${l.minutes} min from done)` : ''}: the restart went ahead without waiting longer, so those lanes were stopped; restart them from their pushed state.` : '');
const MAX_NAMED = 8;
const named = (list) => list.slice(0, MAX_NAMED).map((w) => (w.what && w.what !== w.name ? `${w.name} (${w.what})` : w.name)).join('; ') + (list.length > MAX_NAMED ? `; and ${list.length - MAX_NAMED} more` : '');
// What was running when the app stopped, by name, so the session restarts exactly those. dead: deadWork()'s answer.
export const deadNote = (dead) => {
  const parts = [];
  if (dead?.subagents?.length) parts.push(`background subagents: ${named(dead.subagents)}`);
  if (dead?.shells?.length) parts.push(`shell jobs: ${named(dead.shells)}`);
  return parts.length ? ` These were running when it stopped, and are dead: ${parts.join('. ')}. Restart each one that is not finished from its pushed state.` : '';
};
export const resumeText = ({ at, why, lanes = null, dead = null }) => `The app was restarted at ${hhmm(at)}${why ? ` for ${why}` : ''}; resume where you left off. Anything that was in flight when it stopped (a shell command, a subagent, a send or a push) was interrupted: re-check its real state before relying on it, and redo it if it did not finish. Your background subagents and shell jobs were stopped; restart any unfinished ones from their pushed state.${deadNote(dead)}${lanesNote(lanes)}`;

// Who gets a resume message. before/after: [{ id, state: 'busy'|'idle', interrupted }]. A flag the app set before the
// restart (an old crash nobody resumed) is not this restart's doing and is left alone. Each target also says whether it is
// still a live session (known), and whether its history is over the resume cap (oversize: its bytes, sizeWhy: why).
export function pickTargets({ before, after, also = [] }) {
  const was = new Map(before.map((s) => [s.id, s]));
  const now = new Map(after.map((s) => [s.id, s]));
  const out = [];
  const add = (id, why) => { if (!out.some((t) => t.id === id)) out.push({ id, why }); };
  for (const s of before) if (s.state === 'busy' && !s.stale) add(s.id, `was working (${s.why})`);
  for (const s of after) if (s.interrupted && !s.stale && !was.get(s.id)?.interrupted) add(s.id, 'the app marked it interrupted by the restart');
  for (const id of also) add(id, 'named with --also');
  return out.map((t) => {
    const s = now.get(t.id);
    return { ...t, known: now.has(t.id), title: (s || was.get(t.id))?.title || null, oversize: s?.oversize ?? null, sizeWhy: s?.oversize ? s.why : null };
  });
}

// fn over items, at most `limit` at a time; results in the order of items.
async function pooled(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]);
  }));
  return out;
}

// Sends the resume message to each target (not the held ones), then waits for a turn. Returns one result per target:
// { id, title, why, outcome, tries?, last? } where outcome is 'resumed', 'already continued', 'gone: ...' or 'NOT RESUMED ...'.
// A target over the cap is logged and handed to deps.heldBack, never sent. When anything resumed, the record goes to
// <state>/resume-last.json, which the health watch follows.
export async function resume(deps, { targets, startedAt, restartedAt, why = null, lanes = new Map(), t = {}, log = () => {} }) {
  const tt = { ...RESUME_T, ...t };
  const held = targets.filter((tg) => tg.oversize);
  for (const tg of held) log(`${short(tg.id)}${tg.title ? ` "${tg.title}"` : ''}: NOT resumed: ${tg.sizeWhy}; it needs a hand-off to a fresh session`);
  if (held.length) deps.heldBack?.(held.map((tg) => ({ id: tg.id, title: tg.title, bytes: tg.oversize })));
  const results = await pooled(targets.filter((tg) => !tg.oversize), Math.max(1, tt.concurrency || 1), async (tg) => {
    const text = resumeText({ at: restartedAt, why, lanes: lanes.get(tg.id) || null, dead: deadWork(deps.history(tg.id).lines) });
    const rec = { id: tg.id, title: tg.title, why: tg.why };
    if (!tg.known) return { ...rec, outcome: 'gone: the app has no such live session (archived or deleted)' };
    if (continuedSince(deps.history(tg.id).lines, startedAt)) {
      // Another resumer got there first: only its turn counts. If none starts, we send our own.
      for (const end = deps.now() + tt.retry; deps.now() < end;) {
        if (tookTurnSince(deps.history(tg.id).lines, startedAt)) return { ...rec, outcome: 'already continued' };
        await deps.sleep(3000);
      }
      log(`${short(tg.id)}: continued by someone else but no turn followed; sending our own`);
    }
    for (let tries = 1; tries <= tt.tries; tries++) {
      const at = deps.now();
      const s = await sendTo(deps, tg.id, text, tt.delivery);
      log(`${short(tg.id)}: send ${tries}: ${s.ok ? s.reply : `refused (${s.error || s.reply})`}`);
      if (!s.ok) {
        rec.last = s.error || s.reply;
        if (/archived|not found|unknown session/i.test(rec.last)) return { ...rec, outcome: `gone: ${rec.last}` };
        if (tries < tt.tries) await deps.sleep((tt.backoff || [])[Math.min(tries - 1, (tt.backoff || []).length - 1)] ?? 0);
        continue;
      }
      for (const end = deps.now() + tt.retry; deps.now() < end;) {
        if (tookTurnSince(deps.history(tg.id).lines, at)) return { ...rec, outcome: 'resumed', tries };
        await deps.sleep(3000);
      }
      rec.last = 'delivered but no new turn';
    }
    return { ...rec, outcome: `NOT RESUMED after ${tt.tries} tries (${rec.last || 'no reply'})` };
  });
  const failed = results.filter((r) => !/^(resumed|already continued|gone)/.test(r.outcome));
  if (failed.length) log(`NOT RESUMED: ${failed.length} of ${results.length} session(s): ${failed.map((r) => `${short(r.id)}${r.title ? ` "${r.title}"` : ''}: ${r.outcome}`).join('; ')}`);
  const resumed = results.filter((r) => r.outcome === 'resumed' || r.outcome === 'already continued').map((r) => r.id);
  if (resumed.length) recordResume(deps.state ?? stateDir(), { at: new Date(deps.now()).toISOString(), why, since: new Date(restartedAt).toISOString(), resumed, results });
  return results;
}

// A courtesy: the health watch reads it, and a failure to write it never fails a resume.
function recordResume(state, record) {
  try {
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'resume-last.json'), JSON.stringify(record, null, 2));
  } catch { /* the record is a courtesy */ }
}
