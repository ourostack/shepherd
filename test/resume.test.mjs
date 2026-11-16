// resume(): the one resume message per session after a restart, the turn each must take, and the record the health watch
// follows. Runs against the pretend app's socket and temp histories; nothing touches a real app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAX_HISTORY_BYTES, deps, pickTargets, resume, resumeText } from '../src/index.mjs';
import { startFakeApp, writeHistory } from './fake-app.mjs';

const A = 'aaaaaaaa-0000-4000-8000-000000000001', B = 'bbbbbbbb-0000-4000-8000-000000000002', C = 'cccccccc-0000-4000-8000-000000000003', BIG = 'eeeeeeee-0000-4000-8000-000000000005';
const ev = (type, data = {}, at = Date.now()) => [type, data, at];

// Fake deps: the real history and socket under a temp home; the waits are short so the tests are quick.
function world() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shepherd-resume-'));
  const state = path.join(home, 'state');
  const d = { ...deps({ copilotHome: home, state }), sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))) };
  return { home, state, d, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

const FAST = { delivery: 3000, retry: 300, backoff: [0] };

test('pickTargets: what was working, what the restart interrupted, and what was named; an old crash flag is left alone', () => {
  const before = [{ id: A, state: 'busy', why: 'mid-turn' }, { id: B, state: 'idle', interrupted: true }, { id: C, state: 'idle' }];
  const after = [{ id: A, interrupted: true }, { id: B, interrupted: true }, { id: C, interrupted: true, title: 'c' }, { id: BIG, state: 'idle', oversize: MAX_HISTORY_BYTES + 1, why: 'its history is 501 MB, over the 500 MB resume cap' }];
  const t = pickTargets({ before, after, also: [BIG] });
  assert.deepEqual(t.map((x) => [x.id.slice(0, 1), x.known]), [['a', true], ['c', true], ['e', true]]);
  assert.equal(t[2].oversize, MAX_HISTORY_BYTES + 1, 'an over-cap history is carried with its size and reason');
  assert.match(t[2].sizeWhy, /500 MB resume cap/);
  assert.equal(t[0].oversize, null);
  assert.deepEqual(pickTargets({ before, after: [], also: ['dddddddd'] }).map((x) => [x.id.slice(0, 1), x.known]), [['a', false], ['d', false]]);
});

test('resumeText says when, why, the lanes it had said were running, and what to do', () => {
  const at = new Date(2026, 10, 14, 13, 5).getTime();
  assert.match(resumeText({ at, why: 'an app update' }), /^The app was restarted at 13:05 for an app update; resume where you left off\./);
  assert.match(resumeText({ at, why: null, lanes: { lanes: 3, minutes: 45 } }), /You had said 3 lanes were still running \(about 45 min from done\): the restart went ahead without waiting longer, so those lanes were stopped; restart them from their pushed state\.$/);
  assert.doesNotMatch(resumeText({ at, why: null }), /You had said/);
});

test('resume: a session that takes a turn is resumed, and the record the health watch follows is written', async () => {
  const w = world();
  const app = await startFakeApp(w.home, { turns: true });
  try {
    const startedAt = Date.now() - 1000;
    writeHistory(w.home, A, [ev('user.message', {}, startedAt - 5000), ev('assistant.turn_start', {}, startedAt - 4000)]);
    const targets = pickTargets({ before: [{ id: A, state: 'busy', why: 'mid-turn' }], after: [{ id: A, title: 'busy a', state: 'idle' }] });
    const restartedAt = Date.now();
    const results = await resume(w.d, { targets, startedAt, restartedAt, why: 'an app update', t: FAST });
    assert.equal(results.length, 1);
    assert.equal(results[0].outcome, 'resumed');
    assert.equal(results[0].tries, 1);
    assert.equal(results[0].title, 'busy a');
    assert.equal(app.received.length, 1);
    assert.match(app.received[0].prompt, /^The app was restarted at \d\d:\d\d for an app update; resume where you left off\./);
    const rec = JSON.parse(fs.readFileSync(path.join(w.state, 'resume-last.json'), 'utf8'));
    assert.deepEqual(rec.resumed, [A]);
    assert.equal(rec.why, 'an app update');
    assert.equal(rec.since, new Date(restartedAt).toISOString());
    assert.equal(rec.results[0].outcome, 'resumed');
  } finally {
    await app.close();
    w.cleanup();
  }
});

test('resume: a session something already continued is not messaged twice, and one a resumer messaged that never took a turn still gets ours', async () => {
  const w = world();
  const app = await startFakeApp(w.home, { turns: true });
  try {
    const startedAt = Date.now() - 10000;
    const targets = [{ id: A, why: 'was working', known: true, title: 'a', oversize: null, sizeWhy: null }, { id: B, why: 'was working', known: true, title: 'b', oversize: null, sizeWhy: null }];
    writeHistory(w.home, A, [ev('user.message', {}, startedAt + 5000), ev('assistant.turn_start', {}, startedAt + 5001)]);
    writeHistory(w.home, B, [ev('user.message', {}, startedAt + 5000)]);
    const results = await resume(w.d, { targets, startedAt, restartedAt: startedAt, t: { ...FAST, retry: 100 } });
    assert.deepEqual(results.map((r) => [r.id, r.outcome]), [[A, 'already continued'], [B, 'resumed']]);
    assert.deepEqual(app.received.map((m) => m.session_id), [B], 'only the session nobody answered gets a message');
    const rec = JSON.parse(fs.readFileSync(path.join(w.state, 'resume-last.json'), 'utf8'));
    assert.deepEqual(rec.resumed, [A, B], 'already continued counts as resumed for the health watch');
  } finally {
    await app.close();
    w.cleanup();
  }
});

test('resume: an archived or unknown session is reported gone, not retried', async () => {
  const w = world();
  const app = await startFakeApp(w.home, { refuse: [A] });
  try {
    const targets = [{ id: A, why: 'was working', known: true, title: 'archived one', oversize: null, sizeWhy: null }, { id: C, why: 'named with --also', known: false, title: null, oversize: null, sizeWhy: null }];
    const results = await resume(w.d, { targets, startedAt: Date.now(), restartedAt: Date.now(), t: FAST });
    assert.match(results[0].outcome, /^gone: .*is archived$/);
    assert.equal(results[0].tries, undefined);
    assert.equal(results[1].outcome, 'gone: the app has no such live session (archived or deleted)');
    assert.deepEqual(app.received.map((m) => m.session_id), [A], 'the unknown one is never sent');
    assert.equal(fs.existsSync(path.join(w.state, 'resume-last.json')), false, 'nothing resumed, so no record');
  } finally {
    await app.close();
    w.cleanup();
  }
});

test('resume: a session that is delivered but never takes a turn is named with its reason after the tries', async () => {
  const w = world();
  const app = await startFakeApp(w.home, { turns: true, drop: [A] });
  try {
    const targets = [{ id: A, why: 'was working', known: true, title: 'silent', oversize: null, sizeWhy: null }];
    const log = [];
    const results = await resume(w.d, { targets, startedAt: Date.now(), restartedAt: Date.now(), t: { ...FAST, tries: 2 }, log: (l) => log.push(l) });
    assert.equal(results[0].outcome, 'NOT RESUMED after 2 tries (delivered but no new turn)');
    assert.equal(app.received.length, 2);
    assert.ok(log.some((l) => /^NOT RESUMED: 1 of 1 session\(s\): aaaaaaaa "silent": NOT RESUMED after 2 tries/.test(l)), log.join('\n'));
  } finally {
    await app.close();
    w.cleanup();
  }
});

test('resume: a history over the cap is logged and handed to heldBack, never sent', async () => {
  const w = world();
  const app = await startFakeApp(w.home, { turns: true });
  try {
    const held = [];
    w.d.heldBack = (list) => held.push(...list);
    const targets = pickTargets({ before: [], after: [{ id: BIG, title: 'big', state: 'idle', oversize: MAX_HISTORY_BYTES + 1, why: 'its history is 501 MB, over the 500 MB resume cap' }], also: [BIG] });
    const log = [];
    const results = await resume(w.d, { targets, startedAt: Date.now(), restartedAt: Date.now(), t: FAST, log: (l) => log.push(l) });
    assert.deepEqual(results, []);
    assert.equal(app.received.length, 0);
    assert.deepEqual(held, [{ id: BIG, title: 'big', bytes: MAX_HISTORY_BYTES + 1 }]);
    assert.match(log[0], /^eeeeeeee "big": NOT resumed: its history is 501 MB, over the 500 MB resume cap; it needs a hand-off to a fresh session$/);
  } finally {
    await app.close();
    w.cleanup();
  }
});

test('resume: sends go out concurrently up to a small limit, a failed send is retried after a pause, and a session that still fails is named with its reason', async () => {
  const ids = Array.from({ length: 6 }, (_, i) => `1000000${i}-0000-4000-8000-00000000000${i}`);
  const [FLAKY, DEAD] = [ids[1], ids[2]];
  const w = world();
  const app = await startFakeApp(w.home, { turns: true });
  try {
    const targets = pickTargets({ before: ids.map((id) => ({ id, state: 'busy', why: 'mid-turn' })), after: ids.map((id, i) => ({ id, title: `s${i}`, state: 'idle' })) });
    let live = 0, peak = 0;
    const failures = new Map([[FLAKY, 1], [DEAD, 99]]);
    const sleeps = [];
    const exchange = w.d.exchange;
    w.d.sleep = async (ms) => { sleeps.push(ms); await new Promise((r) => setTimeout(r, 1)); };
    w.d.exchange = async (messages, o) => {
      const id = messages[0]?.session_id;
      if (id && /restarted at/.test(messages[0].prompt) && failures.get(id) > 0) { failures.set(id, failures.get(id) - 1); return [{ type: 'socket_error' }]; }
      if (!/restarted at/.test(messages[0]?.prompt || '')) return exchange(messages, o);
      live++; peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 40));
      try { return await exchange(messages, o); } finally { live--; }
    };
    const log = [];
    const results = await resume(w.d, { targets, startedAt: Date.now(), restartedAt: Date.now(), t: { ...FAST, concurrency: 3, tries: 3, backoff: [111, 222] }, log: (l) => log.push(l) });
    assert.ok(peak > 1 && peak <= 3, `peak in flight ${peak}`);
    assert.equal(results.find((x) => x.id === FLAKY).tries, 2);
    assert.ok(sleeps.includes(111) && sleeps.includes(222), `backoff between tries: ${sleeps}`);
    assert.match(results.find((x) => x.id === DEAD).outcome, /^NOT RESUMED after 3 tries \(socket_error: the app's socket refused or dropped the connection\)/);
    assert.ok(log.some((l) => /^NOT RESUMED: 1 of 6 session\(s\): 10000002 "s2": NOT RESUMED after 3 tries \(socket_error/.test(l)), log.join('\n'));
  } finally {
    await app.close();
    w.cleanup();
  }
});
