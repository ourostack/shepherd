// `shepherd watch`: after a resume, follow every session that was resumed for six hours, with no model turns: launchd runs
// one pass a minute.
//
// For each resumed session it asks four plain questions of the session's own history and the app's database:
//   did it take a turn since the app came back?         not within 5 min → send the resume once more
//   is it erroring (a session error after its last turn, or still flagged interrupted with no turn since)? → same
//   is it stuck busy (working, and no step in its history for 90 min)?                                        → same
//   is it still broken 10 min after that second message?  → it is reported, by name, through the agent, once
// What is healthy is never reported. `shepherd watch --status` shows the watch: how many are healthy, waiting, asked
// again, or broken.
//
// The roster is the newest resume record (resume-last.json, written by resume()) that this watch has not followed yet;
// it starts a new six hours.

import { execFileGroup as execFile } from './group-exec.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tookTurnSince } from './history.mjs';
import { MAX_HISTORY_BYTES, deps, snapshot, stateDir } from './sessions.mjs';
import { sendTo } from './socket.mjs';
import { hhmm, resumeText, short } from './resume.mjs';

export const HW = {
  window: 6 * 3600000, // how long a restart's sessions are followed
  turn: 5 * 60000, // a resumed session must take a turn within this
  stuck: 90 * 60000, // busy with no step in its history for this long
  again: 10 * 60000, // how long a session gets after the second resume message before it is called broken
  deliver: 60000, // how long one send may take
};

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o, null, 2)); };
const parse = (l) => { try { return JSON.parse(l); } catch { return null; } };
const skipOf = (opts, deps) => [...new Set([...(opts.skip || []), ...(deps.skipList?.() || [])])];

// A session error after the last turn that started since `since`: it failed and has not tried again.
export function erroredSince(lines, since) {
  let err = null, turn = null;
  for (const l of lines) {
    if (!l || (!l.includes('error') && !l.includes('assistant.turn_start'))) continue;
    const e = parse(l);
    const at = Date.parse(e?.timestamp || '');
    if (!e || !(at > since)) continue;
    if (e.type === 'assistant.turn_start') turn = at;
    else if (/^session\.error$|\.error$/.test(e.type) && !/tool\./.test(e.type)) err = { at, message: String(e.data?.message || e.data?.error || e.type).slice(0, 160) };
  }
  return err && !(turn && turn > err.at) ? err : null;
}

// What is wrong with one session now, or null. `x`: { since, now, lines, mtime, row, working, asked }.
export function diagnose({ since, now, lines, mtime, row, working, t = HW }) {
  if (!row) return { kind: 'gone' };
  const turned = tookTurnSince(lines, since);
  const err = erroredSince(lines, since);
  if (err) return { kind: 'erroring', why: `an error after its last turn: ${err.message}` };
  if (!turned) {
    if (now - since < t.turn) return { kind: 'waiting', why: 'has not yet had time to take a turn' };
    return { kind: 'silent', why: row.interrupted ? `no turn since the app came back, and the app still flags it interrupted` : 'no turn since the app came back' };
  }
  if (working && mtime && now - mtime > t.stuck) return { kind: 'stuck', why: `busy, with no step in its history for ${Math.round((now - mtime) / 60000)} min` };
  return null;
}

// The roster a new generation of sessions starts with, from the newest resume record. null when there is nothing new.
export function importRoster(dir, current) {
  const a = readJson(path.join(dir, 'resume-last.json'));
  if (!a?.resumed?.length) return null;
  const since = typeof a.since === 'number' ? a.since : Date.parse(a.since);
  const at = Date.parse(a.at);
  if (!Number.isFinite(since) || !Number.isFinite(at)) return null;
  if (current && (`resume:${a.at}` === current.source || at <= (current.at || 0))) return null;
  const results = new Map((a.results || []).map((r) => [r.id, r]));
  return {
    source: `resume:${a.at}`,
    since,
    at,
    why: a.why || 'the app starting again',
    sessions: a.resumed.map((id) => ({ id, title: results.get(id)?.title || null, outcome: results.get(id)?.outcome || 'resumed' })),
  };
}

