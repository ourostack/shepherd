// The inbox duty: agents act as the owner's GitHub account, so the owner's notifications inbox fills with events the agents
// caused (their pull requests merged, a bot's update opened, a CI run finished). This duty marks those done, with zero tokens,
// so only what a person wrote, or what is marked ready or done for the owner, is left to read.
//
// Cost: one conditional request (If-Modified-Since) per poll, a 304 while nothing changed, at the interval GitHub names in
// X-Poll-Interval. Only the threads a rule could mark are looked at (their pull request or issue and its latest comment).
//
// A thread is marked done only when its reason is one of AUTO_REASONS, it is a pull request or issue, and nobody who is not the
// owner's account, a bot or an updater acted last (see judge). Anything unknown is kept: a failed lookup never marks done.
//   state_change, author, subscribed, ci_activity   it was written by the owner's account or a bot, and the last actor (latest
//                                                   unread comment, else who merged or closed it, else its author) is too
//   review_requested                                the pull request's author is a bot or an updater: a CODEOWNERS request
// Kept always: a human other than the owner wrote it, its latest unread comment, or merged or closed it, or authored a
// review-request pull request; any other reason (mention, team_mention, comment, assign, review_requested by a person…); a thread carrying
// a keep label, or listed in the keep file (`<state>/inbox-keep.json`, an array of "owner/repo#n"), which is how something
// marked ready or done for the owner stays visible.
//
// Nothing runs until ~/.config/shepherd/inbox.json (or SHEPHERD_INBOX_CONFIG) says "enabled": true:
//   { "enabled": true, "account": "<login>", "bots": ["<extra login>"], "keepLabels": ["ready", "done"], "ledger": "<file>" }
// Records, in the state folder: inbox-log.jsonl (one line per thread marked done: reason and a one-line why), inbox.json (the
// poll cursor and cache) and inbox-counts.json (per day: marked done, kept, by reason), also written to `ledger` when set,
// for the attention ledger. The token is SHEPHERD_INBOX_TOKEN, GH_TOKEN, GITHUB_TOKEN, or `gh auth token --user <account>`; it
// needs the notifications scope, and is refused when it is not the account's.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ShepherdError } from './error.mjs';
import { readJson, writeJson } from './store.mjs';

export const AUTO_REASONS = ['state_change', 'author', 'subscribed', 'ci_activity', 'review_requested'];
export const SUBJECTS = ['PullRequest', 'Issue'];
export const DEFAULT_KEEP_LABELS = ['ready', 'done'];
export const MIN_POLL_SECONDS = 60;
const MAX_PAGES = 10;
const API = 'https://api.github.com';

export const inboxFile = (env = process.env, home = os.homedir()) => env.SHEPHERD_INBOX_CONFIG || path.join(home, '.config', 'shepherd', 'inbox.json');

// The inbox config from inbox.json: { enabled, account, bots, keepLabels, ledger }. No file: off. A file that is not valid is an error.
export function inboxConfig(file = inboxFile()) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { enabled: false, account: 'arimendelow', bots: [], keepLabels: DEFAULT_KEEP_LABELS, ledger: null };
    throw new ShepherdError({ code: 'inbox-config', problem: `${file} could not be read (${e.message})`, fix: 'check the file, or delete it to turn the inbox duty off' });
  }
  let c;
  try { c = JSON.parse(text); } catch (e) {
    throw new ShepherdError({ code: 'inbox-config', problem: `${file} is not valid JSON (${e.message})`, fix: 'fix the file, or delete it to turn the inbox duty off' });
  }
  const strings = (v, fallback) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s) : fallback);
  return {
    enabled: c?.enabled === true,
    account: typeof c?.account === 'string' && c.account ? c.account : 'arimendelow',
    bots: strings(c?.bots, []).map((s) => s.toLowerCase()),
    keepLabels: strings(c?.keepLabels, DEFAULT_KEEP_LABELS).map((s) => s.toLowerCase()),
    ledger: typeof c?.ledger === 'string' && c.ledger ? c.ledger : null,
  };
}

const lower = (s) => String(s ?? '').toLowerCase();

