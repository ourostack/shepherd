// A message to a session goes out as a peer message from Ouroboros' own chat, formatted so a `~` never strikes text through.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deps } from '../src/index.mjs';
import { send, RELAYED_LABEL } from '../src/operate.mjs';
import { relayOutcome } from '../src/peer.mjs';
import { archive } from '../src/socket.mjs';
import { watchRetire } from '../src/retire.mjs';
import { formatForApp } from '../src/format.mjs';
import { startFakeApp } from './fake-app.mjs';
import { CHAT_SESSION, copilotReplies } from './fake-copilot.mjs';
import { historyFile } from '../src/index.mjs';

const TARGET = 'a1000000-0000-4000-8000-000000000001';
const target = { id: TARGET, name: 'Target', isRunning: false, updatedAt: new Date().toISOString() };

// The pretend app, with Ouroboros' chat listed and its agent making (relay: 'ok'), failing or altering the send_session_message call.
async function withRelay(relay, fn, sendReply = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shepherd-peer-'));
  const home = path.join(root, 'app');
  const chats = [{ id: CHAT_SESSION, title: 'Ouroboros', updatedAt: new Date().toISOString() }];
  const base = copilotReplies({ chats, workspaces: [{ id: 'w1', name: 'Target', workspaceType: 'worktree', session: { sessionId: TARGET, isRunning: false, updatedAt: target.updatedAt, executionLocation: 'local' } }] });
  const append = (event) => {
    const file = historyFile(home, CHAT_SESSION);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ ...event, timestamp: new Date().toISOString() })}\n`);
  };
  const app = await startFakeApp(home, {
    reply: (m) => {
      if (m.type === 'send_message' && m.session_id === CHAT_SESSION && relay) {
        if (sendReply) return sendReply(m);
        const args = JSON.parse(m.prompt.split('\n').at(-1));
        append({ type: 'tool.execution_start', data: { toolCallId: 't1', toolName: 'send_session_message', arguments: relay === 'altered' ? { ...args, message: 'other' } : args } });
        if (relay !== 'altered') append({ type: 'tool.execution_complete', data: { toolCallId: 't1', success: relay !== 'refused', error: relay === 'refused' ? { message: 'session is archived' } : undefined } });
      }
      return base(m);
    },
  });
  const d = { ...deps({ copilotHome: home, state: path.join(root, 'state') }), sendWaitMs: 1500, relayWaitMs: 1500, pollMs: 20 };
  try { return await fn({ d, app }); } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
}

test('a message to a session is relayed as a peer message from Ouroboros, with paths in code', async () => {
  await withRelay('ok', async ({ d, app }) => {
    d.state && fs.mkdirSync(d.state, { recursive: true });
    fs.writeFileSync(path.join(d.state, 'identity.json'), JSON.stringify({ session_id: CHAT_SESSION }));
    const r = await send(d, { session_id: TARGET, message: 'Look in ~/Library/Caches/shepherd and ~/Library/Logs' });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.from, 'Ouroboros');
    assert.equal(r.from_session_id, CHAT_SESSION);
    assert.equal(r.message, 'Look in `~/Library/Caches/shepherd` and `~/Library/Logs`');
    const toTarget = app.received.filter((m) => m.type === 'send_message' && m.session_id === TARGET);
    assert.equal(toTarget.length, 0, 'nothing goes to the session as a user prompt');
    assert.equal(app.received.filter((m) => m.type === 'send_message' && m.session_id === CHAT_SESSION).length, 1);
  });
});

test('a relay that fails or alters the text is reported, never sent as a user prompt', async () => {
  for (const relay of ['refused', 'altered', null]) {
    await withRelay(relay, async ({ d, app }) => {
      fs.mkdirSync(d.state, { recursive: true });
      fs.writeFileSync(path.join(d.state, 'identity.json'), JSON.stringify({ session_id: CHAT_SESSION }));
      const r = await send(d, { session_id: TARGET, message: 'hello' });
      assert.equal(r.ok, false);
      assert.equal(r.status, 'failed');
      assert.equal(app.received.filter((m) => m.type === 'send_message' && m.session_id === TARGET).length, 0);
    });
  }
});

test('history_preserved names the relay session and how to inspect unknown delivery without retrying', async () => {
  for (const dispatched of [false, true]) {
    await withRelay('ok', async ({ d, app }) => {
      fs.mkdirSync(d.state, { recursive: true });
      fs.writeFileSync(path.join(d.state, 'identity.json'), JSON.stringify({ session_id: CHAT_SESSION }));
      const r = await send(d, { session_id: TARGET, message: 'hello' });
      assert.equal(r.ok, false);
      assert.equal(r.status, 'failed');
      assert.equal(r.from_session_id, CHAT_SESSION);
      assert.match(r.error, /history_preserved/);
      assert.match(r.error, /delivery is unknown/);
      assert.ok(r.error.includes(`shepherd messages ${CHAT_SESSION}`));
      assert.ok(r.error.includes(`shepherd open ${CHAT_SESSION}`));
      assert.match(r.error, /before (?:sending|retrying)/);
      if (dispatched) assert.match(r.error, /Saved conversation could not be loaded/);
      assert.deepEqual(app.received.filter((m) => m.type === 'send_message').map((m) => m.session_id), [CHAT_SESSION]);
      assert.equal(app.received.some((m) => m.type === 'create_session'), false);
      assert.equal(JSON.parse(fs.readFileSync(path.join(d.state, 'identity.json'), 'utf8')).session_id, CHAT_SESSION);
    }, (m) => [
      ...(dispatched ? [{ type: 'session_dispatch_state', request_id: m.request_id, session_id: m.session_id, dispatch_may_have_started: true }] : []),
      dispatched
        ? { type: 'session_resume_failed', request_id: m.request_id, session_id: m.session_id, reason: 'history_preserved', message: 'Saved conversation could not be loaded' }
        : { type: 'error', request_id: m.request_id, error: 'history_preserved' },
    ]);
  }
});

test('--as-user sends the owner\'s words as a labelled user prompt', async () => {
  await withRelay('ok', async ({ d, app }) => {
    const r = await send(d, { session_id: TARGET, message: 'from the owner', as_user: true });
    assert.equal(r.ok, true);
    assert.equal(app.received.find((m) => m.type === 'send_message' && m.session_id === TARGET).prompt, `${RELAYED_LABEL}\nfrom the owner`);
  });
});

test('formatForApp wraps paths and commands in code and escapes a stray tilde', () => {
  assert.equal(formatForApp('See ~/Library/Caches/x, then /usr/local/bin/node.'), 'See `~/Library/Caches/x`, then `/usr/local/bin/node`.');
  assert.equal(formatForApp('Run:\n$ npm test'), 'Run:\n`npm test`');
  assert.equal(formatForApp('already `~/a` and https://x.test/~u stay'), 'already `~/a` and https://x.test/~u stay');
  assert.equal(formatForApp('about ~5 minutes'), 'about \\~5 minutes');
  assert.equal(formatForApp('```\n~/a\n```'), '```\n~/a\n```');
});

test('a retry after a bad call counts as sent, and extra arguments count as altered', async () => {
  const args = { session_id: TARGET, delivery_mode: 'immediate', message: 'hi' };
  const at = new Date().toISOString();
  const start = (id, a) => JSON.stringify({ type: 'tool.execution_start', timestamp: at, data: { toolCallId: id, toolName: 'send_session_message', arguments: a } });
  const end = (id, success) => JSON.stringify({ type: 'tool.execution_complete', timestamp: at, data: { toolCallId: id, success } });
  const extra = { ...args, source_user_message: { id: 'x' } };
  assert.equal(relayOutcome([start('a', extra), end('a', false), start('b', args), end('b', true)], args, 0).state, 'sent');
  assert.equal(relayOutcome([start('a', extra), end('a', true)], args, 0).state, 'altered');
});

test('the identity chat is never archived, and the retire watch leaves it out', async () => {
  await withRelay('ok', async ({ d }) => {
    fs.mkdirSync(d.state, { recursive: true });
    fs.writeFileSync(path.join(d.state, 'identity.json'), JSON.stringify({ session_id: CHAT_SESSION }));
    assert.deepEqual(await archive(d, { id: CHAT_SESSION }), { ok: false, error: "Ouroboros' own chat is the sender of its peer messages and is never archived" });
    const out = await watchRetire(d, { apply: true });
    assert.deepEqual(out.retire.filter((e) => e.id === CHAT_SESSION), []);
  });
});
