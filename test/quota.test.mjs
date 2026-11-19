// The quota balancer keeps every Copilot app session on an account with premium requests left.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const Q = await import('../src/quota.mjs');
import { tookTurnSince } from '../src/history.mjs';

// Every file the balancer reads or writes goes to a temp folder: nothing here touches the real config, state or app.
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'shepherd-quota-test-'));
Object.assign(process.env, {
  SHEPHERD_QUOTA_CONFIG: path.join(SANDBOX, 'quota.json'),
  SHEPHERD_QUOTA_STATE: path.join(SANDBOX, 'quota-balance.json'),
  SHEPHERD_QUOTA_APP: path.join(SANDBOX, 'quota-app.json'),
  SHEPHERD_QUOTA_WAITING: path.join(SANDBOX, 'waiting-on-operator.quota.json'),
  SHEPHERD_QUOTA_LOG: path.join(SANDBOX, 'shepherd-quota.jsonl'),
});
after(() => fs.rmSync(SANDBOX, { recursive: true, force: true }));
const NOW = Date.parse('2026-11-09T21:40:00Z');
const at = (min) => new Date(NOW - min * 60000).toISOString();
const cfg = { ...Q.DEFAULTS, me: 'test' };

const A = {
  personal: { id: 'p', login: 'user', host: 'github.com', is_default: true, copilot: true },
  managed: { id: 'e', login: 'work-user', host: 'github.com', is_default: false, copilot: true },
  ghe: { id: 'g', login: 'user', host: 'ghe-one.example.com', is_default: false, copilot: true },
  two: { id: 'm', login: 'user', host: 'ghe-two.example.com', is_default: false, copilot: true },
};
const accounts = Object.values(A);
const reading = (pct, extra = {}) => ({ pct, remaining: pct * 10000, entitlement: 1000000, has_quota: pct > 0, source: 'direct', at: at(1), ...extra });

test('billingAccount mirrors the app: pin, else repository account, else default', () => {
  assert.equal(Q.billingAccount({ copilot_account_id: 'g', github_account_id: 'e' }, accounts, true).id, 'g');
  assert.equal(Q.billingAccount({ copilot_account_id: 'g', github_account_id: 'e' }, accounts, false).id, 'e', 'a pin is inert while the setting is off');
  assert.equal(Q.billingAccount({ copilot_account_id: null, github_account_id: null }, accounts, true).id, 'p');
  assert.equal(Q.billingAccount(null, accounts, true).id, 'p');
  assert.equal(Q.billingAccount({ copilot_account_id: 'e' }, [{ ...A.managed, copilot: false }, A.personal], true).id, 'p', 'an account without a seat cannot bill');
});

test('quotaStall finds a 402 that nothing continued (a real event shape)', () => {
  const err = JSON.stringify({ type: 'session.error', data: { errorType: 'quota', message: 'You have exceeded your monthly quota', statusCode: 402, errorCode: 'quota_exceeded' }, id: 'x1', timestamp: at(10) });
  const turn = JSON.stringify({ type: 'assistant.turn_start', data: {}, id: 't', timestamp: at(5) });
  const user = JSON.stringify({ type: 'user.message', data: {}, id: 'u', timestamp: at(20) });
  assert.deepEqual(Q.quotaStall([user, err]), { id: 'x1', at: at(10), code: 'quota_exceeded' });
  assert.equal(Q.quotaStall([user, err, turn]), null, 'continued since');
  assert.equal(Q.quotaStall([user]), null);
});

test('normalize reads both the REST and the app snapshot shapes', () => {
  assert.deepEqual(Q.normalize({ entitlement: 1000000, remaining: 0, percent_remaining: 0, unlimited: false, has_quota: false, overage_permitted: false }).has_quota, false);
  const app = Q.normalize({ entitlementRequests: 1000000, remainingPercentage: 31.9, usedRequests: 681000, isUnlimitedEntitlement: false, overageAllowedWithExhaustedQuota: true, resetDate: '2026-12-01T00:00:00Z' });
  assert.equal(app.pct, 31.9);
  assert.equal(app.remaining, 319000);
  assert.equal(app.has_quota, true);
});

test('merge keeps the freshest reading per account', () => {
  const m = Q.merge({ k: reading(40, { at: at(30), source: 'cached:direct' }) }, { k: reading(39, { at: at(2), source: 'app' }) });
  assert.equal(m.k.pct, 39);
});

test('health: spent, low, unknown, and a newer quota error beats an older reading', () => {
  assert.equal(Q.health(A.managed, reading(0), cfg), 'out');
  assert.equal(Q.health(A.managed, reading(3), cfg), 'low');
  assert.equal(Q.health(A.managed, null, cfg), 'unknown');
  assert.equal(Q.health(A.managed, reading(30, { at: at(30) }), cfg, { blockedAt: at(10), now: NOW }), 'out');
  assert.equal(Q.health(A.managed, reading(30, { at: at(1) }), cfg, { blockedAt: at(10), now: NOW }), 'ok', 'a fresh reading after the error clears it');
  assert.equal(Q.health(A.managed, reading(30), { ...cfg, exclude: ['work-user@github.com'] }), 'excluded');
});

const st = (projects, sessions = []) => ({ accounts, separate: true, projects, sessions });
const proj = (id, pin, extra = {}) => ({ id, name: id, github_owner: 'o', github_repo: id, github_account_id: 'e', copilot_account_id: pin, ...extra });
const readings = { 'user@github.com': reading(44), 'work-user@github.com': reading(0), 'user@ghe-one.example.com': reading(31), 'user@ghe-two.example.com': reading(99) };

test('a project on a spent account moves to the account with the most left, and every stopped or live session is resumed', () => {
  const s = st([proj('app', 'e')], [{ id: 's1', project_id: 'app', name: 'Meeting evidence' }, { id: 's2', project_id: 'app', name: 'idle' }]);
  const live = { s1: { warm: true, running: false, stall: { id: 'x', at: at(5) } }, s2: { warm: false, running: false, stall: null } };
  const p = Q.plan(s, readings, live, cfg, { now: NOW });
  assert.equal(p.moves.length, 1);
  assert.equal(p.moves[0].to, 'user@ghe-two.example.com');
  assert.equal(p.moves[0].why, 'out');
  assert.deepEqual(p.moves[0].resume.map((r) => [r.id, r.reason]), [['s1', 'quota']]);
});

