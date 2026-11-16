import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFER, READY, continuedSince, lastReply, lastTurnAt, loopState, readTail, tookTurnSince } from '../src/index.mjs';

const ev = (type, data = {}, at = Date.now()) => JSON.stringify({ type, data, timestamp: new Date(at).toISOString() });

test('loopState: working mid-turn, between tool turns and on a running subagent; not working when finished or stopped', () => {
  const run = (...types) => loopState(types.map((t) => (Array.isArray(t) ? ev(t[0], t[1]) : ev(t))));
  assert.equal(run('user.message', 'assistant.turn_start').working, true);
  assert.equal(run('user.message', 'assistant.turn_start', ['assistant.message', { toolRequests: [{}] }], 'assistant.turn_end').working, true, 'a turn that asked for tools is cut between turns');
  assert.equal(run('user.message', 'assistant.turn_start', ['assistant.message', { toolRequests: [] }], 'assistant.turn_end').working, false);
  assert.equal(run('user.message', 'assistant.turn_start', 'subagent.started', ['assistant.message', { toolRequests: [] }], 'assistant.turn_end').working, true);
  assert.equal(run('user.message', 'assistant.turn_start', ['abort', { reason: 'user_initiated' }]).working, false);
  assert.equal(run('user.message', 'assistant.turn_start', ['abort', { reason: 'subagent_cancelled' }]).working, true, 'only a person\'s stop counts');
  assert.equal(run().working, false);
});

test('loopState: a background shell that never reported back keeps the session working', () => {
  const lines = [
    ev('user.message'),
    ev('tool.execution_start', { toolCallId: 't1', toolName: 'bash', arguments: { mode: 'async', description: 'watch build' } }),
    ev('tool.execution_complete', { toolCallId: 't1', result: 'shellId: 7' }),
    ev('assistant.turn_start'),
    ev('assistant.message', { toolRequests: [] }),
    ev('assistant.turn_end'),
  ];
  assert.match(loopState(lines).why, /waiting on shell "watch build"/);
  assert.equal(loopState([...lines, ev('system.notification', { kind: { shellId: 7 } })]).working, false);
});

test('lastReply: ready, defer (with its lanes), and only a line of its own counts', () => {
  const t0 = 1_000_000;
  const msg = (text, at) => ev('assistant.message', { content: text }, at);
  assert.deepEqual(lastReply([msg(`Pushed.\n${READY}`, t0 + 5)], t0), { kind: 'ready', at: t0 + 5 });
  assert.equal(lastReply([msg('`READY-TO-RESTART`.', t0 + 5)], t0).kind, 'ready', 'markdown around the line does not matter');
  assert.equal(lastReply([msg(`I will say ${READY} when done`, t0 + 5)], t0), null, 'only a line of its own counts');
  assert.equal(lastReply([msg(READY, t0 - 5)], t0), null, 'a message from before the ask does not count');
  assert.deepEqual(lastReply([msg(`Two lanes are mid-run.\n${DEFER}: 3 lanes running, about 45 min`, t0 + 5)], t0), { kind: 'defer', at: t0 + 5, lanes: 3, minutes: 45 });
  assert.deepEqual(lastReply([msg(`**${DEFER}: 1 lane running**`, t0 + 5)], t0), { kind: 'defer', at: t0 + 5, lanes: 1, minutes: null }, 'the estimate is optional');
  assert.equal(lastReply([msg(`${DEFER}: 3 lanes running, about 45 min`, t0 + 5), msg(READY, t0 + 9)], t0).kind, 'ready', 'the latest answer counts');
  assert.equal(lastReply([msg(READY, t0 + 5), msg(`${DEFER}: 2 lanes running, about 5 min`, t0 + 9)], t0).kind, 'defer');
});

test('lastTurnAt, continuedSince and tookTurnSince read only the agent loop, not a resume marker', () => {
  const lines = [ev('user.message', {}, 1000), ev('assistant.turn_start', {}, 2000), ev('session.resume', {}, 9000)];
  assert.equal(lastTurnAt(lines), 2000);
  assert.equal(lastTurnAt([]), null);
  assert.equal(continuedSince(lines, 1500), false, 'the only user message is before 1500');
  assert.equal(continuedSince([ev('user.message', {}, 2000)], 1500), true);
  assert.equal(tookTurnSince(lines, 1500), true);
  assert.equal(tookTurnSince(lines, 2000), false, 'strictly after');
});

test('readTail: the last lines of a file, a missing file is no lines, a partial first line is dropped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shepherd-tail-'));
  const f = path.join(dir, 'events.jsonl');
  try {
    assert.deepEqual(readTail(path.join(dir, 'nope.jsonl')), []);
    fs.writeFileSync(f, 'aaaa\nbb\nc\n');
    assert.deepEqual(readTail(f), ['aaaa', 'bb', 'c', ''], 'a file that fits is read whole');
    assert.deepEqual(readTail(f, 5), ['c', ''], 'the first line of a cut tail is dropped');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
