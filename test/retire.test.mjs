// The retire duties: a handed-off session is archived once its successor has taken a turn; an idle orphan after a day. Plus the
// config gate, and the plan that changes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { archiveRow, statePath } from '../src/store.mjs';
import { COORDINATOR_RECENT_MS, FINISHED_IDLE_MS, PRESSURE_MAIN_MS, HANDOFF_QUIET_MS, IDLE_LANDED_MS, IDLE_LANDED_PER_PASS, census, childrenNote, drainTargets, retireConfig, retireSessions, watchRetire } from '../src/retire.mjs';
import { fakeApp, iso, NOW, row, sessionHistory, testDeps, working } from './fake-sidebar.mjs';

const P = 'aaaaaaaa-0000-4000-8000-000000000001';
const S = 'bbbbbbbb-0000-4000-8000-000000000002';
const CHILD = 'cccccccc-0000-4000-8000-000000000003';
const ORPHAN = 'dddddddd-0000-4000-8000-000000000004';
const GONE = 'eeeeeeee-0000-4000-8000-000000000005';
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), name));

// P was handed off to S: P has worked and is idle; S's first message names P, and S has taken its first turn.
function handedOff(home, { turned = true, first = `Succeeds: ${P}\n\nCarry on.` } = {}) {
  sessionHistory(home, P, 'Original work.', { turned: true });
  sessionHistory(home, S, first, { turned });
}
const quiet = { lastActivity: iso(NOW - HANDOFF_QUIET_MS - 1), updatedAt: iso(NOW - HANDOFF_QUIET_MS - 1) };
const day = { lastActivity: iso(NOW - FINISHED_IDLE_MS - 1), updatedAt: iso(NOW - FINISHED_IDLE_MS - 1) };

