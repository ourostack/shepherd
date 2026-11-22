// The morning sign-in queue, against fakes: items queue without prompting, go out as one message once each morning, and resume.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { batchMessage, done, due, list, morning, ouroSender, personalMessage, queue, scopeOf, signinConfig, split, status } from '../src/signin.mjs';

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

test('a failed send leaves the batch to go out on the next pass, and no session named means the Ouroboros chat, and with none stored no send', async () => {
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

const NASTY = 'GITHUB_BROWSER_RESEED=1 node -e \'import("/x/browser.mjs").then(async m=>{console.log(`a $HOME`)})\' && echo "q" > /dev/null\nsecond line $(date) `x`';

test('a resume command is stored and shown byte for byte, through the CLI too', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'signin-cli-'));
  const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'shepherd.mjs');
  const run = (args) => spawnSync(process.execPath, [bin, ...args, '--json', '--copilot-home', home], { encoding: 'utf8', env: { ...process.env, HOME: home, SHEPHERD_SIGNIN_CONFIG: path.join(home, 'none.json') } });
  try {
    const { id } = JSON.parse(run(['signin', 'queue', '--what', 'w', '--why', 'y', '--resume', NASTY]).stdout);
    const s = JSON.parse(run(['signin', 'status', id]).stdout);
    assert.equal(s.resume, NASTY);
    assert.equal(s.what, 'w');
    assert.equal(s.state, 'open');
    assert.ok(JSON.parse(run(['signin', 'preview']).stdout).message.includes(NASTY));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('the same tool asking again for the same thing merges, even with different words; a key merges across tools', () => {
  const w = world(EARLY);
  const a = queue(w.d, ITEM);
  assert.equal(a.merged, undefined);
  const b = queue(w.d, { ...ITEM, why: 'rephrased', resume: 'other command' });
  assert.deepEqual([b.id, b.merged], [a.id, true]);
  assert.equal(list(w.d).length, 1);
  const k = queue(w.d, { ...ITEM, what: 'one', tool: 't1', key: 'k' });
  assert.equal(queue(w.d, { ...ITEM, what: 'two', tool: 't2', key: 'k' }).id, k.id);
  assert.equal(list(w.d).length, 2);
});

test('an item for someone else is recorded but never goes in the owner batch', async () => {
  const w = world(MORNING);
  const o = queue(w.d, { ...ITEM, forWhom: 'the operator' });
  assert.equal(o.for, undefined);
  const x = queue(w.d, { ...ITEM, what: 'theirs', forWhom: 'Alex' });
  assert.equal(x.for, 'Alex');
  const sent = [];
  await morning(w.d, cfg, async (s, m) => { sent.push(m); return { ok: true }; });
  assert.match(sent[0], /1 thing waiting[\s\S]*GitHub passkey/);
  assert.doesNotMatch(sent[0], /theirs/);
});

test('with SHEPHERD_HOME set, a queue call lands under it and leaves the real home untouched', () => {
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'signin-real-'));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'signin-scratch-'));
  const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'shepherd.mjs');
  const env = { ...process.env, HOME: real, SHEPHERD_HOME: scratch };
  for (const k of ['SHEPHERD_SIGNIN_CONFIG']) delete env[k];
  try {
    const r = spawnSync(process.execPath, [bin, 'signin', 'queue', '--what', 'w', '--why', 'y', '--resume', 'x', '--json'], { encoding: 'utf8', env });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(fs.readdirSync(real), []);
    assert.ok(fs.existsSync(path.join(scratch, 'Library', 'Caches', 'shepherd', 'signin-queue.json')));
  } finally { fs.rmSync(real, { recursive: true, force: true }); fs.rmSync(scratch, { recursive: true, force: true }); }
});

const PERSONAL = { card: 'http://127.0.0.1:1/.well-known/agent-card.json', name: 'the personal agent', owner: 'Sam', ouro: 'ouro', identityFile: null };
const pcfg = { ...cfg, personal: PERSONAL, work: ['example-corp/'] };
const WORK = { what: 'Microsoft sign-in (MFA)', why: 'the work mail sync is waiting', resume: 'node mail.mjs --resume', tool: 'mail' };

