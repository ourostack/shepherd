// Wake runners, against fakes: the command's output is parsed, each wake goes to its session once the last one there has
// landed, replaces takes back the queued ones, and the state and config are read and written. No app and no real command
// is touched beyond a node one-liner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WAKE_HOLD_MS, parseWakeOutput, planWakes, readWakeStates, runCommand, runDueWakes, runWakeRunner, runWakeRunners, wakeDelivered, wakeSender, wakeStatusLines, wakesConfig, withdrawQueued } from '../src/wakes.mjs';
import { fakeApp, NOW, testDeps, writeHistory } from './fake-sidebar.mjs';

const SESSION = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const OTHER = 'aaaaaaaa-0000-4000-8000-0000000000a2';
const RUNNER = { name: 'issues', command: ['/bin/poller', 'poll'], everySeconds: 300, delivery: 'immediate', session: SESSION };
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), name));
const printed = (value) => ({ ok: true, stdout: JSON.stringify(value), error: null });

// A fake command line: `poll` prints what the test set, every other argv is a `done` report that lands in `reports`.
function world(output, send = async () => ({ ok: true, error: null })) {
  const w = {
    reports: [],
    sent: [],
    replaced: [],
    reportResult: { ok: true, stdout: '', error: null },
    output: printed(output),
    delivered: new Set(),
    run: async (argv) => {
      if (argv[1] === 'poll') return w.output;
      w.reports.push(argv);
      return w.reportResult;
    },
    send: async (session, message, _delivery, replaces) => {
      w.sent.push([session, message]);
      if (replaces) w.replaced.push([session, replaces]);
      return send(session, message);
    },
    deps: (now = NOW) => ({ run: w.run, send: w.send, delivered: (_s, message) => w.delivered.has(message), now }),
    go: (previous, now = NOW) => runWakeRunner(RUNNER, w.deps(now), previous),
  };
  return w;
}

test('the command output is read as wakes and status lines, cleaned and bounded, and a bad shape is refused', () => {
  const status = ['fine', 'bad\u0007line\nwith break', '', 4, 'x'.repeat(400), ...Array.from({ length: 30 }, (_, i) => `l${i}`)];
  const out = parseWakeOutput(JSON.stringify({ wakes: [{ message: 'm', session: 's', done: ['a', 'b'] }, { message: 'n' }], status }));
  assert.deepEqual(out.wakes, [{ message: 'm', session: 's', done: ['a', 'b'] }, { message: 'n' }]);
  assert.equal(out.status.length, 20);
  assert.deepEqual(out.status.slice(0, 2), ['fine', 'bad line with break']);
  assert.equal(out.status[2].length, 300);
  assert.deepEqual(parseWakeOutput(JSON.stringify({ wakes: [] })).status, []);
  for (const [stdout, message] of [
    ['not json', 'the command did not print JSON'],
    ['[]', 'no "wakes" array'],
    ['null', 'no "wakes" array'],
    ['{"wakes":"x"}', 'no "wakes" array'],
    ['{"wakes":[null]}', 'wakes[0] has no message'],
    ['{"wakes":[{"message":" "}]}', 'wakes[0] has no message'],
    ['{"wakes":[{"message":"m","session":" "}]}', 'wakes[0].session'],
    ['{"wakes":[{"message":"m","replaces":4}]}', 'wakes[0].replaces'],
    ['{"wakes":[{"message":"m","done":[]}]}', 'wakes[0].done'],
    ['{"wakes":[{"message":"m","done":[1]}]}', 'wakes[0].done'],
  ]) assert.throws(() => parseWakeOutput(stdout), (e) => e.message.includes(message), stdout);
});

test('a command runs with no shell and returns what it printed; a failure is named by its program and first stderr line', async () => {
  assert.deepEqual(await runCommand([process.execPath, '-e', "process.stdout.write('$HOME;ok')"], 10_000), { ok: true, stdout: '$HOME;ok', error: null });
  const failed = await runCommand([process.execPath, '-e', "console.error('first\\nsecond'); process.exit(3)"], 10_000);
  assert.equal(failed.ok, false);
  assert.match(failed.error, /^node failed: first$/);
  assert.match((await runCommand(['/nonexistent/program'], 10_000)).error, /^program failed: .*ENOENT/);
  assert.equal((await runCommand([process.execPath, '-e', 'setTimeout(() => {}, 5000)'], 100)).ok, false);
});

