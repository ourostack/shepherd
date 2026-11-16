// Who succeeds whom. A session that takes over another's job says so in its first message, on a line of its own:
// `Succeeds: <predecessor session id>`, within the message's first 16 KB. Kickoffs written before that line existed are read
// too, when "successor to" or "successor of" opens the message and a session id follows close after it. Each history is read
// forward at most FIRST_MESSAGE_SCAN_BYTES until its first message, then only for the successor's first finished turn.
import fs from 'node:fs';
import { readFrom } from './history.mjs';
import { readJson, sessionsRoot, statePath, writeJson } from './store.mjs';

const STRUCTURED = /^[ \t>*_`]*Succeeds:[ \t*_`]*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/im;
const FREE_TEXT = /\bsuccessor (?:to|of)\b/gi;
const SESSION_ID = /\b[0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\b/i;
const HISTORY_ID = /^[0-9a-f-]{36}$/i;
export const MESSAGE_HEAD_CHARS = 16384;
const FREE_TEXT_OPENING_CHARS = 2000;
const FREE_TEXT_ID_WINDOW = 240;
export const FIRST_MESSAGE_SCAN_BYTES = 1024 * 1024;

export const readSuccessions = (d) => readJson(statePath(d, 'successions'), { sessions: {} }).sessions || {};

// The session a first message says it succeeds: the Succeeds line, else the older wording. `known` resolves a short id.
export function namedPredecessor(message, self, known) {
  const head = message.slice(0, MESSAGE_HEAD_CHARS);
  const line = STRUCTURED.exec(head)?.[1]?.toLowerCase();
  if (line && line !== self) return { predecessor: line, marker: 'structured' };
  const opening = head.slice(0, FREE_TEXT_OPENING_CHARS);
  for (const phrase of opening.matchAll(FREE_TEXT)) {
    const after = head.slice(phrase.index + phrase[0].length, phrase.index + phrase[0].length + FREE_TEXT_ID_WINDOW);
    const id = SESSION_ID.exec(after)?.[0]?.toLowerCase();
    const resolved = id ? known(id) : null;
    if (resolved && resolved !== self) return { predecessor: resolved, marker: 'free-text' };
  }
  return null;
}

function historyIds(d) {
  try {
    return fs.readdirSync(sessionsRoot(d)).filter((name) => HISTORY_ID.test(name));
  } catch {
    return [];
  }
}

// Reads what is new in each listed session's history, as far as succession needs, and keeps only the listed sessions plus
// each pending succession (one whose successor has left the sidebar while the session it succeeds is still listed).
// write: false computes the same record without saving it, for a plan.
export function refreshSuccessions(d, listed, { write = true } = {}) {
  const before = readSuccessions(d);
  const live = new Set(listed);
  const ids = historyIds(d);
  const known = (value) => {
    const matches = ids.filter((id) => id.toLowerCase().startsWith(value));
    return matches.length === 1 ? matches[0] : null;
  };
  const next = {};
  for (const [id, entry] of Object.entries(before)) if (!live.has(id) && entry.predecessor && live.has(entry.predecessor)) next[id] = entry;
  for (const id of live) {
    const was = before[id];
    if (was && !was.pending && (!was.predecessor || was.turned)) { next[id] = was; continue; }
    const entry = was ? { ...was } : { predecessor: null, offset: 0, pending: true };
    let message = null;
    let turned = false;
    const read = readFrom(d.historyPath(id), entry.offset, FIRST_MESSAGE_SCAN_BYTES);
    for (const line of read.lines) {
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (!e || typeof e !== 'object' || e.agentId !== undefined) continue;
      const data = e.data && typeof e.data === 'object' ? e.data : {};
      if (entry.pending && !message && e.type === 'user.message' && typeof data.content === 'string') message = { text: data.content, ...(typeof e.timestamp === 'string' ? { at: e.timestamp } : {}) };
      else if ((message || !entry.pending) && e.type === 'assistant.turn_end') turned = true;
    }
    entry.offset = read.offset;
    if (entry.pending) {
      if (message) {
        delete entry.pending;
        const named = namedPredecessor(message.text, id, known);
        Object.assign(entry, named ?? {}, message.at ? { at: message.at } : {});
      } else if (entry.offset >= FIRST_MESSAGE_SCAN_BYTES) delete entry.pending;
    }
    if (entry.predecessor && turned) entry.turned = true;
    next[id] = entry;
  }
  if (write) writeJson(statePath(d, 'successions'), { sessions: next });
  return next;
}

// The newest session that took over `id`'s job, following hand-offs to the live end; null when none did.
export function successorOf(id, successions) {
  // The newest claim wins when two sessions name the same predecessor.
  const direct = (of) => {
    let newest = null;
    for (const [claimant, entry] of Object.entries(successions)) {
      const at = Date.parse(String(entry.at)) || 0;
      if (entry.predecessor === of && (!newest || at > newest.at)) newest = { id: claimant, at };
    }
    return newest?.id ?? null;
  };
  let current = id;
  const seen = new Set([id]);
  for (let later = direct(current); later; later = direct(current)) {
    // Sessions that claim to succeed each other own nothing for certain, so none of them is retired.
    if (seen.has(later)) return null;
    seen.add(later);
    current = later;
  }
  return current === id ? null : current;
}