test('a session stopped on quota in a project that is already on a healthy account is just resumed', () => {
  const s = st([proj('app', 'm')], [{ id: 's1', project_id: 'app', name: 'Meeting evidence' }]);
  const p = Q.plan(s, { ...readings, 'user@ghe-two.example.com': reading(99) }, { s1: { warm: false, stall: { id: 'x', at: at(5) } } }, cfg, { now: NOW });
  assert.equal(p.moves.length, 0);
  assert.deepEqual(p.resumes.map((r) => r.id), ['s1']);
});

test('a quota error marks the account spent even when its last reading looked fine', () => {
  const s = st([proj('a', 'g')], [{ id: 's1', project_id: 'a', name: 'x' }]);
  const p = Q.plan(s, { ...readings, 'user@ghe-one.example.com': reading(31, { at: at(30) }) }, { s1: { warm: true, stall: { id: 'x', at: at(2) } } }, cfg, { now: NOW });
  assert.equal(p.moves[0]?.why, 'out');
});

test('tranche moves wait for a quiet moment; balancing never evicts a working runtime', () => {
  const low = { ...readings, 'user@ghe-one.example.com': reading(3) };
  const s = st([proj('a', 'g')], [{ id: 's1', project_id: 'a', name: 'x' }]);
  assert.equal(Q.plan(s, low, { s1: { warm: true, running: true } }, cfg, { now: NOW }).moves.length, 0);
  assert.equal(Q.plan(s, low, { s1: { warm: true, running: false } }, cfg, { now: NOW }).moves[0].why, 'tranche');
  assert.equal(Q.plan(s, { ...readings, 'user@ghe-one.example.com': reading(0.6) }, { s1: { warm: true, running: true } }, cfg, { now: NOW }).moves.length, 0, 'not even at under 1% left: it moves when quiet, or when the 402 has stopped it');
  assert.equal(Q.plan(s, readings, { s1: { warm: true, working: true } }, cfg, { now: NOW }).moves.length, 0, 'working (a detector shell, a turn): no move');
  assert.equal(Q.plan(s, readings, { s1: { warm: true, running: false } }, cfg, { now: NOW }).moves[0].why, 'tranche', 'warm but idle is quiet: the move stops nothing');
  assert.equal(Q.plan(s, readings, { s1: { warm: false, running: false } }, cfg, { now: NOW }).moves[0].why, 'tranche');
});

test('repo_rules limit which accounts may bill a repository; unknown accounts are never targets', () => {
  const rules = { ...cfg, repo_rules: [{ repo: 'work-org/*', accounts: ['work-user@github.com', '*@ghe-one.example.com'] }] };
  const s = st([proj('workspace', 'e', { github_owner: 'work-org', github_repo: 'workspace' })], []);
  assert.equal(Q.plan(s, readings, {}, rules, { now: NOW }).moves[0].to, 'user@ghe-one.example.com');
  const noTwo = { ...readings }; delete noTwo['user@ghe-two.example.com'];
  assert.equal(Q.plan(st([proj('t', 'e')]), noTwo, {}, cfg, { now: NOW }).moves[0].to, 'user@github.com');
});

test('when every account with a reading is spent, a seated account with no reading is tried rather than stopping', () => {
  const spent = { 'user@github.com': reading(0), 'work-user@github.com': reading(0), 'user@ghe-one.example.com': reading(0.2) };
  const p = Q.plan(st([proj('t', 'e')]), spent, {}, cfg, { now: NOW });
  assert.equal(p.moves[0].to, 'user@ghe-two.example.com');
  assert.equal(Q.plan(st([proj('t', 'g')]), { ...spent, 'user@ghe-one.example.com': reading(40) }, {}, cfg, { now: NOW }).moves.length, 0, 'never a lean move onto an unknown account');
});

const MS = ['work-org/*', 'another-work-org/*', 'home-project'];
const scoped = { ...cfg, repo_rules: [{ repo: MS, accounts: ['work-user@github.com', '*@ghe-one.example.com', '*@ghe-two.example.com'] }], account_rules: [{ account: 'work-user@github.com', repos: MS }] };

test('scope: the managed account bills only a work organization repositories, and a work organization repositories never bill the personal account', () => {
  const personal = proj('app-ui', 'g', { github_owner: 'me', github_repo: 'app-ui' });
  const work = proj('home-project', 'g', { github_owner: null, github_repo: null });
  assert.equal(Q.allowed(personal, A.managed, scoped), false, 'managed never bills a personal repository');
  assert.equal(Q.allowed(personal, A.personal, scoped), true);
  assert.equal(Q.allowed(personal, A.ghe, scoped), true, 'a person pinned personal repositories to GHE by hand');
  assert.equal(Q.allowed(work, A.personal, scoped), false, 'a project with no repository matches by name');
  assert.equal(Q.allowed(work, A.managed, scoped), true);
  const spentGhe = { ...readings, 'user@ghe-one.example.com': reading(0), 'user@ghe-two.example.com': reading(0), 'work-user@github.com': reading(60) };
  assert.equal(Q.plan(st([personal]), spentGhe, {}, scoped, { now: NOW }).moves[0].to, 'user@github.com', 'never managed, even with the most left');
  assert.equal(Q.plan(st([work]), { ...spentGhe, 'work-user@github.com': reading(0) }, {}, scoped, { now: NOW }).moves[0].stuck, 'no allowed account has requests left or enterprise overage', 'stuck rather than the personal account');
});

test('scope: a project billing a forbidden account moves once no turn is running; only the billing account changes', () => {
  const s = st([proj('app-ui', 'e', { github_owner: 'me', github_repo: 'app-ui', github_account_id: 'p' })], [{ id: 's1', project_id: 'app-ui', name: 'x' }]);
  const ok = { ...readings, 'work-user@github.com': reading(50) };
  assert.equal(Q.plan(s, ok, { s1: { warm: true, running: true } }, scoped, { now: NOW }).moves.length, 0);
  const m = Q.plan(s, ok, { s1: { warm: true, running: false } }, scoped, { now: NOW }).moves[0];
  assert.equal(m.why, 'scope');
  assert.equal(m.to, 'user@ghe-two.example.com', 'the allowed account with the most left');
  assert.deepEqual(m.resume, [], 'an idle session resumes on its next message; it is not prodded');
  assert.equal(Object.keys(m).some((k) => /github_account/.test(k)), false);
});