// Who a login is: the owner's account, a bot or an updater (an App's [bot] account, a user of type Bot, or one the config
// names), or a person.
export function classify(user, cfg) {
  if (!user?.login) return 'unknown';
  const login = lower(user.login);
  if (login === lower(cfg.account)) return 'owner';
  if (user.type === 'Bot' || login.endsWith('[bot]') || login.startsWith('app/') || cfg.bots.includes(login)) return 'bot';
  return 'human';
}

const keepKey = (repo, number) => `${repo}#${number}`;

// The decision for one notification, from the facts fetched for it:
//   facts { number, author, labels: [name], commentUser (the latest unread comment's author), closedBy (who merged or closed it) }
// Returns { done: boolean, rule, why }. Pure: no network.
export function judge(n, facts, cfg, keep = []) {
  const repo = n.repository?.full_name ?? '?';
  const keepIt = (rule, why) => ({ done: false, rule, why });
  if (!AUTO_REASONS.includes(n.reason)) return keepIt('reason', `reason ${n.reason} is for a person to read`);
  if (!SUBJECTS.includes(n.subject?.type)) return keepIt('subject', `${n.subject?.type ?? 'unknown subject'} is not a pull request or issue`);
  if (!facts) return keepIt('unknown', 'its details could not be read');
  if (facts.number !== undefined && keep.includes(keepKey(repo, facts.number))) return keepIt('keep-list', 'it is on the keep list');
  const label = (facts.labels ?? []).map(lower).find((l) => cfg.keepLabels.includes(l));
  if (label) return keepIt('keep-label', `it is labelled ${label}`);

  const author = classify(facts.author, cfg);
  if (n.reason === 'review_requested') {
    // A request on a person's pull request is a person's ask.
    if (author !== 'bot') return keepIt('review-by-person', `the review was asked on a pull request by ${facts.author?.login ?? 'someone'}, not a bot`);
  } else if (author === 'human') return keepIt('human-author', `${facts.author.login} wrote it`);
  else if (author === 'unknown') return keepIt('unknown', 'its author could not be read');

  // Whoever wrote the latest unread comment, and whoever merged or closed it, must not be a person.
  const comment = facts.commentUser === undefined ? null : classify(facts.commentUser, cfg);
  if (comment === 'human') return keepIt('human-comment', `${facts.commentUser.login} wrote the latest unread comment`);
  if (comment === 'unknown') return keepIt('unknown', 'the latest comment has no author');
  const closer = facts.closedBy ? classify(facts.closedBy, cfg) : null;
  if (closer === 'human') return keepIt('human-closed', `${facts.closedBy.login} merged or closed it`);
  if (closer === 'unknown') return keepIt('unknown', 'who merged or closed it could not be read');

  if (n.reason === 'review_requested') return { done: true, rule: 'review-requested-on-bot-pr', why: `review requested on ${facts.author.login}'s automated pull request (a code owner request)` };
  const last = comment ? facts.commentUser : closer ? facts.closedBy : facts.author;
  const kind = comment ?? closer ?? author;
  return { done: true, rule: `${n.reason}-by-${kind === 'owner' ? 'agent' : 'bot'}`, why: `${n.reason}: the last actor was ${last.login}, ${kind === 'owner' ? "the owner's account acting through an agent" : 'a bot or updater'}` };
}

// Facts about the thread's pull request or issue, and its latest comment after the notification was last read.
async function facts(n, api) {
  const subject = await api.json(n.subject.url);
  if (!subject) return null;
  const out = {
    number: subject.number,
    author: subject.user ?? null,
    labels: (subject.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)),
    closedBy: subject.merged_by ?? subject.closed_by ?? undefined,
  };
  if (n.subject.latest_comment_url && n.subject.latest_comment_url !== n.subject.url) {
    const c = await api.json(n.subject.latest_comment_url);
    if (!c) return null;
    const at = Date.parse(c.created_at ?? c.submitted_at ?? '');
    const read = Date.parse(n.last_read_at ?? '');
    if (!(read && at && at <= read)) out.commentUser = c.user ?? null;
  }
  return out;
}

