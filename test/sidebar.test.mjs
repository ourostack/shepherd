// The sidebar tidy: a project shows when it is a home or holds an unarchived session (local or cloud), and only the changes are sent.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deps } from '../src/sessions.mjs';
import { watchDuties } from '../src/resident.mjs';
import { renderSidebar, sidebarConfig, sidebarPlan, sidebarTidy } from '../src/index.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shepherd-sidebar-'));
const missing = path.join(dir, 'no-sidebar.json');

test('a home with no sessions shows; a project with only a cloud session shows; an empty project hides; a hidden empty one does not change', () => {
  const projects = [
    { id: 'home', name: 'home', main_repo_path: '/Users/me/home', show_in_sidebar: 0 },
    { id: 'cloud', name: 'cloud', main_repo_path: '/Users/me/cloud', show_in_sidebar: 0 },
    { id: 'empty', name: 'empty', main_repo_path: '/Users/me/empty', show_in_sidebar: 1 },
    { id: 'gone', name: 'gone', main_repo_path: '/Users/me/gone', show_in_sidebar: 0 },
  ];
  const sessions = [{ id: 's1', project_id: 'cloud' }, { id: 's1', project_id: 'cloud' }, { id: 's2', project_id: null }];
  const plan = sidebarPlan(projects, sessions, { homes: ['/Users/me/home/'] });
  const by = Object.fromEntries(plan.map((p) => [p.id, p]));
  assert.deepEqual([by.home.show, by.home.why, by.home.changes], [true, 'a home', true]);
  assert.deepEqual([by.cloud.show, by.cloud.sessions, by.cloud.changes], [true, 1, true], 'a session seen twice counts once');
  assert.deepEqual([by.empty.show, by.empty.changes], [false, true]);
  assert.deepEqual([by.gone.show, by.gone.changes], [false, false], 'an already-hidden empty project is not re-sent');
});

test('apply sends only the changes, leaves other projects alone, and reports a refused request instead of throwing', async () => {
  const sent = [];
  const d = {
    sql: async (q) => (q.startsWith('SELECT id, name, main_repo_path') ? [
      { id: 'home', name: 'home', main_repo_path: '/h', show_in_sidebar: 0 },
      { id: 'empty', name: 'empty', main_repo_path: '/e', show_in_sidebar: 1 },
      { id: 'quiet', name: 'quiet', main_repo_path: '/q', show_in_sidebar: 0 },
    ] : [{ id: 'a', project_id: 'home' }]),
    exchange: async (messages) => {
      sent.push(messages[0]);
      if (messages[0].project_id === 'empty') return [{ type: 'error', message: 'project is busy' }];
      return [{ type: 'project_updated', project: { id: messages[0].project_id, showInSidebar: messages[0].show_in_sidebar } }];
    },
  };
  const r = await sidebarTidy(d, { homes: ['/h'], apply: true });
  assert.deepEqual(sent.map((m) => [m.type, m.project_id, m.show_in_sidebar]), [
    ['set_project_sidebar_visibility', 'home', true],
    ['set_project_sidebar_visibility', 'empty', false],
  ]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.done.map((x) => [x.id, x.ok, x.error]), [['home', true, null], ['empty', false, 'project is busy']]);
  assert.match(renderSidebar(r), /refused: project is busy/);
});

test('the sidebar query runs on the app schema: a cloud session counts, an archived one does not', { skip: spawnSync('/usr/bin/sqlite3', ['-version']).status !== 0 && 'needs /usr/bin/sqlite3' }, async () => {
  const home = fs.mkdtempSync(path.join(dir, 'home-'));
  const sql = [
    'CREATE TABLE projects (id TEXT, name TEXT, main_repo_path TEXT, show_in_sidebar INTEGER);',
    'CREATE TABLE sessions (id TEXT, title TEXT, archived_at TEXT, execution_location TEXT, is_running INTEGER, was_interrupted INTEGER, mode TEXT);',
    'CREATE TABLE workspaces (id TEXT, session_id TEXT, project_id TEXT, archived_at TEXT);',
    'CREATE TABLE workspace_side_chats (session_id TEXT, workspace_id TEXT);',
    'CREATE TABLE session_account_projects (session_id TEXT, project_id TEXT);',
    "INSERT INTO projects VALUES ('cloud', 'cloud', '/c', 0), ('old', 'old', '/o', 1);",
    "INSERT INTO sessions VALUES ('s-cloud', 'x', NULL, 'cloud', 0, 0, NULL), ('s-old', 'y', '2026-11-01', 'local', 0, 0, NULL);",
    "INSERT INTO workspaces VALUES ('w1', 's-cloud', 'cloud', NULL), ('w2', 's-old', 'old', NULL);",
  ].join('\n');
  const dbFile = path.join(home, 'data.db');
  spawnSync('/usr/bin/sqlite3', [dbFile], { input: sql });
  const d = deps({ copilotHome: home, state: home });
  const sent = [];
  d.exchange = async (messages) => { sent.push(messages[0]); return [{ type: 'project_updated', project: { id: messages[0].project_id } }]; };
  const r = await sidebarTidy(d, { homes: [], apply: true });
  assert.deepEqual(sent.map((m) => [m.project_id, m.show_in_sidebar]), [['cloud', true], ['old', false]], 'the cloud session shows its project; the archived one hides its project');
  fs.rmSync(home, { recursive: true, force: true });
  assert.equal(r.ok, true);
});


test('with no sidebar.json the config is off and the duty does nothing; enabled must be exactly true', async () => {
  const saved = process.env.SHEPHERD_SIDEBAR_CONFIG;
  process.env.SHEPHERD_SIDEBAR_CONFIG = missing;
  try {
    assert.deepEqual(sidebarConfig(), { enabled: false, homes: [], everyMinutes: 30 });
    const file = path.join(dir, 'truthy.json');
    fs.writeFileSync(file, JSON.stringify({ enabled: 'yes', homes: ['/h'] }));
    assert.equal(sidebarConfig(file).enabled, false);
    // The duty would throw (no app database under this folder) if it read anything, so resolving proves it did nothing.
    const duty = watchDuties({ copilotHome: dir }).find((x) => x.name === 'sidebar tidy');
    await duty.run();
  } finally {
    if (saved === undefined) delete process.env.SHEPHERD_SIDEBAR_CONFIG;
    else process.env.SHEPHERD_SIDEBAR_CONFIG = saved;
  }
});

after(() => fs.rmSync(dir, { recursive: true, force: true }));