// One pass. Returns the state it left and what it did; tells the agent only about sessions that stay broken.
export async function pass(opts, deps, say = () => {}) {
  const t = { ...HW, ...(opts.t || {}) };
  const now = deps.now();
  const out = (m) => say(`${iso(now)} health-watch: ${m}`);
  const st = deps.readState() || {};
  const fresh = importRoster(deps.state, st.roster);
  if (fresh) {
    if (!opts.dry_run) deps.writeState({ ...st, roster: { ...fresh, begun: iso(now), until: iso(fresh.since + t.window), told: [], sessions: Object.fromEntries(fresh.sessions.filter((s) => !/^gone/.test(s.outcome || '') && !skipOf(opts, deps).some((p) => s.id.startsWith(p))).map((s) => [s.id, { title: s.title, outcome: s.outcome, status: 'pending' }])) } });
    out(`following ${fresh.sessions.length} session(s) resumed after ${fresh.why} (${hhmm(fresh.since)}) until ${hhmm(fresh.since + t.window)}`);
    if (opts.dry_run) return { action: 'import', roster: fresh };
    return pass(opts, deps, say);
  }
  const r = st.roster;
  if (!r) return { action: 'none' };
  if (now >= Date.parse(r.until)) {
    if (!r.finished && !opts.dry_run) { deps.writeState({ ...st, roster: { ...r, finished: iso(now) } }); out('the six hours are over'); }
    return { action: 'finished', roster: r };
  }
  const skip = skipOf(opts, deps);
  const rows = new Map((await deps.rows(Object.keys(r.sessions))).map((x) => [x.id, x]));
  const snap = new Map((await snapshot(deps, now, skip)).map((x) => [x.id, x]));
  const acts = [];
  for (const [id, s] of Object.entries(r.sessions)) {
    if (skip.some((p) => id.startsWith(p)) || s.status === 'gone') continue;
    // Archived (the app no longer lists it) or already handed off: nothing left to watch, and nothing to tell.
    if (!rows.has(id)) { s.status = 'gone'; out(`${short(id)} ${s.title || ''}: archived; dropped from the roster`); continue; }
    const big = (deps.historySize?.(id) || 0) > MAX_HISTORY_BYTES;
    if (big && (await deps.handedOff?.(id))) { s.status = 'gone'; out(`${short(id)} ${s.title || ''}: handed off to a successor; dropped from the roster`); continue; }
    if (big) { if (s.status !== 'oversize') out(`${short(id)} ${s.title || ''}: its history is over the ${MAX_HISTORY_BYTES / 1048576} MB resume cap; not resending`); s.status = 'oversize'; continue; }
    const h = deps.history(id);
    const sn = snap.get(id);
    const dx = diagnose({ since: r.since, now, lines: h.lines, mtime: h.mtime, row: rows.get(id), working: sn?.state === 'busy', t });
    s.checked = iso(now);
    if (!s.title && sn?.title) s.title = sn.title;
    if (!dx) { if (s.status !== 'ok') out(`${short(id)} ${s.title || ''}: healthy${s.resent ? ' after the second resume' : ''}`); s.status = 'ok'; delete s.problem; continue; }
    if (dx.kind === 'gone') { s.status = 'gone'; continue; }
    if (dx.kind === 'waiting') continue;
    s.problem = `${dx.kind}: ${dx.why}`;
    if (!s.resent) {
      if (opts.dry_run) { acts.push({ id, would: 'resend', problem: s.problem }); continue; }
      const sent = await sendTo(deps, id, resumeText({ at: r.since, why: `${r.why} (this is a second message: you had not taken a turn, or were failing, or had stopped)` }), t.deliver);
      s.resent = iso(now); s.status = 'asked-again';
      out(`${short(id)} ${s.title || ''}: ${s.problem}; sent the resume once more (${sent.ok ? sent.reply : `refused: ${sent.error || sent.reply}`})`);
      acts.push({ id, resent: sent.ok });
    } else if (now - Date.parse(s.resent) >= t.again) {
      if (s.status !== 'broken') out(`${short(id)} ${s.title || ''}: still broken after the second resume: ${s.problem}`);
      s.status = 'broken';
    } else s.status = 'asked-again';
  }
  // Held back for size is by design, not broken: said once, as a hand-off to do.
  const held = Object.entries(r.sessions).filter(([, s]) => s.status === 'oversize' && !s.heldTold);
  if (held.length && !opts.dry_run) {
    await deps.tell(`${held.length} session${held.length === 1 ? ' is' : 's are'} held back from resuming because the history is too large (not broken): ${held.map(([id, s]) => `${s.title ? `"${s.title}" ` : ''}(${short(id)})`).join('; ')}. ${held.length === 1 ? 'It needs' : 'They need'} a hand-off to a fresh successor session.`);
    for (const [, s] of held) s.heldTold = iso(now);
    out(`told once about ${held.length} session(s) held back for size`);
  }
  const broken = Object.entries(r.sessions).filter(([, s]) => s.status === 'broken');
  const key = broken.map(([id]) => id).sort().join(',');
  if (broken.length && !(r.told || []).includes(key) && !opts.dry_run) {
    const lines = broken.map(([id, s]) => `${s.title ? `"${s.title}" ` : ''}(${short(id)}): ${s.problem}`).join('; ');
    const total = Object.keys(r.sessions).length;
    await deps.tell(`After the restart at ${hhmm(r.since)} (${r.why}), ${broken.length} of ${total} resumed session${total === 1 ? '' : 's'} stayed broken even after I sent the resume a second time: ${lines}. They need a person or a fresh message from you; the other ${total - broken.length} are fine.`);
    r.told = [...(r.told || []), key];
    out(`told once about ${broken.length} broken session(s)`);
  }
  if (!opts.dry_run) deps.writeState({ ...st, roster: r, last_pass: iso(now) });
  return { action: 'checked', roster: r, acts, counts: counts(r) };
}

