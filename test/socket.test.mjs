import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { appReady, archive, exchange, historyFile, sendTo } from '../src/index.mjs';
import { fakeHistoryDeps } from './fake-history.mjs';
import { startFakeApp } from './fake-app.mjs';

const WS = 'workspace-1111-2222-3333-444444444444';
const SESS = 'aaaaaaaa-0000-4000-8000-000000000001';
const GONE = 'dddddddd-0000-4000-8000-000000000004';

// Node 22 and later have the global WebSocket the socket code uses.
const skip = typeof WebSocket !== 'function' ? 'needs the global WebSocket (Node 22 or newer)' : false;

async function withApp(opts, fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shepherd-sock-'));
  const app = await startFakeApp(home, opts);
  const d = { ...fakeHistoryDeps(home), exchange: (messages, o) => exchange(home, messages, o) };
  try { return await fn({ home, app, d }); } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('appReady and sendTo: the app says hello, and a prompt to a session is queued or sent', { skip }, async () => {
  await withApp({}, async ({ app, d }) => {
    assert.equal(await appReady(d), true);
    assert.deepEqual(await sendTo(d, SESS, 'carry on', 3000), { ok: true, reply: 'session_message_sent', error: null });
    assert.equal(app.received.at(-1).prompt, 'carry on');
    assert.equal(app.received.at(-1).delivery_mode, 'immediate');
  });
});

test('sendTo: a refused send says why; a session the app never answers is reported as no reply', { skip }, async () => {
  await withApp({ refuse: [GONE], silent: [SESS] }, async ({ d }) => {
    const refused = await sendTo(d, GONE, 'hi', 3000);
    assert.equal(refused.ok, false);
    assert.match(refused.error, /is archived/);
    assert.deepEqual(await sendTo(d, SESS, 'hi', 300), { ok: false, reply: 'no reply', error: null });
  });
});

test('archive: a workspace is archived, and its worktree deleted only when the row says it is one and keepWorktree is not set', { skip }, async () => {
  await withApp({}, async ({ app, d }) => {
    const row = { id: SESS, workspaceId: WS, workspaceType: 'worktree' };
    assert.deepEqual(await archive(d, row, { waitMs: 3000 }).then((r) => ({ ok: r.ok, session_id: r.session_id })), { ok: true, session_id: SESS });
    assert.equal(app.received.at(-1).type, 'archive_workspace');
    assert.equal(app.received.at(-1).workspace_id, WS);
    assert.equal(app.received.at(-1).delete_worktree, true);
    await archive(d, row, { keepWorktree: true, waitMs: 3000 });
    assert.equal(app.received.at(-1).delete_worktree, false, 'keepWorktree leaves the worktree on disk');
    await archive(d, { id: SESS, workspaceId: WS }, { waitMs: 3000 });
    assert.equal(app.received.at(-1).delete_worktree, false, 'without a worktree type nothing is deleted');
  });
});

test('archive: a row with no workspace archives the session; a refusal says why, and silence says what to check', { skip }, async () => {
  await withApp({ refuse: [GONE], silent: [SESS] }, async ({ app, d }) => {
    const ok = await archive(d, { id: SESS }, { waitMs: 3000 });
    assert.equal(app.received.at(-1).type, 'archive_session');
    assert.equal(ok.ok, false, 'silence is not confirmation');
    assert.match(ok.error, /did not confirm the archive within 3 s\. Fix: check the session with shepherd status/);
    const refused = await archive(d, { id: GONE }, { waitMs: 3000 });
    assert.equal(refused.ok, false);
    assert.equal(refused.error, `${GONE} is archived`);
  });
});

test('exchange with no port file: the app is not serving, and the fix is to open it', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shepherd-none-'));
  try {
    const [m] = await exchange(home, [{ type: 'x' }]);
    assert.equal(m.type, 'socket_error');
    assert.match(m.message, /the app is not serving\. Fix: open the GitHub Copilot app/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('sendTo: a compressed history is put back before the prompt goes, so a resumed session has it', { skip }, async () => {
  await withApp({}, async ({ home, d }) => {
    const file = historyFile(home, SESS);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.gz`, zlib.gzipSync('{"type":"user.message"}\n'));
    assert.equal((await sendTo(d, SESS, 'carry on', 3000)).ok, true);
    assert.equal(fs.readFileSync(file, 'utf8'), '{"type":"user.message"}\n');
    assert.equal(fs.existsSync(`${file}.gz`), false);
  });
});

test('sendTo: a restore that cannot run never stops the send (deps without historyPath, an id that is not a session id)', { skip }, async () => {
  await withApp({}, async ({ d }) => {
    const { historyPath, ...bare } = d;
    assert.equal((await sendTo(bare, SESS, 'carry on', 3000)).ok, true);
    assert.equal((await sendTo(d, 's1', 'carry on', 3000)).reply === 'history not restored', false);
  });
});

test('archive: after the app confirms and its database shows the session archived, the history is compressed', { skip }, async () => {
  await withApp({}, async ({ home, d }) => {
    const file = historyFile(home, SESS);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"type":"user.message"}\n');
    let reads = 0;
    const later = { ...d, sql: async () => (++reads < 3 ? [] : [{ id: SESS, archived_at: '2026-11-16' }]) };
    const r = await archive(later, { id: SESS }, { waitMs: 3000 });
    assert.equal(r.ok, true);
    assert.equal(r.compressed.ok, true, r.compressed.why);
    assert.equal(fs.existsSync(`${file}.gz`), true);
    assert.equal(fs.existsSync(file), false);
  });
});

test('archive: a failed compress keeps the archive ok; compress: false leaves the history alone', { skip }, async () => {
  await withApp({}, async ({ home, d }) => {
    const file = historyFile(home, SESS);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"type":"user.message"}\n');
    const archived = [{ id: SESS, archived_at: '2026-11-16' }];
    const failing = { ...d, sql: async () => archived, openBy: async () => { throw new Error('lsof missing'); } };
    const failed = await archive(failing, { id: SESS }, { waitMs: 3000 });
    assert.equal(failed.ok, true);
    assert.equal(failed.compressed.ok, false);
    assert.match(failed.compressed.why, /lsof could not say/);
    const skipped = await archive({ ...d, sql: async () => archived }, { id: SESS }, { waitMs: 3000, compress: false });
    assert.equal(skipped.compressed, null);
    assert.equal(fs.existsSync(`${file}.gz`), false);
    assert.equal(fs.existsSync(file), true);
  });
});
