// Copilot quota balancer: no session ever stops on "You have exceeded your monthly quota" while any signed-in
// Copilot account still has premium requests left, and nobody switches accounts by hand.
//
//   node quota-balance.mjs read                 each signed-in Copilot account's premium-request quota, from every source
//   node quota-balance.mjs plan                 what a tick would do now (dry run): moves, resumes, why
//   node quota-balance.mjs tick [--apply] [--only <project id>]   read, move projects off spent accounts, resume
//                                               quota-stalled sessions (macd runs `tick --apply` every minute)
//   node quota-balance.mjs status               the last tick's result
//   node quota-balance.mjs listen               keep the app's per-account quota broadcasts in a file (macd runs this
//                                               in-process, so every model call on any account refreshes its reading)
//
// How the GitHub Copilot app bills (as observed, 2026-11-09): every project
// has a repository account (repo access) and, with Settings > Accounts "separate Copilot account" on, an optional
// pinned Copilot account (inference and billing) in data.db projects.copilot_account_id. A session bills its
// project's pinned account, else the repository account, else the app's default account. The two are independent:
// an managed-only repository keeps its managed repository account while any account with a seat pays for inference.
// `set_project_copilot_account` on the app's own WebSocket re-pins a project and evicts its warm sessions, because a
// runtime freezes its identity at spawn; the next message to a session resumes it, same id and history, on the new
// account. That is the switch: re-pin, then message every session that was stopped (quota error) or evicted (warm).
//
// Quota sources, freshest wins, keyed login@host so every Mac agrees:
//   direct     GET https://api.<host>/copilot_internal/user with that account's gh token (what the app's usage view
//              and VS Code read): quota_snapshots.premium_interactions {entitlement, remaining, percent_remaining}.
//   app        quota_snapshot_updated broadcasts with account_id on the app's socket (sent after every model call),
//              kept by `listen` in ~/.config/mac-fleet/quota-app.json. The only source for an account gh has no token
//              for (ghe-two.example.com ghe-one.example.com). Not `get_account_quota {project_id}`:
//              on 2026-11-09 (app 1.0.102) it answered the default account's numbers, or a stale cycle's, for projects
//              billing other accounts.
//   fleet      the other Macs' readings, from the shared gist (<machine>.quota.txt), when share is configured.
//   agent      each Ouro agent's own file in that gist (<machine>.<agent>.quota.txt, parseAgentQuota): its readings of
//              the accounts it bills, and its burn, a floor on that account's forecast burn.
//   error      a session's own 402 quota_exceeded event marks its account spent until a later reading says otherwise.
//
// Accounts are the ones signed in to the Copilot app (its accounts table, the consumption page), in the app's own
// order: default first, then sign-in order. Nothing lists them in config.
// Policy (config: machines.json defaults.quota_balance, then machines.<me>.quota_balance, over DEFAULTS below):
//   tranche  the operator, 2026-11-09 18:25: fill each account to 30% used before the next, then 60, then 90, then the last
//         10% of each. Per project, the cap is the lowest of `tranches` that some account it may bill is still below
//         (trancheCap); it stays on its account until that account reaches the cap, then moves to the first account in
//         order still below it (pickByTranche)                               -> move when the project is quiet.
//   out   account spent (has_quota false, <= out_pct, or a newer quota error)  -> move the project now, resume all.
//   scope the account bills a project its rules forbid                          -> move when the project is quiet.
// Quiet: no session in the project is working (mid-turn, between turns that asked for tools, or waiting on an async
// shell or a background agent, as history-state.mjs reads it). A move evicts the project's warm runtimes; an idle one
// just loads on the new account at its next message, so a quiet move stops nothing (until 2026-11-09 a project with
// any warm runtime was never balanced, so three busy projects sat on a 29%-left account burning ~10,700
// requests an hour until the operator re-pinned them by hand at 15:45). Balancing never stops a working session: only a spent
// account (out, where the 402 has already stopped it) moves while a session works. Any session such a
// move evicts while it works is resumed by the balancer itself (Housesitter's watcher resumes after an app restart, not after a move).
//   unlimited  prefer_unlimited (default on; the operator, 2026-11-16): an account whose reading is unlimited (user@github.com,
//         the operator's GitHub subsidiary enterprise allocation; the consumption page shows "?") bills every project its rules
//         allow, and the tranches cover only the limited accounts. Off: it comes after every limited one is at 100%.
//   pins  a person's pin (the app marks every pin 'user', the balancer's too, so the balancer keeps the pins it set in
//         its state) is kept unless its account is spent: scope, tranche and unlimited moves leave it alone.
// Evictions: every re-pin, the balancer's, a person's or another agent's, evicts the project's warm runtimes, and the
// app logs each one. Each tick reads the app log since the last tick, messages every session an eviction stopped
// mid-work (history-state.mjs, judged just before its shutdown) to continue, and checks on the next ticks that it took
// a turn, messaging it once more if not. An idle evicted session is left to resume on its next message.
//   overage  included requests spent but the enterprise allows overage (overage_permitted: the account's enterprise
//         pays, never the operator): only after every allowed account reaches 100% used (and every unread seated one); a
//         project on it moves back to included requests when no turn is running. The flag means "configured",
//         not "has room" (the app's QuotaWarningBanner), so a 402 on it is remembered as refused until the reset.
// Forecast: each account's burn (requests an hour, including overage) from the readings of the last 6 hours; for each
// group of accounts a project may bill, the hours until its included requests run out. A group with no enterprise
// overage to fall back on, forecast to run dry before the reset within warn_h hours, or a project with nowhere left
// to go, is listed under "Waiting on the operator" (~/.config/mac-fleet/waiting-on-operator.quota.json, read by ./mac fleet):
// raising a budget or adding a seat is his (money, people).
// Targets are accounts with a known reading that the rules allow, by tranche; an unread seated account only as a last
// resort before overage.
// Rules (both must hold): repo_rules {repo, accounts} say which accounts may bill a repository (a project with no
// repository matches by name); account_rules {account, repos} say which repositories an account may bill (the managed
// account only for a work organization's). Only the Copilot (billing) account moves; the repository account that pushes is
// never touched. A move evicts the project's warm runtimes; only a session stopped on quota or evicted mid-turn is
// messaged to continue (an idle one resumes on its next message, on the new account).
// Every decision is one JSON line in ~/Library/Logs/quota-balance.jsonl; state in ~/.config/mac-fleet/quota-balance.json.

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateAt } from './history-state.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const CHOME = process.env.COPILOT_HOME || path.join(HOME, '.copilot');
const SSTATE = path.join(CHOME, 'session-state');
const CFG_DIR = path.join(HOME, '.config/mac-fleet');
const STATE_FILE = path.join(CFG_DIR, 'quota-balance.json');
const LOG_FILE = path.join(HOME, 'Library/Logs/quota-balance.jsonl');
const APP_FILE = path.join(CFG_DIR, 'quota-app.json');
const WAITING_FILE = path.join(CFG_DIR, 'waiting-on-operator.quota.json');
const PATHS = `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}`;

export const DEFAULTS = {
  enabled: true,
  low_pct: 5,
  out_pct: 0.5,
  tranches: [30, 60, 90, 100],
  max_moves: 10,
  stall_window_h: 12,
  stale_h: 6,
  listen_ms: 0,
  resume_retry_ms: 180000,
  warn_h: 72,
  burn_window_h: 6,
  prefer_unlimited: true,
  respect_user_pins: true,
  resume_window_min: 30,
  exclude: [],
  repo_rules: [],
  account_rules: [],
  share: null,
};

// ---------- config ----------

export function config(file = path.join(HERE, 'machines.json')) {
  let all = {};
  try { all = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* single Mac without fleet config */ }
  const host = (spawnSync('/usr/sbin/scutil', ['--get', 'LocalHostName'], { encoding: 'utf8', timeout: 3000 }).stdout || '').trim().toLowerCase();
  const [me, m = {}] = Object.entries(all.machines || {}).find(([, v]) => String(v.local_hostname || '').toLowerCase() === host) || [host || 'this-mac', {}];
  const d = all.defaults || {};
  const cfg = { ...DEFAULTS, ...(d.quota_balance || {}), ...(m.quota_balance || {}), me };
  // Sharing defaults to the fleet gist when there is one: each Mac writes <machine>.quota.txt, every Mac reads all.
  if (cfg.share === null && d.fleet_gist_id) cfg.share = { gist_id: d.fleet_gist_id, gh_user: (d.github_accounts || []).find((a) => a.host === 'github.com')?.login || null };
  return cfg;
}

// ---------- the app's database (read only) ----------

