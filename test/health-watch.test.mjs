// The six-hour health watch: which resumed sessions are healthy, asked again once, reported once when still broken; the
// roster it follows; and the agent notice. Fakes only: the pretend app's socket, temp folders, and a fake ouro.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deps } from '../src/index.mjs';
import { WHY, counts, diagnose, erroredSince, healthDeps, importRoster, pass, readWatch, renderWatch, tellAgent } from '../src/health-watch.mjs';
import { startFakeApp, writeHistory } from './fake-app.mjs';

const A = 'aaaaaaaa-0000-4000-8000-000000000001', B = 'bbbbbbbb-0000-4000-8000-000000000002', C = 'cccccccc-0000-4000-8000-000000000003', D = 'dddddddd-0000-4000-8000-000000000004', E = 'eeeeeeee-0000-4000-8000-000000000005';
const ev = (type, data = {}, at = Date.now()) => [type, data, at];
const MIN = 60000;

test('erroredSince and diagnose: no turn, an error after the last turn, stuck busy and healthy are told apart', () => {
  const since = Date.parse('2026-11-15T12:00:00Z');
  const at = (m) => since + m * MIN;
  const line = (type, data = {}, t = 0) => JSON.stringify({ type, data, timestamp: new Date(t).toISOString() });
  const turn = line('assistant.turn_start', {}, at(2));
  const err = line('session.error', { message: 'rate limited' }, at(3));
  const base = { since, now: at(30), mtime: at(29), row: { interrupted: 0 }, working: false };
  assert.equal(erroredSince([turn, err], since).message, 'rate limited');
  assert.equal(erroredSince([err, line('assistant.turn_start', {}, at(4))], since), null, 'a turn after the error is a retry');
  assert.equal(diagnose({ ...base, lines: [turn] }), null);
  assert.equal(diagnose({ ...base, lines: [turn, err] }).kind, 'erroring');
  assert.equal(diagnose({ ...base, lines: [] }).kind, 'silent');
  assert.match(diagnose({ ...base, lines: [], row: { interrupted: 1 } }).why, /still flags it interrupted/);
  assert.equal(diagnose({ ...base, now: at(3), lines: [] }).kind, 'waiting', 'a session has 5 minutes to take a turn');
  assert.equal(diagnose({ ...base, now: at(200), mtime: at(60), working: true, lines: [turn] }).kind, 'stuck');
  assert.equal(diagnose({ ...base, now: at(200), mtime: at(190), working: true, lines: [turn] }), null, 'busy with recent steps is working');
  assert.equal(diagnose({ ...base, row: null, lines: [] }).kind, 'gone');
});

