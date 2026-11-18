// The agent verbs of `shepherd`: their arguments (flags, or one JSON object on stdin), and one run per verb through the real CLI
// against the pretend app, checking that --json prints one JSON result.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toolArgs } from '../src/agent-cli.mjs';
import { startFakeApp } from './fake-app.mjs';
import { CHAT_SESSION, WORKSPACE_SESSION, copilotReplies } from './fake-copilot.mjs';
import { writeHistory } from './fake-sidebar.mjs';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'shepherd.mjs');
const IDLE = 'a3000000-0000-4000-8000-000000000003';
const WORKING = 'a1000000-0000-4000-8000-000000000001';
const WAITING = 'a2000000-0000-4000-8000-000000000002';
const PLANNING = 'a5000000-0000-4000-8000-000000000005';

const at = (msAgo) => Date.now() - msAgo;
const lane = (id, sessionId, over = {}) => ({
  id, name: `Lane ${id}`, branch: 'lane-branch', workspaceType: 'worktree', checkoutBindings: [{ repoFullName: 'example/project' }],
  session: { sessionId, isRunning: false, updatedAt: new Date(at(60_000)).toISOString(), executionLocation: 'local' }, ...over,
});

// The CLI as a child process (async, so the in-process app can answer it), with HOME in the test's folder for its state.
const ACTIONS = ['send', 'create', 'answer', 'plan', 'archive', 'automation', 'run-workflow'];
function cli(args, { home, stdin = null, why = true, env = {} }) {
  const argv = why && ACTIONS.includes(args[0]) ? [...args, '--why', 'a test asked for it'] : args;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...argv], { env: { ...process.env, HOME: home, ...env } });
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(stdin ?? '');
  });
}

// An app with a sidebar of four sessions and their histories, a project, and a question and a plan the tracker heard.
async function withApp(fn, { refuse = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shepherd-agent-cli-'));
  const home = path.join(root, 'home');
  const appHome = path.join(root, 'app');
  const workspaces = [lane('w-idle', IDLE, { coordinatingCreatorSessionId: WORKING }), lane('w-work', WORKING, { session: { sessionId: WORKING, isRunning: true, updatedAt: new Date(at(1000)).toISOString(), executionLocation: 'local' } }), lane('w-wait', WAITING), lane('w-plan', PLANNING)];
  const app = await startFakeApp(appHome, { reply: copilotReplies({ workspaces, projects: [{ id: 'proj-1', name: 'Shepherd' }], refuse }) });
  writeHistory(appHome, IDLE, [{ type: 'user.message', data: { content: 'Carry on.' }, at: at(120_000) }, { type: 'assistant.message', data: { content: 'Done.' }, at: at(110_000) }, { type: 'assistant.turn_end', data: {}, at: at(100_000) }]);
  writeHistory(appHome, WORKING, [{ type: 'user.message', data: { content: 'Work.' }, at: at(30_000) }, { type: 'assistant.turn_start', data: {}, at: at(20_000) }]);
  writeHistory(appHome, WAITING, [{ type: 'assistant.message', data: { toolRequests: [{ name: 'ask_user' }] }, at: at(80_000) }, { type: 'tool.execution_start', data: { toolCallId: 'c1', toolName: 'ask_user' }, at: at(70_000) }]);
  writeHistory(appHome, PLANNING, [{ type: 'tool.execution_start', data: { toolCallId: 'p1', toolName: 'exit_plan_mode' }, at: at(70_000) }]);
  const state = path.join(home, 'Library', 'Caches', 'shepherd');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'pending.json'), JSON.stringify({
    [WAITING]: { kind: 'input', requestId: 'q1', choices: ['main'], at: new Date().toISOString() },
    [PLANNING]: { kind: 'plan', requestId: 'pl1', actions: ['go'], at: new Date().toISOString() },
  }));
  try { return await fn({ appHome, home, app }); } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const json = (r) => JSON.parse(r.stdout);

test('toolArgs reads flags into the tool argument names, and kickoff flags into kickoff', () => {
  const p = toolArgs('send', { id: IDLE, message: 'hi', delivery: 'enqueue' });
  assert.deepEqual(p, { session_id: IDLE, message: 'hi', delivery_mode: 'enqueue' });
  const c = toolArgs('create', { project: 'Shepherd', prompt: 'go', mode: 'plan', branch: 'feature-x' });
  assert.deepEqual(c, { project_id: 'Shepherd', branch_name: 'feature-x', kickoff: { prompt: 'go', mode: 'plan' } });
  assert.equal(toolArgs('plan', { id: IDLE, approved: 'false' }).approved, false);
});

test('toolArgs reads one JSON object from --input, and a flag wins over the input', () => {
  const input = JSON.stringify({ session_id: IDLE, message: 'from input', delivery_mode: 'immediate' });
  assert.deepEqual(toolArgs('send', { input, delivery: 'enqueue' }), { session_id: IDLE, message: 'from input', delivery_mode: 'enqueue' });
  const c = toolArgs('create', { input: JSON.stringify({ project_id: 'Shepherd', kickoff: { prompt: 'go', permission_mode: 'manual' } }) });
  assert.deepEqual(c, { project_id: 'Shepherd', kickoff: { prompt: 'go', permission_mode: 'manual' } });
});

