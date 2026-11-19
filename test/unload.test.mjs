// Idle runtimes under memory pressure: only runtimes whose hosted sessions are all long idle and landed are stopped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { holdReason, planUnload, unloadIdle } from '../src/unload.mjs';

const NOW = Date.parse('2026-11-18T12:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();
const row = (id, over = {}) => ({ id, state: 'idle', isRunning: false, lastActivity: hoursAgo(5), updatedAt: hoursAgo(5), ...over });
const d = (landed = 'clean') => ({ now: () => NOW, checkLanded: async () => ({ outcome: landed, why: 'edits not pushed' }) });
const STRESSED = { stressed: true, why: 'memory pressure warning' };
const CALM = { stressed: false, why: '' };
const rt = (pid, sessions, rssMb = 1000) => ({ pid, rssMb, sessions });

test('nothing is stopped without memory pressure', async () => {
  const p = await planUnload({ runtimes: [rt(1, ['a'])], listed: [row('a')], d: d(), stress: CALM });
  assert.equal(p.pressure, false);
  assert.deepEqual(p.stop, []);
});

test('a long-idle landed session is stopped, largest runtime first, at most six a pass', async () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const listed = ids.map((id) => row(id));
  const p = await planUnload({ runtimes: ids.map((id, i) => rt(i + 1, [id], 900 + i * 100)), listed, d: d(), stress: STRESSED });
  assert.deepEqual(p.stop.map((s) => s.pid), [7, 6, 5, 4, 3, 2]);
});

test('working, waiting, recent, automated, remote and open-PR sessions keep their runtime', () => {
  for (const [over, why] of [[{ isRunning: true }, /working/], [{ awaiting: true }, /person/], [{ lastActivity: hoursAgo(1), updatedAt: hoursAgo(1) }, /2 hours/], [{ automation: true }, /automation/], [{ remote: true }, /remote/], [{ openPullRequest: 'x' }, /pull request/]]) {
    assert.match(holdReason(row('a', over), [], NOW), why);
  }
  assert.equal(holdReason(row('a'), [], NOW), null);
});

test('a coordinator whose child works keeps its runtime', async () => {
  const listed = [row('a'), row('b', { parentSessionId: 'a', isRunning: true, state: 'busy' })];
  const p = await planUnload({ runtimes: [rt(1, ['a'])], listed, d: d(), stress: STRESSED });
  assert.equal(p.stop.length, 0);
  assert.match(p.keep[0].why, /coordinates/);
});

test('one running session in a shared runtime saves the whole runtime', async () => {
  const listed = [row('a'), row('b', { isRunning: true, state: 'busy' })];
  const p = await planUnload({ runtimes: [rt(1, ['a', 'b'])], listed, d: d(), stress: STRESSED });
  assert.equal(p.stop.length, 0);
});

test('unlanded work, an unknown session and an unattributed runtime are left alone', async () => {
  assert.equal((await planUnload({ runtimes: [rt(1, ['a'])], listed: [row('a')], d: d('hold'), stress: STRESSED })).stop.length, 0);
  assert.equal((await planUnload({ runtimes: [rt(1, ['a'])], listed: [row('a')], d: d('land'), stress: STRESSED })).stop.length, 0);
  assert.equal((await planUnload({ runtimes: [rt(1, ['zz'])], listed: [row('a')], d: d(), stress: STRESSED })).stop.length, 0);
  assert.equal((await planUnload({ runtimes: [rt(1, [])], listed: [row('a')], d: d(), stress: STRESSED })).stop.length, 0);
});

test('a plan kills nothing; apply kills the chosen runtimes', async () => {
  const killed = [];
  const kill = async (pid) => { killed.push(pid); return true; };
  const args = { runtimes: [rt(7, ['a'])], listed: [row('a')], d: d(), stress: STRESSED };
  await unloadIdle(args, kill);
  assert.deepEqual(killed, []);
  const r = await unloadIdle({ ...args, apply: true }, kill);
  assert.deepEqual(killed, [7]);
  assert.equal(r.stop[0].done, true);
});

test('a runtime hosts the sessions found in the environment of its descendants, through wrappers', async () => {
  const { parseRuntimes } = await import('../src/unload.mjs');
  const a = '11111111-1111-1111-1111-111111111111';
  const b = '22222222-2222-2222-2222-222222222222';
  const out = [
    ' 10 1 2048 /x/copilot-runtime --server --stdio HOME=/h',
    ` 11 10 100 node mcp COPILOT_AGENT_SESSION_ID=${a}`,
    ' 12 10 100 wrapper',
    ` 13 12 100 node mcp COPILOT_AGENT_SESSION_ID=${b}`,
    ` 14 1 100 node other COPILOT_AGENT_SESSION_ID=${b}`,
  ].join('\n');
  const [r] = parseRuntimes(out);
  assert.equal(r.pid, 10);
  assert.equal(r.rssMb, 2);
  assert.deepEqual(r.sessions.sort(), [a, b]);
});