function sql(query) {
  const db = path.join(CHOME, 'data.db');
  const r = spawnSync('/usr/bin/sqlite3', ['-readonly', '-json', '-cmd', '.timeout 3000', db, query], { encoding: 'utf8', maxBuffer: 64 << 20, timeout: 15000 });
  if (r.status !== 0) throw new Error(`sqlite3: ${(r.stderr || r.error?.message || '').trim().slice(0, 300)}`);
  return r.stdout.trim() ? JSON.parse(r.stdout) : [];
}

export const keyOf = (a) => `${a.login}@${a.host}`;

export function appState() {
  // The app's own list (Settings > Accounts, the consumption page): default first, then in sign-in order. This is the
  // tranche order; nothing in machines.json lists accounts.
  const accounts = sql("SELECT id, login, host, is_default, settings_json FROM accounts WHERE kind = 'github' ORDER BY is_default DESC, created_at, rowid").map((a) => {
    let s = {}; try { s = JSON.parse(a.settings_json || '{}'); } catch { /* keep {} */ }
    return { id: a.id, login: a.login, host: a.host, is_default: Boolean(a.is_default), copilot: s.copilotAccess !== false && s.copilotAppEnabled !== false };
  });
  const projects = sql('SELECT id, name, github_owner, github_repo, github_account_id, copilot_account_id, copilot_account_source FROM projects');
  let separate = false;
  try { const [r] = sql("SELECT value FROM app_state WHERE key = 'copilot-account-settings'"); const v = JSON.parse(r?.value || '{}'); separate = Boolean((v.state || v).separateCopilotAccountEnabled); } catch { /* off */ }
  const sessions = sql(`SELECT s.id, s.title, s.is_running, s.updated_at,
      COALESCE(w.project_id, (SELECT w2.project_id FROM workspace_side_chats sc JOIN workspaces w2 ON w2.id = sc.workspace_id WHERE sc.session_id = s.id), (SELECT project_id FROM session_account_projects WHERE session_id = s.id)) AS project_id,
      COALESCE(w.name, s.title) AS name
    FROM sessions s LEFT JOIN workspaces w ON w.session_id = s.id AND w.archived_at IS NULL
    WHERE s.archived_at IS NULL AND COALESCE(s.execution_location, 'local') = 'local'`);
  return { accounts, projects, separate, sessions };
}

// Pure. Mirrors AccountResolution::copilot_account_for_project: pinned (when the setting is on and the account can
// supply Copilot), else the repository account (when it can), else the default account.
export function billingAccount(project, accounts, separate) {
  const by = new Map(accounts.map((a) => [a.id, a]));
  const def = accounts.find((a) => a.is_default) || null;
  if (!project) return def;
  const pinned = separate && project.copilot_account_id ? by.get(project.copilot_account_id) : null;
  if (pinned?.copilot) return pinned;
  const repo = project.github_account_id ? by.get(project.github_account_id) : null;
  if (repo?.copilot) return repo;
  return def;
}

// ---------- session state: live runtimes and quota stalls ----------

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
export function warm(id) {
  try { return fs.readdirSync(path.join(SSTATE, id)).some((f) => { const m = f.match(/^inuse\.(\d+)\.lock$/); return m && alive(Number(m[1])); }); } catch { return false; }
}

function tail(id, bytes = 2 * 1024 * 1024) {
  const f = path.join(SSTATE, id, 'events.jsonl');
  let fd;
  try {
    fd = fs.openSync(f, 'r');
    const st = fs.fstatSync(fd);
    const len = Math.min(st.size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    return { lines: buf.toString('utf8').split('\n').slice(len < st.size ? 1 : 0), mtime: st.mtimeMs };
  } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

// Pure. The last quota error, if nothing has run since: {id, at, code} or null. A user message or a new turn after the
// error means the session already continued.
export function quotaStall(lines) {
  let stall = null;
  for (const l of lines) {
    if (!l || l.length < 20) continue;
    if (!/"type":"(session\.error|user\.message|assistant\.turn_start)"/.test(l.slice(0, 60))) continue;
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (e.type === 'session.error') {
      const d = e.data || {};
      if (d.errorType === 'quota' || d.statusCode === 402 || /quota_exceeded/.test(String(d.errorCode || ''))) stall = { id: e.id, at: e.timestamp, code: d.errorCode || d.errorType };
    } else if (stall && Date.parse(e.timestamp) > Date.parse(stall.at)) stall = null;
  }
  return stall;
}

// ---------- readings ----------

function ghToken(host, login) {
  const env = { ...process.env, PATH: PATHS };
  delete env.GH_TOKEN; delete env.GITHUB_TOKEN; delete env.GH_ENTERPRISE_TOKEN;
  const r = spawnSync('gh', ['auth', 'token', '--hostname', host, '--user', login], { encoding: 'utf8', timeout: 10000, env });
  const t = (r.stdout || '').trim();
  return r.status === 0 && t ? t : null;
}

const apiBase = (host) => (host === 'github.com' ? 'https://api.github.com' : `https://api.${host}`);

// Pure. One premium_interactions snapshot, from either shape (REST snake_case or the app's camelCase).
export function normalize(snap, extra = {}) {
  if (!snap) return null;
  const ent = snap.entitlement ?? snap.entitlementRequests;
  const pct = snap.percent_remaining ?? snap.remainingPercentage;
  const rem = snap.remaining ?? snap.quota_remaining ?? (ent != null && pct != null ? Math.round((ent * pct) / 100) : null);
  return {
    unlimited: Boolean(snap.unlimited ?? snap.isUnlimitedEntitlement),
    entitlement: ent ?? null,
    remaining: rem,
    pct: pct ?? null,
    has_quota: snap.has_quota ?? (pct == null ? null : pct > 0),
    overage_permitted: snap.overage_permitted ?? snap.overageAllowedWithExhaustedQuota ?? null,
    reset: snap.quota_reset_date_utc || snap.resetDate || null,
    // Requests used, overage included: the burn counter (remaining stops at 0, overage keeps counting).
    spent: (ent != null && rem != null ? ent - rem : snap.credits_used ?? snap.usedRequests ?? null) == null ? null
      : (ent != null && rem != null ? ent - rem : snap.credits_used ?? snap.usedRequests) + Number(snap.overage_count ?? snap.overage ?? 0),
    ...extra,
  };
}

async function direct(a) {
  const token = ghToken(a.host, a.login);
  if (!token) return null;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 10000);
  try {
    const r = await fetch(`${apiBase(a.host)}/copilot_internal/user`, { headers: { Authorization: `token ${token}`, Accept: 'application/json', 'User-Agent': 'quota-balance' }, signal: ctl.signal });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const j = await r.json();
    if (j.login && j.login.toLowerCase() !== a.login.toLowerCase()) return { error: `token is for ${j.login}` };
    const p = j.quota_snapshots?.premium_interactions;
    return normalize(p ? { ...p, quota_reset_date_utc: j.quota_reset_date_utc } : null, { source: 'direct', at: new Date().toISOString(), plan: j.copilot_plan || null });
  } catch (e) { return { error: e.name === 'AbortError' ? 'timeout' : e.message }; } finally { clearTimeout(t); }
}

function appSocket() {
  const read = (f) => fs.readFileSync(path.join(CHOME, 'run', f), 'utf8').trim().split(/\r?\n/);
  const [port, owner] = read('ws.port');
  const [token] = read('ws.token');
  if (owner && !alive(Number(owner))) throw new Error('the Copilot app that wrote ws.port is not running');
  return { port, token };
}

// Send requests (optional) and collect replies until done() or the wait runs out.
export function exchange(messages, { done = () => false, waitMs = 10000, keep = () => true } = {}) {
  let sock;
  try { sock = appSocket(); } catch (e) { return Promise.resolve([{ type: 'socket_error', message: e.message }]); }
  return new Promise((resolve) => {
    const got = [];
    const ws = new WebSocket(`ws://127.0.0.1:${sock.port}/?token=${encodeURIComponent(sock.token)}&observer=1`);
    const finish = () => { clearTimeout(t); try { ws.close(); } catch { /* gone */ } resolve(got); };
    const t = setTimeout(finish, waitMs);
    ws.addEventListener('open', () => { for (const m of messages) ws.send(JSON.stringify(m)); });
    ws.addEventListener('message', (e) => { let j; try { j = JSON.parse(String(e.data)); } catch { return; } if (!keep(j)) return; got.push(j); if (done(j, got)) finish(); });
    ws.addEventListener('error', () => { got.push({ type: 'socket_error' }); finish(); });
  });
}

// The listener's file: login@host -> reading, written on every broadcast.
export function appFileReadings(file = APP_FILE) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).readings || {}; } catch { return {}; }
}