test('toolArgs refuses what it cannot read, with the verb\'s help as the fix', () => {
  const bad = (verb, input, problem) => assert.throws(() => toolArgs(verb, input), (e) => e.exit === 2 && e.shape.problem === problem && e.shape.fix === `shepherd ${verb} --help`);
  bad('send', { id: IDLE, delivery: 'sometimes' }, '--delivery takes immediate|enqueue');
  bad('send', { input: JSON.stringify({ bogus: 1 }) }, 'unknown input key "bogus" for send');
  bad('send', { input: '[1]' }, '--input needs one JSON object on stdin');
});

test('shepherd sessions --json lists the sidebar with its summary, and --state keeps one state', async () => {
  await withApp(async ({ appHome, home }) => {
    const all = await cli(['sessions', '--json', '--copilot-home', appHome], { home });
    assert.equal(all.status, 0, all.stderr);
    const r = json(all);
    assert.equal(r.summary.total, 4);
    assert.ok(r.sessions.some((s) => s.id === IDLE && s.activity.status === 'idle'));
    const busy = json(await cli(['sessions', '--state', 'busy', '--json', '--copilot-home', appHome], { home }));
    assert.deepEqual(busy.sessions.map((s) => s.id), [WORKING]);
  });
});

test('shepherd session <id> --json shows one session and what it waits on', async () => {
  await withApp(async ({ appHome, home }) => {
    const r = await cli(['session', WAITING.slice(0, 8), '--json', '--copilot-home', appHome], { home });
    assert.equal(r.status, 0, r.stderr);
    const s = json(r);
    assert.equal(s.id, WAITING);
    assert.equal(s.awaiting_input.request_id, 'q1');
  });
});

test('shepherd messages <id> --json returns the last messages, oldest first', async () => {
  await withApp(async ({ appHome, home }) => {
    const r = json(await cli(['messages', IDLE, '--count', '1', '--json', '--copilot-home', appHome], { home }));
    assert.deepEqual(r.messages.map((m) => [m.role, m.text]), [['assistant', 'Done.']]);
    assert.equal(r.coverage, 'local');
  });
});

test('shepherd send <id> --message --json delivers, and a refused send exits 1 with ok false', async () => {
  await withApp(async ({ appHome, home, app }) => {
    const r = await cli(['send', WORKING, '--message', 'carry on', '--delivery', 'enqueue', '--as-user', '--json', '--copilot-home', appHome], { home });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(json(r).status, 'accepted');
    assert.equal(app.received.at(-1).delivery_mode, 'enqueue');
  }, { refuse: [IDLE] });
  await withApp(async ({ appHome, home }) => {
    const r = await cli(['send', IDLE, '--json', '--copilot-home', appHome], { home });
    assert.equal(r.status, 1);
    assert.equal(json(r).code, 'no-message');
    assert.match(r.stderr, /^shepherd: no-message: the message is empty\. Fix: pass --message <text>\.$/m);
  });
  await withApp(async ({ appHome, home }) => {
    const r = await cli(['send', '--input', '-', '--json', '--copilot-home', appHome], { home, stdin: JSON.stringify({ session_id: IDLE, message: 'hi', as_user: true }) });
    assert.equal(r.status, 1);
    assert.equal(json(r).ok, false);
    assert.match(json(r).error, /is archived/);
  }, { refuse: [IDLE] });
});

test('shepherd create --json makes a project session on the project and prints its id', async () => {
  await withApp(async ({ appHome, home }) => {
    const r = await cli(['create', '--project', 'Shepherd', '--name', 'Lane', '--prompt', 'Go', '--as-user', '--json', '--copilot-home', appHome], { home });
    assert.equal(r.status, 0, r.stderr);
    const c = json(r);
    assert.equal(c.ok, true);
    assert.equal(c.session_id, WORKSPACE_SESSION);
    assert.equal(c.kind, 'session');
  });
});

test('shepherd create --session-kind chat --json makes a chat', async () => {
  await withApp(async ({ appHome, home }) => {
    const c = json(await cli(['create', '--session-kind', 'chat', '--name', 'Notes', '--json', '--copilot-home', appHome], { home }));
    assert.equal(c.session_id, CHAT_SESSION);
    assert.equal(c.kind, 'chat');
  });
});

test('shepherd answer <id> --answer --json answers the question the tracker heard', async () => {
  await withApp(async ({ appHome, home, app }) => {
    const r = await cli(['answer', WAITING, '--answer', 'main', '--json', '--copilot-home', appHome], { home });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(json(r), { ok: true, session_id: WAITING });
    assert.equal(app.received.find((m) => m.type === 'respond_to_user_input').request_id, 'q1');
  });
});

test('shepherd plan <id> --approved --json approves the plan and sends its feedback', async () => {
  await withApp(async ({ appHome, home, app }) => {
    const r = await cli(['plan', PLANNING, '--approved', 'true', '--action', 'go', '--feedback', 'Thanks', '--as-user', '--json', '--copilot-home', appHome], { home });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(json(r), { ok: true, approved: true, session_id: PLANNING, feedback_sent: true });
    assert.equal(app.received.find((m) => m.type === 'respond_to_exit_plan_mode').approved, true);
  });
});

