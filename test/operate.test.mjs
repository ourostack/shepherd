// The agent operations over the app's socket: reading sessions, sending, creating, answering, archiving, automations and
// workflows. Ported from the rules the app-sessions tools kept, against a pretend app (test/fake-app.mjs, test/fake-copilot.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deps } from '../src/index.mjs';
import { answer, archiveSession, automation, automationOf, create, findSession, messages, plan, runWorkflow, send, session, sessions, show, workflows } from '../src/operate.mjs';
import { writePending } from '../src/store.mjs';
import { startFakeApp } from './fake-app.mjs';
import { CHAT_SESSION, WORKSPACE_SESSION, copilotReplies } from './fake-copilot.mjs';
import { writeHistory } from './fake-sidebar.mjs';

const WORKING = 'a1000000-0000-4000-8000-000000000001';
const WAITING = 'a2000000-0000-4000-8000-000000000002';
const IDLE = 'a3000000-0000-4000-8000-000000000003';
const PLANNING = 'a5000000-0000-4000-8000-000000000005';
const OLD = 'b0000000-0000-4000-8000-000000000001';
const NEWER = 'b0000000-0000-4000-8000-000000000002';

const at = (msAgo) => Date.now() - msAgo;
const lane = (id, sessionId, over = {}) => ({
  id, name: `Lane ${id}`, branch: 'lane-branch', workspaceType: 'worktree', checkoutBindings: [{ repoFullName: 'example/project' }],
  session: { sessionId, isRunning: false, updatedAt: new Date(at(60_000)).toISOString(), executionLocation: 'local' }, ...over,
});

