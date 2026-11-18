// Idle runtimes under swap pressure: only runtimes whose hosted sessions are all long idle and landed are stopped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { holdReason, planUnload, unloadIdle } from '../src/unload.mjs';

const NOW = Date.parse('2026-11-18T12:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();
const row = (id, over = {}) => ({ id, state: 'idle', isRunning: false, lastActivity: hoursAgo(5), updatedAt: hoursAgo(5), ...over });
const d = (landed = 'clean') => ({ now: () => NOW, checkLanded: async () => ({ outcome: landed, why: 'edits not pushed' }) });
const rt = (pid, sessions, rssMb = 1000) => ({ pid, rssMb, sessions });

test('nothing is stopped below the swap threshold', async () => {
  const p = await planUnload({ runtimes: [rt(1, ['a'])], listed: [row('a')], d: d(), swapPct: 60 });
  assert.equal(p.pressure, false);
  assert.deepEqual(p.stop, []);
});

test('a long-idle landed session is stopped, largest runtime first, at most two a pass', async () => {
  const listed = ['a', 'b', 'c'].map((id) => row(id));
  const p = await planUnload({ runtimes: [rt(1, ['a'], 900), rt(2, ['b'], 1500), rt(3, ['c'], 1200)], listed, d: d(), swapPct: 95 });
  assert.deepEqual(p.stop.map((s) => s.pid), [2, 3]);
});

test('working, waiting, recent, automated, remote and open-PR sessions keep their runtime', () => {
  for (const [over, why] of [[{ isRunning: true }, /working/], [{ awaiting: true }, /person/], [{ lastActivity: hoursAgo(1), updatedAt: hoursAgo(1) }, /2 hours/], [{ automation: true }, /automation/], [{ remote: true }, /remote/], [{ openPullRequest: 'x' }, /pull request/]]) {
    assert.match(holdReason(row('a', over), [], NOW), why);
  }
  assert.equal(holdReason(row('a'), [], NOW), null);
});

test('a coordinator whose child works keeps its runtime', async () => {
  const listed = [row('a'), row('b', { parentSessionId: 'a', isRunning: true, state: 'busy' })];
  const p = await planUnload({ runtimes: [rt(1, ['a'])], listed, d: d(), swapPct: 95 });
  assert.equal(p.stop.length, 0);
  assert.match(p.keep[0].why, /coordinates/);
});

test('one running session in a shared runtime saves the whole runtime', async () => {
  const listed = [row('a'), row('b', { isRunning: true, state: 'busy' })];
  const p = await planUnload({ runtimes: [rt(1, ['a', 'b'])], listed, d: d(), swapPct: 95 });
  assert.equal(p.stop.length, 0);
});

test('unlanded work, an unknown session and an unattributed runtime are left alone', async () => {
  assert.equal((await planUnload({ runtimes: [rt(1, ['a'])], listed: [row('a')], d: d('hold'), swapPct: 95 })).stop.length, 0);
  assert.equal((await planUnload({ runtimes: [rt(1, ['a'])], listed: [row('a')], d: d('land'), swapPct: 95 })).stop.length, 0);
  assert.equal((await planUnload({ runtimes: [rt(1, ['zz'])], listed: [row('a')], d: d(), swapPct: 95 })).stop.length, 0);
  assert.equal((await planUnload({ runtimes: [rt(1, [])], listed: [row('a')], d: d(), swapPct: 95 })).stop.length, 0);
});

test('a plan kills nothing; apply kills the chosen runtimes', async () => {
  const killed = [];
  const kill = async (pid) => { killed.push(pid); return true; };
  const args = { runtimes: [rt(7, ['a'])], listed: [row('a')], d: d(), swapPct: 95 };
  await unloadIdle(args, kill);
  assert.deepEqual(killed, []);
  const r = await unloadIdle({ ...args, apply: true }, kill);
  assert.deepEqual(killed, [7]);
  assert.equal(r.stop[0].done, true);
});