// Resident (macd): hold an observer socket to the app and keep the latest per-account snapshot in APP_FILE. Reconnects
// every 30 s while the app is down or restarting. Returns { stop }.
export function listen({ log = () => {}, file = APP_FILE, retryMs = 30000 } = {}) {
  let ws = null;
  let stopped = false;
  let timer = null;
  let byId = new Map();
  const refreshAccounts = () => { try { byId = new Map(appState().accounts.map((a) => [a.id, a])); } catch { /* app db busy */ } };
  const again = () => { if (!stopped) { clearTimeout(timer); timer = setTimeout(open, retryMs); } };
  const open = () => {
    if (stopped) return;
    let sock;
    try { sock = appSocket(); } catch { return again(); }
    refreshAccounts();
    try { ws = new WebSocket(`ws://127.0.0.1:${sock.port}/?token=${encodeURIComponent(sock.token)}&observer=1`); } catch { return again(); }
    ws.addEventListener('message', (e) => {
      let j; try { j = JSON.parse(String(e.data)); } catch { return; }
      if (j.type !== 'quota_snapshot_updated' || !j.account_id) return;
      if (!byId.has(j.account_id)) refreshAccounts();
      const a = byId.get(j.account_id);
      const n = normalize(j.snapshots?.premium_interactions, { source: 'app', at: new Date().toISOString() });
      if (!a || !n) return;
      try {
        const cur = appFileReadings(file);
        cur[keyOf(a)] = n;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file + '.new', JSON.stringify({ readings: cur }, null, 1));
        fs.renameSync(file + '.new', file);
      } catch (err) { log(`quota listen: ${err.message}`); }
    });
    ws.addEventListener('close', again);
    ws.addEventListener('error', () => { try { ws.close(); } catch { /* gone */ } again(); });
  };
  open();
  return { stop: () => { stopped = true; clearTimeout(timer); try { ws?.close(); } catch { /* gone */ } } };
}

async function appBroadcasts(accounts, ms) {
  if (!ms) return {};
  const got = await exchange([], { waitMs: ms, keep: (j) => j.type === 'quota_snapshot_updated' && j.account_id });
  const by = new Map(accounts.map((a) => [a.id, a]));
  const out = {};
  for (const j of got) {
    const a = by.get(j.account_id);
    const n = normalize(j.snapshots?.premium_interactions, { source: 'app', at: new Date().toISOString() });
    if (a && n) out[keyOf(a)] = n;
  }
  return out;
}

function shareToken(share) {
  const env = { ...process.env, PATH: PATHS };
  delete env.GH_TOKEN; delete env.GITHUB_TOKEN;
  const r = spawnSync('gh', ['auth', 'token', '--hostname', 'github.com', ...(share.gh_user ? ['--user', share.gh_user] : [])], { encoding: 'utf8', timeout: 10000, env });
  return r.status === 0 ? r.stdout.trim() : null;
}