// GitHub API over fetch, injectable. get() is conditional; json() reads one object (null on any failure); done() marks a thread done.
export function githubApi({ token, fetchFn = globalThis.fetch }) {
  const headers = (extra = {}) => ({ authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'shepherd-inbox', ...extra });
  const abs = (u) => (u.startsWith('http') ? u : `${API}${u}`);
  return {
    request: (url, init = {}) => fetchFn(abs(url), { ...init, headers: headers(init.headers) }),
    async json(url) {
      try {
        const r = await fetchFn(abs(url), { headers: headers() });
        return r.ok ? await r.json() : null;
      } catch { return null; }
    },
    async done(id) {
      const r = await fetchFn(`${API}/notifications/threads/${id}`, { method: 'DELETE', headers: headers() });
      return r.status === 204 || r.status === 205 || r.status === 404;
    },
  };
}

export function resolveToken(cfg, env = process.env, run = (account) => execFileSync('gh', ['auth', 'token', '--user', account], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] })) {
  for (const key of ['SHEPHERD_INBOX_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']) if (env[key]) return env[key];
  try {
    const t = run(cfg.account).trim();
    if (t) return t;
  } catch { /* fall through */ }
  throw new ShepherdError({ code: 'inbox-token', problem: `no GitHub token for ${cfg.account}`, fix: 'set SHEPHERD_INBOX_TOKEN, or sign gh in as that account with the notifications scope' });
}

const stateFile = (d) => path.join(d.state, 'inbox.json');
const logFile = (d) => path.join(d.state, 'inbox-log.jsonl');
const countsFile = (d) => path.join(d.state, 'inbox-counts.json');
export const readInbox = (d) => readJson(stateFile(d), {});
export const readCounts = (d) => readJson(countsFile(d), { days: {} });
const readKeep = (d, cfg) => [...readJson(path.join(d.state, 'inbox-keep.json'), []).filter((s) => typeof s === 'string'), ...(Array.isArray(cfg.keep) ? cfg.keep : [])];

function appendLog(d, row) {
  try {
    fs.mkdirSync(d.state, { recursive: true });
    fs.appendFileSync(logFile(d), `${JSON.stringify(row)}\n`);
  } catch { /* the log is best effort */ }
}

// All unread notifications, following pages; or { notModified: true }.
async function listNotifications(api, since) {
  const first = await api.request('/notifications?per_page=50', since ? { headers: { 'if-modified-since': since } } : {});
  const pollSeconds = Number(first.headers.get('x-poll-interval')) || MIN_POLL_SECONDS;
  if (first.status === 304) return { notModified: true, pollSeconds, lastModified: since };
  if (!first.ok) throw new ShepherdError({ code: 'inbox-read', problem: `GitHub answered ${first.status} reading notifications`, fix: first.status === 401 || first.status === 403 ? 'give the token the notifications scope' : 'run shepherd inbox again shortly' });
  let items = await first.json();
  let next = /<([^>]+)>;\s*rel="next"/.exec(first.headers.get('link') ?? '')?.[1];
  for (let page = 1; next && page < MAX_PAGES; page++) {
    const r = await api.request(next);
    if (!r.ok) break;
    items = items.concat(await r.json());
    next = /<([^>]+)>;\s*rel="next"/.exec(r.headers.get('link') ?? '')?.[1];
  }
  return { notModified: false, items, pollSeconds, lastModified: first.headers.get('last-modified') ?? undefined };
}