test('a move messages only sessions stopped on quota or evicted mid-turn', () => {
  const s = st([proj('t', 'e')], [{ id: 'a', project_id: 't', name: 'stalled' }, { id: 'b', project_id: 't', name: 'running' }, { id: 'c', project_id: 't', name: 'idle warm' }, { id: 'd', project_id: 't', name: 'old stall' }]);
  const live = { a: { warm: true, stall: { id: 'x', at: at(3) } }, b: { warm: true, running: true }, c: { warm: true }, d: { warm: false, stall: { id: 'y', at: at(60 * 24) } } };
  assert.deepEqual(Q.plan(s, readings, live, cfg, { now: NOW }).moves[0].resume.map((r) => [r.id, r.reason]), [['a', 'quota'], ['b', 'evicted mid-turn']]);
});

test('the listener file supplies readings for accounts gh has no token for', async () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
  assert.equal(Q.appFileReadings(path.join(dir, 'quota-app.json'))['user@ghe-two.example.com'].pct, 77);
  assert.deepEqual(Q.appFileReadings(path.join(dir, 'no-such-quota-app.json')), {});
});

const ov = (pct, extra = {}) => reading(pct, { overage_permitted: true, ...extra });

test('enterprise overage: a spent account whose enterprise allows overage is a last resort, not a dead end', () => {
  assert.equal(Q.health(A.ghe, ov(0), cfg), 'overage');
  assert.equal(Q.health(A.managed, reading(0, { overage_permitted: false }), cfg), 'out');
  const all = { 'user@github.com': reading(0), 'work-user@github.com': reading(0), 'user@ghe-one.example.com': ov(0), 'user@ghe-two.example.com': ov(0) };
  const work = proj('home-project', 'e', { github_owner: null, github_repo: null });
  const m = Q.plan(st([work]), all, {}, scoped, { now: NOW }).moves[0];
  assert.equal(m.why, 'out');
  assert.match(m.to, /^user@ghe-(one|two)\.example\.com$/, 'managed spent with no overage -> a GHE account on enterprise overage, not stuck');
  const p = Q.plan(st([proj('home-project', 'g', { github_owner: null, github_repo: null })]), all, {}, scoped, { now: NOW });
  assert.equal(p.moves.length, 0, 'already on overage with nothing better: stays');
});

test('a project on overage moves back to included requests once no turn is running', () => {
  const r = { ...readings, 'user@ghe-one.example.com': ov(0), 'user@ghe-two.example.com': reading(80) };
  const s = st([proj('t', 'g')], [{ id: 's1', project_id: 't', name: 'x' }]);
  assert.equal(Q.plan(s, r, { s1: { warm: true, running: true } }, cfg, { now: NOW }).moves.length, 0);
  assert.equal(Q.plan(s, r, { s1: { warm: true, running: false } }, cfg, { now: NOW }).moves[0].why, 'included');
});

test('a 402 on an overage account is remembered as refused; with nothing left the project is stuck and a person is asked', () => {
  const all = { 'user@github.com': reading(0), 'work-user@github.com': reading(0), 'user@ghe-one.example.com': ov(0), 'user@ghe-two.example.com': ov(0, { at: at(30) }) };
  const work = proj('home-project', 'm', { github_owner: null, github_repo: null });
  const s = st([work], [{ id: 's1', project_id: 'home-project', name: 'x' }]);
  const p = Q.plan(s, all, { s1: { warm: true, stall: { id: 'x', at: at(2) } } }, scoped, { now: NOW, refused: { 'user@ghe-one.example.com': at(60) } });
  assert.equal(p.moves[0].stuck, 'no allowed account has requests left or enterprise overage');
  assert.deepEqual(Object.keys(p.refused).sort(), ['user@ghe-one.example.com', 'user@ghe-two.example.com']);
  assert.equal(p.waiting.length >= 1, true);
  assert.match(p.waiting.at(-1).sentence, /home-project is stuck/);
});

test('burn rate: requests an hour over the window, restarting after a reset; too little history gives none', () => {
  const h = [{ at: at(120), spent: 600000 }, { at: at(60), spent: 610000 }, { at: at(0), spent: 620000 }];
  assert.equal(Q.burnRate(h, { now: NOW }), 10000);
  assert.equal(Q.burnRate([...h, { at: at(-10), spent: 5 }], { now: NOW + 10 * 60000 }), null, 'counter reset: start again');
  assert.equal(Q.burnRate([{ at: at(5), spent: 1 }, { at: at(0), spent: 2 }], { now: NOW }), null, 'under 20 minutes');
  const f = Q.forecast({ k: h }, { k: { remaining: 300000, reset: '2026-12-01T00:00:00Z' } }, { now: NOW });
  assert.equal(f.k.per_h, 10000);
  assert.equal(f.k.hours_left, 30);
});

test('forecast: a person is told well before a group with no overage fallback runs dry, not at the moment it does', () => {
  const r = { 'user@github.com': reading(44), 'work-user@github.com': reading(5, { overage_permitted: false, remaining: 50000, reset: '2026-12-01T00:00:00Z' }), 'user@ghe-one.example.com': reading(0, { overage_permitted: false }), 'user@ghe-two.example.com': reading(0, { overage_permitted: false }) };
  const burn = { 'work-user@github.com': { per_h: 1000, hours_left: 50 } };
  const work = proj('home-project', 'e', { github_owner: null, github_repo: null });
  const p = Q.plan(st([work]), r, {}, scoped, { now: NOW, burn });
  const g = p.runway.find((x) => x.accounts.includes('work-user@github.com'));
  assert.equal(Math.round(g.hours_left), 50);
  assert.match(g.alert, /run out in about 2 days .*1000 an hour.*none of .* allows enterprise overage/);
  assert.equal(p.waiting[0].kind, 'money');
  const withOverage = { ...r, 'user@ghe-two.example.com': ov(0) };
  assert.equal(Q.plan(st([work]), withOverage, {}, scoped, { now: NOW, burn }).waiting.length, 0, 'enterprise overage behind it: no ask');
  assert.equal(Q.plan(st([work]), r, {}, scoped, { now: NOW, burn: { 'work-user@github.com': { per_h: 100 } } }).waiting.length, 0, '500 h away: not yet');
});