export function counts(r) {
  const c = { ok: 0, pending: 0, 'asked-again': 0, broken: 0, gone: 0 };
  for (const s of Object.values(r?.sessions || {})) c[s.status] = (c[s.status] || 0) + 1;
  return c;
}

// The health watch's deps: the app's (Shepherd's deps), its state file, the agent's notices and the app's own flags.
// base is injectable so tests can fake the database.
export function healthDeps({ home = os.homedir(), copilotHome, base = deps({ copilotHome }) } = {}) {
  const state = base.state;
  const file = path.join(state, 'health-watch.json');
  return {
    ...base,
    readState: () => readJson(file, {}),
    writeState: (o) => writeJson(file, o),
    tell: tellAgent({ state, home }),
    // A session whose history is too large and that a newer session's kickoff names as its successor.
    handedOff: async (id) => {
      const root = path.dirname(path.dirname(base.historyPath(id)));
      let names = [];
      try { names = fs.readdirSync(root); } catch { return false; }
      for (const n of names) {
        if (n === id) continue;
        try {
          const f = path.join(root, n, 'events.jsonl');
          if (Date.now() - fs.statSync(f).mtimeMs > 86400000) continue;
          const fd = fs.openSync(f, 'r'); const buf = Buffer.alloc(16384); const len = fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
          const head = buf.toString('utf8', 0, len);
          if ((head.includes(id) || head.includes(id.slice(0, 8))) && /successor|hand-?off|handed off|carry on from/i.test(head)) return true;
        } catch { /* unreadable */ }
      }
      return false;
    },
    // The app's own flags for these sessions.
    rows: async (ids) => {
      if (!ids.length) return [];
      const list = ids.map((i) => `'${String(i).replace(/[^0-9a-f-]/gi, '')}'`).join(',');
      return (await base.sql(`SELECT id, is_running AS running, was_interrupted AS interrupted FROM sessions WHERE archived_at IS NULL AND id IN (${list})`));
    },
  };
}

// ---------- telling the agent ----------

export const WHY = 'Shepherd\'s health watch reports a resumed session that stayed broken';

// The agent's CLI: on PATH, or where its installer puts it (launchd's PATH is short).
export function findOuro(home = os.homedir(), env = process.env) {
  const onPath = (env.PATH || '').split(path.delimiter).filter(Boolean).map((d) => path.join(d, 'ouro')).find((p) => fs.existsSync(p));
  return onPath || [path.join(home, '.ouro-cli', 'bin', 'ouro')].find((p) => fs.existsSync(p)) || null;
}

const run = (file, argv, env) => new Promise((res) => {
  execFile(file, argv, { timeout: 60000, maxBuffer: 16 << 20, env }, (err, stdout, stderr) => res({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') }));
});

// One message to the agent, which tells the person. Every attempt is appended to told.log in the state folder. Never throws.
export function tellAgent({ state, home = os.homedir(), agent = process.env.SHEPHERD_AGENT || 'ouroboros', env = process.env } = {}) {
  return async (text) => {
    let r = { code: 1, stderr: 'the ouro CLI was not found' };
    try {
      const ouro = findOuro(home, env);
      if (ouro) r = await run(ouro, ['msg', '--to', agent, '--why', WHY, text], env);
    } catch (e) { r = { code: 1, stderr: e.message }; }
    const error = r.code === 0 ? null : String(r.stderr).trim().slice(0, 200);
    try {
      fs.mkdirSync(state, { recursive: true });
      fs.appendFileSync(path.join(state, 'told.log'), `${JSON.stringify({ at: new Date().toISOString(), ok: r.code === 0, text, ...(error ? { error } : {}) })}\n`);
    } catch { /* the log is a courtesy */ }
    return { ok: r.code === 0, error };
  };
}

// ---------- what --status shows ----------

export function readWatch(state = stateDir()) {
  const w = readJson(path.join(state, 'health-watch.json'), {});
  return { watch: w.roster || null, last_pass: w.last_pass || null };
}

export function renderWatch(r, now = Date.now()) {
  const w = r.watch;
  if (!w) return 'health watch: nothing to follow yet';
  const c = counts(w);
  const over = now >= Date.parse(w.until);
  const L = [`health watch: ${Object.keys(w.sessions).length} session(s) resumed after ${w.why} at ${hhmm(w.since)}: ${c.ok} healthy, ${c.pending} waiting, ${c['asked-again']} asked again, ${c.broken} BROKEN${c.gone ? `, ${c.gone} gone` : ''}; ${over ? 'the six hours ended ' : 'following until '}${hhmm(Date.parse(w.until))}`];
  for (const [id, s] of Object.entries(w.sessions)) if (s.status !== 'ok' && s.status !== 'gone') L.push(`  ${s.status} ${short(id)} ${s.title || ''}${s.problem ? `: ${s.problem}` : ''}`);
  return L.join('\n');
}
