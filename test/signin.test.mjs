// The morning sign-in queue, against fakes: items queue without prompting, go out as one message once each morning, and resume.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { batchMessage, done, due, list, morning, queue, status } from '../src/signin.mjs';

const MORNING = new Date(2026, 10, 17, 8, 5).getTime();
const EARLY = new Date(2026, 10, 17, 6, 0).getTime();
const world = (now) => { const state = fs.mkdtempSync(path.join(os.tmpdir(), 'signin-')); const d = { state, now: () => w.now }; const w = { state, d, now }; return w; };
const ITEM = { what: 'GitHub passkey', why: 'a release is waiting', resume: 'node release.mjs --resume', tool: 'github-browser' };
const cfg = { session: 'aaaaaaaa-0000-4000-8000-0000000000a1', hour: 8 };

test('an item queues once, with what, why and the resume command; a repeat returns the open item', () => {
  const w = world(EARLY);
  const a = queue(w.d, ITEM);
  assert.equal(queue(w.d, ITEM).id, a.id);
  assert.equal(list(w.d).length, 1);
  assert.throws(() => queue(w.d, { what: 'x' }), /needs what, why and the command that resumes it/);
});

test('the morning goes out as one message, once a day, only from the hour, and only with something open', async () => {
  const w = world(EARLY);
  queue(w.d, ITEM);
  queue(w.d, { ...ITEM, what: 'device code', tool: 'mini' });
  const sent = [];
  const send = async (session, message) => { sent.push([session, message]); return { ok: true }; };
  assert.equal(due(w.d, cfg), false);
  assert.equal((await morning(w.d, cfg, send)).sent, false);
  w.now = MORNING;
  const r = await morning(w.d, cfg, send);
  assert.deepEqual([r.sent, r.count], [true, 2]);
  assert.equal(sent.length, 1);
  assert.match(sent[0][1], /2 things waiting[\s\S]*GitHub passkey[\s\S]*device code/);
  assert.equal((await morning(w.d, cfg, send)).sent, false);
  w.now = MORNING + 86400000;
  assert.equal((await morning(w.d, cfg, send)).sent, true);
});

test('a failed send leaves the batch to go out on the next pass, and no session named means Ouroboros' own chat, and with none stored no send', async () => {
  const w = world(MORNING);
  queue(w.d, ITEM);
  assert.equal((await morning(w.d, cfg, async () => ({ ok: false, error: 'down' }))).error, 'down');
  assert.equal(due(w.d, cfg), true);
  assert.equal(due(w.d, { ...cfg, session: null }), false);
  fs.writeFileSync(path.join(w.state, 'identity.json'), JSON.stringify({ session_id: 'bbbbbbbb-0000-4000-8000-0000000000b1' }));
  const sent = [];
  await morning(w.d, { ...cfg, session: null }, async (session) => { sent.push(session); return { ok: true }; });
  assert.deepEqual(sent, ['bbbbbbbb-0000-4000-8000-0000000000b1']);
});

test('done resumes the flow: status reads done, the item leaves the batch', () => {
  const w = world(MORNING);
  const a = queue(w.d, ITEM);
  assert.equal(status(w.d, a.id).doneAt, null);
  assert.equal(done(w.d, a.id).length, 1);
  assert.ok(status(w.d, a.id).doneAt);
  assert.equal(batchMessage(list(w.d)), null);
});

test('the CLI queues, previews the batch and marks done', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'signin-cli-'));
  const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'shepherd.mjs');
  const run = (args) => spawnSync(process.execPath, [bin, ...args, '--json', '--copilot-home', home], { encoding: 'utf8', env: { ...process.env, HOME: home, SHEPHERD_SIGNIN_CONFIG: path.join(home, 'none.json') } });
  try {
    const q = run(['signin', 'queue', '--what', 'a demo', '--why', 'just checking', '--resume', 'echo go']);
    assert.equal(q.status, 0, q.stderr);
    const { id } = JSON.parse(q.stdout);
    assert.match(JSON.parse(run(['signin', 'preview']).stdout).message, /1 thing waiting[\s\S]*a demo/);
    assert.equal(JSON.parse(run(['signin', 'status', id]).stdout).state, 'open');
    run(['signin', 'done', id]);
    assert.equal(JSON.parse(run(['signin', 'status', id]).stdout).state, 'done');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