async function gistFetch(share, method = 'GET', body) {
  const token = shareToken(share);
  if (!token) throw new Error('no github.com gh token for the share gist');
  const once = async (etag) => {
    const r = await fetch(`https://api.github.com/gists/${share.gist_id}`, { method, headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'quota-balance', ...(etag ? { 'If-None-Match': etag } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
    if (r.status === 304) return { status: 304 };
    if (!r.ok) throw new Error(`gist ${method} HTTP ${r.status}`);
    return { status: r.status, etag: r.headers.get('etag'), body: method === 'GET' ? await r.json() : null };
  };
  // Reads come from a copy at most 5 minutes old (gist-cache.mjs): the tick runs every minute, and gist reads are
  // limited per token. Other Macs' shares change at most every 10 minutes and agent readings are trusted for 6 h.
  if (method === 'GET') return (await (await import('./gist-cache.mjs')).cachedGet(share.gist_id, once)).body;
  return (await once()).body;
}

// Pure. An agent's own file in the fleet gist, <machine>.<agent>.quota.txt (Ouroboros, Housesitter: whatever Copilot
// accounts it bills). Content: {machine, agent, at, readings: [Reading]}, Reading = {key: "login@host", leftPct,
// burnPerH, dryAt, overageOk, at} plus optional remaining, entitlement, reset (ourostack/ouroboros fleet-readings.ts
// publishes and reads the same shape). Returns {machine, agent, at, readings: login@host -> reading, burn: login@host
// -> requests an hour}, or null when the name or content is not an agent file.
export function parseAgentQuota(name, content) {
  const m = String(name).match(/^([^.]+)\.([^.]+)\.quota\.txt$/);
  if (!m) return null;
  let j; try { j = JSON.parse(content); } catch { return null; }
  const source = `agent:${m[1]}.${m[2]}`;
  const readings = {};
  const burn = {};
  for (const r of [].concat(j?.readings || [])) {
    if (!r?.key || !/^[^@\s]+@[^@\s]+$/.test(r.key)) continue;
    const at = r.at || j.at || null;
    if (r.leftPct != null) {
      readings[r.key] = { unlimited: false, entitlement: r.entitlement ?? null, remaining: r.remaining ?? (r.entitlement != null ? Math.round((r.entitlement * r.leftPct) / 100) : null), pct: r.leftPct, has_quota: r.leftPct > 0, overage_permitted: r.overageOk ?? null, reset: r.reset || null,
        spent: r.entitlement != null && r.remaining != null ? r.entitlement - r.remaining : null, source, at };
    }
    if (Number.isFinite(r.burnPerH) && r.burnPerH >= 0) burn[r.key] = (burn[r.key] || 0) + r.burnPerH;
  }
  return { machine: m[1], agent: m[2], at: j?.at || null, readings, burn };
}

// Pure. Agent burn per account from fresh agent files: login@host -> {per_h, agents: ["mac-b.ouroboros", ...]}.
export function agentBurn(agents, { now = Date.now(), windowH = 6 } = {}) {
  const out = {};
  for (const a of agents || []) {
    if (!a?.at || ago(a.at, now) > windowH) continue;
    for (const [k, per] of Object.entries(a.burn || {})) {
      const o = (out[k] ||= { per_h: 0, agents: [] });
      o.per_h += per;
      o.agents.push(`${a.machine}.${a.agent}`);
    }
  }
  return out;
}

async function fleetReadings(share, me) {
  const out = {};
  const agents = [];
  const g = await gistFetch(share);
  for (const [name, f] of Object.entries(g.files || {})) {
    const agent = parseAgentQuota(name, f.content);
    if (agent) { agents.push(agent); for (const [k, v] of Object.entries(agent.readings)) out[k] = merge({ [k]: out[k] }, { [k]: v })[k]; continue; }
    const m = name.match(/^([^.]+)\.quota\.txt$/);
    if (!m || m[1] === me) continue;
    try { for (const [k, v] of Object.entries(JSON.parse(f.content).readings || {})) out[k] = merge({ [k]: out[k] }, { [k]: { ...v, source: `fleet:${m[1]}/${v.source}` } })[k]; } catch { /* half-written */ }
  }
  return { readings: out, agents };
}

// Pure. Freshest reading per account; a direct reading beats others of the same minute.
export function merge(...sets) {
  const out = {};
  const rank = (r) => Date.parse(r.at || 0) + (String(r.source).endsWith('direct') ? 60000 : 0);
  for (const s of sets) for (const [k, r] of Object.entries(s || {})) if (r && r.pct != null && (!out[k] || rank(r) > rank(out[k]))) out[k] = r;
  return out;
}

// Pure. The tick's readings: last tick's (cached), then the fleet gist's (other Macs and agents), the listener's and
// direct ones; freshest wins. An agent's reading counts only while its file is in the gist and under staleH old: it is
// never carried over from the cache, so a removed or silent agent stops counting at the next tick. A reading without
// `remaining` (an agent that knows only its percent) takes the entitlement from any other reading of that account.
export function combine(prev, fleet, app, directs, { now = Date.now(), staleH = 6 } = {}) {
  const isAgent = (r) => /(^|:)agent:/.test(String(r?.source || ''));
  const old = Object.fromEntries(Object.entries(prev || {}).filter(([, v]) => !isAgent(v)).map(([k, v]) => [k, { ...v, source: String(v.source).replace(/^(cached:)*/, 'cached:') }]));
  const live = Object.fromEntries(Object.entries(fleet || {}).filter(([, v]) => !isAgent(v) || ago(v.at, now) <= staleH));
  const out = merge(old, live, app, directs);
  for (const [k, r] of Object.entries(out)) {
    if (r.remaining != null || r.pct == null) continue;
    const ent = r.entitlement ?? [directs, app, live, old].map((x) => x?.[k]?.entitlement).find((e) => e != null);
    if (ent != null) out[k] = { ...r, entitlement: ent, remaining: Math.round((ent * r.pct) / 100) };
  }
  return out;
}

export async function read(st, cfg, prev = {}) {
  const want = st.accounts.filter((a) => a.copilot);
  const errors = {};
  const directs = {};
  await Promise.all(want.map(async (a) => { const r = await direct(a); if (r?.error) errors[keyOf(a)] = r.error; else if (r) directs[keyOf(a)] = r; }));
  const app = merge(appFileReadings(), await appBroadcasts(st.accounts, cfg.listen_ms));
  let fleet = {};
  let agents = [];
  if (cfg.share?.gist_id) { try { ({ readings: fleet, agents } = await fleetReadings(cfg.share, cfg.me)); } catch (e) { errors.share = e.message; } }
  return { readings: combine(prev, fleet, app, directs, { now: Date.now(), staleH: cfg.stale_h }), own: merge(app, directs), agents, errors };
}

// ---------- the plan (pure) ----------

const ago = (iso, now) => (now - Date.parse(iso || 0)) / 3600000;

// Pure. Is this account usable, and if not, how badly?
export function health(acct, reading, cfg, { blockedAt = null, now = Date.now() } = {}) {
  if (!acct?.copilot) return 'no-seat';
  if (cfg.exclude.includes(keyOf(acct))) return 'excluded';
  if (blockedAt && (!reading || Date.parse(reading.at) < Date.parse(blockedAt) || reading.pct <= cfg.out_pct)) return 'out';
  if (!reading || reading.pct == null) return 'unknown';
  if (reading.unlimited) return 'ok';
  if (reading.has_quota === false || reading.pct <= cfg.out_pct) return reading.overage_permitted === true ? 'overage' : 'out';
  if (reading.pct < cfg.low_pct) return 'low';
  if (ago(reading.at, now) > cfg.stale_h) return 'stale';
  return 'ok';
}

const glob = (pat) => new RegExp(`^${String(pat).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i');
const anyOf = (pats) => (pats == null ? [] : [].concat(pats));
export function allowed(project, acct, cfg) {
  const repo = project?.github_owner && project?.github_repo ? `${project.github_owner}/${project.github_repo}` : project?.name || '';
  const key = keyOf(acct);
  const byRepo = (cfg.repo_rules || []).filter((r) => anyOf(r.repo).some((x) => glob(x).test(repo)));
  const byAcct = (cfg.account_rules || []).filter((r) => anyOf(r.account).some((x) => glob(x).test(key)));
  return byRepo.every((r) => anyOf(r.accounts).some((k) => glob(k).test(key))) && byAcct.every((r) => anyOf(r.repos).some((x) => glob(x).test(repo)));
}

// ---------- tranches (pure; ourostack/ouroboros chooseAccount mirrors these) ----------
// the operator, 2026-11-09 18:25: "first get to 30% usage on first account before switching to next one, then 60, then 90, then
// squeeze final 10 out of each. same should be done for ghcp agents :) across the board".

export const TRANCHES = [30, 60, 90, 100];

// Pure. Percent of included requests used, or null with no reading. Spent (has_quota false) is 100; unlimited is 0.
export function usedPct(r) {
  if (!r || r.pct == null) return null;
  if (r.unlimited) return 0;
  if (r.has_quota === false) return 100;
  return Math.max(0, Math.min(100, 100 - r.pct));
}

// Pure. The current cap: the lowest tranche that some eligible account (with a reading) is still below. It rises only
// once every eligible account has reached it. When every one is at 100 it stays 100 and pickByTranche returns null:
// only then does enterprise overage come in.
export function trancheCap(readings, eligible, caps = TRANCHES) {
  const used = (eligible || []).map((k) => usedPct(readings?.[k])).filter((u) => u != null);
  for (const c of caps) if (used.some((u) => u < c)) return c;
  return caps.at(-1);
}

// Pure. Stay on the current account while it is eligible and below the cap; else the first account in order that is
// eligible and below it; null when none is (included requests spent everywhere: overage, or nowhere to go).
export function pickByTranche(current, readings, eligible, order, cap) {
  const ok = new Set(eligible || []);
  const below = (k) => ok.has(k) && usedPct(readings?.[k]) != null && usedPct(readings[k]) < cap;
  if (below(current)) return current;
  return (order || []).find(below) ?? (eligible || []).find(below) ?? null;
}

// Pure. Did a person pin this project's Copilot account? The app records every pin, the balancer's included, as
// copilot_account_source 'user', so a pin is the balancer's only while it is the account the balancer last set
// (ownPins: project id -> account id, kept in the state file).
export function userPinned(project, separate, ownPins = {}) {
  return Boolean(separate && project?.copilot_account_source === 'user' && project.copilot_account_id && ownPins[project.id] !== project.copilot_account_id);
}

// Pure. ownPins seeded from the decision log, for a state file written before the balancer kept them: each project's
// last successful move. A project whose pin has changed since was re-pinned by someone else.
export function pinsFromLog(lines) {
  const out = {};
  for (const l of lines || []) {
    if (!l || !l.includes('"act":"move"')) continue;
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (e.act === 'move' && e.result?.ok && e.project_id && e.to_id) out[e.project_id] = e.to_id;
  }
  return out;
}

// Pure. st: appState(); readings: login@host -> reading; live: session id -> {warm, running, stall}.
// Unlimited (prefer_unlimited, on by default; the operator, 2026-11-16, of user@github.com: "this last bucket on the
// list, which does not have a limit ... should optionally prefer it"): a project bills an unlimited account its rules
// allow, and the tranches cover only the limited accounts. With prefer_unlimited off, the unlimited account comes after
// every limited one is at 100% used, before enterprise overage. A person's pin (userPinned) is kept unless its account
// is spent.
export function plan(st, readings, live, cfg, { now = Date.now(), refused = {}, burn = {}, keeperResumes = false, ownPins = {} } = {}) {
  const blocked = {};
  for (const a of st.accounts) { const r = refused[keyOf(a)]; if (r) blocked[a.id] = r; }
  for (const s of st.sessions) {
    const stall = live[s.id]?.stall;
    if (!stall || ago(stall.at, now) > cfg.stall_window_h) continue;
    const p = st.projects.find((x) => x.id === s.project_id);
    const a = billingAccount(p, st.accounts, st.separate);
    if (a && (!blocked[a.id] || stall.at > blocked[a.id])) blocked[a.id] = stall.at;
  }
  const refusedNow = Object.fromEntries(st.accounts.filter((a) => blocked[a.id]).map((a) => [keyOf(a), blocked[a.id]]));
  const hp = (a) => health(a, readings[keyOf(a)], cfg, { blockedAt: blocked[a.id], now });
  const accounts = st.accounts.map((a) => ({ key: keyOf(a), id: a.id, health: hp(a), pct: readings[keyOf(a)]?.pct ?? null, remaining: readings[keyOf(a)]?.remaining ?? null, source: readings[keyOf(a)]?.source || null, at: readings[keyOf(a)]?.at || null, blocked_at: blocked[a.id] || null, projects: 0, live_sessions: 0 }));
  const row = new Map(accounts.map((r) => [r.id, r]));
  // What the tranches see: a spent, refused or overage-only account is at 100% used; no reading, no place in them.
  const eff = {};
  for (const a of st.accounts) {
    const h = hp(a);
    if (h === 'out' || h === 'overage') eff[keyOf(a)] = { pct: 0, has_quota: false };
    else if (['ok', 'low', 'stale'].includes(h) && readings[keyOf(a)]) eff[keyOf(a)] = readings[keyOf(a)];
  }
  const order = st.accounts.map(keyOf);
  const byKey = new Map(st.accounts.map((a) => [keyOf(a), a]));
  const isUnlimited = (k) => readings[k]?.unlimited === true && hp(byKey.get(k)) === 'ok';
  const tranches = cfg.tranches || TRANCHES;
  const moves = [];
  const resumes = [];
  const pins = [];
  for (const p of st.projects) {
    const sess = st.sessions.filter((s) => s.project_id === p.id);
    const cur = billingAccount(p, st.accounts, st.separate);
    if (!cur) continue;
    const r = row.get(cur.id);
    if (r) { r.projects++; r.live_sessions += sess.filter((s) => live[s.id]?.warm).length; }
    const busy = sess.some((s) => live[s.id]?.running || live[s.id]?.working);
    const h = hp(cur);
    const ok = (a) => a.id !== cur.id && allowed(p, a, cfg);
    const eligible = st.accounts.filter((a) => a.copilot && allowed(p, a, cfg) && !cfg.exclude.includes(keyOf(a))).map(keyOf);
    const unlimited = order.filter((k) => eligible.includes(k) && isUnlimited(k));
    const limited = eligible.filter((k) => !unlimited.includes(k));
    const cap = trancheCap(eff, limited, tranches);
    const stayOrFirst = (ks) => (ks.includes(keyOf(cur)) ? keyOf(cur) : ks[0] ?? null);
    const pick = cfg.prefer_unlimited && unlimited.length ? stayOrFirst(unlimited)
      : pickByTranche(keyOf(cur), eff, limited, order, cap) ?? stayOrFirst(unlimited);
    let best = pick && pick !== keyOf(cur) ? byKey.get(pick) : null;
    const pinned = cfg.respect_user_pins !== false && userPinned(p, st.separate, ownPins) && cur.id === p.copilot_account_id;
    if (pinned) pins.push({ project_id: p.id, project: p.name, account: keyOf(cur), health: h });
    // Last resort when no account has included requests in the tranches: one with a seat but no reading, then one on
    // enterprise overage. If it is spent too, its own 402 marks it out on the next tick and the project moves again.
    const fallback = [
      ...st.accounts.filter((a) => ok(a) && !cfg.exclude.includes(keyOf(a)) && hp(a) === 'unknown'),
      ...st.accounts.filter((a) => ok(a) && hp(a) === 'overage'),
    ];
    const hoursLeft = burn[keyOf(cur)]?.hours_left;
    // A working session is never moved; it moves once its project is quiet. Only a spent account moves under one: its
    // 402 has already stopped the turn. A person's pin moves only then too (2026-11-16 07:25: a scope move took the operator's
    // own pins off user@github.com).
    let why = null;
    if (h === 'out') why = 'out';
    else if (pinned) why = null;
    else if (!allowed(p, cur, cfg) && !busy) why = 'scope';
    else if (h === 'overage' && best && !busy) why = 'included';
    else if (['ok', 'low', 'stale'].includes(h) && best && !busy) why = unlimited.includes(keyOf(best)) ? 'unlimited' : 'tranche';
    if ((why === 'out' || why === 'scope') && !best) best = fallback[0];
    const stalled = sess.filter((s) => live[s.id]?.stall && ago(live[s.id].stall.at, now) <= cfg.stall_window_h);
    if (why && best) {
      // The keeper resumes every session a move evicts while it works; without a keeper the balancer does.
      const quotaStopped = (s) => live[s.id]?.stall && ago(live[s.id].stall.at, now) <= cfg.stall_window_h;
      const evictedWorking = (s) => !keeperResumes && (live[s.id]?.running || live[s.id]?.working);
      moves.push({ project_id: p.id, project: p.name, from: keyOf(cur), to: keyOf(best), to_id: best.id, why, cap, busy, from_pct: readings[keyOf(cur)]?.pct ?? null, to_pct: readings[keyOf(best)]?.pct ?? null, from_hours_left: hoursLeft ?? null,
        resume: sess.filter((s) => quotaStopped(s) || evictedWorking(s)).map((s) => ({ id: s.id, name: s.name, reason: quotaStopped(s) ? 'quota' : 'evicted mid-turn' })) });
    } else if (why) {
      moves.push({ project_id: p.id, project: p.name, from: keyOf(cur), to: null, why, cap, stuck: 'no allowed account has requests left or enterprise overage' });
    } else if (h === 'ok' || h === 'low' || h === 'stale' || h === 'overage') {
      for (const s of stalled) resumes.push({ id: s.id, name: s.name, project: p.name, project_id: p.id, account: keyOf(cur), reason: 'quota', error_id: live[s.id].stall.id });
    }
  }
  // Remote steering resolves the repository with the billing account, on that account's host, so a repository billed
  // from another host cannot be steered remotely (2026-11-09: an app sessions "could not resolve an-org/an-app.
  // Logged in as https://ghe-two.example.com"). The app has no per-session account; reported, not acted on.
  const remoteOff = st.projects.filter((p) => {
    const host = st.accounts.find((a) => a.id === p.github_account_id)?.host;
    const bill = moves.find((m) => m.project_id === p.id && m.to_id)?.to_id ?? billingAccount(p, st.accounts, st.separate)?.id;
    const billHost = st.accounts.find((a) => a.id === bill)?.host;
    return host && billHost && host !== billHost;
  });
  const def = st.accounts.find((a) => a.is_default);
  const defH = def ? hp(def) : null;
  const unprojected = st.sessions.filter((s) => !s.project_id && live[s.id]?.warm).length;
  const notes = [];
  if (remoteOff.length) notes.push(`remote steering is off for ${remoteOff.map((p) => p.name).join(', ')}: each bills an account on a different host than its repository; local steering (./mac sessions send) still works`);
  // A GitHub Sandbox (cloud session) is provisioned with, and bound to, the project's repository account
  // (as observed), not its pinned Copilot account, so
  // no re-pin steers it. Reported so cloud lanes are started locally while that account is spent.
  const cloudOut = st.projects.filter((p) => { const a = st.accounts.find((x) => x.id === p.github_account_id); return a && a.host === 'github.com' && hp(a) === 'out'; });
  if (cloudOut.length) notes.push(`cloud sessions for ${cloudOut.map((p) => p.name).join(', ')} bill their repository account, which is spent, and no re-pin moves them: run those lanes locally (they bill the project's Copilot account)`);
  if (def && defH !== 'ok' && unprojected) notes.push(`${unprojected} live chat session(s) bill the default account ${keyOf(def)} (${defH}); the app has no per-chat Copilot account, so they are not moved`);
  for (const a of accounts) {
    const b = burn[a.key];
    if (b) Object.assign(a, { burn_per_h: b.per_h, hours_left: b.hours_left, agents_per_h: b.agents_per_h ?? null, agents: b.agents || [], dry_at: b.hours_left === Infinity || b.hours_left == null ? null : new Date(now + b.hours_left * 3600000).toISOString() });
    a.overage = readings[a.key]?.overage_permitted ?? null;
  }
  const runway = groupRunway(st, readings, burn, cfg, { now, hp, accounts: st.accounts });
  for (const g of runway) { g.cap = trancheCap(eff, g.accounts.filter((k) => !isUnlimited(k)), tranches); g.unlimited = g.accounts.filter(isUnlimited); }
  const waiting = [];
  for (const g of runway) if (g.alert) waiting.push({ kind: 'money', sentence: g.alert });
  for (const m of moves.filter((x) => x.stuck)) waiting.push({ kind: 'money', sentence: `${m.project} is stuck on ${m.from} (${m.why}): ${m.stuck}. Options: ask that account's enterprise admin to allow overage or raise its budget, or add another work-licensed seat to the Copilot app.` });
  return { accounts, moves: moves.slice(0, cfg.max_moves), resumes, notes, runway, waiting, refused: refusedNow, pins };
}

// Pure. history: [{at, spent}] oldest first -> requests an hour over the window, from the last counter reset on.
export function burnRate(history, { now = Date.now(), windowH = 6 } = {}) {
  let h = (history || []).filter((x) => x && x.spent != null && now - Date.parse(x.at) <= windowH * 3600000);
  for (let i = h.length - 1; i > 0; i--) if (h[i].spent < h[i - 1].spent) { h = h.slice(i); break; }
  if (h.length < 2) return null;
  const spanH = (Date.parse(h.at(-1).at) - Date.parse(h[0].at)) / 3600000;
  if (spanH < 1 / 3) return null;
  return Math.max(0, (h.at(-1).spent - h[0].spent) / spanH);
}

// Pure. Per account: burn and hours until its included requests run out at that burn.
// agents: agentBurn() of the agents' own files. An account's counter already includes its agents' requests, so their
// burn is a floor, never added on top: it counts when this Mac has no burn of its own for the account (no history yet,
// or only the app's broadcasts, which go quiet while only an agent bills it) or sees less than the agents report.
export function forecast(history, readings, { now = Date.now(), windowH = 6, agents = {} } = {}) {
  const out = {};
  for (const [k, r] of Object.entries(readings)) {
    const own = burnRate(history[k], { now, windowH });
    const ag = agents[k];
    if (own == null && !ag) continue;
    const per = Math.max(own ?? 0, ag?.per_h ?? 0);
    out[k] = { per_h: Math.round(per), hours_left: r.unlimited ? Infinity : r.remaining == null ? null : per > 0 ? Math.max(0, r.remaining) / per : Infinity, reset: r.reset || null, ...(ag ? { agents_per_h: Math.round(ag.per_h), agents: ag.agents } : {}) };
  }
  return out;
}

const fmtH = (h) => (h == null ? '?' : h === Infinity ? 'never' : h >= 48 ? `${Math.round(h / 24)} days` : `${Math.round(h)} h`);

// Pure. For each set of accounts some project may bill: included requests left, the burn on those accounts, hours to
// dry, and whether enterprise overage is there to fall back on. alert: a sentence for the operator, or null.
export function groupRunway(st, readings, burn, cfg, { now = Date.now(), hp, accounts }) {
  const groups = new Map();
  for (const p of st.projects) {
    const keys = accounts.filter((a) => a.copilot && allowed(p, a, cfg) && !cfg.exclude.includes(keyOf(a))).map(keyOf).sort();
    const id = keys.join(',');
    if (!groups.has(id)) groups.set(id, { accounts: keys, projects: [] });
    groups.get(id).projects.push(p.name);
  }
  const byKey = new Map(accounts.map((a) => [keyOf(a), a]));
  const out = [];
  for (const g of groups.values()) {
    if (!g.accounts.length) continue;
    const usable = g.accounts.filter((k) => ['ok', 'low', 'stale'].includes(hp(byKey.get(k))));
    const left = usable.reduce((n, k) => n + (readings[k]?.unlimited ? Infinity : Math.max(0, readings[k]?.remaining ?? 0)), 0);
    const known = g.accounts.filter((k) => burn[k]);
    const per = known.reduce((n, k) => n + burn[k].per_h, 0);
    const hours = left === Infinity ? Infinity : left <= 0 ? 0 : per > 0 ? left / per : known.length ? Infinity : null;
    const overage = g.accounts.filter((k) => hp(byKey.get(k)) === 'overage' || (readings[k]?.overage_permitted === true && ['ok', 'low', 'stale'].includes(hp(byKey.get(k)))));
    const resets = g.accounts.map((k) => readings[k]?.reset).filter(Boolean).sort();
    const reset = resets[0] || null;
    const beforeReset = hours != null && (!reset || now + hours * 3600000 < Date.parse(reset));
    const label = g.projects.length > 3 ? `${g.projects.slice(0, 3).join(', ')} and ${g.projects.length - 3} more` : g.projects.join(', ');
    let alert = null;
    if (!overage.length && hours != null && hours < cfg.warn_h && beforeReset) {
      alert = `Copilot premium requests for ${label} run out in about ${fmtH(hours)} at the current burn (${Math.round(per)} an hour; ${Math.round(left)} left on ${usable.join(', ') || 'no account'}), before the ${reset ? reset.slice(0, 10) : 'next'} reset, and none of ${g.accounts.join(', ')} allows enterprise overage. Options: ask an enterprise admin to allow overage or raise the budget on one of them, or add another work-licensed seat to the Copilot app.`;
    }
    out.push({ accounts: g.accounts, projects: g.projects.length, included_left: left === Infinity ? null : Math.round(left), burn_per_h: Math.round(per), hours_left: hours, reset, before_reset: beforeReset, overage_fallback: overage, alert });
  }
  return out;
}

// ---------- acting ----------

function readState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { readings: {}, resumed: {}, last: null }; } }
function writeState(s) { fs.mkdirSync(CFG_DIR, { recursive: true }); fs.writeFileSync(STATE_FILE + '.new', JSON.stringify(s, null, 1)); fs.renameSync(STATE_FILE + '.new', STATE_FILE); }
function logLine(o) { try { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); fs.appendFileSync(LOG_FILE, JSON.stringify({ at: new Date().toISOString(), ...o }) + '\n'); } catch { /* log is best effort */ } }

export const resumePrompt = (why, from, to, cap) => why === 'quota-only'
  ? `[quota-balance] Your last turn stopped with "You have exceeded your monthly quota" on ${from}. This project now bills ${to}, which has premium requests left. Continue exactly where you left off: redo the step that failed, and re-check anything that was in flight before relying on it.`
  : why === 'evicted'
    ? `[quota-balance] This project's Copilot account was switched (at ${from}), so the app stopped your runtime while you were working and will restart it on the new account; your history is intact. Continue exactly where you left off. Anything that was in flight or running in the background (a shell command, a detector or watcher, a subagent, a push) was stopped: re-check its real state and restart it if it is still needed.`
  : `[quota-balance] This project's Copilot account was switched from ${from} to ${to} (${why === 'out' ? `${from} ran out of premium requests` : why === 'tranche' ? `${from} reached the ${cap}% usage tranche; accounts fill in turn to 30, 60, 90, then 100% used` : why === 'unlimited' ? `${to} has no premium-request limit` : why === 'scope' ? `${from} may not bill this repository` : why === 'included' ? `${to} has included premium requests left; ${from} was spending enterprise overage` : `${to} has far more premium requests left`}), so the app restarted your runtime on the new account; your history is intact. Continue exactly where you left off. Anything that was in flight or running in the background (a shell command, a detector or watcher, a subagent, a push) was stopped: re-check its real state and restart it if it is still needed.`;

async function setAccount(projectId, accountId) {
  const got = await exchange([{ type: 'set_project_copilot_account', project_id: projectId, account_id: accountId }], {
    keep: (j) => (j.type === 'project_updated' && j.project?.id === projectId) || j.type === 'error' || j.type === 'socket_error',
    done: (j) => j.type !== 'error' || /copilot account/i.test(j.message || ''),
    waitMs: 8000,
  });
  const [row] = sql(`SELECT copilot_account_id FROM projects WHERE id = '${String(projectId).replace(/[^\w-]/g, '')}'`);
  const err = got.find((j) => j.type === 'error' && /copilot account/i.test(j.message || ''));
  return { ok: row?.copilot_account_id === accountId && !err, reply: got.at(-1)?.type || 'no reply', error: err?.message || got.find((j) => j.type === 'socket_error')?.message || null };
}

async function send(id, text) {
  const request_id = randomUUID();
  const got = await exchange([{ type: 'send_message', session_id: id, prompt: text, delivery_mode: 'immediate', request_id }], {
    keep: (j) => j.request_id === request_id || (j.session_id === id && /message_(sent|queued|delivery)/.test(j.type)) || j.type === 'socket_error',
    done: (j) => /^(session_message_sent|session_message_queued|session_message_delivery_unknown|error|socket_error)$/.test(j.type),
    // An evicted session loads first; closing the socket before the app answers cancels the send (sessions-local.mjs).
    waitMs: 120000,
  });
  const last = got.at(-1);
  return { ok: Boolean(last && /session_message_(sent|queued)/.test(last.type)), reply: last?.type || 'no reply', error: last?.type === 'error' ? String(last.message).slice(0, 200) : null };
}

// ---------- evictions: every re-pin, the balancer's or anyone's, stops the project's warm runtimes ----------
// The app logs each one ("evicted warm session so it re-resolves the project-linked account session_id=… project_id=…"). A runtime evicted while its agent loop was working is told to continue; an
// idle one resumes on its next message. 2026-11-16 15:32Z: a coordinator session re-pinned its own project mid-turn
// and sat stopped until the operator noticed.

const APP_LOGS = path.join(CHOME, 'logs');
const EVICT = 'evicted warm session so it re-resolves the project-linked account';

// Pure. App log text -> [{at, session_id, project_id}].
export function parseEvictions(text) {
  const out = [];
  for (const l of String(text).split('\n')) {
    if (!l.includes(EVICT)) continue;
    const at = (l.match(/^(\d{4}-\d\d-\d\dT[\d:.]+Z)\s/) || [])[1];
    const sid = (l.match(/session_id=([0-9a-f-]{36})/) || [])[1];
    if (at && sid && Number.isFinite(Date.parse(at))) out.push({ at, session_id: sid, project_id: (l.match(/project_id=([0-9a-f-]{36})/) || [])[1] || null });
  }
  return out;
}

// The app's log since the cursor {ino, offset}: the newest github-app.*.log, plus the rest of the file the cursor was in
// when the app rotated it. Without a cursor, the last 8 MB (about the last 15 minutes). Whole lines only.
export function readAppLog(cursor, { dir = APP_LOGS, maxBytes = 16 << 20, firstBytes = 8 << 20 } = {}) {
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^github-app\.\d+(\.\d+)?\.log$/.test(f)).map((f) => { const p = path.join(dir, f); const s = fs.statSync(p); return { p, ino: s.ino, size: s.size, mtime: s.mtimeMs }; });
  } catch { return { text: '', cursor }; }
  if (!files.length) return { text: '', cursor };
  const cur = files.reduce((a, b) => (b.mtime > a.mtime ? b : a));
  const chunk = (f, from) => {
    from = Math.max(0, from, f.size - maxBytes);
    if (from >= f.size) return { text: '', end: f.size };
    let fd;
    try {
      fd = fs.openSync(f.p, 'r');
      const buf = Buffer.alloc(f.size - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      const nl = buf.lastIndexOf(0x0a);
      return nl < 0 ? { text: '', end: from } : { text: buf.subarray(0, nl + 1).toString('utf8'), end: from + nl + 1 };
    } catch { return { text: '', end: from }; } finally { if (fd !== undefined) fs.closeSync(fd); }
  };
  let text = '';
  let from;
  if (!cursor?.ino) from = cur.size - firstBytes;
  else if (cursor.ino === cur.ino) from = cur.size >= cursor.offset ? cursor.offset : 0;
  else { const old = files.find((f) => f.ino === cursor.ino); if (old) text += chunk(old, cursor.offset).text; from = 0; }
  const c = chunk(cur, from);
  return { text: text + c.text, cursor: { ino: cur.ino, offset: c.end } };
}