// A home with the sidebar and histories above, and deps that talk to the pretend app over its real socket.
async function withCopilot({ workspaces = [], chats = [], projects = [], refuse = [], reply = null } = {}, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shepherd-ops-'));
  const home = path.join(root, 'app');
  const state = path.join(root, 'state');
  const base = copilotReplies({ workspaces, chats, projects, refuse });
  const app = await startFakeApp(home, { reply: (m) => (reply?.(m) ?? base(m)) });
  const d = { ...deps({ copilotHome: home, state }), sendWaitMs: 1500 };
  try { return await fn({ d, app, home, state, root }); } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const sidebar = () => [
  lane('w-idle', IDLE, { coordinatingCreatorSessionId: WORKING, projectName: 'Project', projectId: 'p1', displayPath: '/work/idle' }),
  lane('w-work', WORKING, { session: { sessionId: WORKING, isRunning: true, updatedAt: new Date(at(1000)).toISOString(), executionLocation: 'local' } }),
  lane('w-wait', WAITING),
  lane('w-plan', PLANNING),
];

function histories(d, home) {
  writeHistory(home, IDLE, [{ type: 'user.message', data: { content: 'Carry on.' }, at: at(120_000) }, { type: 'assistant.message', data: { content: 'Done.' }, at: at(110_000) }, { type: 'assistant.turn_end', data: {}, at: at(100_000) }]);
  writeHistory(home, WORKING, [{ type: 'user.message', data: { content: 'Work.' }, at: at(30_000) }, { type: 'assistant.turn_start', data: {}, at: at(20_000) }]);
  writeHistory(home, WAITING, [
    { type: 'user.message', data: { content: 'Ask me.' }, at: at(90_000) },
    { type: 'assistant.message', data: { toolRequests: [{ name: 'ask_user' }] }, at: at(80_000) },
    { type: 'tool.execution_start', data: { toolCallId: 'c1', toolName: 'ask_user' }, at: at(70_000) },
  ]);
  writeHistory(home, PLANNING, [
    { type: 'user.message', data: { content: 'Plan it.' }, at: at(90_000) },
    { type: 'tool.execution_start', data: { toolCallId: 'p1', toolName: 'exit_plan_mode' }, at: at(70_000) },
  ]);
}

test('sessions lists the sidebar with counts, and a state filter keeps only that state', async () => {
  await withCopilot({ workspaces: sidebar() }, async ({ d, home }) => {
    histories(d, home);
    const all = await sessions(d);
    assert.equal(all.summary.total, 4);
    assert.equal(all.summary.busy, 1);
    assert.equal(all.summary.blocked, 2);
    assert.equal(all.summary.awaiting_user_input, 1);
    assert.equal(all.summary.awaiting_plan_approval, 1);
    const idle = all.sessions.find((s) => s.id === IDLE);
    assert.equal(idle.project_name, 'Project');
    assert.equal(idle.project_id, 'p1');
    assert.equal(idle.path, '/work/idle');
    assert.equal(idle.coordinator_session_id, WORKING, 'the recorded coordinator is still listed, so it is named');
    assert.equal(idle.coordinator_found_by, undefined);
    assert.equal(idle.coordinating_creator_session_id, WORKING);
    assert.equal(idle.app_url, `ghapp://sessions/${IDLE}`);
    const busy = await sessions(d, { state: 'busy' });
    assert.deepEqual(busy.sessions.map((s) => s.id), [WORKING]);
    assert.equal(busy.sessions[0].activity.status, 'busy');
    const waiting = await sessions(d, { state: 'waiting' });
    assert.deepEqual(waiting.sessions.map((s) => s.id).sort(), [WAITING, PLANNING].sort());
  });
});

test('a session is found by its id or a unique start of 8 or more characters, and the refusals say why', async () => {
  await withCopilot({ workspaces: sidebar() }, async ({ d, home }) => {
    histories(d, home);
    assert.equal((await session(d, IDLE)).id, IDLE);
    assert.equal((await session(d, IDLE.slice(0, 8))).id, IDLE);
    assert.equal((await session(d, 'w-idle')).id, IDLE, 'the workspace id names it too');
    await assert.rejects(session(d, 'a3000'), (e) => e.code === 'short-id' && /8 or more characters/.test(e.problem));
    await assert.rejects(session(d, 'ffffffff-0000'), (e) => e.code === 'no-session');
    await assert.rejects(session(d, ''), (e) => e.code === 'no-session');
    assert.equal(findSession([{ id: IDLE, workspaceId: 'x' }], 'x').id, IDLE);
  });
  await withCopilot({ workspaces: [lane('w-old', OLD), lane('w-newer', NEWER)] }, async ({ d }) => {
    await assert.rejects(session(d, OLD.slice(0, 8)), (e) => e.code === 'ambiguous-session' && /matches 2 sessions/.test(e.problem));
    assert.equal((await session(d, OLD)).id, OLD, 'a whole id is never ambiguous');
  });
});

test('session shows what a blocked session waits on: the request id and the question, from what the tracker heard', async () => {
  await withCopilot({ workspaces: sidebar() }, async ({ d, home }) => {
    histories(d, home);
    writePending(d, {
      [WAITING]: { kind: 'input', requestId: 'q1', question: 'Which branch?', choices: ['main', 'dev'], allowFreeform: false, at: new Date().toISOString() },
    });
    const waiting = await session(d, WAITING);
    assert.equal(waiting.awaiting_user_input, true);
    assert.deepEqual(waiting.awaiting_input, { kind: 'user_input', request_id: 'q1', question: 'Which branch?', choices: ['main', 'dev'], allow_freeform: false });
    const planned = await session(d, PLANNING);
    assert.equal(planned.awaiting_plan_approval, true);
    assert.equal(planned.awaiting_input.request_id, null, 'a plan this agent did not hear has no request id');
  });
});

test('messages returns the last n messages, oldest first, with where they came from', async () => {
  await withCopilot({ workspaces: sidebar() }, async ({ d, home }) => {
    histories(d, home);
    const r = await messages(d, IDLE, 1);
    assert.deepEqual(r.messages.map((m) => [m.role, m.text]), [['assistant', 'Done.']]);
    assert.equal(r.coverage, 'local');
    assert.equal(r.requestedCount, 1);
    assert.equal(r.beginningReached, true);
    const all = await messages(d, IDLE);
    assert.deepEqual(all.messages.map((m) => m.role), ['user', 'assistant']);
    assert.equal(all.last_activity !== undefined, true);
    const working = await messages(d, WORKING);
    assert.equal(working.coverage, 'local');
    assert.deepEqual(working.messages.map((m) => m.text), ['Work.']);
  });
});

test('messages says a missing history is missing, and clamps the count to 1..50', async () => {
  await withCopilot({ workspaces: [lane('w-none', 'c0000000-0000-4000-8000-000000000001')] }, async ({ d }) => {
    const r = await messages(d, 'c0000000-0000-4000-8000-000000000001', 500);
    assert.equal(r.missing, true);
    assert.equal(r.coverage, 'missing');
    assert.equal(r.requestedCount, 50);
  });
});

test('send delivers immediately by default, queues when asked, and reports a refusal', async () => {
  await withCopilot({ workspaces: sidebar(), refuse: [IDLE] }, async ({ d, app, home }) => {
    histories(d, home);
    const ok = await send(d, { session_id: WORKING, message: 'carry on' });
    assert.deepEqual(ok, { ok: true, status: 'accepted', session_id: WORKING, name: 'Lane w-work', message_id: 'msg-1' });
    assert.equal(app.received.at(-1).delivery_mode, 'immediate');
    const queued = await send(d, { session_id: WORKING, message: 'after', delivery_mode: 'enqueue' });
    assert.equal(queued.ok, true);
    assert.equal(app.received.at(-1).delivery_mode, 'enqueue');
    const refused = await send(d, { session_id: IDLE, message: 'hi' });
    assert.equal(refused.ok, false);
    assert.equal(refused.status, 'failed');
    assert.equal(refused.error, `${IDLE} is archived`);
    await assert.rejects(send(d, { session_id: WORKING, message: '  ' }), (e) => e.code === 'no-message');
  });
});

test('a message the app began to deliver but did not confirm is not called lost', async () => {
  await withCopilot({ workspaces: sidebar(), reply: (m) => (m.type === 'send_message' ? [{ type: 'session_dispatch_state', request_id: m.request_id, session_id: m.session_id, dispatch_may_have_started: true }] : null) }, async ({ d, home }) => {
    histories(d, home);
    const r = await send(d, { session_id: WORKING, message: 'carry on' });
    assert.equal(r.ok, false);
    assert.match(r.error, /began delivering the message but had not confirmed it in time; read the session before sending it again/);
  });
});

test('create makes a chat, names it, sets its mode and sends the first message, and records it as this agent\'s', async () => {
  await withCopilot({ workspaces: sidebar() }, async ({ d, app, state }) => {
    const r = await create(d, { name: 'Notes', session_kind: 'chat', kickoff: { prompt: 'Start here', mode: 'plan' } });
    assert.equal(r.ok, true);
    assert.equal(r.session_id, CHAT_SESSION);
    assert.equal(r.kind, 'chat');
    assert.equal(r.app_url, `ghapp://sessions/${CHAT_SESSION}`);
    assert.match(r.coordination, /cannot be a session's coordinator/);
    const types = app.received.map((m) => m.type);
    assert.deepEqual(types.filter((t) => ['create_session', 'rename_session', 'set_session_mode', 'send_message'].includes(t)), ['create_session', 'rename_session', 'set_session_mode', 'send_message']);
    assert.equal(app.received.find((m) => m.type === 'set_session_mode').mode, 'plan');
    assert.equal(app.received.find((m) => m.type === 'send_message').prompt, 'Start here');
    const probes = JSON.parse(fs.readFileSync(path.join(state, 'probes.json'), 'utf8'));
    assert.equal(probes[CHAT_SESSION].name, 'Notes');
  });
});

test('create makes a project session in a worktree, finding the project by name, and opens its session', async () => {
  const projects = [{ id: 'proj-1', name: 'Shepherd' }];
  await withCopilot({ workspaces: sidebar(), projects }, async ({ d, app }) => {
    const r = await create(d, { project_id: 'Shepherd', name: 'Lane', workspace_type: 'worktree', kickoff: { prompt: 'Go', permission_mode: 'allow-all' } });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.session_id, WORKSPACE_SESSION);
    assert.equal(r.kind, 'session');
    assert.equal(r.workspace_id, 'w-new');
    const make = app.received.find((m) => m.type === 'create_worktree_workspace');
    assert.equal(make.project_id, 'proj-1');
    assert.equal(make.name, 'Lane');
    assert.match(make.branch_name, /^shepherd-[0-9a-f]{8}$/);
    assert.equal(app.received.find((m) => m.type === 'create_session' && m.workspace_id).cwd, '/work/new-lane');
    assert.equal(app.received.find((m) => m.type === 'send_message').delivery_mode, 'immediate');
  });
});

test('create refuses a project session with no project, and an unknown project, saying which projects exist', async () => {
  await withCopilot({ workspaces: sidebar(), projects: [{ id: 'proj-1', name: 'Shepherd' }] }, async ({ d }) => {
    await assert.rejects(create(d, { session_kind: 'project' }), (e) => e.code === 'no-project' && /needs a project/.test(e.problem));
    await assert.rejects(create(d, { project_id: 'Nope' }), (e) => e.code === 'no-project' && /\(it has: Shepherd\)/.test(e.problem));
  });
});

test('answer answers a question the tracker heard, with the request id, and refuses one it did not hear', async () => {
  await withCopilot({ workspaces: sidebar() }, async ({ d, app, home }) => {
    histories(d, home);
    await assert.rejects(answer(d, { session_id: WAITING, answer: 'main' }), (e) => e.code === 'not-waiting' && /heard asked/.test(e.problem));
    writePending(d, { [WAITING]: { kind: 'input', requestId: 'q1', choices: ['main', 'dev'], at: new Date().toISOString() } });
    const r = await answer(d, { session_id: WAITING, answer: 'main' });
    assert.deepEqual(r, { ok: true, session_id: WAITING });
    const sent = app.received.find((m) => m.type === 'respond_to_user_input');
    assert.equal(sent.request_id, 'q1');
    assert.equal(sent.was_freeform, false);
    await assert.rejects(answer(d, { session_id: WAITING, answer: '' }), (e) => e.code === 'no-answer');
  });
});

test('plan approves or rejects a plan the tracker heard, then sends its feedback', async () => {
  await withCopilot({ workspaces: sidebar() }, async ({ d, app, home }) => {
    histories(d, home);
    await assert.rejects(plan(d, { session_id: PLANNING, approved: true }), (e) => e.code === 'not-waiting');
    writePending(d, { [PLANNING]: { kind: 'plan', requestId: 'pl1', summary: 'Do it', actions: ['go'], at: new Date().toISOString() } });
    const r = await plan(d, { session_id: PLANNING, approved: false, selected_action: 'go', feedback: 'Smaller please' });
    assert.deepEqual(r, { ok: true, approved: false, session_id: PLANNING, feedback_sent: true });
    const responded = app.received.find((m) => m.type === 'respond_to_exit_plan_mode');
    assert.equal(responded.request_id, 'pl1');
    assert.equal(responded.approved, false);
    assert.equal(responded.selected_action, 'go');
    assert.equal(app.received.find((m) => m.type === 'send_message' && m.prompt === 'Smaller please').session_id, PLANNING);
  });
});

test('archive takes only what this agent created, or what the owner asked for, or an oversize session a newer one handed off', async () => {
  await withCopilot({ workspaces: [lane('w-old', OLD), lane('w-newer', NEWER), lane('w-mine', IDLE)] }, async ({ d, state }) => {
    // Not created here, not asked for, not handed off: refused, and nothing is archived.
    await assert.rejects(archiveSession(d, { session_id: OLD }), (e) => e.code === 'not-created-here' && /was not created by this agent/.test(e.problem));
    // Created here: archived, and its probe is cleared.
    await create(d, { name: 'mine', session_kind: 'chat', kickoff: {} });
    const made = JSON.parse(fs.readFileSync(path.join(state, 'probes.json'), 'utf8'));
    assert.ok(made[CHAT_SESSION]);
    // The owner asked for OLD: archived, and logged as owner-asked.
    const asked = await archiveSession(d, { session_id: OLD, owner_asked: true });
    assert.deepEqual(asked, { ok: true, session_id: OLD });
    const log = fs.readFileSync(path.join(state, 'retire-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(log.at(-1).id, OLD);
    assert.equal(log.at(-1).reason, 'owner-asked');
  });
});

test('archive takes an oversize session that a newer session names as handed off, and nothing else', async () => {
  await withCopilot({ workspaces: [lane('w-old', OLD), lane('w-newer', NEWER)] }, async ({ d, state }) => {
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'oversize.json'), JSON.stringify({ sessions: { [OLD]: { reason: 'oversize' } } }));
    fs.writeFileSync(path.join(state, 'successions.json'), JSON.stringify({ sessions: { [NEWER]: { predecessor: OLD, at: new Date().toISOString(), turned: true, offset: 0 } } }));
    const r = await archiveSession(d, { session_id: OLD });
    assert.equal(r.ok, true);
    const log = fs.readFileSync(path.join(state, 'retire-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(log.at(-1).reason, 'handed-off');
    await assert.rejects(archiveSession(d, { session_id: NEWER }), (e) => e.code === 'not-created-here');
  });
});

test('automation saves only the fields given, clears the one a session has, and reads them', async () => {
  await withCopilot({ workspaces: sidebar() }, async ({ d, app }) => {
    const saved = await automation(d, { session_id: WORKING, prompt: 'Check the build', interval: 'minutes', every_minutes: 30 });
    assert.deepEqual(saved, { ok: true, session_id: WORKING, automation: { id: 'auto-1', name: null } });
    const sent = app.received.find((m) => m.type === 'save_session_automation');
    assert.deepEqual(Object.keys(sent).filter((k) => !['type', 'session_id', 'request_id'].includes(k)).sort(), ['every_minutes', 'interval', 'prompt']);
    assert.deepEqual(await automation(d, { session_id: WORKING, clear: true }), { ok: true, session_id: WORKING, cleared: true });
    assert.equal(app.received.find((m) => m.type === 'cancel_session_automation').automation_id, 'auto-1');
    const read = await automationOf(d, WORKING);
    assert.deepEqual(read.automations, [{ id: 'auto-1' }]);
  });
});

test('workflows lists the app\'s workflows, runs one, and shows a session in the window', async () => {
  await withCopilot({ workspaces: sidebar() }, async ({ d }) => {
    assert.deepEqual(await workflows(d), { ok: true, workflows: [{ id: 'wf-1', name: 'Nightly' }] });
    assert.deepEqual(await runWorkflow(d, 'wf-1'), { ok: true, run: { id: 'run-1' } });
    await assert.rejects(runWorkflow(d, ''), (e) => e.code === 'no-workflow');
    assert.deepEqual(await show(d, IDLE), { ok: true, session_id: IDLE, app_url: `ghapp://sessions/${IDLE}` });
  });
});
