// A message to a session goes out as a peer message from Ouroboros' own chat, formatted so a `~` never strikes text through.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deps } from '../src/index.mjs';
import { send, RELAYED_LABEL } from '../src/operate.mjs';
import { formatForApp } from '../src/format.mjs';
import { startFakeApp } from './fake-app.mjs';
import { CHAT_SESSION, copilotReplies } from './fake-copilot.mjs';
import { historyFile } from '../src/index.mjs';

const TARGET = 'a1000000-0000-4000-8000-000000000001';
const target = { id: TARGET, name: 'Target', isRunning: false, updatedAt: new Date().toISOString() };

// The pretend app, with Ouroboros' chat listed and its agent making (relay: 'ok'), failing or altering the send_session_message call.
async function withRelay(relay, fn) {
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