test('an archived session holds no runtime: a runtime whose sessions are all archived or idle and landed is stopped, one hosting an unknown session is not', async () => {
  const archived = new Set(['x', 'y']);
  const base = { listed: [row('a')], d: d(), stress: STRESSED, archived };
  assert.deepEqual((await planUnload({ ...base, runtimes: [rt(1, ['x', 'y'])] })).stop.map((s) => s.pid), [1]);
  assert.deepEqual((await planUnload({ ...base, runtimes: [rt(2, ['x', 'a'])] })).stop.map((s) => s.pid), [2]);
  assert.equal((await planUnload({ ...base, runtimes: [rt(3, ['x', 'zz'])] })).stop.length, 0, 'an unknown session is not an archived one');
  const live = { ...base, listed: [row('a', { lastActivity: hoursAgo(0.1), updatedAt: hoursAgo(0.1) })] };
  assert.equal((await planUnload({ ...live, runtimes: [rt(4, ['x', 'a'])] })).stop.length, 0, 'a recent session keeps it');
});

test('a coordinator named for its role, or one that made a session in the last day, keeps its runtime; a working child keeps it too', async () => {
  assert.match(holdReason(row('a', { name: 'Desk epoch 3 (2)' }), [], NOW), /coordinator role/);
  assert.match(holdReason(row('a'), [row('b', { creatorSessionId: 'a', createdAt: hoursAgo(3) })], NOW), /last day/);
  assert.equal(holdReason(row('a'), [row('b', { creatorSessionId: 'a', createdAt: hoursAgo(40) })], NOW), null);
});

test('a heavy runtime (by footprint, not rss) goes after 15 quiet minutes, even a coordinator that made a session today', async () => {
  const { parseFootprint } = await import('../src/unload.mjs');
  assert.equal(parseFootprint('copilot-runtime [1]: 64-bit    Footprint: 17 GB (16384 bytes per page)'), 17408);
  assert.equal(parseFootprint('x Footprint: 3183 MB (y)'), 3183);
  const mins = (m) => new Date(NOW - m * 60000).toISOString();
  const listed = [
    row('a', { name: 'desk epoch 3', lastActivity: mins(20), updatedAt: mins(20) }),
    row('k', { createdAt: hoursAgo(1), parentSessionId: 'a', lastActivity: mins(20), updatedAt: mins(20) }),
  ];
  const heavy = await planUnload({ runtimes: [{ pid: 1, rssMb: 300, footprintMb: 17000, sessions: ['a', 'k'] }], listed, d: d(), stress: STRESSED });
  assert.equal(heavy.stop.length, 1);
  assert.equal(heavy.stop[0].footprintMb, 17000);
  const light = await planUnload({ runtimes: [{ pid: 1, rssMb: 300, footprintMb: 400, sessions: ['a', 'k'] }], listed, d: d(), stress: STRESSED });
  assert.equal(light.stop.length, 0);
  const mid = await planUnload({ runtimes: [{ pid: 1, rssMb: 300, footprintMb: 1200, sessions: ['a', 'k'] }], listed, d: d(), stress: STRESSED });
  assert.equal(mid.stop.length, 1, 'a 1.2 GB coordinator runtime quiet for 20 minutes goes');
  const busy = await planUnload({ runtimes: [{ pid: 1, rssMb: 300, footprintMb: 17000, sessions: ['a', 'k'] }], listed: [...listed, row('w', { parentSessionId: 'a', isRunning: true, state: 'busy' })], d: d(), stress: STRESSED });
  assert.equal(busy.stop.length, 0);
  const recent = await planUnload({ runtimes: [{ pid: 1, rssMb: 300, footprintMb: 17000, sessions: ['k'] }], listed: [row('k', { lastActivity: mins(5), updatedAt: mins(5) })], d: d(), stress: STRESSED });
  assert.equal(recent.stop.length, 0);
});

test('heavy runtimes are stopped largest footprint first', async () => {
  const listed = [row('a'), row('b')];
  const p = await planUnload({ runtimes: [{ pid: 1, rssMb: 900, footprintMb: 2000, sessions: ['a'] }, { pid: 2, rssMb: 100, footprintMb: 9000, sessions: ['b'] }], listed, d: d(), stress: STRESSED });
  assert.deepEqual(p.stop.map((s) => s.pid), [2, 1]);
});
