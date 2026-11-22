// The morning sign-in queue. An agent flow that needs the owner to sign in or approve something (a QR code, a passkey, a device
// code, MFA, a headful browser sign-in, GitHub sudo) never prompts live: it queues one short item here (what, why, the one command
// that resumes it) and carries on. Once each morning the open items go out as ONE message, the owner does them in one sitting, and
// each flow resumes with its own command. The queue is a record in Shepherd's state folder; a write that fails throws, because an
// item that was not recorded would be lost.
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { identityId, readJson, writeJson } from './store.mjs';
import { plain } from './notice.mjs';
import { ShepherdError } from './error.mjs';
import { wakeSender } from './wakes.mjs';
import { findOuro } from './health-watch.mjs';

export const signinFile = (env = process.env, home = os.homedir()) => env.SHEPHERD_SIGNIN_CONFIG || path.join(home, '.config', 'shepherd', 'signin.json');
export const queueFile = (d) => path.join(d.state, 'signin-queue.json');
export const DEFAULT_HOUR = 8;

// { session, hour, personal, work }: the session that gets the morning message and the local hour it goes out. With no session named,
// Ouroboros' own chat (the stored identity) gets it: it is the one that tells the owner on Teams. `personal` splits the batch: when it
// names an A2A card, the owner's personal items go to that agent instead, as one item, and only work items stay with the session.
// `work` adds patterns (case-insensitive) that mark an item as work, beside the built-in ones (Microsoft, Teams and the like).
export function signinConfig(file = signinFile()) {
  const obj = readJson(file, {});
  const hour = Number.isInteger(obj.hour) && obj.hour >= 0 && obj.hour <= 23 ? obj.hour : DEFAULT_HOUR;
  return { session: typeof obj.session === 'string' && obj.session ? obj.session : null, hour, personal: personalConfig(obj.personal), work: Array.isArray(obj.work) ? obj.work.filter((w) => typeof w === 'string' && w) : [] };
}

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
// { card, name, owner, ouro, identityFile }, or null when no card is named (then the whole batch goes to the session, as before).
function personalConfig(p) {
  if (!p || typeof p !== 'object' || !str(p.card)) return null;
  return { card: str(p.card), name: str(p.name) ?? 'the personal agent', owner: str(p.owner) ?? 'the owner', ouro: str(p.ouro), identityFile: str(p.identityFile) };
}

const read = (d) => { const q = readJson(queueFile(d), {}); return { items: Array.isArray(q.items) ? q.items : [], lastSent: q.lastSent ?? null, lastSentPersonal: q.lastSentPersonal ?? null, personalRetryAt: q.personalRetryAt ?? null }; };
const write = (d, q) => writeJson(queueFile(d), q);

// Queues one item and returns it. A repeat of an open item (the same key, else the same tool asking for the same thing) is merged into
// it: the open item comes back with merged: true and nothing new is recorded. The resume command is stored exactly as given; only the
// owner-facing what and why are flattened. `forWhom` names someone other than the owner; that item is recorded but never goes in the owner's batch.
export function queue(d, { what, why, resume, tool, key, forWhom, scope }) {
  const clean = { what: plain(what ?? '', 160), why: plain(why ?? '', 240), resume: typeof resume === 'string' ? resume.trim().slice(0, 2000) : '', tool: plain(tool ?? 'agent', 60) };
  if (!clean.what || !clean.why || !clean.resume) throw new ShepherdError({ code: 'signin-item', problem: 'an item needs what, why and the command that resumes it', fix: 'shepherd signin queue --what "<what to sign in to>" --why "<what is waiting>" --resume "<the one command>"' });
  if (scope != null && !SCOPES.includes(scope)) throw new ShepherdError({ code: 'signin-item', problem: `scope is work or personal, not ${scope}`, fix: 'shepherd signin queue ... --scope work' });
  const extra = { ...(key ? { key: plain(key, 80) } : {}), ...(forWhom && !isOwner(forWhom) ? { for: plain(forWhom, 60) } : {}), ...(scope ? { scope } : {}) };
  const q = read(d);
  const open = q.items.find((i) => !i.doneAt && (extra.key ? i.key === extra.key : !i.key && i.tool === clean.tool && i.what === clean.what));
  if (open) return { ...open, merged: true };
  const item = { id: crypto.createHash('sha256').update(`${clean.tool}|${clean.what}|${clean.resume}|${d.now()}`).digest('hex').slice(0, 8), ...clean, ...extra, at: new Date(d.now()).toISOString(), doneAt: null };
  write(d, { ...q, items: [...q.items, item] });
  return item;
}

