// The retire duties' own records, in Shepherd's state folder: the hand-off record, the over-limit flags and the archive log.
// A write that fails is ignored and a read that fails is empty: each is a record, not a gate.
import fs from 'node:fs';
import path from 'node:path';
import { archive } from './socket.mjs';

export const FILES = { successions: 'successions.json', oversize: 'oversize.json', retireLog: 'retire-log.jsonl' };
export const DELIVER_MS = 60000;

export const statePath = (d, name) => path.join(d.state, FILES[name]);
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
  return r.ok;
}