test('each wake goes to its session, the runner\'s session when it names none, and each delivery is reported', async () => {
  const w = world({ wakes: [{ message: 'one', session: OTHER, done: ['/bin/poller', 'ack', '1'] }, { message: 'two', done: ['/bin/poller', 'ack', '2'] }], status: ['polled just now'] });
  const state = await w.go();
  assert.deepEqual(w.sent, [[OTHER, 'one'], [SESSION, 'two']]);
  assert.deepEqual(w.reports, [['/bin/poller', 'ack', '1'], ['/bin/poller', 'ack', '2']]);
  const at = new Date(NOW).toISOString();
  assert.deepEqual(state, {
    lastRunAt: at, lastWakes: 2, lastDelivered: 2, status: ['polled just now'],
    open: { [OTHER]: { at, message: 'one' }, [SESSION]: { at, message: 'two' } },
  });
});

test('a wake is delivered immediately unless the runner asks for enqueue', async () => {
  const w = world({ wakes: [{ message: 'one' }] });
  await w.go();
  assert.equal(w.sent.length, 1);
  const calls = [];
  await runWakeRunner({ ...RUNNER, delivery: 'enqueue' }, { ...w.deps(), send: async (...args) => { calls.push(args); return { ok: true, error: null }; } });
  assert.deepEqual(calls[0], [SESSION, 'one', 'enqueue', undefined]);
});

test('a new wake is held while the last one sent to its session has not reached it, and goes once that one lands', async () => {
  const w = world({ wakes: [{ message: 'first', done: ['/bin/poller', 'ack', '1'] }] });
  const first = await w.go();
  w.output = printed({ wakes: [{ message: 'second', done: ['/bin/poller', 'ack', '2'] }] });
  const second = await w.go(first, NOW + 300_000);
  assert.deepEqual(w.sent, [[SESSION, 'first']]);
  assert.deepEqual(w.reports[1], ['/bin/poller', 'ack', '2', '--error', 'held: the wake sent 5 min ago has not reached the session yet']);
  assert.equal(second.lastDelivered, 0);
  assert.deepEqual(second.open, { [SESSION]: { at: new Date(NOW).toISOString(), message: 'first' } });
  assert.match(second.lastError, /^could not deliver a wake: held:/);
  w.delivered.add('first');
  const third = await w.go(second, NOW + 600_000);
  assert.deepEqual(w.sent, [[SESSION, 'first'], [SESSION, 'second']]);
  assert.deepEqual(third.open, { [SESSION]: { at: new Date(NOW + 600_000).toISOString(), message: 'second' } });
  w.delivered.add('second');
  w.output = printed({ wakes: [] });
  assert.equal((await w.go(third, NOW + 900_000)).open, undefined);
});

test('a wake that names what it replaces is sent rather than held, and takes the older queued ones back', async () => {
  const w = world({ wakes: [{ message: 'first', replaces: 'News:' }] });
  const first = await w.go();
  w.output = printed({ wakes: [{ message: 'second', replaces: 'News:', done: ['/bin/poller', 'ack', '2'] }] });
  const second = await w.go(first, NOW + 300_000);
  assert.deepEqual(w.sent, [[SESSION, 'first'], [SESSION, 'second']]);
  assert.deepEqual(w.replaced, [[SESSION, 'News:'], [SESSION, 'News:']]);
  assert.deepEqual(w.reports, [['/bin/poller', 'ack', '2']]);
  assert.equal(second.lastDelivered, 1);
  assert.equal(second.lastError, undefined);
});

test('a wake that never shows up is lost after the hold, and each session is held on its own', async () => {
  const w = world({ wakes: [{ message: 'a', session: 's1' }] });
  const first = await w.go();
  w.output = printed({ wakes: [{ message: 'b', session: 's1' }, { message: 'c', session: 's2' }] });
  const held = await w.go(first, NOW + 60_000);
  assert.deepEqual(w.sent.map(([session]) => session), ['s1', 's2']);
  assert.equal(held.open.s1.message, 'a');
  assert.equal(held.open.s2.message, 'c');
  w.output = printed({ wakes: [{ message: 'd', session: 's1' }] });
  const later = await w.go(held, NOW + WAKE_HOLD_MS + 1000);
  assert.deepEqual(w.sent.at(-1), ['s1', 'd']);
  assert.equal(later.open.s1.message, 'd');
});