// Pure. Was the session working when the eviction at `at` stopped it, and has nothing continued it since? lines: its
// events.jsonl. The runtime shuts down (session.shutdown) just before the app logs the eviction, so the loop is judged
// as it stood just before that shutdown.
export function evictedWork(lines, at) {
  const t0 = Date.parse(at);
  let T = t0 - 1;
  for (const l of lines) {
    if (!l || !l.includes('"session.shutdown"')) continue;
    let e; try { e = JSON.parse(l); } catch { continue; }
    const t = Date.parse(e.timestamp);
    if (e.type === 'session.shutdown' && t <= t0 + 1000 && t > t0 - 60000) T = Math.min(T, t - 1);
  }
  const s = stateAt(lines, T);
  return { resume: s.working && s.postUser === 0 && s.postTurn === 0, working: s.working, continued: s.postUser + s.postTurn > 0, why: s.why };
}

// Pure. Has the session started a turn since `at`?
export function tookTurn(lines, at) {
  const t0 = Date.parse(at);
  for (const l of lines) {
    if (!l || !l.includes('"assistant.turn_start"')) continue;
    const m = l.match(/"timestamp":"([^"]+)"/);
    if (m && Date.parse(m[1]) > t0) return true;
  }
  return false;
}

// Pure. Which logged evictions need a resume message: one per session, inside the window, not already messaged since
// (resumed: state.resumed), judged from its history (historyOf: id -> events lines or null).
export function evictionResumes(evictions, historyOf, { now = Date.now(), windowMin = 30, resumed = {} } = {}) {
  const last = new Map();
  for (const ev of evictions) if (now - Date.parse(ev.at) <= windowMin * 60000) last.set(ev.session_id, ev);
  const out = [];
  for (const ev of last.values()) {
    const prior = resumed[ev.session_id];
    if (prior && Date.parse(prior.at) >= Date.parse(ev.at)) continue;
    const lines = historyOf(ev.session_id);
    if (!lines) continue;
    // Any eviction of it in the window that stopped work counts, judged at that eviction (a later idle eviction of a
    // runtime the first one stopped is still a stopped session).
    const all = evictions.filter((e) => e.session_id === ev.session_id && now - Date.parse(e.at) <= windowMin * 60000);
    const hit = all.map((e) => ({ e, w: evictedWork(lines, e.at) })).find((x) => x.w.resume);
    if (hit) out.push({ ...hit.e, why: hit.w.why });
  }
  return out;
}