test('shepherd archive --json archives a session the owner asked for, and refuses one nobody asked for', async () => {
  await withApp(async ({ appHome, home }) => {
    const refused = await cli(['archive', IDLE, '--json', '--copilot-home', appHome], { home });
    assert.equal(refused.status, 1);
    assert.equal(json(refused).ok, false);
    assert.equal(json(refused).code, 'not-created-here');
    const asked = await cli(['archive', IDLE, '--owner-asked', '--json', '--copilot-home', appHome], { home });
    assert.equal(asked.status, 0, asked.stderr);
    assert.deepEqual(json(asked), { ok: true, session_id: IDLE });
  });
});

test('shepherd automation <id> --json saves, reads and clears a session\'s automation', async () => {
  await withApp(async ({ appHome, home }) => {
    const save = json(await cli(['automation', WORKING, '--prompt', 'Check the build', '--interval', 'minutes', '--every-minutes', '30', '--json', '--copilot-home', appHome], { home }));
    assert.equal(save.ok, true);
    assert.equal(save.automation.id, 'auto-1');
    const read = json(await cli(['automation', WORKING, '--json', '--copilot-home', appHome], { home }));
    assert.deepEqual(read.automations, [{ id: 'auto-1' }]);
    const clear = json(await cli(['automation', WORKING, '--clear', '--json', '--copilot-home', appHome], { home }));
    assert.deepEqual(clear, { ok: true, session_id: WORKING, cleared: true });
  });
});

test('shepherd workflows --json lists the app\'s workflows', async () => {
  await withApp(async ({ appHome, home }) => {
    assert.deepEqual(json(await cli(['workflows', '--json', '--copilot-home', appHome], { home })), { ok: true, workflows: [{ id: 'wf-1', name: 'Nightly' }] });
  });
});

test('shepherd run-workflow <id> --json starts one', async () => {
  await withApp(async ({ appHome, home }) => {
    assert.deepEqual(json(await cli(['run-workflow', 'wf-1', '--json', '--copilot-home', appHome], { home })), { ok: true, run: { id: 'run-1' } });
  });
});

test('shepherd open <id> --json shows the session in the app', async () => {
  await withApp(async ({ appHome, home }) => {
    assert.deepEqual(json(await cli(['open', IDLE, '--json', '--copilot-home', appHome], { home })), { ok: true, session_id: IDLE, app_url: `ghapp://sessions/${IDLE}` });
  });
});

test('a bad agent verb is a usage error with the fix, and an app that is not running says so', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shepherd-agent-none-'));
  try {
    const bad = await cli(['send', IDLE, '--delivery', 'sometimes'], { home });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /^shepherd: send: --delivery is one of immediate, enqueue, not "sometimes"\. Fix: shepherd send /);
    const down = await cli(['sessions', '--json', '--copilot-home', path.join(home, 'nothing')], { home });
    assert.equal(down.status, 1);
    assert.match(down.stderr, /^shepherd: sidebar-unlisted: .*no ws\.port/m);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('by default an action without --why warns and goes on to the next check', async () => {
  await withApp(async ({ appHome, home }) => {
    const soft = await cli(['send', '--json', '--copilot-home', appHome], { home, why: false });
    assert.match(soft.stderr, /warning: send was run without --why/);
    assert.doesNotMatch(soft.stderr, /needs --why/);
    assert.match(soft.stderr, /needs <id>/);
  });
});

test('an action refuses without --why before it looks for the id, and a missing id says where to get one', async () => {
  await withApp(async ({ appHome, home }) => {
    const noWhy = await cli(['send', '--json', '--copilot-home', appHome], { home, why: false, env: { SHEPHERD_STRICT_WHY: '1' } });
    assert.equal(noWhy.status, 2);
    assert.match(noWhy.stderr, /needs --why/);
    const noId = await cli(['send', '--json', '--copilot-home', appHome], { home });
    assert.equal(noId.status, 2);
    assert.match(noId.stderr, /needs <id>.*Fix: shepherd sessions, then shepherd send <id>/);
    const noTarget = await cli(['create', '--json', '--copilot-home', appHome], { home });
    assert.equal(noTarget.status, 1);
    assert.match(noTarget.stderr, /needs a project.*--session-kind chat/);
  });
});

test('shepherd watch <id> waits on a session and, when nothing happens in time, exits 3 with the command that resumes', async () => {
  await withApp(async ({ appHome, home }) => {
    const r = await cli(['watch', IDLE, '--timeout', '100ms', '--json', '--copilot-home', appHome], { home });
    assert.equal(r.status, 3, r.stdout + r.stderr);
    const w = json(r);
    assert.equal(w.ax, 'wait/1');
    assert.equal(w.state, 'timed-out');
    assert.match(w.resume.command, new RegExp(`^shepherd watch ${IDLE} --timeout 100ms --cursor`));
  });
});
