// The app's sidebar rows, and what each session's own history says it is doing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rows, tailFacts, classify, describePermission } from '../src/rows.mjs';
import { fakeApp, sessionHistory, testDeps, NOW, writeHistory } from './fake-sidebar.mjs';

const WORKING = 'a0000000-0000-4000-8000-000000000001';
const WAITING = 'a0000000-0000-4000-8000-000000000002';
const IDLE = 'a0000000-0000-4000-8000-000000000003';
const CHAT = 'a0000000-0000-4000-8000-000000000004';

const workspace = (id, sessionId, over = {}) => ({
  id, name: `Lane ${id}`, branch: 'lane-branch', workspaceType: 'worktree', checkoutBindings: [{ repoFullName: 'example/project' }],
  session: { sessionId, isRunning: false, updatedAt: '2026-11-16T15:00:00Z', executionLocation: 'local' }, ...over,
});

test('the sidebar rows carry the coordinator, the open pull request and the automation, and skip archived ones', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rows-'));
  const app = fakeApp({
    workspaces: [
      workspace('w1', IDLE, { coordinatingCreatorSessionId: WORKING, repoContexts: [{ createdPullRequest: { htmlUrl: 'https://github.com/example/project/pull/7', state: 'open' } }], session: { sessionId: IDLE, isRunning: false, updatedAt: '2026-11-16T15:00:00Z', sessionAutomation: { id: 'x' } } }),
      workspace('w2', 'gone-not-listed', { archivedAt: '2026-11-16T10:00:00Z' }),
    ],
    chats: [{ id: CHAT, title: 'A chat', parentSessionId: WORKING, isRunning: false, updatedAt: '2026-11-16T15:00:00Z' }],
  });
  sessionHistory(home, IDLE, 'Carry on.', { turned: true });
  const listed = await rows(testDeps(home, { app }));
  assert.equal(listed.length, 2);
  const { lastActivity, ...lane } = listed.find((r) => r.id === IDLE);
  assert.equal(typeof lastActivity, 'string');
  assert.deepEqual(lane, {
    id: IDLE, name: 'Lane w1', kind: 'workspace', workspaceId: 'w1', workspaceType: 'worktree', project: null, projectId: null, projectRepo: 'example/project', branch: 'lane-branch',
    path: null, createdAt: null, creatorSessionId: null, parentSessionId: null, coordinatingCreatorSessionId: WORKING, wasInterrupted: false,
    state: 'idle', detail: 'its turn ended', isRunning: false, remote: false, updatedAt: '2026-11-16T15:00:00Z',
    openPullRequest: 'https://github.com/example/project/pull/7', automation: true,
  });
  assert.equal(listed.find((r) => r.id === CHAT).parentSessionId, WORKING);
});

test('a session the app marks running is working, and one whose history waits on an answer is waiting', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rows-state-'));
  const app = fakeApp({
    workspaces: [
      workspace('w1', WORKING, { session: { sessionId: WORKING, isRunning: true, updatedAt: '2026-11-16T15:59:00Z', executionLocation: 'local' } }),
      workspace('w2', WAITING, { session: { sessionId: WAITING, isRunning: false, updatedAt: '2026-11-16T15:59:00Z', executionLocation: 'local' } }),
    ],
  });
  writeHistory(home, WAITING, [
    { type: 'user.message', data: { content: 'Ask me.' }, at: NOW - 60_000 },
    { type: 'assistant.message', data: { toolRequests: [{ name: 'ask_user' }] }, at: NOW - 50_000 },
    { type: 'tool.execution_start', data: { toolCallId: 'c1', toolName: 'ask_user' }, at: NOW - 40_000 },
  ]);
  const byId = Object.fromEntries((await rows(testDeps(home, { app }))).map((r) => [r.id, r]));
  assert.equal(byId[WORKING].state, 'working');
  assert.equal(byId[WORKING].detail, 'the app says it is running');
  assert.equal(byId[WAITING].state, 'waiting');
  assert.equal(byId[WAITING].awaiting, 'input');
});

test('a session frozen on a permission prompt is waiting, and its row carries the oldest open request in plain words', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rows-perm-'));
  const app = fakeApp({ workspaces: [workspace('w1', WAITING, { projectName: 'Project', projectId: 'p1', displayPath: '/work/lane', session: { sessionId: WAITING, isRunning: false, updatedAt: '2026-11-16T15:59:00Z', executionLocation: 'local' } })] });
  writeHistory(home, WAITING, [
    { type: 'permission.requested', data: { requestId: 'r1', permissionRequest: { kind: 'shell', intention: 'run tests', command: 'secret --token x' } }, at: NOW - 60_000 },
    { type: 'permission.requested', data: { requestId: 'r2', permissionRequest: { kind: 'write' } }, at: NOW - 30_000 },
  ]);
  const [lane] = await rows(testDeps(home, { app }));
  assert.equal(lane.awaiting, 'permission');
  assert.equal(lane.state, 'waiting');
  assert.deepEqual(lane.prompt, { requestId: 'r1', what: 'run a shell command (run tests)', at: new Date(NOW - 60_000).toISOString() });
  assert.equal(lane.project, 'Project');
  assert.equal(lane.projectId, 'p1');
  assert.equal(lane.path, '/work/lane');
  assert.equal(describePermission({ kind: 'extension-permission-access', extensionName: 'mail', capabilities: ['network', 'files'] }), 'let the extension mail network, files');
  fs.rmSync(home, { recursive: true, force: true });
});

test('a session that is not running but whose loop stopped mid-turn is stuck, not idle', () => {
  const at = NOW - 3 * 3600_000;
  const facts = tailFacts([{ type: 'user.message', timestamp: new Date(at).toISOString(), data: {} }, { type: 'assistant.turn_start', timestamp: new Date(at + 1000).toISOString(), data: {} }]);
  assert.equal(classify(false, facts, NOW).state, 'stuck');
  assert.equal(classify(false, facts, NOW).detail, 'not running, but its loop stopped mid-turn (last assistant.turn_start)');
  const done = tailFacts([{ type: 'user.message', data: {} }, { type: 'assistant.message', data: {} }, { type: 'assistant.turn_end', data: {} }]);
  assert.equal(classify(false, done, NOW).state, 'idle');
});

test('a running session whose history has not grown for half an hour is stuck', () => {
  const facts = tailFacts([]);
  assert.equal(classify(true, facts, NOW, NOW - 31 * 60_000).state, 'stuck');
  assert.equal(classify(true, facts, NOW, NOW - 60_000).state, 'working');
});

test('a sidebar the app does not answer for throws, with the reason', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rows-down-'));
  const d = testDeps(home, { app: { exchange: async () => [{ type: 'socket_error', message: 'no ws.port' }] } });
  await assert.rejects(rows(d), (e) => e.code === 'sidebar-unlisted' && /no ws\.port/.test(e.problem));
  fs.rmSync(home, { recursive: true, force: true });
});