test('work is Microsoft, Teams and the configured work patterns; everything else is personal; an explicit scope wins', () => {
  assert.equal(scopeOf(WORK), 'work');
  assert.equal(scopeOf({ ...ITEM, why: 'a Teams meeting bot needs approval' }), 'work');
  assert.equal(scopeOf(ITEM), 'personal');
  assert.equal(scopeOf({ ...ITEM, why: 'GitHub is waiting for approval to x (work GitHub account a_b)' }), 'work');
  assert.equal(scopeOf({ ...ITEM, why: 'GitHub is waiting for approval to x (GitHub account a)' }), 'personal');
  assert.equal(scopeOf({ ...ITEM, resume: 'gh -R example-corp/tool run' }, ['Example-Corp/']), 'work');
  assert.equal(scopeOf({ ...WORK, scope: 'personal' }), 'personal');
  const w = world(EARLY);
  assert.equal(queue(w.d, { ...ITEM, scope: 'work' }).scope, 'work');
  assert.throws(() => queue(w.d, { ...ITEM, what: 'other', scope: 'home' }), /scope is work or personal/);
  assert.deepEqual(split([ITEM, WORK], cfg), { work: [ITEM, WORK], personal: [] });
});

test('signin.json names the personal agent by its card; without one the batch is unsplit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signin-cfg-'));
  const file = path.join(dir, 'signin.json');
  fs.writeFileSync(file, JSON.stringify({ hour: 9, personal: { card: 'http://x/card', name: 'Pip', owner: 'Sam' }, work: ['acme/', 3] }));
  assert.deepEqual(signinConfig(file), { session: null, hour: 9, personal: { card: 'http://x/card', name: 'Pip', owner: 'Sam', ouro: 'ouro', identityFile: null }, work: ['acme/'] });
  fs.writeFileSync(file, JSON.stringify({ personal: { name: 'Pip' } }));
  assert.equal(signinConfig(file).personal, null);
});

test('the personal items go to the personal agent as one intake item with a dated dedupe key; work items stay with the session', async () => {
  const w = world(MORNING);
  queue(w.d, ITEM);
  queue(w.d, { ...ITEM, what: 'device code', tool: 'tv' });
  queue(w.d, WORK);
  const toAgent = [];
  const toSession = [];
  const r = await morning(w.d, pcfg, async (s, m) => { toSession.push([s, m]); return { ok: true }; }, async (card, text) => { toAgent.push([card, text]); return { ok: true }; });
  assert.deepEqual([r.sent, r.count, r.personal, r.error], [true, 3, 'sent', null]);
  assert.equal(toAgent.length, 1);
  assert.equal(toAgent[0][0], PERSONAL.card);
  const m = toAgent[0][1];
  for (const line of [/^from: Shepherd/m, /^urgency: today$/m, /^ask: 2 sign-ins waiting on Sam/m, /^why only Sam: /m, /^steps:$/m, /^deadline: end of today \(2026-11-17\)/m, /^dedupe key: shepherd-signin-2026-11-17$/m]) assert.match(m, line);
  assert.match(m, /GitHub passkey[\s\S]*device code/);
  assert.doesNotMatch(m, /Microsoft/);
  assert.equal(toSession.length, 1);
  assert.match(toSession[0][1], /1 thing waiting[\s\S]*Microsoft sign-in/);
  assert.doesNotMatch(toSession[0][1], /GitHub passkey|unreachable/);
  assert.equal(due(w.d, pcfg), false);
  assert.equal((await morning(w.d, pcfg, async () => assert.fail('sent twice'), async () => assert.fail('sent twice'))).sent, false);
});

test('when the personal agent cannot be reached, its items go to the session with a note saying so', async () => {
  const w = world(MORNING);
  queue(w.d, ITEM);
  queue(w.d, WORK);
  const toSession = [];
  const r = await morning(w.d, { ...pcfg, personal: { ...PERSONAL, name: 'Pip' } }, async (s, m) => { toSession.push(m); return { ok: true }; }, async () => ({ ok: false, error: 'fetch failed' }));
  assert.deepEqual([r.sent, r.count, r.personal], [true, 2, 'fallback']);
  assert.equal(toSession.length, 1);
  assert.match(toSession[0], /^Pip unreachable, so this came here\. \(fetch failed\)\n/);
  assert.match(toSession[0], /2 things waiting[\s\S]*Microsoft sign-in[\s\S]*GitHub passkey/);
  assert.equal(due(w.d, pcfg), false);
});

