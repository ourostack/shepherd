// Compresses an archived session's history (events.jsonl to events.jsonl.gz) and puts it back. Everything outside this
// file (the app's database, the open-file check, gzip, the ledger) comes through deps, so tests use fakes.
import fs from 'node:fs';

export const COMPRESS_WAIT_MS = 10000;
const POLL_MS = 500;
const ID = /^[A-Za-z0-9-]+$/;

// The app's row for a session, read through deps.sql: archived, live, or not listed at all (no row).
const rowOf = async (deps, id) => (await deps.sql(`SELECT id, archived_at FROM sessions WHERE id = '${id}'`))[0];

// Polls the app's database until it shows the session archived, for up to COMPRESS_WAIT_MS. Never throws.
export async function waitForArchive(deps, id, waitMs = COMPRESS_WAIT_MS) {
  for (let i = 0; i * POLL_MS < waitMs; i++) {
    try { if ((await rowOf(deps, id))?.archived_at) return true; } catch { /* the database may be busy; try again */ }
    await deps.sleep(POLL_MS);
  }
  return false;
}

// Compress an archived (or unlisted) session's history. Refuses, leaving everything untouched, unless the app does not
// list the session as live, events.jsonl exists with no .gz beside it, and no process has it open.
export async function compressHistory(deps, id, { dryRun = false } = {}) {
  const no = (why) => ({ id, ok: false, before: null, after: null, why });
  if (!ID.test(id)) return no(`"${id}" is not a session id`);
  try {
    const row = await rowOf(deps, id);
    if (row && !row.archived_at) return no('the app lists it as live, not archived');
    const file = deps.historyPath(id), gz = `${file}.gz`;
    if (fs.existsSync(gz)) return no('its history is already compressed');
    if (!fs.existsSync(file)) return no('there is no events.jsonl to compress');
    let open;
    try { open = await deps.openBy(file); } catch (e) { return no(`lsof could not say whether a process has the history open (${e.message})`); }
    if (open.length) return no(`process ${open.join(', ')} has the history open`);
    const before = fs.statSync(file).size;
    if (dryRun) return { id, ok: true, before, after: null, why: 'dry run: nothing changed' };
    await deps.gzip(file);
    const after = fs.statSync(gz).size;
    await deps.ledger({ at: new Date(deps.now()).toISOString(), kind: 'history-compressed', by: 'shepherd', session: id, before, after });
    return { id, ok: true, before, after, why: null };
  } catch (e) {
    return no(e.message);
  }
}

// Put a compressed history back: gunzip events.jsonl.gz when events.jsonl is missing. Nothing to restore is ok too.
export async function restoreHistory(deps, id) {
  if (!ID.test(id)) return { id, ok: false, restored: false, why: `"${id}" is not a session id` };
  try {
    const file = deps.historyPath(id), gz = `${file}.gz`;
    if (fs.existsSync(file)) return { id, ok: true, restored: false, why: 'its history is not compressed' };
    if (!fs.existsSync(gz)) return { id, ok: true, restored: false, why: 'there is no compressed history to restore' };
    await deps.gunzip(gz);
    return { id, ok: true, restored: true, why: null };
  } catch (e) {
    return { id, ok: false, restored: false, why: e.message };
  }
}