test('projects with idle warm runtimes on a 29%-left account move at a quiet moment, before a person has to', () => {
  const r = { ...readings, 'user@ghe-one.example.com': reading(28.7), 'user@ghe-two.example.com': reading(98.7) };
  const s = st([proj('ws', 'g'), proj('desk', 'g')], [{ id: 'a', project_id: 'ws', name: 'workspace' }, { id: 'b', project_id: 'desk', name: 'disk' }]);
  const p = Q.plan(s, r, { a: { warm: true }, b: { warm: true, working: true } }, cfg, { now: NOW });
  assert.deepEqual(p.moves.map((m) => [m.project, m.to, m.why, m.cap]), [['ws', 'user@ghe-two.example.com', 'tranche', 30]], 'the working project waits for its quiet moment');
});

test('spent under a working session: it moves at once (the 402 already stopped it) and the keeper resumes it', () => {
  const r = { 'user@ghe-one.example.com': reading(0), 'user@ghe-two.example.com': reading(70) };
  const s = st([proj('ws', 'g')], [{ id: 'a', project_id: 'ws', name: 'workspace' }]);
  const out = Q.plan(s, r, { a: { warm: true, working: true } }, cfg, { now: NOW, keeperResumes: true });
  assert.equal(out.moves[0].why, 'out');
  assert.equal(out.moves[0].to, 'user@ghe-two.example.com');
  assert.deepEqual(out.moves[0].resume, [], 'the keeper resumes the evicted working session, not the balancer');
});

test('remote steering: a project billed from another host than its repository is reported', () => {
  const s = st([proj('app', 'm')], [{ id: 'a', project_id: 'app', name: 'x' }]);
  assert.match(Q.plan(s, readings, {}, cfg, { now: NOW }).notes.join(' '), /remote steering is off for app/);
  const even = { 'work-user@github.com': reading(60), 'user@ghe-two.example.com': reading(60) };
  assert.doesNotMatch(Q.plan(st([proj('app', 'e')]), even, {}, cfg, { now: NOW }).notes.join(' '), /remote steering/, 'same host: nothing to report');
});

// ---------- tranches ----------

const K = { p: 'user@github.com', e: 'work-user@github.com', g: 'user@ghe-one.example.com', m: 'user@ghe-two.example.com' };
const used = (u, extra) => reading(100 - u, extra);
const ORDER = [K.p, K.e, K.g, K.m];

test('usedPct: spent is 100, unlimited 0, no reading null', () => {
  assert.equal(Q.usedPct(reading(70)), 30);
  assert.equal(Q.usedPct(reading(0)), 100);
  assert.equal(Q.usedPct({ pct: 40, has_quota: false }), 100);
  assert.equal(Q.usedPct({ pct: 0, unlimited: true }), 0);
  assert.equal(Q.usedPct(null), null);
});

test('trancheCap: the lowest of 30/60/90/100 some eligible account is still below; it rises only when all reach it', () => {
  const r = { [K.p]: used(55.5), [K.e]: used(100), [K.g]: used(71.3), [K.m]: used(4.6) };
  assert.equal(Q.trancheCap(r, ORDER), 30, 'the readings: ghe-two.example.com is the one under 30');
  assert.equal(Q.trancheCap({ ...r, [K.m]: used(30) }, ORDER), 60, 'every account at 30 or more: 60');
  assert.equal(Q.trancheCap({ ...r, [K.m]: used(29.9) }, ORDER), 30, 'one still under 30: the cap holds');
  assert.equal(Q.trancheCap({ [K.p]: used(60), [K.g]: used(95) }, [K.p, K.g]), 90);
  assert.equal(Q.trancheCap({ [K.p]: used(100), [K.g]: used(100) }, [K.p, K.g]), 100, 'all spent: 100, and pickByTranche finds none');
  assert.equal(Q.trancheCap({ ...r, [K.m]: undefined }, [K.p, K.g, K.m]), 60, 'an account with no reading has no say');
  assert.equal(Q.trancheCap(r, [K.g]), 90, 'only the accounts the project may bill count');
});

test('pickByTranche: stay below the cap; at the cap the next account in order that is below it; null only when all are spent', () => {
  const r = { [K.p]: used(10), [K.e]: used(100), [K.g]: used(20), [K.m]: used(30) };
  assert.equal(Q.pickByTranche(K.g, r, ORDER, ORDER, 30), K.g, 'below the cap: stays, even though another has more left');
  assert.equal(Q.pickByTranche(K.m, r, ORDER, ORDER, 30), K.p, 'at the cap: the first in order still below it');
  assert.equal(Q.pickByTranche(K.m, r, [K.g, K.m], ORDER, 30), K.g, 'only eligible accounts');
  assert.equal(Q.pickByTranche(K.m, { ...r, [K.p]: used(30), [K.g]: used(30) }, ORDER, ORDER, 60), K.m, 'the cap rose: stays');
  assert.equal(Q.pickByTranche(K.m, { [K.m]: used(100), [K.g]: used(100) }, [K.g, K.m], ORDER, 100), null, 'overage only after 100');
  assert.equal(Q.pickByTranche(K.m, { [K.m]: used(99.5), [K.g]: used(100) }, [K.g, K.m], ORDER, 100), K.m, 'the final 10%: squeezed out of each');
});

test('plan by tranche: fill one account to the cap, then the next; the cap rises only when all are at it', () => {
  const s = (pin) => st([proj('desk', pin)], [{ id: 's1', project_id: 'desk', name: 'x' }]);
  const quiet = { s1: { warm: true } };
  const base = { [K.p]: used(55.5), [K.e]: used(100), [K.g]: used(71.3), [K.m]: used(4.6) };
  assert.equal(Q.plan(s('m'), base, quiet, cfg, { now: NOW }).moves.length, 0, 'everything on ghe-two.example.com, under 30, stays');
  assert.equal(Q.plan(s('m'), { ...base, [K.m]: used(31) }, quiet, cfg, { now: NOW }).moves.length, 0, 'two at 31, every account at 30+: cap 60, stays');
  const at60 = Q.plan(s('m'), { ...base, [K.m]: used(60) }, quiet, cfg, { now: NOW }).moves[0];
  assert.deepEqual([at60.to, at60.why, at60.cap], [K.p, 'tranche', 60], 'two at 60: the personal account (55.5) is first in order below 60');
  const busy = Q.plan(s('m'), { ...base, [K.m]: used(60) }, { s1: { warm: true, working: true } }, cfg, { now: NOW });
  assert.equal(busy.moves.length, 0, 'a working session is never moved; it moves once quiet');
  assert.equal(Q.plan(s('g'), base, quiet, cfg, { now: NOW }).moves[0].to, K.m, 'a project left on a 71%-used account goes to the one under the cap');
});

