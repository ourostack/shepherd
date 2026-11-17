// Stuck resume: a session whose agent loop stopped (not running, its last turn called tools and no next turn started) gets one
// message to carry on, once per stop and at most three times a day. Left alone: a session idle over a day, one whose history is
// over 500 MB (the app loads all of it on resume), a remote one, and one that waits on a person. Nothing runs until
// ~/.config/shepherd/stuck-resume.json (or SHEPHERD_STUCK_RESUME_CONFIG) says "enabled": true. The record of what it resumed
// is <state>/stuck-resume.json, by session.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ShepherdError } from './error.mjs';
import { sendTo } from './socket.mjs';
import { readJson, writeJson } from './store.mjs';

export const RESUME_MAX_IDLE_MS = 24 * 3600000;
export const RESUME_MAX_LOG_BYTES = 500 * 1024 * 1024;
export const RESUMES_PER_DAY = 3;
export const RESUME_SEND_MS = 120000;
export const RESUME_TEXT = 'Your loop stopped: your last turn ended without finishing and no next turn started. Carry on where you left off. Re-check anything that was in flight (a shell command, a subagent, a send or a push) before relying on it.';
const DAY = 24 * 3600000;

export const stuckResumeFile = (env = process.env, home = os.homedir()) => env.SHEPHERD_STUCK_RESUME_CONFIG || path.join(home, '.config', 'shepherd', 'stuck-resume.json');
const statePath = (d) => path.join(d.state, 'stuck-resume.json');

// The stuck-resume config: { enabled } from stuck-resume.json. No file: off. A file that is not JSON is an error.
export function stuckResumeConfig(file = stuckResumeFile()) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { enabled: false };
    throw new ShepherdError({ code: 'stuck-resume-config', problem: `${file} could not be read (${e.message})`, fix: 'check the file, or delete it to turn stuck resume off' });
  }
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    throw new ShepherdError({ code: 'stuck-resume-config', problem: `${file} is not valid JSON (${e.message})`, fix: 'fix the file, or delete it to turn stuck resume off' });
  }
  return { enabled: obj?.enabled === true };
}

// The record without the resumes older than a day (a copy: planning changes nothing).
function pruned(record, now) {
  const resumed = {};
  for (const [id, entry] of Object.entries(record.resumed ?? {})) {
    const times = (entry.times ?? []).filter((at) => now - Date.parse(at) < DAY);
    if (times.length) resumed[id] = { ...entry, times };
  }
  return resumed;
}

// Why a stuck session is not resumed now, or null when it is.
function holdReason(row, resumed, now, d) {
  if (row.isRunning) return 'it is running';
  if (row.remote) return 'it is remote';
  if (row.awaiting) return 'it waits on a person';
  const last = Date.parse(row.lastActivity ?? '');
  if (Number.isNaN(last)) return 'its last activity is not known';
  if (now - last > RESUME_MAX_IDLE_MS) return 'it has been idle over a day';
  if (d.historySize(row.id) > RESUME_MAX_LOG_BYTES) return 'its history is over 500 MB';
  const before = resumed[row.id];
  if (before?.lastActivity === row.lastActivity) return 'it was already resumed for this stop';
  if ((before?.times.length ?? 0) >= RESUMES_PER_DAY) return `it was resumed ${RESUMES_PER_DAY} times today`;
  return null;
}

// Every stuck session with what a resume would do now: { id, name, resume, why }. Changes nothing.
export function stuckPlan(rows, d, now = d.now()) {
  const resumed = pruned(readJson(statePath(d), {}), now);
  return rows.filter((row) => row.state === 'stuck').map((row) => {
    const hold = holdReason(row, resumed, now, d);
    return { id: row.id, name: row.name, resume: hold === null, why: hold ?? row.detail };
  });
}

// Resumes every session whose loop stopped since it was last resumed. Returns how many resumes the app took.
export async function resumeStuck(rows, d, now = d.now(), { send = (id, text) => sendTo(d, id, text, RESUME_SEND_MS) } = {}) {
  const resumed = pruned(readJson(statePath(d), {}), now);
  let count = 0;
  for (const row of rows) {
    if (row.state !== 'stuck' || holdReason(row, resumed, now, d) !== null) continue;
    const asked = await send(row.id, RESUME_TEXT).catch((error) => ({ ok: false, error: error.message }));
    const at = new Date(now).toISOString();
    const times = [...(resumed[row.id]?.times ?? []), at];
    resumed[row.id] = { name: row.name, lastActivity: row.lastActivity, at, ok: asked.ok, times };
    if (asked.ok) count += 1;
  }
  writeJson(statePath(d), { resumed });
  return count;
}
