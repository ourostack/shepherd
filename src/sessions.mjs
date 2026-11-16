// The app's sessions as work: each local, unarchived session, and whether its agent loop is busy.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ShepherdError } from './error.mjs';
import { exchange } from './socket.mjs';
import { lastTurnAt, loopState, readTail } from './history.mjs';

// A session whose history is bigger than this is never resumed: the app loads the whole file into memory on resume.
export const MAX_HISTORY_BYTES = 500 * 1024 * 1024;
export const STALE_MS = 24 * 3600000;
export const LOOKBACK_MS = 24 * 3600000;

const SQLITE = '/usr/bin/sqlite3';

export const ROWS = `SELECT s.id, s.title, s.mode, s.is_running AS running, s.was_interrupted AS interrupted, s.execution_location AS loc, w.id AS workspace_id
FROM sessions s LEFT JOIN workspaces w ON w.session_id = s.id
WHERE s.archived_at IS NULL AND w.archived_at IS NULL`;

export const historyFile = (copilotHome, id) => path.join(copilotHome, 'session-state', id, 'events.jsonl');

function judge(deps, r, now) {
  const bytes = deps.historySize(r.id);
  if (bytes > MAX_HISTORY_BYTES) return { id: r.id, title: r.title, mode: r.mode || null, state: 'idle', why: `its history is ${Math.round(bytes / 1048576)} MB, over the ${MAX_HISTORY_BYTES / 1048576} MB resume cap`, running: Boolean(r.running), interrupted: Boolean(r.interrupted), oversize: bytes };
  const h = deps.history(r.id);
  const last = lastTurnAt(h.lines);
  // A session whose last turn is over a day old is idle, whatever flag the app still carries for it.
  const stale = last != null ? last < now - STALE_MS : h.mtime > 0 && h.mtime < now - STALE_MS;
  if (stale) return { id: r.id, title: r.title, mode: r.mode || null, state: 'idle', why: 'its last turn was over 24 h ago', running: false, interrupted: false, stale: true };
  const v = h.mtime >= now - LOOKBACK_MS ? loopState(h.lines) : { working: false, why: 'no recent activity' };
  // The app's own running flag counts too: either one says the session had work in flight.
  const busy = v.working || Boolean(r.running);
  return { id: r.id, title: r.title, mode: r.mode || null, state: busy ? 'busy' : 'idle', why: v.working ? v.why : r.running ? 'the app marks it running' : v.why, running: Boolean(r.running), interrupted: Boolean(r.interrupted) };
}

// Every local, unarchived session (except those whose id starts with an entry of skip): its mode, whether its agent loop
// is working (busy) or not (idle), and its workspace id when it has one.
export async function snapshot(deps, now = deps.now(), skip = []) {
  const rows = (await deps.sql(ROWS)).filter((r) => (r.loc === 'local' || !r.loc) && !skip.some((p) => r.id.startsWith(p)));
  return rows.map((r) => ({ ...judge(deps, r, now), workspaceId: r.workspace_id ?? null }));
}

function sqlite(copilotHome, query) {
  const db = path.join(copilotHome, 'data.db');
  if (!fs.existsSync(db)) return Promise.reject(new ShepherdError({ code: 'no-database', problem: `there is no GitHub Copilot app database at ${db}`, fix: 'open the GitHub Copilot app once so it creates the database, or point copilotHome (shepherd status --copilot-home) at the folder that holds data.db' }));
  return new Promise((resolve, reject) => execFile(SQLITE, ['-readonly', '-json', '-cmd', '.timeout 3000', db, query], { timeout: 30000, maxBuffer: 64 << 20 }, (err, stdout, stderr) => {
    if (err?.code === 'ENOENT') return reject(new ShepherdError({ code: 'no-sqlite3', problem: `${SQLITE} is missing`, fix: 'install the Xcode command line tools with xcode-select --install' }));
    if (err) return reject(new ShepherdError({ code: 'sqlite-refused', problem: `SQLite refused the app's database at ${db}: ${String(stderr).trim().slice(0, 160) || err.message}`, fix: 'quit and reopen the GitHub Copilot app, then try again' }));
    try { resolve(String(stdout).trim() ? JSON.parse(stdout) : []); } catch (e) { reject(new ShepherdError({ code: 'sqlite-refused', problem: `SQLite's answer was not JSON (${e.message})`, fix: 'check that /usr/bin/sqlite3 is the system SQLite' })); }
  }));
}

// The app-facing deps: the database (read-only), each session's history, the socket, and the clock. Tests pass fakes instead.
export function deps({ copilotHome = path.join(os.homedir(), '.copilot') } = {}) {
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    sql: (query) => sqlite(copilotHome, query),
    history: (id) => {
      const f = historyFile(copilotHome, id);
      try { return { lines: readTail(f), mtime: fs.statSync(f).mtimeMs }; } catch { return { lines: [], mtime: 0 }; }
    },
    historySize: (id) => { try { return fs.statSync(historyFile(copilotHome, id)).size; } catch { return 0; } },
    exchange: (messages, opts) => exchange(copilotHome, messages, opts),
  };
}