test('plan by tranche: overage only after every allowed account is at 100', () => {
  const work = proj('home-project', 'g', { github_owner: null, github_repo: null });
  const s = st([work], [{ id: 's1', project_id: 'home-project', name: 'x' }]);
  const r = { [K.p]: used(10), [K.e]: used(100), [K.g]: used(100, { overage_permitted: true }), [K.m]: used(95, { overage_permitted: true }) };
  const m = Q.plan(s, r, { s1: { warm: true } }, scoped, { now: NOW }).moves[0];
  assert.deepEqual([m.to, m.why], [K.m, 'included'], 'two has its last 5% left: used before overage, never the personal account');
  assert.equal(Q.plan(s, { ...r, [K.m]: used(100, { overage_permitted: true }) }, { s1: { warm: true } }, scoped, { now: NOW }).moves.length, 0, 'all at 100: stays on enterprise overage');
});

test('the tranche order is the app account list, not a configured one', () => {
  const s = st([proj('desk', 'm')], [{ id: 's1', project_id: 'desk', name: 'x' }]);
  const r = { [K.p]: used(20), [K.e]: used(20), [K.g]: used(20), [K.m]: used(30) };
  assert.equal(Q.plan(s, r, {}, cfg, { now: NOW }).moves[0].to, K.p, 'first in the app list');
  const reordered = { ...s, accounts: [A.ghe, A.two, A.personal, A.managed] };
  assert.equal(Q.plan(reordered, r, {}, cfg, { now: NOW }).moves[0].to, K.g, 'whatever order the app lists');
  assert.equal(Q.plan({ ...s, accounts: [A.personal, A.two] }, r, {}, cfg, { now: NOW }).moves[0].to, K.p, 'an account signed out of the app is gone from the pool');
  assert.equal(Q.plan({ ...s, accounts: [A.two] }, r, {}, cfg, { now: NOW }).moves.length, 0, 'one account: nowhere to go but on');
});

test('runway groups show the current tranche', () => {
  const p = Q.plan(st([proj('desk', 'm')]), { [K.p]: used(55.5), [K.e]: used(100), [K.g]: used(71.3), [K.m]: used(4.6) }, {}, cfg, { now: NOW });
  assert.equal(p.runway[0].cap, 30);
});

// ---------- agent burn ----------

test('parseAgentQuota reads <machine>.<agent>.quota.txt and ignores machine files', () => {
  const body = JSON.stringify({ machine: 'machine-b', agent: 'agent-a', at: at(2), readings: [{ key: K.m, leftPct: 60, burnPerH: 1200, dryAt: null, overageOk: true, at: at(2) }, { key: 'not a key', leftPct: 1 }] });
  const a = Q.parseAgentQuota('machine-b.agent-a.quota.txt', body);
  assert.equal(a.agent, 'agent-a');
  assert.equal(a.machine, 'machine-b');
  assert.equal(a.readings[K.m].pct, 60);
  assert.equal(a.readings[K.m].overage_permitted, true);
  assert.equal(a.readings[K.m].source, 'agent:machine-b.agent-a');
  assert.deepEqual(a.burn, { [K.m]: 1200 });
  assert.equal(Q.parseAgentQuota('machine-b.quota.txt', body), null, 'a machine file is not an agent file');
  assert.equal(Q.parseAgentQuota('machine-b.agent-a.quota.txt', '{half'), null);
});

test('agent burn counts in the forecast as a floor: never added on top of the account counter that already includes it', () => {
  const h = [{ at: at(120), spent: 600000 }, { at: at(0), spent: 620000 }];
  const agents = Q.agentBurn([{ machine: 'machine-b', agent: 'agent-a', at: at(2), burn: { k: 3000, j: 500 } }, { machine: 'machine-c', agent: 'agent-b', at: at(60 * 24), burn: { k: 99999 } }], { now: NOW });
  assert.deepEqual(agents.k, { per_h: 3000, agents: ['machine-b.agent-a'] }, 'a day-old agent file is ignored');
  const f = Q.forecast({ k: h }, { k: { remaining: 300000 }, j: { remaining: 1000 } }, { now: NOW, agents });
  assert.equal(f.k.per_h, 10000, 'this Mac sees 10000/h, which already includes the agent');
  assert.equal(f.k.agents_per_h, 3000);
  assert.equal(f.j.per_h, 500, 'no history of its own: the agent burn is the forecast');
  assert.equal(f.j.hours_left, 2);
  const g = Q.forecast({ k: h }, { k: { remaining: 300000 } }, { now: NOW, agents: { k: { per_h: 15000, agents: ['machine-b.agent-a'] } } });
  assert.equal(g.k.per_h, 15000, 'agents report more than this Mac saw: theirs');
});

test('a removed agent file stops counting at the next tick; agent readings are never cached', () => {
  const probe = { pct: 28.7, remaining: null, entitlement: null, has_quota: true, source: 'agent:machine-b.probe', at: at(1) };
  const macB = reading(28.7, { source: 'fleet:machine-b/direct', at: at(13) });
  const prev = { [K.g]: { ...probe, source: 'cached:agent:machine-b.probe' } };
  const r = Q.combine(prev, { [K.g]: macB }, {}, {}, { now: NOW });
  assert.equal(r[K.g].source, 'fleet:machine-b/direct', 'the probe is gone from the gist: its cached reading is dropped, even though it is newer');
  assert.equal(Q.combine({ [K.g]: probe }, {}, {}, {}, { now: NOW })[K.g], undefined, 'a cached agent reading never carries over on its own');
  assert.equal(Q.combine({}, { [K.g]: { ...probe, at: at(7 * 60) } }, {}, {}, { now: NOW, staleH: 6 })[K.g], undefined, 'an agent reading over stale_h old has expired');
  const live = Q.combine({ [K.g]: { ...macB, source: 'direct' } }, { [K.g]: probe }, {}, {}, { now: NOW });
  assert.equal(live[K.g].source, 'agent:machine-b.probe', 'while the file is there and fresh, it counts');
  assert.equal(live[K.g].remaining, 287000, 'a percent-only agent reading takes the entitlement from another reading of the account');
  const next = Q.combine(live, { [K.g]: macB }, {}, {}, { now: NOW });
  assert.equal(next[K.g].source, 'fleet:machine-b/direct', 'and the tick after the file goes, it is gone');
});

