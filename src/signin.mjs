// The morning sign-in queue. An agent flow that needs the owner to sign in or approve something (a QR code, a passkey, a device
// code, MFA, a headful browser sign-in, GitHub sudo) never prompts live: it queues one short item here (what, why, the one command
// that resumes it) and carries on. Once each morning the open items go out as ONE message, the owner does them in one sitting, and
// each flow resumes with its own command. The queue is a record in Shepherd's state folder; a write that fails throws, because an
// item that was not recorded would be lost.
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { readJson, writeJson } from './store.mjs';
import { plain } from './notice.mjs';
import { ShepherdError } from './error.mjs';
import { wakeSender } from './wakes.mjs';

export const signinFile = (env = process.env, home = os.homedir()) => env.SHEPHERD_SIGNIN_CONFIG || path.join(home, '.config', 'shepherd', 'signin.json');
export const queueFile = (d) => path.join(d.state, 'signin-queue.json');
export const DEFAULT_HOUR = 8;

// { session, hour }: the session that gets the morning message (Ouroboros' chat, which tells the owner) and the local hour it goes out.
export function signinConfig(file = signinFile()) {
  const obj = readJson(file, {});
  const hour = Number.isInteger(obj.hour) && obj.hour >= 0 && obj.hour <= 23 ? obj.hour : DEFAULT_HOUR;
  return { session: typeof obj.session === 'string' && obj.session ? obj.session : null, hour };
}

const read = (d) => { const q = readJson(queueFile(d), {}); return { items: Array.isArray(q.items) ? q.items : [], lastSent: q.lastSent ?? null }; };
const write = (d, q) => writeJson(queueFile(d), q);

// Queues one item and returns it. The same tool asking for the same thing again returns the open item instead of a second one.
export function queue(d, { what, why, resume, tool }) {
  const clean = { what: plain(what ?? '', 160), why: plain(why ?? '', 240), resume: plain(resume ?? '', 300), tool: plain(tool ?? 'agent', 60) };
  if (!clean.what || !clean.why || !clean.resume) throw new ShepherdError({ code: 'signin-item', problem: 'an item needs what, why and the command that resumes it', fix: 'shepherd signin queue --what "<what to sign in to>" --why "<what is waiting>" --resume "<the one command>"' });
  const q = read(d);
  const open = q.items.find((i) => !i.doneAt && i.tool === clean.tool && i.what === clean.what && i.resume === clean.resume);
  if (open) return open;
  const item = { id: crypto.createHash('sha256').update(`${clean.tool}|${clean.what}|${clean.resume}|${d.now()}`).digest('hex').slice(0, 8), ...clean, at: new Date(d.now()).toISOString(), doneAt: null };
  write(d, { ...q, items: [...q.items, item] });
  return item;
}

export const list = (d) => read(d).items.filter((i) => !i.doneAt);
export const status = (d, id) => read(d).items.find((i) => i.id === id) ?? null;

// Marks one item (or every open one) done. Returns the items it marked.
export function done(d, id) {
  const q = read(d);
  const at = new Date(d.now()).toISOString();
  const marked = [];
  const items = q.items.map((i) => {
    if (i.doneAt || (id !== 'all' && i.id !== id)) return i;
    const next = { ...i, doneAt: at };
    marked.push(next);
    return next;
  });
  if (marked.length) write(d, { ...q, items: items.filter((i) => !i.doneAt || Date.parse(i.doneAt) > d.now() - 7 * 86400000) });
  return marked;
}

// The one message: every open item, what it is and the command that resumes it once the owner has done it.
export function batchMessage(items) {
  if (!items.length) return null;
  return [
    `Morning sign-ins: ${items.length} thing${items.length === 1 ? '' : 's'} waiting on the owner. Tell them as one message, they do them in one sitting, then run each resume command and \`shepherd signin done <id>\`.`,
    ...items.map((i, n) => `${n + 1}. [${i.id}] ${i.what}: ${i.why}. Resume: ${i.resume}`),
  ].join('\n');
}

const dayKey = (ms) => { const t = new Date(ms); return `${t.getFullYear()}-${t.getMonth() + 1}-${t.getDate()}`; };

// The batch is due once the local hour has come, on a day it has not already gone out, and something is open.
export const due = (d, cfg) => {
  const q = read(d);
  const now = d.now();
  return !!cfg.session && new Date(now).getHours() >= cfg.hour && q.lastSent !== dayKey(now) && q.items.some((i) => !i.doneAt);
};

// Sends the batch when it is due. `send` is injected for tests. Resolves { sent, count, error }.
export async function morning(d, cfg = signinConfig(), send = wakeSender(d)) {
  if (!due(d, cfg)) return { sent: false, count: 0, error: null };
  const items = list(d);
  const r = await send(cfg.session, batchMessage(items), 'enqueue');
  if (!r.ok) return { sent: false, count: items.length, error: r.error };
  write(d, { ...read(d), lastSent: dayKey(d.now()) });
  return { sent: true, count: items.length, error: null };
}
