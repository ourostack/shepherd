// Fakes for the retire duties' tests: a sidebar and socket that answer list, send and archive, and session histories written
// to a temp folder. Nothing here touches a real app, a real Mac or a real account.
import fs from 'node:fs';
import path from 'node:path';
import { deps, historyFile } from '../src/index.mjs';
import { fakeHistoryDeps } from './fake-history.mjs';

export const NOW = Date.parse('2026-11-16T16:00:00Z');
export const iso = (ms) => new Date(ms).toISOString();

// An app that answers the sidebar list, send_message and the two archives. Every request is kept in sent and archived.
export function fakeApp({ workspaces = [], chats = [] } = {}) {
  const sent = [];
  const archived = [];
  const exchange = async (messages) => {
    const out = [];
    for (const m of messages) {
      if (m.type === 'list_workspaces') out.push({ type: 'workspace_list', workspaces });
      else if (m.type === 'list_general_chat_sessions') out.push({ type: 'general_chat_sessions_list', sessions: chats });
      else if (m.type === 'send_message') { sent.push({ id: m.session_id, text: m.prompt }); out.push({ type: 'session_message_sent', request_id: m.request_id }); }
      else if (m.type === 'archive_workspace') { archived.push(m.workspace_id); out.push({ type: 'workspace_archived', request_id: m.request_id }); }
      else if (m.type === 'archive_session') { archived.push(m.session_id); out.push({ type: 'general_chat_sessions_changed' }); }
    }
    return out;
  };
  return { exchange, sent, archived };
}

// Shepherd's deps over a temp home and state folder: the app is `app`, the clock is `now`, and the history gzip and the
// ledger are the test fakes (zlib, an in-memory array).
export function testDeps(home, { now = NOW, app = fakeApp(), state = path.join(home, 'state') } = {}) {
  const base = deps({ copilotHome: home, state });
  return { ...base, ...fakeHistoryDeps(home, { ledger: [] }), now: () => now, checkLanded: async () => ({ outcome: 'clean' }), exchange: app.exchange, state, tell: async () => ({ ok: true, error: null }) };
}

// A history file with these events, each { type, data, at } (at defaults to now): the lines are JSON, one event each.
export function writeHistory(home, id, events, now = NOW) {
  const file = historyFile(home, id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = events.map((e) => JSON.stringify({ type: e.type, data: e.data ?? {}, timestamp: iso(e.at ?? now) }));
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

// A session's history the way the app writes one: start-up events, then its first message (when given), then its turn.
export function sessionHistory(home, id, first, { turned = false, at = NOW - 3600_000 } = {}) {
  const events = [{ type: 'session.start', data: { sessionId: id }, at }];
  if (first !== null) events.push({ type: 'user.message', data: { content: first }, at: at + 1000 });
  if (turned) events.push({ type: 'assistant.message', data: { content: 'On it.' }, at: at + 2000 }, { type: 'assistant.turn_end', data: {}, at: at + 3000 });
  return writeHistory(home, id, events, at);
}

// A sparse events.jsonl of `bytes` ending in `tail` (no real bytes are written), for the size watch.
export function sparseHistory(home, id, bytes, tail = '') {
  const file = historyFile(home, id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  fs.truncateSync(file, bytes - Buffer.byteLength(tail));
  if (tail) fs.appendFileSync(file, tail);
  return file;
}

// A sidebar row for the retire and size-watch tests (what rows() returns), with its defaults.
export const row = (id, over = {}) => ({
  id, name: `session ${id.slice(0, 4)}`, kind: 'workspace', workspaceId: `w-${id.slice(0, 4)}`, workspaceType: 'worktree', projectRepo: 'example/project', branch: 'work',
  parentSessionId: null, coordinatingCreatorSessionId: null, state: 'idle', detail: 'its turn ended', isRunning: false, remote: false,
  updatedAt: iso(NOW - 3600_000), lastActivity: iso(NOW - 3600_000), ...over,
});
export const working = { state: 'working', isRunning: true, lastActivity: iso(NOW) };