test('a reading with no remaining count never forecasts "dry now"', () => {
  const h = [{ at: at(120), spent: 600000 }, { at: at(0), spent: 620000 }];
  const f = Q.forecast({ k: h }, { k: { pct: 28.7, remaining: null } }, { now: NOW, agents: { k: { per_h: 5000, agents: ['machine-b.x'] } } });
  assert.equal(f.k.hours_left, null);
  const p = Q.plan(st([proj('desk', 'g')]), { ...readings, [K.g]: { ...reading(28.7), remaining: null } }, {}, cfg, { now: NOW, burn: f.k ? { [K.g]: f.k } : {} });
  assert.equal(p.accounts.find((a) => a.key === K.g).dry_at, null);
});

// ---------- unlimited, a person's pins, and evictions ----------

const unl = (extra) => reading(100, { unlimited: true, ...extra });
// An example rule set: the personal account may bill the work organization's repositories too.
const live16 = { ...cfg, repo_rules: [{ repo: MS, accounts: ['work-user@github.com', 'user@github.com', '*@ghe-one.example.com', '*@ghe-two.example.com'] }], account_rules: [{ account: 'work-user@github.com', repos: MS }] };

test('prefer unlimited: a project bills the unlimited account its rules allow; the tranches cover only the limited ones', () => {
  const r = { ...readings, 'user@github.com': unl() };
  const s = st([proj('a', 'g'), proj('b', 'p')], [{ id: 's1', project_id: 'a', name: 'x' }]);
  const p = Q.plan(s, r, { s1: { warm: true } }, cfg, { now: NOW });
  assert.deepEqual(p.moves.map((m) => [m.project, m.to, m.why]), [['a', 'user@github.com', 'unlimited']], 'b already bills it and stays');
  assert.equal(Q.plan(s, r, { s1: { warm: true, working: true } }, cfg, { now: NOW }).moves.length, 0, 'never under a working session');
  const off = { ...cfg, prefer_unlimited: false };
  assert.deepEqual(Q.plan(s, r, {}, off, { now: NOW }).moves.map((m) => [m.project, m.to, m.why]), [['a', 'user@ghe-two.example.com', 'tranche'], ['b', 'user@ghe-two.example.com', 'tranche']], 'off: the limited accounts fill first');
  const spent = { 'user@github.com': unl(), 'work-user@github.com': reading(0), 'user@ghe-one.example.com': reading(0), 'user@ghe-two.example.com': reading(0) };
  assert.equal(Q.plan(st([proj('a', 'g')]), spent, {}, off, { now: NOW }).moves[0].to, 'user@github.com', 'off: then the unlimited one');
  assert.equal(Q.plan(s, r, {}, cfg, { now: NOW }).runway.find((g) => g.accounts.includes('user@github.com')).cap, 30, 'the unlimited account does not hold the cap down');
});

test('a person\'s pin is kept: no scope, tranche or unlimited move takes it, until its account is spent', () => {
  const r = { ...readings, 'user@github.com': unl() };
  const pinned = proj('a', 'g', { copilot_account_source: 'user' });
  assert.equal(Q.userPinned(pinned, true, {}), true);
  assert.equal(Q.userPinned(pinned, true, { a: 'g' }), false, 'the balancer set this pin itself');
  const p = Q.plan(st([pinned]), r, {}, cfg, { now: NOW });
  assert.equal(p.moves.length, 0);
  assert.deepEqual(p.pins.map((x) => [x.project, x.account]), [['a', 'user@ghe-one.example.com']]);
  assert.equal(Q.plan(st([pinned]), r, {}, cfg, { now: NOW, ownPins: { a: 'g' } }).moves[0].why, 'unlimited', 'a pin the balancer set moves as before');
  const managed = proj('app-ui', 'e', { github_owner: 'me', github_repo: 'app-ui', copilot_account_source: 'user' });
  assert.equal(Q.plan(st([managed]), { ...r, 'work-user@github.com': reading(50) }, {}, scoped, { now: NOW }).moves.length, 0, 'not even out of scope');
});

test('a person\'s pin on a spent account still moves', () => {
  const pinned = proj('a', 'e', { copilot_account_source: 'user' });
  const m = Q.plan(st([pinned], [{ id: 's1', project_id: 'a', name: 'x' }]), { ...readings, 'user@github.com': unl() }, { s1: { warm: true, stall: { id: 'x', at: at(2) } } }, cfg, { now: NOW }).moves[0];
  assert.equal(m.why, 'out');
  assert.equal(m.to, 'user@github.com');
  assert.deepEqual(m.resume.map((x) => x.reason), ['quota']);
});

test('a person\'s pins on user@github.com are not moved back by scope, under the old rule or the new one', () => {
  const r = { 'user@github.com': unl(), 'work-user@github.com': reading(0), 'user@ghe-one.example.com': reading(24.8), 'user@ghe-two.example.com': reading(0) };
  const ws = proj('workspace shared workspace', 'p', { github_owner: 'work-org', github_repo: 'workspace', copilot_account_source: 'user' });
  const before = { ...scoped, repo_rules: [{ repo: MS, accounts: ['work-user@github.com', '*@ghe-one.example.com', '*@ghe-two.example.com'] }] };
  assert.equal(Q.plan(st([ws]), r, {}, before, { now: NOW }).moves.length, 0, 'the 07:25 scope move');
  assert.equal(Q.plan(st([ws]), r, {}, live16, { now: NOW }).moves.length, 0);
  const pages = proj('work-org/workspace-pages', 'g', { github_owner: 'work-org', github_repo: 'workspace-pages' });
  assert.equal(Q.allowed(pages, A.personal, live16), true,   'the example config lets user@github.com bill a work organization repositories');  assert.deepEqual(Q.plan(st([pages]), r, {}, live16, { now: NOW }).moves.map((m) => [m.to, m.why]), [['user@github.com', 'unlimited']]);
  assert.deepEqual(Q.pinsFromLog([
    JSON.stringify({ act: 'move', project_id: 'ws', to_id: 'g', result: { ok: true } }),
    JSON.stringify({ act: 'move', project_id: 'ws', to_id: 'p', result: { ok: false } }),
    JSON.stringify({ act: 'resume', session: 's' }),
  ]), { ws: 'g' },   'only successful moves; a re-pin by a person after it reads as theirs');});