test('a predecessor is archived once its successor took a turn and it has been idle five minutes, with a note and a log line', async () => {
  const home = tmp('retire-');
  handedOff(home);
  const app = fakeApp();
  const d = testDeps(home, { app });
  const listed = [row(P, { name: 'Old coordinator', ...quiet }), row(S, { ...working, name: 'New coordinator' })];
  const entries = await retireSessions(listed, d, { apply: true });
  assert.deepEqual(entries.map((e) => [e.what, e.id, e.reason, e.done]), [['archive', P, 'handed-off', true]]);
  assert.equal(entries[0].why, `succeeded by "New coordinator" (${S.slice(0, 8)}); branch work in example/project`);
  assert.deepEqual(app.archived, ['w-aaaa']);
  assert.deepEqual(app.sent, [], 'no children, nothing to tell');
  const log = fs.readFileSync(path.join(d.state, 'retire-log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(log[0].reason, 'handed-off');
  fs.rmSync(home, { recursive: true, force: true });
});

test('the successor first turn is awaited, and a predecessor that is busy, waiting, stuck, remote or recently active is never archived', async () => {
  const home = tmp('retire-busy-');
  handedOff(home, { turned: false });
  const app = fakeApp();
  const d = testDeps(home, { app });
  assert.deepEqual(await retireSessions([row(P, quiet), row(S, working)], d, { apply: true }), []);
  sessionHistory(home, S, `Succeeds: ${P}\n\nCarry on.`, { turned: true });
  for (const over of [working, { state: 'waiting', awaiting: 'input' }, { state: 'waiting', awaiting: 'plan' }, { state: 'stuck' }, { remote: true }, { lastActivity: iso(NOW - 60_000), updatedAt: iso(NOW - 60_000) }]) {
    assert.deepEqual(await retireSessions([row(P, { ...quiet, ...over }), row(S, working)], d, { apply: true }), [], JSON.stringify(over));
  }
  assert.deepEqual(app.archived, []);
  fs.rmSync(home, { recursive: true, force: true });
});

test('the predecessor is held while a session it coordinates works, then archived, and its successor is told which children it had', async () => {
  const home = tmp('retire-children-');
  handedOff(home);
  const app = fakeApp();
  const d = testDeps(home, { app });
  const lane = { coordinatingCreatorSessionId: P };
  const held = await retireSessions([row(P, quiet), row(S, { ...working, ...lane }), row(CHILD, { ...working, ...lane, name: 'Lane' })], d, { apply: true });
  assert.deepEqual(held.map((e) => e.what), ['hold']);
  assert.deepEqual(app.archived, []);
  const done = await retireSessions([row(P, quiet), row(S, working), row(CHILD, { ...lane, name: 'Lane' })], d, { apply: true });
  assert.deepEqual(done.map((e) => [e.id, e.done]), [[P, true]]);
  assert.deepEqual(app.sent, [{ id: S, text: childrenNote(row(P, { name: 'session aaaa' }), [row(CHILD, { name: 'Lane' })]) }]);
  assert.match(app.sent[0].text, /It coordinated "Lane" \(cccccccc-0000-4000-8000-000000000003\)/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('two sessions that claim to succeed each other retire neither, and an archive the app refuses is not counted', async () => {
  const home = tmp('retire-loop-');
  sessionHistory(home, P, `Succeeds: ${S}`, { turned: true });
  sessionHistory(home, S, `Succeeds: ${P}`, { turned: true });
  const d = testDeps(home);
  assert.deepEqual(await retireSessions([row(P, quiet), row(S, quiet)], d, { apply: true }), []);
  fs.rmSync(path.join(home, 'state'), { recursive: true });
  fs.rmSync(path.join(home, 'session-state'), { recursive: true });
  handedOff(home);
  const refused = testDeps(home, { app: { exchange: async (m) => m.map((x) => ({ type: 'error', request_id: x.request_id, message: 'busy' })) } });
  assert.deepEqual(await retireSessions([row(P, quiet), row(S, working)], refused, { apply: true }), []);
  fs.rmSync(home, { recursive: true, force: true });
});

test('a plan decides the same and changes nothing: no archive, no message, no hand-off record', async () => {
  const home = tmp('retire-plan-');
  handedOff(home);
  const app = fakeApp();
  const d = testDeps(home, { app });
  const entries = await retireSessions([row(P, quiet), row(S, working)], d, { apply: false });
  assert.deepEqual(entries.map((e) => [e.id, e.done]), [[P, false]]);
  assert.deepEqual(app.archived, []);
  assert.equal(fs.existsSync(path.join(d.state, 'successions.json')), false);
  assert.equal(fs.existsSync(path.join(d.state, 'retire-log.jsonl')), false);
  fs.rmSync(home, { recursive: true, force: true });
});

test('an idle orphan whose coordinator is gone is archived after a day, and one with a live coordinator, an open pull request, an automation, a busy child or a recent turn is kept', async () => {
  const home = tmp('retire-orphan-');
  const app = fakeApp();
  const d = testDeps(home, { app });
  const gone = { ...day, coordinatingCreatorSessionId: GONE };
  const orphan = await retireSessions([row(ORPHAN, { ...gone, detail: 'its turn ended' })], d, { apply: true });
  assert.deepEqual(orphan.map((e) => [e.id, e.reason, e.why]), [[ORPHAN, 'finished', 'its turn ended; branch work in example/project']]);
  for (const listed of [
    [row(ORPHAN, { ...day, coordinatingCreatorSessionId: P }), row(P, working)],
    [row(ORPHAN, day)],
    [row(ORPHAN, { ...gone, openPullRequest: 'https://github.com/example/project/pull/1' })],
    [row(ORPHAN, { ...gone, automation: true })],
    [row(ORPHAN, gone), row(CHILD, { ...working, coordinatingCreatorSessionId: ORPHAN })],
    [row(ORPHAN, { ...gone, lastActivity: iso(NOW - FINISHED_IDLE_MS + 60_000) })],
    [row(ORPHAN, { ...gone, state: 'waiting', awaiting: 'input' })],
  ]) assert.deepEqual(await retireSessions(listed, d, { apply: true }), [], JSON.stringify(listed[0]));
  assert.equal(app.archived.length, 1);
  fs.rmSync(home, { recursive: true, force: true });
});

test('a lane whose recorded coordinator is archived is kept while a listed session it reports to still coordinates it', async () => {
  const home = tmp('retire-reports-');
  handedOff(home);
  const reportTo = JSON.stringify({ type: 'assistant.message', data: { toolRequests: [{ name: 'send_session_message', arguments: { session_id: 'w-cccc' } }] } });
  fs.mkdirSync(path.join(home, 'session-state', ORPHAN), { recursive: true });
  fs.writeFileSync(path.join(home, 'session-state', ORPHAN, 'events.jsonl'), `${reportTo}\n`);
  const d = testDeps(home);
  const lane = row(ORPHAN, { ...day, coordinatingCreatorSessionId: GONE });
  assert.deepEqual(await retireSessions([row(CHILD, working), lane], d, { apply: true }), []);
  fs.rmSync(home, { recursive: true, force: true });
});

test('the config is off with no file, on only for "enabled": true, and an unreadable file is an error', () => {
  const home = tmp('retire-config-');
  const file = path.join(home, 'retire.json');
  assert.deepEqual(retireConfig(file), { enabled: false, idleLanded: false });
  fs.writeFileSync(file, '{"enabled": "yes"}');
  assert.deepEqual(retireConfig(file), { enabled: false, idleLanded: false });
  fs.writeFileSync(file, '{"enabled": true}');
  assert.deepEqual(retireConfig(file), { enabled: true, idleLanded: false });
  fs.writeFileSync(file, '{"enabled": true, "idleLanded": true}');
  assert.deepEqual(retireConfig(file), { enabled: true, idleLanded: true });
  fs.writeFileSync(file, '{ not json');
  assert.throws(() => retireConfig(file), (e) => e.code === 'retire-config');
  fs.rmSync(home, { recursive: true, force: true });
});

test('a pass that cannot list the app changes nothing and says why', async () => {
  const home = tmp('retire-down-');
  const d = testDeps(home, { app: { exchange: async () => [{ type: 'socket_error', message: 'no ws.port' }] } });
  const r = await watchRetire(d, { apply: true });
  assert.deepEqual(r.retire, []);
  assert.deepEqual(r.size, []);
  assert.match(r.errors[0], /could not list the app's sessions: .*no ws\.port/);
  fs.rmSync(home, { recursive: true, force: true });
});

// ---------- the landed gate: nothing is archived while its work is not on main ----------

import { accountFor, checkLanded, land } from '../src/landed.mjs';

// A scripted git and gh: each call is matched by its arguments, and every call is kept.
function scripted(answers) {
  const calls = [];
  const answer = (tool) => async (cwd, args) => {
    const line = `${tool} ${args.join(' ')}`;
    calls.push(line);
    const hit = Object.entries(answers).find(([k]) => line.startsWith(k));
    const v = hit ? hit[1] : '';
    return typeof v === 'object' ? { code: v.code, stdout: v.stdout ?? '', stderr: v.stderr ?? '' } : { code: 0, stdout: `${v}\n`, stderr: '' };
  };
  return { calls, landDeps: { git: answer('git'), gh: answer('gh'), exists: () => true } };
}
const REPO = { 'git rev-parse --is-inside-work-tree': 'true', 'git symbolic-ref --short -q HEAD': 'work', 'git rev-parse HEAD': 'abc', 'git status --porcelain': '', 'git symbolic-ref --short -q refs/remotes/origin/HEAD': 'origin/main', 'git rev-list --count origin/main..HEAD': '3', 'git rev-parse --verify -q origin/work': 'abc', 'git rev-list --count origin/work..HEAD': '0', 'gh pr list': '[]' };
const wsRow = (over = {}) => row(P, { path: '/work/tree', ...over });

test('landed check: clean and merged goes; each kind of unlanded work is named; anything unknown is held', async () => {
  const merged = JSON.stringify([{ number: 7, state: 'MERGED', url: 'u', headRefOid: 'abc' }]);
  const cases = [
    ['merged branch', { 'gh pr list': merged }, 'clean'],
    ['nothing beyond main', { 'git rev-list --count origin/main..HEAD': '0' }, 'clean'],
    ['uncommitted changes', { 'git status --porcelain': ' M a.js' }, 'land'],
    ['unpushed commits', { 'git rev-list --count origin/work..HEAD': '2' }, 'land'],
    ['never pushed', { 'git rev-parse --verify -q origin/work': { code: 1 } }, 'land'],
    ['pushed, no pull request', {}, 'land'],
    ['pull request open and pushed', { 'gh pr list': JSON.stringify([{ number: 8, state: 'OPEN', url: 'pr8', headRefOid: 'abc' }]) }, 'hold'],
    ['pull request closed unmerged', { 'gh pr list': JSON.stringify([{ number: 9, state: 'CLOSED', url: 'pr9', headRefOid: 'abc' }]) }, 'hold'],
    ['merged but head moved on', { 'gh pr list': JSON.stringify([{ number: 7, state: 'MERGED', url: 'u', headRefOid: 'old' }]) }, 'land'],
    ['detached head not on origin', { 'git symbolic-ref --short -q HEAD': '' }, 'hold'],
    ['detached head already on origin', { 'git symbolic-ref --short -q HEAD': '', 'git branch -r --contains': '  origin/main' }, 'clean'],
    ['detached head on origin but dirty', { 'git symbolic-ref --short -q HEAD': '', 'git branch -r --contains': '  origin/main', 'git status --porcelain': ' M a' }, 'hold'],
    ['fetch fails', { 'git fetch': { code: 1 } }, 'hold'],
    ['gh unavailable', { 'gh pr list': { code: 1 } }, 'hold'],
    ['dirty on main', { 'git symbolic-ref --short -q HEAD': 'main', 'git status --porcelain': '?? x' }, 'hold'],
    ['clean on main', { 'git symbolic-ref --short -q HEAD': 'main', 'git rev-list --count origin/main..HEAD': '0' }, 'clean'],
  ];
  for (const [name, over, want] of cases) {
    const s = scripted({ ...REPO, ...over });
    assert.equal((await checkLanded(wsRow(), { landDeps: s.landDeps })).outcome, want, name);
  }
  assert.equal((await checkLanded(row(P, { path: null }), { landDeps: scripted(REPO).landDeps })).outcome, 'hold');
  assert.equal((await checkLanded(row(P, { path: '/x' }), { landDeps: { ...scripted(REPO).landDeps, exists: () => false } })).outcome, 'hold');
  assert.equal((await checkLanded(row(P, { kind: 'chat', path: null }), {})).outcome, 'clean');
});

test('land: commits uncommitted work, pushes, opens a pull request with a clean message and turns auto-merge on; failures hold', async () => {
  const found = { cwd: '/work/tree', branch: 'work', def: 'main', dirty: true, open: null };
  const s = scripted({ 'git log': 'Fix the thing', 'gh pr create': 'https://github.com/o/r/pull/5' });
  assert.deepEqual(await land(found, { landDeps: s.landDeps }), { ok: true, url: 'https://github.com/o/r/pull/5' });
  assert.deepEqual(s.calls.map((c) => c.split(' ').slice(0, 2).join(' ')), ['git add', 'git commit', 'git push', 'git log', 'gh pr', 'gh pr']);
  assert.ok(s.calls.at(-1).startsWith('gh pr merge https://github.com/o/r/pull/5') && s.calls.at(-1).endsWith('--auto --squash'));
  assert.doesNotMatch(s.calls.join('\n'), /co-authored|copilot|claude|\bAI\b/i);
  const noPush = scripted({ 'git push': { code: 1 } });
  assert.equal((await land(found, { landDeps: noPush.landDeps })).ok, false);
  assert.ok(!noPush.calls.some((c) => c.startsWith('gh pr create')));
  const noAuto = scripted({ 'gh pr create': 'https://github.com/o/r/pull/6', 'gh pr merge': { code: 1, stderr: 'not allowed' } });
  const r = await land({ ...found, dirty: false }, { landDeps: noAuto.landDeps });
  assert.equal(r.ok, false);
  assert.match(r.why, /auto-merge could not be turned on/);
  const existing = scripted({});
  assert.equal((await land({ ...found, dirty: false, open: 'pr1' }, { landDeps: existing.landDeps })).url, 'pr1');
  assert.ok(!existing.calls.some((c) => c.startsWith('gh pr create')));
});

test('retire: a finished session with unlanded work is never archived; a plan says what would land, apply lands it and holds, clean goes', async () => {
  const home = tmp('retire-landed-');
  const listed = [row(ORPHAN, { ...day, coordinatingCreatorSessionId: GONE, path: '/w/o' })];
  sessionHistory(home, ORPHAN, 'work', { turned: true });
  for (const [found, landed, expect] of [
    [{ outcome: 'land', why: '2 unpushed commit(s) on work' }, { ok: true, url: 'pr5' }, ['hold', 'landing']],
    [{ outcome: 'land', why: 'uncommitted changes on work' }, { ok: false, why: 'could not push' }, ['hold', 'unlanded']],
    [{ outcome: 'hold', why: 'detached HEAD' }, null, ['hold', 'unlanded']],
  ]) {
    const app = fakeApp();
    const d = { ...testDeps(home, { app }), checkLanded: async () => found, land: async () => landed };
    const e = await retireSessions(listed, d, { apply: true });
    assert.deepEqual(e.map((x) => [x.what, x.reason]), [expect], found.why);
    assert.deepEqual(app.archived, []);
  }
  const app = fakeApp();
  const plan = await retireSessions(listed, { ...testDeps(home, { app }), checkLanded: async () => ({ outcome: 'land', why: 'x' }), land: async () => { throw new Error('plan must not land'); } }, { apply: false });
  assert.deepEqual(plan.map((x) => x.what), ['land']);
  const go = await retireSessions(listed, { ...testDeps(home, { app }), checkLanded: async () => ({ outcome: 'clean' }) }, { apply: true });
  assert.deepEqual(go.map((x) => x.what), ['archive']);
  assert.equal(app.archived.length, 1);
  fs.rmSync(home, { recursive: true, force: true });
});

test('retire: a handed-off session with unlanded work is held, once, not again as finished', async () => {
  const home = tmp('retire-landed-ho-');
  handedOff(home);
  const app = fakeApp();
  const d = { ...testDeps(home, { app }), checkLanded: async () => ({ outcome: 'hold', why: 'dirty' }) };
  const e = await retireSessions([row(P, { ...quiet, ...day, coordinatingCreatorSessionId: GONE }), row(S, { ...working })], d, { apply: true });
  assert.equal(e.filter((x) => x.id === P).length, 1);
  assert.deepEqual(app.archived, []);
  fs.rmSync(home, { recursive: true, force: true });
});

// ---------- idle and landed: any idle session with its work on main, coordinated or not ----------

const idle = (ms, over = {}) => ({ lastActivity: iso(NOW - ms), updatedAt: iso(NOW - ms), ...over });
const clean = { checkLanded: async () => ({ outcome: 'clean' }) };
const LEAD = 'ffffffff-0000-4000-8000-000000000006';

test('idle-landed: archives an idle session, coordinated or not, once it has been quiet two hours; off unless asked', async () => {
  const home = tmp('retire-idle-');
  const app = fakeApp();
  const d = { ...testDeps(home, { app }), ...clean };
  const listed = [row(LEAD, { ...working, name: 'Lead', createdAt: iso(NOW - 40 * 3600_000) }), row(ORPHAN, idle(IDLE_LANDED_MS + 1, { coordinatingCreatorSessionId: LEAD })), row(CHILD, idle(IDLE_LANDED_MS + 1))];
  assert.deepEqual(await retireSessions(listed, d, { apply: true }), [], 'off by default');
  const e = await retireSessions(listed, d, { apply: true, idleLanded: true });
  assert.deepEqual(e.map((x) => [x.id, x.reason, x.done]).sort(), [[CHILD, 'idle-landed', true], [ORPHAN, 'idle-landed', true]].sort());
  assert.match(e.find((x) => x.id === CHILD).why, /^idle 2 h, no coordinator; /);
  assert.equal(app.archived.length, 2);
  const log = fs.readFileSync(path.join(d.state, 'retire-log.jsonl'), 'utf8');
  assert.match(log, /idle-landed/);
  fs.rmSync(home, { recursive: true, force: true });
});

const HOT = { stressed: true, why: 'memory pressure warning' };
test('memory pressure: a session idle six hours whose only unlanded work is on main itself is archived; without pressure, or with work on a branch, it stays', async () => {
  const home = tmp('retire-pressure-');
  const app = fakeApp();
  const onMain = { checkLanded: async () => ({ outcome: 'hold', onDefault: true, why: 'it has uncommitted changes on main itself, which cannot be landed by a pull request' }) };
  const onBranch = { checkLanded: async () => ({ outcome: 'hold', why: '1 unpushed commit(s) on a-branch' }) };
  let n = 0;
  const run = (deps, stress) => retireSessions([row(`${ORPHAN.slice(0, -2)}0${n}`, idle(PRESSURE_MAIN_MS + 1)), row(`${CHILD.slice(0, -2)}0${n++}`, idle(PRESSURE_MAIN_MS - 60_000))], { ...testDeps(home, { app }), ...deps }, { apply: true, idleLanded: true, stress });
  assert.deepEqual((await run(onMain, { stressed: false, why: '' })).map((x) => x.what), ['hold', 'hold'], 'no pressure');
  assert.deepEqual((await run(onBranch, HOT)).map((x) => x.what), ['hold', 'hold'], 'a branch with unpushed work stays');
  const e = await run(onMain, HOT);
  assert.deepEqual(e.map((x) => [x.id, x.what, x.reason]), [[`${ORPHAN.slice(0, -2)}02`, 'archive', 'memory-pressure'], [`${CHILD.slice(0, -2)}02`, 'hold', 'unlanded']]);
  assert.match(e[0].why, /memory pressure warning; its folder keeps the changes it has on main/);
  assert.equal(app.archived.length, 1);
  fs.rmSync(home, { recursive: true, force: true });
});

test('idle-landed: never takes a session that works, waits, is recent, has a pull request or automation, or is a coordinator', async () => {
  const home = tmp('retire-idle-guards-');
  const app = fakeApp();
  const d = { ...testDeps(home, { app }), ...clean };
  const old = idle(IDLE_LANDED_MS + 1);
  const kid = (over) => row(CHILD, { coordinatingCreatorSessionId: ORPHAN, createdAt: iso(NOW - 30 * 3600_000), ...idle(IDLE_LANDED_MS + 1), ...over });
  const cases = {
    working: [row(ORPHAN, { ...working })],
    waiting: [row(ORPHAN, { ...old, state: 'waiting', awaiting: 'input' })],
    'quiet under two hours': [row(ORPHAN, idle(IDLE_LANDED_MS - 60_000))],
    'open pull request': [row(ORPHAN, { ...old, openPullRequest: 'https://github.com/example/project/pull/1' })],
    automation: [row(ORPHAN, { ...old, automation: true })],
    'remote, quiet under a day': [row(ORPHAN, { ...old, remote: true })],
    'remote, running': [row(ORPHAN, { ...working, remote: true })],
    'remote, waiting': [row(ORPHAN, { ...idle(FINISHED_IDLE_MS + 1), remote: true, state: 'waiting', awaiting: 'input' })],
    'remote with a pull request': [row(ORPHAN, { ...idle(FINISHED_IDLE_MS + 1), remote: true, openPullRequest: 'https://github.com/example/project/pull/1' })],
    'a working child': [row(ORPHAN, old), kid(working)],
    'a child made in the last day': [row(ORPHAN, old), kid({ createdAt: iso(NOW - COORDINATOR_RECENT_MS + 60_000) })],
    'named for its role': [row(ORPHAN, { ...old, name: 'Desk epoch 3 (2)' }), row(CHILD, { ...old, name: 'the coordinator' }), row(LEAD, { ...old, name: 'ouro ui' })],
  };
  for (const [name, listed] of Object.entries(cases)) {
    const e = await retireSessions(listed, d, { apply: true, idleLanded: true });
    const taken = e.filter((x) => x.what === 'archive').map((x) => x.id);
    assert.ok(!taken.includes(ORPHAN), name);
    if (name === 'named for its role') assert.deepEqual(taken, [], name);
  }
  fs.rmSync(home, { recursive: true, force: true });
});

test('a cloud-hosted session idle over a day is archived with nothing to land, coordinated or not; a live coordinator of one stays', async () => {
  const home = tmp('retire-remote-');
  const app = fakeApp();
  const d = { ...testDeps(home, { app }), checkLanded: async () => ({ outcome: 'hold', why: 'no working folder' }) };
  const old = { ...idle(FINISHED_IDLE_MS + 1), remote: true };
  const listed = [row(ORPHAN, old), row(CHILD, { ...old, coordinatingCreatorSessionId: GONE }), row(LEAD, { ...old, ...idle(FINISHED_IDLE_MS + 1) })];
  const e = await retireSessions(listed, d, { apply: true, idleLanded: true });
  assert.deepEqual(e.filter((x) => x.what === 'archive').map((x) => x.id).sort(), [CHILD, LEAD, ORPHAN].sort());
  assert.equal(app.archived.length, 3);
  const e2 = await retireSessions([row(ORPHAN, old), row(CHILD, { ...working, coordinatingCreatorSessionId: ORPHAN })], d, { apply: true, idleLanded: true });
  assert.deepEqual(e2.filter((x) => x.id === ORPHAN), [], 'a working child keeps its coordinator');
  fs.rmSync(home, { recursive: true, force: true });
});

test('a cloud session whose GitHub task is already archived (the app answers 409) has its sidebar entry deleted, a local one never', async () => {
  const home = tmp('retire-409-');
  const app = fakeApp({ alreadyArchived: ['w-aaaa', 'w-bbbb'] });
  const d = { ...testDeps(home, { app }), ...clean };
  const old = { ...idle(FINISHED_IDLE_MS + 1), remote: true };
  const e = await retireSessions([row(P, old), row(S, { ...old, remote: false })], d, { apply: true, idleLanded: true });
  assert.deepEqual(e.filter((x) => x.what === 'archive').map((x) => x.id), [P]);
  assert.deepEqual(app.deleted, ['w-aaaa'], 'only the cloud session is deleted');
  assert.deepEqual(app.archived, []);
  const log = fs.readFileSync(path.join(d.state, 'retire-log.jsonl'), 'utf8');
  assert.match(log, /already archived, so its sidebar entry was deleted/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('idle-landed: sessions the app refuses to archive do not use up every pass', async () => {
  const home = tmp('retire-refused-');
  const app = fakeApp();
  const refused = new Set();
  const d = { ...testDeps(home, { app }), ...clean, archive: async (r) => { if (refused.has(r.id)) return false; app.archived.push(r.workspaceId); return true; } };
  const ids = Array.from({ length: IDLE_LANDED_PER_PASS + 1 }, (_, i) => `${String(i).padStart(2, '0')}${P.slice(2)}`);
  const listed = ids.map((id, i) => row(id, { ...idle(IDLE_LANDED_MS + 1000 - i), name: `s${i}` }));
  ids.slice(0, IDLE_LANDED_PER_PASS).forEach((id) => refused.add(id));
  const first = await retireSessions(listed, d, { apply: true, idleLanded: true });
  assert.equal(first.filter((x) => x.reason === 'archive-refused').length, IDLE_LANDED_PER_PASS);
  const second = await retireSessions(listed, d, { apply: true, idleLanded: true });
  assert.deepEqual(second.filter((x) => x.what === 'archive').map((x) => x.id), [ids[IDLE_LANDED_PER_PASS]]);
  fs.rmSync(home, { recursive: true, force: true });
});

test('idle-landed: a child idle for days is archived once its coordinator has no working child and made none lately, and unlanded work is held, never landed', async () => {
  const home = tmp('retire-idle-landed-');
  const app = fakeApp();
  let landed = false;
  const d = { ...testDeps(home, { app }), checkLanded: async (r) => (r.id === CHILD ? { outcome: 'land', why: 'uncommitted changes on work' } : { outcome: 'clean' }), land: async () => { landed = true; return { ok: true }; } };
  const old = idle(IDLE_LANDED_MS + 1);
  const listed = [row(ORPHAN, { ...old, createdAt: iso(NOW - 90 * 3600_000), name: 'plain' }), row(CHILD, { ...old, name: 'dirty' }), row(LEAD, { ...old, name: 'tidy' })];
  const e = await retireSessions(listed, d, { apply: true, idleLanded: true });
  assert.deepEqual(e.map((x) => [x.id, x.what, x.reason]).sort(), [[CHILD, 'hold', 'unlanded'], [LEAD, 'archive', 'idle-landed'], [ORPHAN, 'archive', 'idle-landed']].sort());
  assert.equal(landed, false);
  assert.deepEqual(app.archived.length, 2);
  fs.rmSync(home, { recursive: true, force: true });
});

test('idle-landed: a pass that applies checks a few per pass and does not re-check a held session for half an hour; a plan checks all', async () => {
  const home = tmp('retire-idle-cap-');
  const ids = Array.from({ length: IDLE_LANDED_PER_PASS + 5 }, (_, i) => `1000000${i.toString(16).padStart(1, '0')}-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`);
  let checks = 0;
  const base = { ...testDeps(home, { app: fakeApp() }), checkLanded: async () => { checks += 1; return { outcome: 'hold', why: 'dirty' }; } };
  const listed = ids.map((id, i) => row(id, idle(IDLE_LANDED_MS + 1 + i)));
  await retireSessions(listed, base, { apply: true, idleLanded: true });
  assert.equal(checks, IDLE_LANDED_PER_PASS);
  checks = 0;
  await retireSessions(listed, base, { apply: true, idleLanded: true });
  assert.equal(checks, 5, 'the first pass\'s holds are not looked at again');
  checks = 0;
  await retireSessions(listed, base, { apply: false, idleLanded: true });
  assert.equal(checks, ids.length);
  fs.rmSync(home, { recursive: true, force: true });
});

test('census counts sessions by state and age, coordinated or not, and the memory the idle ones hold', () => {
  const h = 3600_000;
  const c = census([row(LEAD, working), row(ORPHAN, { ...idle(h), coordinatingCreatorSessionId: LEAD }), row(CHILD, idle(5 * h)), row(P, idle(30 * h)), row(S, { ...idle(5 * h), coordinatingCreatorSessionId: GONE })], NOW);
  assert.deepEqual(c, { total: 5, running: 1, idleUnder2h: 1, idle2to24h: 2, idleOver24h: 1, coordinated: 1, orphans: 4, remote: 0, idleMemoryMb: 600 });
});

test('landed check: a work organization or work user repository is fetched and listed as the work account, a personal one is not, and a failed fetch is never landed', async () => {
  assert.deepEqual(['https://github.com/gim-home/CIT.git', 'https://arimendelow_microsoft@github.com/arimendelow_microsoft/desk.git', 'https://github.com/teams-microsoft/x', 'git@github.com:shared-internal-tools/y.git', 'https://github.com/ourostack/shepherd.git', 'git@github.com:arimendelow/desk.git', ''].map(accountFor), ['work', 'work', 'work', 'work', 'personal', 'personal', 'personal']);
  const accounts = [];
  const s = scripted({ ...REPO, 'git remote get-url origin': 'https://github.com/gim-home/CIT.git' });
  const as = (tool) => async (cwd, args, account) => { accounts.push(`${tool} ${args[0]} ${account}`); return s.landDeps[tool](cwd, args); };
  const found = await checkLanded(wsRow(), { landDeps: { ...s.landDeps, git: as('git'), gh: as('gh') } });
  assert.equal(found.account, 'work');
  assert.ok(accounts.some((a) => a === 'git fetch work') && accounts.some((a) => a === 'gh pr work'), accounts.join(', '));
  assert.ok(!accounts.some((a) => a.endsWith('personal')));
  const failed = scripted({ ...REPO, 'git fetch': { code: 1 }, 'git remote get-url origin': 'https://github.com/gim-home/CIT.git' });
  assert.equal((await checkLanded(wsRow(), { landDeps: failed.landDeps })).outcome, 'hold');
});

test('a session a drain sends its wakes to, configured or recorded as successor, is never archived', async () => {
  const home = tmp('retire-');
  handedOff(home);
  const dir = tmp('drains-');
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ drains: [{ repo: 'o/r', session: P }] }));
  const d = testDeps(home, { app: fakeApp() });
  d.drainTargets = () => drainTargets(dir);
  const listed = [row(P, quiet), row(S, { lastActivity: iso(NOW), updatedAt: iso(NOW) })];
  const out = await retireSessions(listed, d, { apply: true });
  assert.deepEqual(out.filter((e) => e.what === 'archive'), []);
  assert.equal(out.find((e) => e.id === P).reason, 'drain-target');
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ 'o/r': { successor: { from: P, to: ORPHAN } } }));
  assert.deepEqual([...drainTargets(dir)].sort(), [P, ORPHAN].sort());
  assert.deepEqual([...drainTargets(path.join(dir, 'missing'))], []);
});

test('the shared archive door refuses a drain target, so a duty that skips retire cannot archive it', async () => {
  const home = tmp('retire-');
  const dir = tmp('drains-');
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ drains: [{ repo: 'o/r', session: P }] }));
  const d = testDeps(home, { app: fakeApp() });
  d.drainTargets = () => drainTargets(dir);
  assert.equal(await archiveRow(d, row(P, quiet), 'oversize-idle', 'big'), false);
  assert.equal(fs.existsSync(statePath(d, 'retireLog')), false);
});