function liveOf(st, now) {
  const live = {};
  const since = now - 14 * 86400000;
  for (const s of st.sessions) {
    if (Date.parse(s.updated_at || 0) < since && !s.is_running) continue;
    const t = tail(s.id);
    const w = warm(s.id);
    live[s.id] = { warm: w, running: Boolean(s.is_running), working: Boolean(w && t && stateAt(t.lines, now).working), stall: t ? quotaStall(t.lines) : null };
  }
  return live;
}

export async function tick({ apply = false, only = null, cfg = config(), now = Date.now() } = {}) {
  if (!cfg.enabled) return { ok: true, disabled: true };
  const state = readState();
  state.resumed ||= {};
  const st = appState();
  const { readings, own, agents, errors } = await read(st, cfg, state.readings);
  const live = liveOf(st, now);
  const history = (id) => tail(id)?.lines || null;
  // Burn history: one sample per account per 5 minutes, from this Mac's own readings, kept for burn_window_h.
  state.history ||= {};
  for (const [k, r] of Object.entries(readings)) {
    if (r.spent == null || String(r.source).startsWith('cached:')) continue;
    const h = (state.history[k] ||= []);
    if (!h.length || Date.parse(r.at) - Date.parse(h.at(-1).at) >= 5 * 60000) h.push({ at: r.at, spent: r.spent });
    state.history[k] = h.filter((x) => now - Date.parse(x.at) <= cfg.burn_window_h * 3600000);
  }
  const burn = forecast(state.history, readings, { now, windowH: cfg.burn_window_h, agents: agentBurn(agents, { now, windowH: cfg.burn_window_h }) });
  // A refusal (a 402) is remembered until a reading shows requests again or the reset passes.
  state.refused ||= {};
  for (const [k, at] of Object.entries(state.refused)) { const r = readings[k]; if ((r && r.pct > cfg.out_pct && Date.parse(r.at) > Date.parse(at)) || now - Date.parse(at) > 31 * 86400000 || (r?.reset && now > Date.parse(r.reset) && Date.parse(at) < Date.parse(r.reset))) delete state.refused[k]; }
  // The pins this balancer set, so a person's pin is told apart (userPinned); seeded once from the decision log.
  if (!state.pins) { try { state.pins = pinsFromLog(fs.readFileSync(LOG_FILE, 'utf8').split('\n')); } catch { state.pins = {}; } }
  const p = plan(st, readings, live, cfg, { now, refused: state.refused, burn, keeperResumes: false, ownPins: state.pins });
  Object.assign(state.refused, p.refused);
  // --only <project id>: act on one project (a proof or a manual nudge); the plan for the rest is still shown.
  if (only) { p.moves = p.moves.filter((m) => m.project_id === only); p.resumes = p.resumes.filter((r) => r.project_id === only); }
  const done = { moved: [], resumed: [] };
  if (apply) {
    for (const m of p.moves.filter((x) => x.to_id)) {
      const r = await setAccount(m.project_id, m.to_id);
      logLine({ act: 'move', ...m, resume: m.resume.map((s) => s.id), result: r });
      done.moved.push({ project: m.project, from: m.from, to: m.to, why: m.why, ok: r.ok, error: r.error });
      if (!r.ok) continue;
      state.pins[m.project_id] = m.to_id;
      for (const s of m.resume) {
        const why = s.reason === 'quota' && m.why !== 'out' ? 'quota-only' : m.why;
        const x = await send(s.id, resumePrompt(why, m.from, m.to, m.cap));
        const stallId = live[s.id]?.stall?.id || null;
        state.resumed[s.id] = { at: new Date().toISOString(), error_id: stallId, ok: x.ok, tries: 1, why: m.why, verify: x.ok };
        logLine({ act: 'resume', session: s.id, name: s.name, reason: s.reason, result: x });
        done.resumed.push({ id: s.id, name: s.name, reason: s.reason, ok: x.ok, error: x.error });
      }
    }
    for (const r of p.resumes) {
      const prior = state.resumed[r.id];
      if (prior && prior.error_id === r.error_id && (prior.tries >= 2 || now - Date.parse(prior.at) < cfg.resume_retry_ms)) continue;
      const x = await send(r.id, resumePrompt('quota-only', 'the account it was billing then', r.account));
      state.resumed[r.id] = { at: new Date().toISOString(), error_id: r.error_id, ok: x.ok, tries: (prior?.error_id === r.error_id ? prior.tries : 0) + 1, why: 'quota', verify: x.ok };
      logLine({ act: 'resume', session: r.id, name: r.name, reason: 'quota (account already healthy)', account: r.account, result: x });
      done.resumed.push({ id: r.id, name: r.name, reason: 'quota', ok: x.ok, error: x.error });
    }
    // Every re-pin since the last tick, this tick's moves included: resume each session it stopped mid-work.
    const log = readAppLog(state.evict_cursor);
    state.evict_cursor = log.cursor;
    for (const ev of evictionResumes(parseEvictions(log.text), history, { now: Date.now(), windowMin: cfg.resume_window_min, resumed: state.resumed })) {
      const name = st.sessions.find((x) => x.id === ev.session_id)?.name || null;
      const x = await send(ev.session_id, resumePrompt('evicted', ev.at.slice(11, 19) + 'Z'));
      state.resumed[ev.session_id] = { at: new Date().toISOString(), evicted_at: ev.at, ok: x.ok, tries: 1, why: 'evicted', verify: x.ok };
      logLine({ act: 'resume', session: ev.session_id, name, reason: `evicted mid-work by a re-pin at ${ev.at} (${ev.why})`, project_id: ev.project_id, result: x });
      done.resumed.push({ id: ev.session_id, name, reason: 'evicted', ok: x.ok, error: x.error });
    }
    // Verify: a resumed session takes a turn. An evicted one that has not after resume_retry_ms is messaged once more.
    for (const [id, v] of Object.entries(state.resumed)) {
      if (!v.verify) continue;
      const lines = history(id);
      if (lines && tookTurn(lines, v.at)) { v.verify = false; v.verified_at = new Date().toISOString(); logLine({ act: 'resume-verified', session: id, why: v.why, sent_at: v.at }); continue; }
      if (Date.now() - Date.parse(v.at) < cfg.resume_retry_ms) continue;
      if (v.why === 'evicted' && v.tries < 2) {
        const x = await send(id, resumePrompt('evicted', (v.evicted_at || v.at).slice(11, 19) + 'Z'));
        Object.assign(v, { at: new Date().toISOString(), ok: x.ok, tries: v.tries + 1, verify: x.ok });
        logLine({ act: 'resume', session: id, reason: 'evicted: no turn after the first message, sent again', result: x });
        done.resumed.push({ id, name: null, reason: 'evicted (again)', ok: x.ok, error: x.error });
      } else { v.verify = false; v.unverified = true; logLine({ act: 'resume-unverified', session: id, why: v.why, sent_at: v.at, tries: v.tries }); }
    }
    for (const [id, v] of Object.entries(state.resumed)) if (now - Date.parse(v.at) > 7 * 86400000) delete state.resumed[id];
    // A person's pin the balancer keeps: logged once per project and account.
    state.pin_logged ||= {};
    for (const x of p.pins) if (state.pin_logged[x.project_id] !== x.account) { state.pin_logged[x.project_id] = x.account; logLine({ act: 'user-pin', ...x, decision: x.health === 'out' ? 'move: spent' : 'keep' }); }
  } else {
    const log = readAppLog(state.evict_cursor);
    p.evicted = evictionResumes(parseEvictions(log.text), history, { now, windowMin: cfg.resume_window_min, resumed: state.resumed || {} });
  }
  state.readings = readings;
  if (apply && cfg.share?.gist_id && Object.keys(own).length) {
    const sig = JSON.stringify(Object.fromEntries(Object.entries(own).map(([k, v]) => [k, Math.round(v.pct)])));
    // At most one write every 10 minutes when the rounded readings change, and every 30 minutes regardless: gist writes
    // share one 100-an-hour budget per GitHub account with the heartbeats, the KVM's outbox and the agents' peer link.
    const since = now - Date.parse(state.shared_at || 0);
    if ((sig !== state.shared_sig && since >= 10 * 60000) || since > 30 * 60000) {
      try {
        await gistFetch(cfg.share, 'PATCH', { files: { [`${cfg.me}.quota.txt`]: { content: JSON.stringify({ machine: cfg.me, at: new Date(now).toISOString(), readings: own }, null, 1) + '\n' } } });
        state.shared_sig = sig; state.shared_at = new Date(now).toISOString();
      } catch (e) { errors.share_write = e.message; }
    }
  }
  if (apply) {
    try {
      const prev = JSON.parse(fs.readFileSync(WAITING_FILE, 'utf8'));
      const prevAt = new Map((prev.items?.[0]?.items || []).map((i) => [i.sentence.split(' run out in ')[0].split(' is stuck on ')[0], i.since]));
      for (const w of p.waiting) w.since = prevAt.get(w.sentence.split(' run out in ')[0].split(' is stuck on ')[0]) || new Date(now).toISOString();
    } catch { for (const w of p.waiting) w.since = new Date(now).toISOString(); }
    fs.mkdirSync(CFG_DIR, { recursive: true });
    fs.writeFileSync(WAITING_FILE + '.new', JSON.stringify({ updated_at: new Date(now).toISOString(), machine: cfg.me, items: p.waiting.length ? [{ machine: cfg.me, session_id: 'quota-balance', name: 'Copilot quota', since: p.waiting[0].since, items: p.waiting }] : [] }, null, 1));
    fs.renameSync(WAITING_FILE + '.new', WAITING_FILE);
    for (const w of p.waiting) if (!state.alerted?.[w.sentence.slice(0, 80)]) { logLine({ act: 'waiting-on-operator', sentence: w.sentence }); (state.alerted ||= {})[w.sentence.slice(0, 80)] = new Date(now).toISOString(); }
  }
  const out = { ok: true, at: new Date(now).toISOString(), machine: cfg.me, applied: apply, agents: (agents || []).map((a) => ({ name: `${a.machine}.${a.agent}`, at: a.at, accounts: Object.keys(a.readings).concat(Object.keys(a.burn)).filter((k, i, x) => x.indexOf(k) === i) })), accounts: p.accounts, moves: p.moves, resumes: p.resumes, evicted: p.evicted || [], pins: p.pins, notes: p.notes, runway: p.runway, waiting: p.waiting, done, errors };
  state.last = out;
  if (apply) writeState(state);
  return out;
}