test('a failed command keeps what is in flight, and delivers nothing', async () => {
  const w = world({ wakes: [{ message: 'a' }] });
  const first = await w.go();
  w.output = { ok: false, stdout: '', error: 'poller failed: no token' };
  assert.deepEqual((await w.go(first, NOW + 1000)).open, first.open);
  assert.deepEqual(await w.go(undefined, NOW + 2000), { lastRunAt: new Date(NOW + 2000).toISOString(), lastError: 'poller failed: no token' });
  w.output = { ok: false, stdout: '', error: null };
  assert.equal((await w.go()).lastError, 'the command failed');
  w.output = { ok: true, stdout: 'oops', error: null };
  assert.equal((await w.go()).lastError, 'the command did not print JSON');
  assert.equal(w.sent.length, 1);
});

test('no wakes means nothing is sent', async () => {
  const w = world({ wakes: [] });
  assert.deepEqual(await w.go(), { lastRunAt: new Date(NOW).toISOString(), lastWakes: 0, lastDelivered: 0, status: [] });
  assert.equal(w.sent.length, 0);
});

test('a refused send is reported with its reason, and a refusal with none still gets one, so the command keeps the wake', async () => {
  const w = world({ wakes: [{ message: 'a', done: ['/bin/poller', 'ack', 'a'] }, { message: 'b', done: ['/bin/poller', 'ack', 'b'] }] }, async (_s, message) => ({ ok: false, error: message === 'a' ? 'the app did not answer in time' : null }));
  const state = await w.go();
  assert.deepEqual(w.reports, [['/bin/poller', 'ack', 'a', '--error', 'the app did not answer in time'], ['/bin/poller', 'ack', 'b', '--error', 'the app refused the message']]);
  assert.equal(state.lastDelivered, 0);
  assert.equal(state.lastError, 'could not deliver a wake: the app did not answer in time');
});

test('a send that throws is a failed wake, and the next wake still goes', async () => {
  let calls = 0;
  const w = world({ wakes: [{ message: 'a' }, { message: 'b' }] }, async () => {
    if (calls++ === 0) throw new Error('socket closed');
    return { ok: true, error: null };
  });
  const state = await w.go();
  assert.equal(state.lastDelivered, 1);
  assert.equal(state.lastError, 'could not deliver a wake: socket closed');
});

test('a wake that names no session, with the runner having none, fails without sending', async () => {
  const w = world({ wakes: [{ message: 'a', done: ['/bin/poller', 'ack', 'a'] }] });
  const state = await runWakeRunner({ name: 'issues', command: RUNNER.command, everySeconds: 300, delivery: 'immediate' }, w.deps());
  assert.equal(w.sent.length, 0);
  assert.deepEqual(w.reports, [['/bin/poller', 'ack', 'a', '--error', 'the wake names no session and the runner has none']]);
  assert.match(state.lastError, /names no session/);
});

test('a failed report of a delivery is said, with the command\'s reason', async () => {
  const w = world({ wakes: [{ message: 'a', done: ['/bin/poller', 'ack', 'a'] }] });
  w.reportResult = { ok: false, stdout: '', error: 'poller failed: busy' };
  assert.deepEqual(
    { lastDelivered: (await w.go()).lastDelivered, lastError: (await w.go()).lastError },
    { lastDelivered: 1, lastError: "could not report a wake's delivery: poller failed: busy" },
  );
  w.reportResult = { ok: false, stdout: '', error: null };
  assert.equal((await w.go()).lastError, "could not report a wake's delivery: the command failed");
});