// One poll. apply: false judges and changes nothing (no state, no log). Resolves to { skipped } (not due), { notModified },
// or { account, listed, done: [{id, repo, title, reason, rule, why}], kept: [{ ... }] }. `force` ignores the poll interval.
export async function pollInbox(d, cfg, { apply = true, api, force = false } = {}) {
  const now = d.now();
  const state = readInbox(d);
  if (!force && state.nextAt && now < state.nextAt) return { skipped: true, nextAt: state.nextAt };
  api ??= githubApi({ token: resolveToken(cfg) });
  if (apply) {
    const me = await api.json('/user');
    if (!me?.login) throw new ShepherdError({ code: 'inbox-token', problem: 'the token could not read its own account', fix: 'give the token the notifications scope' });
    if (lower(me.login) !== lower(cfg.account)) throw new ShepherdError({ code: 'inbox-account', problem: `the token is ${me.login}'s, not ${cfg.account}'s`, fix: `use ${cfg.account}'s token: only that inbox is tidied` });
  }
  const listed = await listNotifications(api, apply && !force ? state.lastModified : undefined);
  const nextAt = now + Math.max(MIN_POLL_SECONDS, listed.pollSeconds) * 1000;
  if (listed.notModified) {
    if (apply) writeJson(stateFile(d), { ...state, nextAt, pollSeconds: listed.pollSeconds });
    return { notModified: true, nextAt };
  }
  const keep = readKeep(d, cfg);
  const cache = state.kept ?? {};
  const nextCache = {};
  const done = [];
  const kept = [];
  for (const n of listed.items) {
    const key = `${n.id}:${n.updated_at}`;
    const row = { id: n.id, repo: n.repository?.full_name, title: n.subject?.title, reason: n.reason, type: n.subject?.type };
    let verdict = cache[key];
    if (!verdict || verdict.rule === 'unknown') {
      const wanted = AUTO_REASONS.includes(n.reason) && SUBJECTS.includes(n.subject?.type);
      verdict = judge(n, wanted ? await facts(n, api).catch(() => null) : null, cfg, keep);
    }
    if (verdict.done) {
      if (apply && !(await api.done(n.id).catch(() => false))) { kept.push({ ...row, rule: 'not-done', why: 'GitHub refused to mark it done' }); continue; }
      done.push({ ...row, rule: verdict.rule, why: verdict.why });
      if (apply) appendLog(d, { at: new Date(now).toISOString(), ...row, rule: verdict.rule, why: verdict.why });
    } else {
      kept.push({ ...row, rule: verdict.rule, why: verdict.why });
      nextCache[key] = verdict;
    }
  }
  if (apply) {
    writeJson(stateFile(d), { lastModified: listed.lastModified, nextAt, pollSeconds: listed.pollSeconds, kept: nextCache });
    recordCounts(d, cfg, now, done, kept);
  }
  return { account: cfg.account, listed: listed.items.length, done, kept };
}

// Per-day counts, in the state folder and (when configured) the attention ledger's file: threads marked done by reason, and what
// the last poll left in the inbox for a person.
function recordCounts(d, cfg, now, done, kept) {
  const day = new Date(now).toISOString().slice(0, 10);
  const all = readCounts(d);
  const today = all.days[day] ?? { markedDone: 0, byReason: {}, byRule: {} };
  today.markedDone += done.length;
  for (const x of done) {
    today.byReason[x.reason] = (today.byReason[x.reason] ?? 0) + 1;
    today.byRule[x.rule] = (today.byRule[x.rule] ?? 0) + 1;
  }
  today.keptNow = kept.length;
  today.updatedAt = new Date(now).toISOString();
  const days = Object.fromEntries(Object.entries({ ...all.days, [day]: today }).sort().slice(-14));
  const out = { source: 'github-inbox', account: cfg.account, days };
  writeJson(countsFile(d), out);
  if (cfg.ledger) writeJson(cfg.ledger, out);
}

export const inboxStatus = (d) => ({ ...readInbox(d), kept: undefined, counts: readCounts(d).days });

export function renderInbox(r) {
  if (r.skipped) return `inbox: not due until ${new Date(r.nextAt).toISOString()}`;
  if (r.notModified) return 'inbox: nothing changed since the last poll';
  const lines = [`inbox ${r.account}: ${r.listed} unread, ${r.done.length} done, ${r.kept.length} kept`];
  for (const x of r.done) lines.push(`  done  ${x.repo}  ${x.title}  [${x.reason}]  ${x.why}`);
  for (const x of r.kept) lines.push(`  kept  ${x.repo}  ${x.title}  [${x.reason}]  ${x.why}`);
  return lines.join('\n');
}