// ---------- CLI ----------

function table(out) {
  const lines = [`Copilot accounts on ${out.machine} (${out.at}):`];
  for (const a of out.accounts) lines.push(`  ${a.key.padEnd(34)} ${String(a.health).padEnd(8)} ${a.pct == null ? '   ?' : `${String(a.pct).padStart(5)}%`} left  ${a.burn_per_h == null ? 'burn ?                        ' : `${String(a.burn_per_h).padStart(6)}/h ${fmtH(a.hours_left).padStart(7)}${a.dry_at ? ` dry ${a.dry_at.slice(5, 16).replace('T', ' ')}Z` : '              '}`}  ${String(a.projects).padStart(2)} project(s), ${a.live_sessions} live  [${a.source || 'no reading'}${a.at ? ` ${a.at.slice(11, 16)}Z` : ''}]${a.overage ? ' overage ok' : ''}${a.agents?.length ? ` agents ${a.agents_per_h}/h (${a.agents.join(', ')})` : ''}${a.blocked_at ? ` quota error ${a.blocked_at}` : ''}`);
  for (const g of out.runway || []) lines.push(`  runway ${g.projects} project(s) on {${g.accounts.join(', ')}}: ${g.unlimited?.length ? `unlimited on ${g.unlimited.join(', ')}; ` : ''}tranche ${g.cap}% used; ${g.hours_left == null ? 'burn not known yet' : `${fmtH(g.hours_left)} of included requests at ${g.burn_per_h}/h`}${g.overage_fallback.length ? `, then enterprise overage on ${g.overage_fallback.join(', ')}` : ', NO overage fallback'}${g.reset ? ` (reset ${g.reset.slice(0, 10)})` : ''}`);
  for (const w of out.waiting || []) lines.push(`  WAITING ON THE OPERATOR: ${w.sentence}`);
  for (const m of out.moves) lines.push(`  move ${m.project}: ${m.from} -> ${m.to || '(none)'} (${m.why}${m.why === 'tranche' ? ` ${m.cap}%` : ''}${m.from_hours_left != null ? `, ${fmtH(m.from_hours_left)} left at this burn` : ''}${m.busy ? '; working sessions are messaged to continue' : ''})${m.resume?.length ? `, resume ${m.resume.length}` : ''}${m.stuck ? ` STUCK: ${m.stuck}` : ''}`);
  for (const x of out.pins || []) lines.push(`  keep ${x.project} on ${x.account}: a person pinned it${x.health === 'out' ? ' (spent, so it moves)' : ''}`);
  for (const e of out.evicted || []) lines.push(`  resume ${e.session_id.slice(0, 8)}: a re-pin at ${e.at.slice(11, 19)}Z stopped it mid-work (${e.why})`);
  for (const r of out.resumes) lines.push(`  resume ${r.name} (${r.id.slice(0, 8)}): stopped on quota, ${r.account} is healthy now`);
  for (const n of out.notes) lines.push(`  note: ${n}`);
  for (const [k, e] of Object.entries(out.errors || {})) lines.push(`  (${k}: ${e})`);
  return lines.join('\n');
}