// Events shaped like a coordinator session at the 15:32:02Z re-pin of its own project, and at the 15:23:57Z one, idle.
const ev = (type, iso, data = {}) => JSON.stringify({ type, data, id: `${type}-${iso}`, timestamp: iso });
const midTurn = [
  ev('user.message', '2026-11-16T15:26:04.447Z'), ev('assistant.turn_start', '2026-11-16T15:26:04.720Z'),
  ev('assistant.message', '2026-11-16T15:31:58.000Z', { toolRequests: [{ name: 'bash' }] }), ev('tool.execution_start', '2026-11-16T15:31:58.100Z', { toolCallId: 't1', toolName: 'bash', arguments: {} }),
  ev('session.shutdown', '2026-11-16T15:32:00.900Z'),
];
const idle = [
  ev('user.message', '2026-11-16T15:02:39.618Z'), ev('assistant.turn_start', '2026-11-16T15:02:39.625Z'),
  ev('assistant.message', '2026-11-16T15:02:40.944Z'), ev('assistant.turn_end', '2026-11-16T15:02:40.945Z'),
  ev('session.shutdown', '2026-11-16T15:23:57.678Z'),
];
const LOGLINE = (iso, sid) => `${iso}  INFO task_spawn{task="websocket_server"}:task_spawn{task="ws_handle_client_message" kind="set_project_copilot_account"}: github_app::session::manager::cli_pool: evicted warm session so it re-resolves the project-linked account session_id=${sid} project_id=00000001-0000-4000-8000-000000000001`;
const SID = '00000002-0000-4000-8000-000000000002';

test('evictions: a session a re-pin stopped mid-work is resumed; an idle one, or one that continued, is not', () => {
  const evs = Q.parseEvictions([LOGLINE('2026-11-16T15:32:02.603023Z', SID), 'noise', LOGLINE('2026-11-16T15:24:00.602670Z', '00000003-0000-4000-8000-000000000003')].join('\n'));
  assert.deepEqual(evs[0], { at: '2026-11-16T15:32:02.603023Z', session_id: SID, project_id: '00000001-0000-4000-8000-000000000001' });
  assert.equal(Q.evictedWork(midTurn, evs[0].at).resume, true);
  assert.equal(Q.evictedWork(idle, '2026-11-16T15:24:00.602670Z').resume, false, 'its turn had ended: it resumes on its next message');
  assert.equal(Q.evictedWork([...midTurn, ev('user.message', '2026-11-16T15:35:00.000Z')], evs[0].at).resume, false, 'someone already messaged it');
  const now = Date.parse('2026-11-16T15:33:00Z');
  const hist = { [SID]: midTurn, '00000003-0000-4000-8000-000000000003': idle };
  assert.deepEqual(Q.evictionResumes(evs, (id) => hist[id], { now }).map((x) => x.session_id), [SID]);
  assert.deepEqual(Q.evictionResumes(evs, (id) => hist[id], { now, resumed: { [SID]: { at: '2026-11-16T15:32:30Z' } } }), [], 'already messaged since that eviction');
  assert.deepEqual(Q.evictionResumes(evs, (id) => hist[id], { now: now + 3600000 }), [], 'outside the window');
  assert.equal(tookTurnSince([...midTurn, ev('assistant.turn_start', '2026-11-16T15:33:10.000Z')], Date.parse('2026-11-16T15:33:00Z')), true);
  assert.equal(tookTurnSince(midTurn, Date.parse('2026-11-16T15:33:00Z')), false);
});

test('readAppLog reads only what the app wrote since the last tick, whole lines, across a rotation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-log-'));
  const f = path.join(dir, 'github-app.1154.log');
  fs.writeFileSync(f, `${LOGLINE('2026-11-16T15:00:00Z', SID)}\n`);
  let r = Q.readAppLog(null, { dir });
  assert.equal(Q.parseEvictions(r.text).length, 1, 'first tick: the recent tail');
  fs.appendFileSync(f, `${LOGLINE('2026-11-16T15:01:00Z', SID)}\npartial`);
  r = Q.readAppLog(r.cursor, { dir });
  assert.deepEqual(Q.parseEvictions(r.text).map((e) => e.at), ['2026-11-16T15:01:00Z'], 'only the new line; the partial one waits');
  fs.appendFileSync(f, ` line\n${LOGLINE('2026-11-16T15:02:00Z', SID)}\n`);
  fs.renameSync(f, path.join(dir, 'github-app.1154.8.log'));
  fs.writeFileSync(f, `${LOGLINE('2026-11-16T15:03:00Z', SID)}\n`);
  fs.utimesSync(f, new Date(), new Date(Date.now() + 1000));
  r = Q.readAppLog(r.cursor, { dir });
  assert.deepEqual(Q.parseEvictions(r.text).map((e) => e.at), ['2026-11-16T15:02:00Z', '2026-11-16T15:03:00Z']);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- the tick, against an in-memory app (the app's rows, its socket and its histories are fakes) ----------

const iso = (min) => new Date(NOW - min * 60000).toISOString();
const ev402 = (min) => JSON.stringify({ type: 'session.error', data: { errorType: 'quota', statusCode: 402, errorCode: 'quota_exceeded' }, id: `e${min}`, timestamp: iso(min) });
const evUser = (min) => JSON.stringify({ type: 'user.message', data: {}, id: `u${min}`, timestamp: iso(min) });

function fakeDeps({ copilotHome, accounts, projects, sessions, histories = {}, pins = {}, exchange = async () => [] }) {
  const sql = async (q) => {
    if (/FROM accounts/.test(q)) return accounts;
    if (/SELECT copilot_account_id FROM projects WHERE id = '([^']*)'/.test(q)) return [{ copilot_account_id: pins[q.match(/id = '([^']*)'/)[1]] ?? null }];
    if (/app_state/.test(q)) return [{ value: JSON.stringify({ separateCopilotAccountEnabled: true }) }];
    if (/FROM projects/.test(q)) return projects.map((p) => ({ ...p, copilot_account_id: pins[p.id] ?? p.copilot_account_id }));
    if (/FROM sessions/.test(q)) return sessions;
    return [];
  };
  return {
    copilotHome,
    now: () => NOW,
    sleep: async () => {},
    sql,
    exchange,
    history: (id) => ({ lines: histories[id] ?? [], mtime: 0 }),
    historyPath: (id) => path.join(copilotHome, 'session-state', id, 'events.jsonl'),
  };
}

