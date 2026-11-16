// The retire duties: a handed-off session is archived once its successor has taken a turn; an idle orphan after a day. Plus the
// config gate, and the plan that changes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FINISHED_IDLE_MS, HANDOFF_QUIET_MS, childrenNote, retireConfig, retireSessions, watchRetire } from '../src/retire.mjs';
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
  assert.deepEqual(retireConfig(file), { enabled: false });
  fs.writeFileSync(file, '{"enabled": "yes"}');
  assert.deepEqual(retireConfig(file), { enabled: false });
  fs.writeFileSync(file, '{"enabled": true}');
  assert.deepEqual(retireConfig(file), { enabled: true });
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