const SCOPES = ['work', 'personal'];

// Work is anything for the owner's employer: Microsoft accounts and services, Teams, and whatever signin.json's `work` adds (work
// repositories, a work GitHub account). Everything else is personal. An item queued with an explicit scope keeps it. The built-in words
// are matched in what, why and tool only (a resume command's paths say little); the configured patterns are matched in the resume too.
const WORK = /\b(microsoft|(?<!github )teams|azure|entra|outlook|office ?365|m365|sharepoint|onedrive for business|dev\.azure\.com|visualstudio\.com|aka\.ms|work github account)\b/i;
export function scopeOf(item, work = []) {
  if (SCOPES.includes(item.scope)) return item.scope;
  const words = [item.what, item.why, item.tool].join('\n');
  const all = `${words}\n${item.resume ?? ''}`.toLowerCase();
  return WORK.test(words) || work.some((w) => all.includes(w.toLowerCase())) ? 'work' : 'personal';
}

const isOwner = (who) => /^(owner|the owner|operator|the operator)?$/i.test(String(who).trim());
// Open items that go in the owner's morning batch; items for someone else wait for them.
export const mine = (items) => items.filter((i) => !i.for);

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
    `Morning sign-ins: ${items.length} thing${items.length === 1 ? '' : 's'} waiting on the owner. Tell the owner on Teams as one message; they do them in one sitting, then run each resume command and \`shepherd signin done <id>\`.`,
    ...items.map((i, n) => `${n + 1}. [${i.id}] ${i.what}: ${i.why}. Resume: ${/\n/.test(i.resume) ? `\n\`\`\`\n${i.resume}\n\`\`\`` : i.resume}`),
  ].join('\n');
}

const dayKey = (ms) => { const t = new Date(ms); return `${t.getFullYear()}-${t.getMonth() + 1}-${t.getDate()}`; };
const isoDay = (ms) => { const t = new Date(ms); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`; };
export const dedupeKey = (ms) => `shepherd-signin-${isoDay(ms)}`;

// The personal items as ONE item in the personal agent's intake format: from, urgency, ask, why only the owner, steps, deadline and
// a dedupe key, so a resend on the same day is the same item.
export function personalMessage(items, { owner = 'the owner', now = Date.now(), host = os.hostname() } = {}) {
  if (!items.length) return null;
  const n = `${items.length} sign-in${items.length === 1 ? '' : 's'}`;
  return [
    `from: Shepherd, the morning sign-in queue on ${host}`,
    'urgency: today',
    `ask: ${n} waiting on ${owner}; do them in one sitting.`,
    `why only ${owner}: each needs ${owner}'s own sign-in, passkey or approval, which no agent can give.`,
    'steps:',
    ...items.map((i, k) => `${k + 1}. [${i.id}] ${i.what}: ${i.why}. Then run: ${/\n/.test(i.resume) ? `\n\`\`\`\n${i.resume}\n\`\`\`` : i.resume}`),
    `${items.length + 1}. Then \`shepherd signin done <id>\` for each one done.`,
    `deadline: end of today (${isoDay(now)}); each flow stays paused until it is done.`,
    `dedupe key: ${dedupeKey(now)}`,
  ].join('\n');
}

export const fallbackNote = (name) => `${name.charAt(0).toUpperCase()}${name.slice(1)} unreachable, so this came here.`;

// Who gets what this morning: { work, personal } item lists. With no personal agent configured everything is work (the old batch).
export function split(items, cfg) {
  if (!cfg.personal) return { work: items, personal: [] };
  const work = [];
  const personal = [];
  for (const i of items) (scopeOf(i, cfg.work) === 'work' ? work : personal).push(i);
  return { work, personal };
}

const pending = (d, cfg) => {
  const q = read(d);
  const today = dayKey(d.now());
  const { work, personal } = split(q.items.filter((i) => !i.doneAt && !i.for), cfg);
  return { work: q.lastSent !== today ? work : [], personal: q.lastSentPersonal !== today ? personal : [], retryAt: q.personalRetryAt };
};