test('config: off unless quota.json says "enabled": true; a file that is not JSON is a ShepherdError', () => {
  const f = path.join(SANDBOX, 'cfg-check.json');
  assert.equal(Q.config(path.join(SANDBOX, 'missing.json')).enabled, false, 'no file: off');
  fs.writeFileSync(f, '{}');
  assert.equal(Q.config(f).enabled, false);
  fs.writeFileSync(f, '{"enabled": true, "low_pct": 3}');
  assert.equal(Q.config(f).enabled, true);
  assert.equal(Q.config(f).low_pct, 3);
  fs.writeFileSync(f, '{"enabled": "yes"}');
  assert.equal(Q.config(f).enabled, false, 'only the boolean true turns it on');
  fs.writeFileSync(f, '{half');
  assert.throws(() => Q.config(f), { code: 'quota-config' });
});

test('no config: an applied tick does nothing: no reads, no messages, no files written', async () => {
  let touched = 0;
  const d = fakeDeps({ copilotHome: SANDBOX, accounts: [], projects: [], sessions: [], exchange: async () => { touched++; return []; } });
  const out = await Q.tick(d, { apply: true, cfg: Q.config(path.join(SANDBOX, 'none.json')), fetchDirect: async () => { touched++; return null; } });
  assert.deepEqual(out, { ok: true, disabled: true, applied: false });
  assert.equal(touched, 0);
  assert.equal(fs.existsSync(process.env.SHEPHERD_QUOTA_STATE), false);
  assert.equal(fs.existsSync(process.env.SHEPHERD_QUOTA_LOG), false);
});

test('an applied tick moves a project off a spent account, messages the session its quota error stopped, and logs both', async () => {
  const pins = {};
  const sent = [];
  const exchange = async (messages) => messages.map((m) => {
    if (m.type === 'set_project_copilot_account') { pins[m.project_id] = m.account_id; return { type: 'project_updated', project: { id: m.project_id } }; }
    sent.push(m);
    return { type: 'session_message_sent', request_id: m.request_id, session_id: m.session_id };
  });
  const S = '00000011-0000-4000-8000-000000000011';
  const d = fakeDeps({
    copilotHome: SANDBOX,
    accounts: [{ id: 'a1', login: 'user', host: 'github.com', is_default: 1, settings_json: '{}' }, { id: 'a2', login: 'other', host: 'github.com', is_default: 0, settings_json: '{}' }],
    projects: [{ id: 'p1', name: 'app', github_owner: 'me', github_repo: 'app', github_account_id: 'a1', copilot_account_id: 'a1', copilot_account_source: 'app' }],
    sessions: [{ id: S, title: 'work', is_running: 0, updated_at: iso(1), project_id: 'p1', name: 'work' }],
    histories: { [S]: [evUser(20), ev402(5)] },
    pins,
    exchange,
  });
  const at = new Date(NOW).toISOString();
  const fetchDirect = async (a) => (a.id === 'a1'
    ? Q.normalize({ entitlement: 1000000, remaining: 0, percent_remaining: 0, has_quota: false }, { source: 'direct', at })
    : Q.normalize({ entitlement: 1000000, remaining: 800000, percent_remaining: 80, has_quota: true }, { source: 'direct', at }));
  const cfg = { ...Q.DEFAULTS, enabled: true, me: 'test' };

  const out = await Q.tick(d, { apply: true, cfg, now: NOW, fetchDirect });

  assert.equal(out.done.moved.length, 1);
  assert.deepEqual([out.done.moved[0].from, out.done.moved[0].to, out.done.moved[0].why, out.done.moved[0].ok], ['user@github.com', 'other@github.com', 'out', true]);
  assert.equal(pins.p1, 'a2', 'the project is re-pinned to the account with the most left');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].session_id, S);
  assert.match(sent[0].prompt, /switched from user@github\.com to other@github\.com/);
  assert.deepEqual(out.done.resumed.map((r) => [r.id, r.ok]), [[S, true]]);
  assert.deepEqual(JSON.parse(fs.readFileSync(process.env.SHEPHERD_QUOTA_STATE, 'utf8')).pins, { p1: 'a2' });
  const lines = fs.readFileSync(process.env.SHEPHERD_QUOTA_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => [l.act, l.act === 'resume' ? l.session : l.to]), [['move', 'other@github.com'], ['resume', S]]);
  assert.equal(Q.status().applied, true);
});

test('burn is known for a stale account and an unlimited one, and projects the date it runs dry against the reset', () => {
  const reset = '2026-12-01T00:00:00Z';
  const now = Date.parse('2026-11-19T12:00:00Z');
  const stale = { unlimited: false, remaining: 333708, spent: 666292, reset, at: '2026-11-18T22:59:00Z' };
  const lone = Q.forecast({}, { k: stale, u: { unlimited: true, spent: 0, reset } }, { now });
  assert.equal(lone.u.hours_left, Infinity, 'unlimited never runs dry');
  assert.equal(Q.forecast({}, { s: { remaining: 0, spent: 1000000, reset, at: '2026-11-19T11:00:00Z' } }, { now }).s.hours_left, 0, 'spent is dry now');
  assert.equal(lone.k.basis, 'month-to-date', 'one reading: the month to date');
  assert.ok(lone.k.per_h > 1000 && lone.k.per_h < 2000);
  assert.ok(Number.isFinite(lone.k.hours_left) && lone.k.hours_left < Date.parse(reset) / 3600000 - now / 3600000, 'dry before the reset');
  const days = [{ at: '2026-11-10T00:00:00Z', spent: 500000 }, { at: '2026-11-18T22:59:00Z', spent: 666292 }];
  const f = Q.forecast({ k: days }, { k: stale }, { now });
  assert.equal(f.k.basis, 'history', 'older readings, none in the window: the span they cover');
  assert.equal(f.k.per_h, Math.round(166292 / (214.98)));
  const hist = [{ at: '2026-10-01T00:00:00Z', spent: 1 }, { at: '2026-11-01T00:00:00Z', spent: 2 }, { at: '2026-11-01T01:00:00Z', spent: 3 }, { at: '2026-11-19T11:50:00Z', spent: 4 }, { at: '2026-11-19T11:55:00Z', spent: 5 }];
  assert.deepEqual(Q.pruneHistory(hist, { now }).map((x) => x.spent), [2, 4, 5], 'the period, thinned to 6 hours outside the window');
});