test('only personal items need no session; a failed session send retries only the work part', async () => {
  const w = world(MORNING);
  queue(w.d, ITEM);
  assert.equal(due(w.d, { ...pcfg, session: null }), true);
  const agent = [];
  const r = await morning(w.d, { ...pcfg, session: null }, async () => assert.fail('no session'), async (c, t) => { agent.push(t); return { ok: true }; });
  assert.deepEqual([r.sent, r.count, r.personal], [true, 1, 'sent']);
  const w2 = world(MORNING);
  queue(w2.d, ITEM);
  queue(w2.d, WORK);
  const first = await morning(w2.d, pcfg, async () => ({ ok: false, error: 'down' }), async () => ({ ok: true }));
  assert.deepEqual([first.personal, first.error], ['sent', 'down']);
  assert.equal(due(w2.d, pcfg), true);
  const again = [];
  await morning(w2.d, pcfg, async (s, m) => { again.push(m); return { ok: true }; }, async () => assert.fail('personal resent'));
  assert.match(again[0], /1 thing waiting[\s\S]*Microsoft/);
});

test('the personal message keeps a multi-line resume command whole, and is null with nothing to send', () => {
  assert.equal(personalMessage([]), null);
  const m = personalMessage([{ id: 'abc', ...ITEM, resume: 'a\nb' }], { now: MORNING, host: 'h' });
  assert.match(m, /^from: Shepherd, the morning sign-in queue on h$/m);
  assert.match(m, /Then run: \n```\na\nb\n```/);
  assert.match(m, /why only the owner: /);
});

test('the sender runs ouro a2a message with the card, the text, --json and --why, and reads a refusal or a failure', async () => {
  const calls = [];
  const fake = (out) => (cmd, args, opts, cb) => { calls.push([cmd, args]); out(cb); };
  const send = (out, p = PERSONAL) => ouroSender(p, fake(out))('http://c/card', 'hello');
  assert.deepEqual(await send((cb) => cb(null, '{"peerName":"pip","text":"got it","conversationId":"c"}\n', '')), { ok: true, error: null });
  const [cmd, args] = calls[0];
  assert.equal(cmd, 'ouro');
  assert.deepEqual(args.slice(0, 7), ['a2a', 'message', '--to', 'http://c/card', '--text', 'hello', '--json']);
  assert.equal(args[7], '--why');
  assert.ok(!args.includes('--identity-file'));
  await send((cb) => cb(null, '{}', ''), { ...PERSONAL, ouro: '/opt/ouro', identityFile: '/k/id.json' });
  assert.equal(calls[1][0], '/opt/ouro');
  assert.deepEqual(calls[1][1].slice(-2), ['--identity-file', '/k/id.json']);
  assert.deepEqual(await send((cb) => cb(Object.assign(new Error('exit 1')), '', 'fetch failed: ECONNREFUSED')), { ok: false, error: 'fetch failed: ECONNREFUSED' });
  assert.deepEqual(await send((cb) => cb(new Error('exit 1'), '{"ok":false,"reason":"not-a-friend"}', '')), { ok: false, error: 'not-a-friend' });
});

test('the CLI preview shows the split when signin.json names a personal agent', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'signin-cli-'));
  const conf = path.join(home, 'signin.json');
  fs.writeFileSync(conf, JSON.stringify({ personal: { card: 'http://127.0.0.1:1/card', name: 'Pip' } }));
  const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'shepherd.mjs');
  const run = (args) => spawnSync(process.execPath, [bin, ...args, '--json', '--copilot-home', home], { encoding: 'utf8', env: { ...process.env, HOME: home, SHEPHERD_SIGNIN_CONFIG: conf } });
  try {
    assert.equal(run(['signin', 'queue', '--what', 'a demo', '--why', 'just checking', '--resume', 'echo go']).status, 0);
    assert.equal(run(['signin', 'queue', '--what', 'Teams device code', '--why', 'the bot', '--resume', 'echo work']).status, 0);
    assert.equal(run(['signin', 'queue', '--what', 'odd one', '--why', 'y', '--resume', 'echo x', '--scope', 'work']).status, 0);
    const p = JSON.parse(run(['signin', 'preview']).stdout);
    assert.equal(p.personal.to, 'http://127.0.0.1:1/card');
    assert.deepEqual(p.personal.items.map((i) => i.what), ['a demo']);
    assert.match(p.personal.message, /dedupe key: shepherd-signin-\d{4}-\d{2}-\d{2}/);
    assert.deepEqual(p.items.map((i) => i.what), ['Teams device code', 'odd one']);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
