// One conversation with the GitHub Copilot app's local WebSocket. The app's port and token are in <home>/run/.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ShepherdError } from './error.mjs';
import { compressHistory, restoreHistory, waitForArchive } from './compress.mjs';

export const ARCHIVE_WAIT_MS = 20000;

const read = (copilotHome, name) => fs.readFileSync(path.join(copilotHome, 'run', name), 'utf8').trim().split(/\s+/)[0];

// The app's observer socket URL, from <home>/run/ws.port and ws.token. Throws when the app is not serving.
export function socketUrl(copilotHome) {
  const port = read(copilotHome, 'ws.port');
  const token = read(copilotHome, 'ws.token');
  return `ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}&observer=1`;
}

// Send `messages`, then collect what the app says until done(message) or waitMs passes. keep filters what is collected.
export function exchange(copilotHome, messages, { done = () => false, waitMs = 10000, keep = () => true } = {}) {
  let url;
  try { url = socketUrl(copilotHome); } catch {
    return Promise.resolve([{ type: 'socket_error', message: `no ws.port or ws.token in ${path.join(copilotHome, 'run')}: the app is not serving. Fix: open the GitHub Copilot app and try again.` }]);
  }
  if (typeof WebSocket !== 'function') throw new ShepherdError({ code: 'node-too-old', problem: 'this Node has no global WebSocket', fix: 'run it on Node 22.18 or newer' });
  return new Promise((resolve) => {
    const got = [];
    let ws;
    try { ws = new WebSocket(url); } catch { resolve([{ type: 'socket_error' }]); return; }
    let over = false;
    const finish = () => { if (over) return; over = true; clearTimeout(timer); try { ws.close(); } catch { /* closed */ } resolve(got); };
    const timer = setTimeout(finish, waitMs);
    ws.addEventListener('open', () => { for (const m of messages) ws.send(JSON.stringify(m)); });
    ws.addEventListener('message', (e) => {
      let j; try { j = JSON.parse(String(e.data)); } catch { return; }
      if (!keep(j)) return;
      got.push(j);
      if (done(j, got)) finish();
    });
    ws.addEventListener('error', () => { got.push({ type: 'socket_error' }); finish(); });
  });
}

export const appReady = async (deps) => (await deps.exchange([], { done: (j) => j.type === 'server_hello', keep: (j) => j.type === 'server_hello', waitMs: 3000 })).some((j) => j.type === 'server_hello');

// Send a prompt to a session; ok when the app queued or sent it. A session whose history was compressed gets it back first.
export async function sendTo(deps, id, prompt, waitMs) {
  // Best effort: a session restored after its history was compressed gets it back before it resumes. A restore that
  // can't run (deps without historyPath, an id that isn't a session id, a failed gunzip) never stops the send.
  if (typeof deps.historyPath === 'function') await restoreHistory(deps, id);
  const request_id = randomUUID();
  const got = await deps.exchange([{ type: 'send_message', session_id: id, prompt, delivery_mode: 'immediate', request_id }], {
    keep: (j) => j.request_id === request_id || (j.session_id === id && /message_(sent|queued|delivery)/.test(j.type)) || j.type === 'socket_error',
    done: (j) => /^(session_message_sent|session_message_queued|session_message_delivery_unknown|error|socket_error)$/.test(j.type),
    // A session whose runtime is not loaded loads first, often for more than 20 s; closing early cancels the send.
    waitMs,
  });
  const last = got.at(-1);
  return {
    ok: Boolean(last && /session_message_(sent|queued)/.test(last.type)),
    reply: last?.type || 'no reply',
    error: last?.type === 'error' || last?.type === 'socket_error' ? String(last.message || (last.type === 'socket_error' ? 'socket_error: the app\'s socket refused or dropped the connection' : '')).slice(0, 200) : null,
  };
}

// Archive a session row from snapshot or the sessions query. A row with a workspace archives the workspace, and deletes
// its worktree only when the row says it is one and keepWorktree is not set; a row without one archives the session.
// Once the app confirms, the session's history is compressed (after the app's database shows it archived).
export async function archive(deps, row, { keepWorktree = false, waitMs = ARCHIVE_WAIT_MS, compress = true } = {}) {
  const request_id = randomUUID();
  const workspace = Boolean(row.workspaceId);
  const msg = workspace
    ? { type: 'archive_workspace', workspace_id: row.workspaceId, delete_worktree: row.workspaceType === 'worktree' && !keepWorktree, request_id }
    : { type: 'archive_session', session_id: row.id, request_id };
  const okType = workspace ? 'workspace_archived' : 'general_chat_sessions_changed';
  const verdict = (j) => {
    if (j.type === 'socket_error') return 'fail';
    if (j.type === okType && (!workspace || j.request_id === request_id)) return 'ok';
    return j.request_id === request_id ? 'fail' : 'ignore';
  };
  const got = await deps.exchange([msg], { keep: (j) => verdict(j) !== 'ignore', done: (j) => verdict(j) !== 'ignore', waitMs });
  const hit = got.find((j) => verdict(j) !== 'ignore');
  const ok = hit !== undefined && verdict(hit) === 'ok';
  const out = {
    ok,
    session_id: row.id,
    error: ok ? null : hit ? String(hit.message || hit.type).slice(0, 200) : `the app did not confirm the archive within ${Math.round(waitMs / 1000)} s. Fix: check the session with shepherd status, then try again.`,
    compressed: null,
  };
  if (ok && compress) {
    await waitForArchive(deps, row.id);
    out.compressed = await compressHistory(deps, row.id);
  }
  return out;
}