export async function main(argv) {
  const [sub = 'plan', ...rest] = argv;
  const json = rest.includes('--json');
  if (sub === 'status') { console.log(JSON.stringify(readState().last)); return 0; }
  if (sub === 'read') {
    const cfg = config();
    const st = appState();
    const r = await read(st, cfg, readState().readings);
    console.log(json ? JSON.stringify(r) : Object.entries(r.readings).map(([k, v]) => `${k.padEnd(34)} ${String(v.pct).padStart(5)}% left (${v.remaining ?? '?'} of ${v.entitlement ?? '?'}) ${v.source} ${v.at}`).join('\n') + (Object.keys(r.errors).length ? `\n(${JSON.stringify(r.errors)})` : ''));
    return 0;
  }
  if (sub === 'plan' || sub === 'tick') {
    const i = rest.indexOf('--only');
    const out = await tick({ apply: sub === 'tick' && rest.includes('--apply'), only: i >= 0 ? rest[i + 1] : null });
    console.log(json || sub === 'tick' ? JSON.stringify(out) : table(out));
    return 0;
  }
  if (sub === 'listen') { listen({ log: (t) => console.error(t) }); await new Promise(() => {}); }
  throw new Error('usage: quota-balance.mjs read | plan | tick [--apply] [--only <project id>] | status | listen');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try { process.exitCode = await main(process.argv.slice(2)); } catch (e) { console.log(JSON.stringify({ ok: false, error: e.message })); process.exitCode = 1; }
}
