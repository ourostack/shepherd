// A session id that names an archived session follows the hand-off chain (`Succeeds: <id>`) to the newest live successor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { refreshSuccessions } from '../src/handoff.mjs';
import { send, session } from '../src/operate.mjs';
import { fakeApp, sessionHistory, testDeps, NOW } from './fake-sidebar.mjs';

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const C = 'cccccccc-0000-4000-8000-000000000003';
const D = 'dddddddd-0000-4000-8000-000000000004';
const lane = (sessionId, name) => ({
  id: `w-${sessionId.slice(0, 4)}`, name, branch: 'b', workspaceType: 'worktree', checkoutBindings: [{ repoFullName: 'example/project' }],
  session: { sessionId, isRunning: false, updatedAt: new Date(NOW - 60_000).toISOString(), executionLocation: 'local' },
});
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'follow-'));

function setup(live) {
  const home = tmp();
  const workspaces = live.map(([id, name]) => lane(id, name));
  const app = fakeApp({ workspaces });
  return { home, workspaces, app, d: testDeps(home, { app }) };
}
const sendTo = (ctx, id) => send(ctx.d, { session_id: id, message: 'wake', as_user: true });

test('a message to an archived session goes to the session that succeeds it, and says so', async () => {
  const ctx = setup([[B, 'New desk']]);
  sessionHistory(ctx.home, A, 'Original.');
  sessionHistory(ctx.home, B, `Succeeds: ${A}\n\nCarry on.`);
  const out = await sendTo(ctx, A);
  assert.equal(out.ok, true);
  assert.equal(out.session_id, B);
  assert.equal(out.followed_from, A);
  assert.match(out.note, /^aaaaaaaa has been handed off: delivered to its successor New desk \(bbbbbbbb\)$/);
  assert.equal(ctx.app.sent.at(-1).id, B);
});

test('a chain of two hand-offs reaches the live end, from whole ids and from 8-character prefixes', async () => {
  const ctx = setup([[B, 'Middle'], [C, 'Newest']]);
  sessionHistory(ctx.home, A, 'Original.');
  sessionHistory(ctx.home, B, `Succeeds: ${A}`);
  sessionHistory(ctx.home, C, `Succeeds: ${B}`);
  refreshSuccessions(ctx.d, [B, C]); // the watch sees both while they are listed
  ctx.workspaces.length = 0;
  ctx.workspaces.push(lane(C, 'Newest'));
  for (const id of [A, A.slice(0, 8), B.slice(0, 8)]) {
    const out = await sendTo(ctx, id);
    assert.equal(out.session_id, C, id);
    assert.equal(out.followed_from, id.length === 8 && id === B.slice(0, 8) ? B : A);
  }
  assert.equal((await session(ctx.d, A.slice(0, 8))).id, C, 'reads follow too');
});

test('no successor fails as before, and a live session is never redirected', async () => {
  const ctx = setup([[B, 'Other'], [C, 'Live']]);
  sessionHistory(ctx.home, B, 'Unrelated.');
  sessionHistory(ctx.home, C, `Succeeds: ${B}`);
  await assert.rejects(sendTo(ctx, A), (e) => e.code === 'no-session');
  await assert.rejects(sendTo(ctx, A.slice(0, 8)), (e) => e.code === 'no-session');
  await assert.rejects(sendTo(ctx, 'aaaaaa'), (e) => e.code === 'short-id');
  assert.equal((await sendTo(ctx, B)).session_id, B, 'B is listed, so it is not followed');
  assert.equal(ctx.app.sent.length, 1);
});

test('two sessions claiming the same predecessor: the newest gets the message, and the note says there were two', async () => {
  const ctx = setup([[B, 'Older claim'], [C, 'Newer claim']]);
  sessionHistory(ctx.home, A, 'Original.');
  sessionHistory(ctx.home, B, `Succeeds: ${A}`, { at: NOW - 7200_000 });
  sessionHistory(ctx.home, C, `Succeeds: ${A}`, { at: NOW - 3600_000 });
  const out = await sendTo(ctx, A);
  assert.equal(out.session_id, C);
  assert.match(out.note, /the newest of 2 sessions that claim to succeed it/);
});
