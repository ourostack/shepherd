// The prompt tracker: what the app announces (a question or plan approval) is recorded for answer and plan, and resolved ones are forgotten.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyFrame, deps, listenPrompts } from '../src/index.mjs';
import { readPending } from '../src/store.mjs';
import { startFakeApp } from './fake-app.mjs';

const SESSION = 'a1000000-0000-4000-8000-000000000001';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('applyFrame records a question with its choices and a plan with its actions, and ignores frames it cannot key', () => {
  const pending = {};
  assert.equal(applyFrame(pending, { type: 'user_input_request', session_id: SESSION, request_id: 'q1', question: 'Which?', choices: ['a', 1, 'b'], allow_freeform: true }, 'T'), true);
  assert.deepEqual(pending[SESSION], { kind: 'input', requestId: 'q1', at: 'T', question: 'Which?', choices: ['a', 'b'], allowFreeform: true });
  assert.equal(applyFrame(pending, { type: 'exit_plan_mode_request', session_id: 'other', request_id: 'p1', summary: 'Plan', actions: ['go'] }, 'T'), true);
  assert.deepEqual(pending.other, { kind: 'plan', requestId: 'p1', at: 'T', summary: 'Plan', actions: ['go'] });
  assert.equal(applyFrame(pending, { type: 'user_input_request', request_id: 'q2' }, 'T'), false, 'no session');
  assert.equal(applyFrame(pending, { type: 'session_idle', session_id: SESSION, request_id: 'x' }, 'T'), false, 'another kind');
});

test('applyFrame forgets a request when its own resolution arrives, and not another request\'s', () => {
  const pending = {};
  applyFrame(pending, { type: 'user_input_request', session_id: SESSION, request_id: 'q1', question: 'Which?' }, 'T');
  assert.equal(applyFrame(pending, { type: 'user_input_resolved', session_id: SESSION, request_id: 'other' }, 'T'), false);
  assert.ok(pending[SESSION]);
  assert.equal(applyFrame(pending, { type: 'user_input_resolved', session_id: SESSION, request_id: 'q1' }, 'T'), true);
  assert.equal(pending[SESSION], undefined);
});

test('the tracker keeps an observer connection and records what the app announces in the state folder', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shepherd-prompts-'));
  const home = path.join(root, 'app');
  const app = await startFakeApp(home, {});
  const d = deps({ copilotHome: home, state: path.join(root, 'state') });
  const listener = listenPrompts(d, { retryMs: 20 });
  try {
    // The socket opens a moment after the tracker starts, so the question is pushed until the tracker has it.
    for (let i = 0; i < 100 && !readPending(d)[SESSION]; i++) {
      app.push({ type: 'user_input_request', session_id: SESSION, request_id: 'q1', question: 'Which branch?', choices: ['main'] });
      await sleep(30);
    }
    assert.equal(readPending(d)[SESSION].requestId, 'q1');
    assert.equal(readPending(d)[SESSION].question, 'Which branch?');
    app.push({ type: 'user_input_resolved', session_id: SESSION, request_id: 'q1' });
    for (let i = 0; i < 100 && readPending(d)[SESSION]; i++) await sleep(20);
    assert.equal(readPending(d)[SESSION], undefined, 'a resolved question is forgotten');
  } finally {
    listener.stop();
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the tracker starts without the app running, and stops cleanly', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shepherd-prompts-down-'));
  const d = deps({ copilotHome: path.join(root, 'app'), state: path.join(root, 'state') });
  const listener = listenPrompts(d, { retryMs: 10 });
  await sleep(30);
  listener.stop();
  assert.deepEqual(readPending(d), {});
  fs.rmSync(root, { recursive: true, force: true });
});
