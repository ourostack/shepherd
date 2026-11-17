// The X-ray's pretend app: a Copilot app home under the given (temporary) HOME, with its database, session histories and a
// socket on loopback that answers as the app does (test/fake-app.mjs). It prints "ready" and stays up until it is stopped.
// Nothing here touches a real app: the home it writes is the one folder it is given.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { startFakeApp } from '../test/fake-app.mjs';
import { copilotReplies } from '../test/fake-copilot.mjs';

const home = process.argv[2];
if (!home) { console.error('xray-fixture: needs the temporary home as its argument'); process.exit(2); }
const appHome = path.join(home, '.copilot');
fs.mkdirSync(appHome, { recursive: true });

const IDLE = 'a3000000-0000-4000-8000-000000000003';
const WORKING = 'a1000000-0000-4000-8000-000000000001';
const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();
const lane = (id, sessionId, running, msAgo) => ({
  id, name: `Lane ${id}`, branch: 'lane-branch', workspaceType: 'worktree', checkoutBindings: [{ repoFullName: 'example/project' }],
  session: { sessionId, isRunning: running, updatedAt: iso(msAgo), executionLocation: 'local' },
});

const sql = [
  'CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, mode TEXT, is_running INTEGER, was_interrupted INTEGER, execution_location TEXT, archived_at TEXT);',
  'CREATE TABLE workspaces (id TEXT, session_id TEXT, project_id TEXT, archived_at TEXT);',
  'CREATE TABLE projects (id TEXT, name TEXT, container_kind TEXT, main_repo_path TEXT, show_in_sidebar INTEGER, copilot_account_id TEXT);',
  `INSERT INTO sessions VALUES ('${IDLE}', 'idle lane', NULL, 0, 0, 'local', NULL);`,
  `INSERT INTO sessions VALUES ('${WORKING}', 'working lane', 'autopilot', 1, 0, 'local', NULL);`,
  `INSERT INTO workspaces VALUES ('w-idle', '${IDLE}', 'proj-1', NULL);`,
  `INSERT INTO workspaces VALUES ('w-work', '${WORKING}', 'proj-1', NULL);`,
  "INSERT INTO projects VALUES ('proj-1', 'Shepherd', 'repository', '/work/shepherd', 1, NULL);",
].join('\n');
spawnSync('/usr/bin/sqlite3', [path.join(appHome, 'data.db')], { input: sql, stdio: ['pipe', 'ignore', 'inherit'] });

const history = (id, events) => {
  const dir = path.join(appHome, 'session-state', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), `${events.map(([type, data, msAgo]) => JSON.stringify({ type, data, timestamp: iso(msAgo) })).join('\n')}\n`);
};
history(IDLE, [['user.message', { content: 'Carry on.' }, 120_000], ['assistant.message', { content: 'Done.' }, 110_000], ['assistant.turn_end', {}, 100_000]]);
history(WORKING, [['user.message', { content: 'Work.' }, 30_000], ['assistant.turn_start', {}, 20_000]]);

const app = await startFakeApp(appHome, { reply: copilotReplies({ workspaces: [lane('w-idle', IDLE, false, 60_000), lane('w-work', WORKING, true, 1000)], projects: [{ id: 'proj-1', name: 'Shepherd' }] }) });
fs.writeFileSync(path.join(home, '.shepherd-xray-fixture'), `${JSON.stringify({ port: Number(fs.readFileSync(path.join(appHome, 'run', 'ws.port'), 'utf8')) })}\n`);
console.log('ready');
const stop = async () => { await app.close(); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