// The batch is due once the local hour has come, on a day it has not already gone out, and something is open for a route that exists.
// A personal agent that failed with no session to fall back to is tried again after RETRY_MS, not on every pass.
export const RETRY_MS = 15 * 60000;
export const due = (d, cfg) => {
  if (new Date(d.now()).getHours() < cfg.hour) return false;
  const p = pending(d, cfg);
  const session = !!(cfg.session ?? identityId(d));
  return !!((p.work.length && session) || (p.personal.length && (session || !(p.retryAt > d.now()))));
};

// Sends the personal message with `ouro a2a message`, which seals and signs it with this machine's A2A identity (the receiving agent
// must have onboarded that identity as a friend) and waits for the agent's reply, a whole turn. Resolves { ok, error, unconfirmed };
// never throws. Only a definite non-delivery (no connection, a refusal) is a failure: a timeout means the agent may well have it and is
// still answering, so it counts as sent (unconfirmed), never as a reason to send the same items to the work chat too.
export const SEND_TIMEOUT_MS = 120000;
export function ouroSender(personal, run = execFile, ouro = () => personal.ouro ?? findOuro()) {
  return (card, text) => new Promise((resolve) => {
    const bin = ouro();
    if (!bin) return resolve({ ok: false, error: 'the ouro CLI was not found' });
    const args = ['a2a', 'message', '--to', card, '--text', text, '--json', '--why', 'Shepherd morning sign-ins: the owner asked that personal sign-ins reach them only through their personal agent'];
    if (personal.identityFile) args.push('--identity-file', personal.identityFile);
    run(bin, args, { timeout: SEND_TIMEOUT_MS, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      let r = null;
      try { r = JSON.parse(String(stdout).trim().split('\n').pop()); } catch {}
      if (r?.ok === false) return resolve({ ok: false, error: plain(r.reason ?? r.message ?? 'refused', 240) });
      if (err?.killed) return resolve({ ok: true, error: null, unconfirmed: true });
      if (err) return resolve({ ok: false, error: plain(String(stderr || err.message), 240) || 'ouro a2a message failed' });
      resolve({ ok: true, error: null });
    });
  });
}

// Sends the batch when it is due. `send` (the session) and `sendPersonal` (the personal agent) are injected for tests. With a personal
// agent configured, its items go there first as one item; if it can't be reached they join the session's message with a note saying
// so. Each route records its own day, so a failed route is retried alone; a route with nothing to send that morning counts as sent, so
// an item queued later waits for tomorrow, as before. Resolves { sent, count, error, personal: 'sent' | 'fallback' | null, personalError }.
export async function morning(d, cfg = signinConfig(), send = wakeSender(d), sendPersonal = cfg.personal ? ouroSender(cfg.personal) : null) {
  if (!due(d, cfg)) return { sent: false, count: 0, error: null, personal: null, personalError: null };
  const today = dayKey(d.now());
  const p = pending(d, cfg);
  const session = cfg.session ?? identityId(d);
  const mark = (m) => write(d, { ...read(d), ...m });
  let route = null;
  let personalError = null;
  let count = 0;
  let toSession = session ? p.work : [];
  if (p.personal.length && (session || !(p.retryAt > d.now()))) {
    const r = await sendPersonal(cfg.personal.card, personalMessage(p.personal, { owner: cfg.personal.owner, now: d.now() }));
    if (r.ok) {
      route = 'sent';
      count += p.personal.length;
      mark({ lastSentPersonal: today, personalRetryAt: null });
    } else {
      personalError = r.error ?? 'no reply';
      if (session) { route = 'fallback'; toSession = [...toSession, ...p.personal]; }
      else mark({ personalRetryAt: d.now() + RETRY_MS });
    }
  }
  const quiet = { ...(p.work.length ? {} : { lastSent: today }), ...(p.personal.length ? {} : { lastSentPersonal: today }) };
  if (!toSession.length) {
    if (count) mark(quiet);
    return { sent: count > 0, count, error: personalError, personal: route, personalError };
  }
  const r = await send(session, [route === 'fallback' && fallbackNote(cfg.personal.name), batchMessage(toSession)].filter(Boolean).join('\n'), 'enqueue');
  if (!r.ok) return { sent: count > 0, count, error: r.error, personal: route, personalError };
  mark({ ...quiet, lastSent: today, ...(route === 'fallback' ? { lastSentPersonal: today, personalRetryAt: null } : {}) });
  return { sent: true, count: count + toSession.length, error: null, personal: route, personalError };
}
