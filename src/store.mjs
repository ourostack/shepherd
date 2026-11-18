// The retire duties' own records, in Shepherd's state folder: the hand-off record, the over-limit flags and the archive log; and
// the sessions this agent created (probes, which it may archive) and the questions and plans the app announced (pending).
// A write that fails is ignored and a read that fails is empty: each is a record, not a gate.
import fs from 'node:fs';
import path from 'node:path';
import { ALREADY_ARCHIVED, archive, deleteWorkspace } from './socket.mjs';

export const FILES = { successions: 'successions.json', oversize: 'oversize.json', retireLog: 'retire-log.jsonl', probes: 'probes.json', pending: 'pending.json', identity: 'identity.json', lineage: 'lineage.json' };
export const DELIVER_MS = 60000;

export const statePath = (d, name) => path.join(d.state, FILES[name]);
// Ouroboros' own chat, the sender of its peer messages: the one session no duty may archive.
export const identityId = (d) => { if (!d?.state) return null; const id = readJson(path.join(d.state, FILES.identity), {}).session_id; return typeof id === 'string' ? id : null; };
export const sessionsRoot = (d) => path.join(d.copilotHome, 'session-state');

export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
  } catch { /* the record is best effort */ }
}

function appendLog(file, row) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
  } catch { /* the log is best effort */ }
}

// Archive through the app, keeping the worktree and compressing the history. Logged when the app confirms. Resolves to ok.
export async function archiveRow(d, row, reason, note) {
  const r = await archive(d, row, { keepWorktree: true });
  if (r.ok) appendLog(statePath(d, 'retireLog'), { at: new Date(d.now()).toISOString(), id: row.id, name: row.name, reason, note });
  // The app refuses to archive a cloud session whose GitHub task is already archived and keeps it listed: drop the entry instead.
  if (!r.ok && row.remote && ALREADY_ARCHIVED.test(r.error ?? '')) {
    const del = await deleteWorkspace(d, row);
    if (del.ok) appendLog(statePath(d, 'retireLog'), { at: new Date(d.now()).toISOString(), id: row.id, name: row.name, reason, note: `${note}; its GitHub task was already archived, so its sidebar entry was deleted` });
    return del.ok;
  }
  return r.ok;
}

// The sessions this agent created with `shepherd create`, by id: the only ones it may archive without the owner's word.
export const readProbes = (d) => readJson(statePath(d, 'probes'), {});
export function addProbe(d, id, name, now) {
  writeJson(statePath(d, 'probes'), { ...readProbes(d), [id]: { name, at: new Date(now).toISOString() } });
}
export function removeProbe(d, id) {
  const probes = readProbes(d);
  delete probes[id];
  writeJson(statePath(d, 'probes'), probes);
}

// The open questions and plan approvals by session id, as the prompt tracker last heard them.
export const readPending = (d) => readJson(statePath(d, 'pending'), {});
export const writePending = (d, pending) => writeJson(statePath(d, 'pending'), pending);

// An archive this agent made of a session it did not create, logged with its reason, in the same log the retire duties use.
export function logArchive(d, entry) {
  appendLog(statePath(d, 'retireLog'), { at: entry.at ?? new Date(d.now()).toISOString(), ...entry });
}