function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shepherd-watch-'));
  const home = path.join(root, 'copilot');
  const state = path.join(root, 'state');
  fs.mkdirSync(home, { recursive: true });
  return { root, home, state, told: [], cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

// The watch's deps over a real history under a temp home, with the app's database faked by `rows`.
function watchDeps(w, rows) {
  const base = { ...deps({ copilotHome: w.home, state: w.state }), sleep: async () => {}, sql: async () => rows };
  const d = healthDeps({ home: w.root, base });
  d.tell = async (t) => { w.told.push(t); return { ok: true }; };
  return d;
}

const writeRoster = (w, o) => { fs.mkdirSync(w.state, { recursive: true }); fs.writeFileSync(path.join(w.state, 'resume-last.json'), JSON.stringify(o)); };

test('importRoster: the newest resume record this watch has not followed; an empty one starts nothing', () => {
  const w = world();
  try {
    writeRoster(w, { at: '2026-11-15T20:09:28Z', why: null, since: '2026-11-15T20:09:00Z', resumed: [A, B], results: [{ id: A, title: 'a', outcome: 'resumed' }, { id: B, title: 'b', outcome: 'NOT RESUMED after 3 tries (socket_error)' }] });
    const r = importRoster(w.state, null);
    assert.equal(r.since, Date.parse('2026-11-15T20:09:00Z'));
    assert.equal(r.why, 'the app starting again');
    assert.deepEqual(r.sessions, [{ id: A, title: 'a', outcome: 'resumed' }, { id: B, title: 'b', outcome: 'NOT RESUMED after 3 tries (socket_error)' }]);
    assert.equal(importRoster(w.state, r), null, 'already followed');
    writeRoster(w, { at: '2026-11-15T20:19:00Z', why: null, since: '2026-11-15T20:19:00Z', resumed: [], results: [] });
    assert.equal(importRoster(w.state, r), null, 'an empty record starts nothing');
    writeRoster(w, { at: '2026-11-16T08:00:00Z', why: 'an app update', since: '2026-11-16T08:00:00Z', resumed: [C], results: [] });
    const n = importRoster(w.state, r);
    assert.equal(n.why, 'an app update');
    assert.deepEqual(n.sessions, [{ id: C, title: null, outcome: 'resumed' }]);
    assert.equal(importRoster(w.state, n), null, 'an older record never replaces a newer roster');
  } finally {
    w.cleanup();
  }
});

test('a silent session is asked again once, then reported by name once; healthy ones are never mentioned', async () => {
  const w = world();
  const since = Date.now() - 12 * MIN;
  const app = await startFakeApp(w.home, { turns: true, drop: [B] });
  try {
    writeHistory(w.home, A, [ev('user.message', {}, since + MIN), ev('assistant.turn_start', {}, since + 3 * MIN)]);
    writeHistory(w.home, C, [ev('user.message', {}, since + MIN), ev('assistant.turn_start', {}, since + 2 * MIN), ev('session.error', { message: 'model unavailable' }, since + 3 * MIN)]);
    writeHistory(w.home, D, [ev('user.message', {}, since + MIN), ev('assistant.turn_start', {}, since + 4 * MIN), ev('assistant.turn_end', {}, since + 5 * MIN)]);
    const rows = [A, B, C, D].map((id) => ({ id, title: { [A]: 'took its turn', [B]: 'never answers', [C]: 'errored out', [D]: 'finished long ago' }[id], running: 0, interrupted: 0, loc: 'local' }));
    writeRoster(w, { at: new Date(since + MIN).toISOString(), why: null, since: new Date(since).toISOString(), resumed: [A, B, C, D], results: rows.map((r) => ({ id: r.id, title: r.title, outcome: 'resumed' })) });
    const d = watchDeps(w, rows);
    const lines = [];
    const opts = { t: { deliver: 3000 } };
    const r1 = await pass(opts, d, (l) => lines.push(l));
    assert.deepEqual(counts(r1.roster), { ok: 2, pending: 0, 'asked-again': 2, broken: 0, gone: 0 });
    assert.deepEqual(app.received.map((m) => m.session_id).sort(), [B, C].sort(), 'only the two with a problem are asked again');
    assert.match(app.received[0].prompt, /^The app was restarted at \d\d:\d\d for the app starting again \(this is a second message/);
    assert.deepEqual(w.told, [], 'asking again is not reported');
    // The second message has had its ten minutes and B still has not taken a turn; C answered it.
    await new Promise((r) => setTimeout(r, 60));
    const st = d.readState();
    st.roster.sessions[B].resent = new Date(Date.now() - 11 * MIN).toISOString();
    st.roster.sessions[C].resent = new Date(Date.now() - 11 * MIN).toISOString();
    d.writeState(st);
    const r2 = await pass(opts, d, (l) => lines.push(l));
    assert.equal(r2.roster.sessions[C].status, 'ok', 'C answered the second message');
    assert.equal(r2.roster.sessions[B].status, 'broken');
    assert.equal(w.told.length, 1);
    assert.match(w.told[0], /1 of 4 resumed sessions stayed broken even after I sent the resume a second time: "never answers" \(bbbbbbbb\): silent: no turn since the app came back.*the other 3 are fine\./);
    assert.equal(app.received.length, 2, 'it asks once, not forever: B and C, once each');
    await pass(opts, d, (l) => lines.push(l));
    assert.equal(w.told.length, 1, 'told once');
    const text = renderWatch(readWatch(w.state));
    assert.match(text, /health watch: 4 session\(s\) resumed after the app starting again.*3 healthy, 0 waiting, 0 asked again, 1 BROKEN/);
    assert.match(text, /broken bbbbbbbb never answers: silent/);
    assert.ok(lines.some((l) => /aaaaaaaa .*healthy/.test(l)), 'a healthy session is noted in the log');
    assert.ok(!lines.some((l) => /(aaaaaaaa|dddddddd).*(broken|asked|resume once more)/.test(l)), 'healthy sessions are never called broken or asked again');
  } finally {
    await app.close();
    w.cleanup();
  }
});

test('a session busy with no step for 90 minutes is stuck; after the six hours the watch ends', async () => {
  const w = world();
  const since = Date.now() - 4 * 3600000;
  const file = writeHistory(w.home, E, [ev('user.message', {}, since + 1000), ev('assistant.turn_start', {}, since + 2000)]);
  const old = new Date(Date.now() - 3 * 3600000);
  fs.utimesSync(file, old, old);
  const app = await startFakeApp(w.home);
  try {
    writeRoster(w, { at: new Date(since).toISOString(), why: null, since: new Date(since).toISOString(), resumed: [E], results: [{ id: E, title: 'stuck one', outcome: 'resumed' }] });
    const d = watchDeps(w, [{ id: E, title: 'stuck one', running: 1, interrupted: 0, loc: 'local' }]);
    const r = await pass({ t: { deliver: 3000 } }, d);
    assert.match(r.roster.sessions[E].problem, /^stuck: busy, with no step in its history for 1\d\d min/);
    assert.equal(app.received.length, 1);
    const st = d.readState();
    st.roster.until = new Date(Date.now() - 1000).toISOString();
    d.writeState(st);
    assert.equal((await pass({ t: { deliver: 3000 } }, d)).action, 'finished');
    assert.equal(app.received.length, 1, 'nothing is sent after the six hours');
  } finally {
    await app.close();
    w.cleanup();
  }
});

test('a session that is gone from the app is dropped from the roster without a message', async () => {
  const w = world();
  try {
    writeRoster(w, { at: new Date().toISOString(), why: null, since: new Date().toISOString(), resumed: [A], results: [{ id: A, title: 'archived since', outcome: 'resumed' }] });
    const d = watchDeps(w, []);
    const r = await pass({}, d, () => {});
    assert.equal(r.roster.sessions[A].status, 'gone');
    assert.deepEqual(w.told, []);
  } finally {
    w.cleanup();
  }
});

test('tellAgent runs ouro msg with the reason and logs each attempt; without ouro it logs the failure and never throws', async () => {
  const w = world();
  const bin = path.join(w.root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'ouro'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${path.join(bin, 'argv.txt')}'\n`, { mode: 0o755 });
  try {
    const tell = tellAgent({ state: w.state, home: w.root, env: { ...process.env, PATH: bin } });
    assert.deepEqual(await tell('one line'), { ok: true, error: null });
    assert.deepEqual(fs.readFileSync(path.join(bin, 'argv.txt'), 'utf8').split('\n').slice(0, 6), ['msg', '--to', 'ouroboros', '--why', WHY, 'one line']);
    const none = tellAgent({ state: w.state, home: w.root, env: { ...process.env, PATH: path.join(w.root, 'empty') } });
    const r = await none('again');
    assert.equal(r.ok, false);
    assert.match(r.error, /the ouro CLI was not found/);
    const log = fs.readFileSync(path.join(w.state, 'told.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(log.map((x) => [x.text, x.ok]), [['one line', true], ['again', false]]);
  } finally {
    w.cleanup();
  }
});