test('runWakeRunners saves each runner\'s state, runs only the due ones, and forgets runners no longer configured', async () => {
  const dir = tmp('wake-states-');
  try {
    const runs = [];
    const deps = { run: async (argv) => { runs.push(argv[0]); return printed({ wakes: [], status: ['ok'] }); }, send: async () => ({ ok: true, error: null }), delivered: () => false, now: NOW };
    const a = { name: 'a', command: ['a'] };
    const b = { name: 'b', command: ['b'] };
    await runWakeRunners(dir, [a, b], deps);
    assert.deepEqual(Object.keys(readWakeStates(dir)), ['a', 'b']);
    runs.length = 0;
    await runWakeRunners(dir, [a, b], { ...deps, now: NOW + 1000 }, new Set(['b']));
    assert.deepEqual(runs, ['b']);
    assert.equal(readWakeStates(dir).a.lastRunAt, new Date(NOW).toISOString());
    assert.equal(readWakeStates(dir).b.lastRunAt, new Date(NOW + 1000).toISOString());
    await runWakeRunners(dir, [b], deps, new Set());
    assert.deepEqual(Object.keys(readWakeStates(dir)), ['b']);
    assert.deepEqual(readWakeStates(path.join(dir, 'missing')), {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runDueWakes runs each runner at its own everySeconds, not on every pass', async () => {
  const dir = tmp('wake-due-');
  try {
    const marker = path.join(dir, 'ran');
    const runner = {
      name: 'slow',
      command: [process.execPath, '-e', `require('fs').appendFileSync(${JSON.stringify(marker)}, 'x'); process.stdout.write('{"wakes":[]}')`],
      everySeconds: 300,
      delivery: 'immediate',
    };
    const d = { ...testDeps(dir), state: dir };
    const due = new Map();
    const passAt = async (now) => Object.keys(await runDueWakes({ ...d, now: () => now }, [runner], due, now));
    assert.deepEqual(await passAt(NOW), ['slow']);
    assert.deepEqual(await passAt(NOW + 60_000), []);
    assert.deepEqual(await passAt(NOW + 300_000), ['slow']);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'xx');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the wake config is off with no file, reads the runners when enabled, and a bad one is refused', () => {
  const dir = tmp('wake-config-');
  try {
    assert.deepEqual(wakesConfig(path.join(dir, 'none.json')), { enabled: false, runners: [] });
    const file = path.join(dir, 'wakes.json');
    fs.writeFileSync(file, JSON.stringify({ enabled: true, runners: [{ name: ' issues ', command: ['/bin/poller', 'poll'], session: SESSION }, { name: 'quick', command: ['/bin/q'], everySeconds: 60, delivery: 'enqueue' }] }));
    assert.deepEqual(wakesConfig(file), {
      enabled: true,
      runners: [
        { name: 'issues', command: ['/bin/poller', 'poll'], everySeconds: 300, delivery: 'immediate', session: SESSION },
        { name: 'quick', command: ['/bin/q'], everySeconds: 60, delivery: 'enqueue' },
      ],
    });
    fs.writeFileSync(file, JSON.stringify({ enabled: false, runners: [{ name: 'x', command: ['/bin/x'] }] }));
    assert.equal(wakesConfig(file).enabled, false);
    for (const runners of [[{ name: '', command: ['x'] }], [{ name: 'a', command: [] }], [{ name: 'a', command: ['x'], everySeconds: 5 }], [{ name: 'a', command: ['x'], delivery: 'soon' }], [{ name: 'a', command: ['x'] }, { name: 'a', command: ['y'] }]]) {
      fs.writeFileSync(file, JSON.stringify({ enabled: true, runners }));
      assert.throws(() => wakesConfig(file), (e) => e.code === 'wakes-config' && e.message.includes('wakes.json: runners['), JSON.stringify(runners));
    }
    fs.writeFileSync(file, '{ not json');
    assert.throws(() => wakesConfig(file), (e) => e.code === 'wakes-config' && /is not valid JSON/.test(e.message));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the sender takes back the user-side queued messages with the prefix, and still sends when that fails', async () => {
  const home = tmp('wake-queue-');
  try {
    const app = fakeApp();
    const removed = [];
    const queue = [
      { id: 'q1', kind: 'message', source: 'user', display_text: 'News: old' },
      { id: 'q2', kind: 'message', source: 'agent', display_text: 'News: from an agent' },
      { id: 'q3', kind: 'message', source: 'user', display_text: 'Other' },
    ];
    let fail = false;
    const d = {
      ...testDeps(home, { app }),
      exchange: async (messages, opts) => {
        const [m] = messages;
        if (m.type === 'get_session_queue') {
          if (fail) throw new Error('socket closed');
          return [{ type: 'session_queue', request_id: m.request_id, data: { items: queue } }];
        }
        if (m.type === 'remove_session_queue_item') { removed.push(m.id); return [{ type: 'ok', request_id: m.request_id }]; }
        return app.exchange(messages, opts);
      },
    };
    assert.equal(await withdrawQueued(d, SESSION, 'News:'), 1);
    assert.deepEqual(removed, ['q1']);
    assert.deepEqual(await wakeSender(d)(SESSION, 'new', 'immediate', 'News:'), { ok: true, error: null });
    assert.deepEqual(app.sent, [{ id: SESSION, text: 'new' }]);
    fail = true;
    assert.deepEqual(await wakeSender(d)(SESSION, 'again', 'enqueue', 'News:'), { ok: true, error: null });
    assert.equal(app.sent.length, 2);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a wake counts as delivered when the session log has a user message that starts with it, sent after the wake', () => {
  const home = tmp('wake-log-');
  try {
    writeHistory(home, SESSION, [{ type: 'user.message', data: { content: 'New issue in a/b: fix   the  thing' }, at: NOW + 1000 }]);
    const d = testDeps(home);
    assert.equal(wakeDelivered(d, SESSION, 'New issue in a/b: fix the thing', NOW), true);
    assert.equal(wakeDelivered(d, SESSION, 'New issue in a/b: fix the thing', NOW + 600_000), false, 'an older message is not this one');
    assert.equal(wakeDelivered(d, OTHER, 'New issue in a/b', NOW), false, 'a session with no log');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('planWakes shows what each runner would send and sends nothing', async () => {
  const plans = await planWakes([
    { name: 'a', command: ['a'], session: SESSION },
    { name: 'b', command: ['b'] },
  ], async (argv) => (argv[0] === 'a'
    ? printed({ wakes: [{ message: 'hi' }, { message: 'yo', session: OTHER, replaces: 'News' }], status: ['ok'] })
    : { ok: false, stdout: '', error: 'b failed: no token' }));
  assert.deepEqual(plans, [
    { name: 'a', error: null, status: ['ok'], wakes: [{ session: SESSION, message: 'hi', replaces: null }, { session: OTHER, message: 'yo', replaces: 'News' }] },
    { name: 'b', error: 'b failed: no token', status: [], wakes: [] },
  ]);
});

test('the status line shows last run, wakes delivered, open wakes and last error per runner, then the command\'s own lines', () => {
  const states = {
    issues: { lastRunAt: new Date(NOW - 20_000).toISOString(), lastWakes: 1, lastDelivered: 1, status: ['polled just now, 7 open'] },
    slow: { lastRunAt: new Date(NOW - 4 * 3_600_000).toISOString(), lastWakes: 3, lastDelivered: 2, lastError: 'could not deliver a wake: archived', open: { [SESSION]: { at: NOW, message: 'x' } } },
    broken: { lastRunAt: new Date(NOW - 12 * 60_000).toISOString(), lastError: 'the command did not print JSON' },
  };
  const runners = ['issues', 'slow', 'broken', 'fresh'].map((name) => ({ name, command: ['x'] }));
  assert.deepEqual(wakeStatusLines(runners, states, NOW), [
    'wake runner issues: ran just now, 1/1 wake delivered',
    'polled just now, 7 open',
    'wake runner slow: ran 4h ago, 2/3 wakes delivered, 1 open, last error: could not deliver a wake: archived',
    'wake runner broken: ran 12m ago, last error: the command did not print JSON',
    'wake runner fresh: not run yet',
  ]);
});

test('a slow runner does not hold up the others, is not started twice, and every runner keeps its own state', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wakes-slow-'));
  try {
    const script = path.join(dir, 'cmd.mjs');
    fs.writeFileSync(script, `if (process.argv[2] === 'slow') await new Promise((r) => setTimeout(r, 400)); console.log(${JSON.stringify(JSON.stringify({ wakes: [], status: [] }))});`);
    const runners = ['slow', 'fast'].map((name) => ({ name, command: [process.execPath, script, name], everySeconds: 10 }));
    const d = { state: dir, now: () => 0 };
    const due = new Map();
    assert.deepEqual(Object.keys(await runDueWakes(d, runners, due, 0, 150)), ['fast'], 'the pass returns without waiting for the slow runner');
    assert.deepEqual(Object.keys(await runDueWakes(d, runners, due, 20000, 150)), ['fast'], 'the slow runner is still going, so it is not started again');
    await new Promise((resolve) => setTimeout(resolve, 600));
    const states = readWakeStates(dir);
    assert.ok(states.slow.lastRunAt && states.fast.lastRunAt, 'both states are in the file');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (fn, ms = 5000) => { for (const end = Date.now() + ms; Date.now() < end && !fn();) await new Promise((r) => setTimeout(r, 50)); };

test('a runner that times out takes its whole process tree with it', async () => {
  const runner = `const { spawn } = require('node:child_process');
const g = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: 'inherit' });
console.log(g.pid); setInterval(() => {}, 1000);`;
  const r = await runCommand([process.execPath, '-e', runner], 600);
  assert.equal(r.ok, false);
  const pid = Number(r.stdout.trim());
  assert.ok(pid > 0);
  await until(() => !alive(pid));
  assert.equal(alive(pid), false, 'the grandchild, which ignores SIGTERM, is gone');
});

test('a runner that exits normally leaves no grandchild behind', async () => {
  const runner = `const { spawn } = require('node:child_process');
const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
g.unref(); console.log(g.pid);`;
  const r = await runCommand([process.execPath, '-e', runner], 10_000);
  assert.equal(r.ok, true);
  const pid = Number(r.stdout.trim());
  await until(() => !alive(pid));
  assert.equal(alive(pid), false);
});
