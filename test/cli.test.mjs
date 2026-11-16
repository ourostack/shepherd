import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'shepherd.mjs');
const run = (args, env = {}) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });

test('shepherd help prints the two verbs and exits 0; an unknown verb or flag is a usage error with the fix', () => {
  const help = run(['help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /shepherd status \[--json\]/);
  const verb = run(['sweep']);
  assert.equal(verb.status, 2);
  assert.match(verb.stderr, /shepherd: usage: unknown command "sweep"\. Fix: shepherd help\./);
  assert.equal(run(['status', '--send']).status, 2);
  assert.equal(run(['restore-history']).status, 2);
  assert.match(run(['restore-history']).stderr, /restore-history needs a session id\. Fix: shepherd restore-history <id>\./);
});

test('shepherd status with no app database says where it looked and exits 1', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shepherd-cli-'));
  try {
    const r = run(['status', '--json', '--copilot-home', home]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^shepherd: no-database: there is no GitHub Copilot app database at .*data\.db\. Fix: open the GitHub Copilot app/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

const haveSqlite = spawnSync('/usr/bin/sqlite3', ['-version']).status === 0;

test('shepherd status --json reads a pretend app database and history: busy, idle and the size of each', { skip: !haveSqlite && 'needs /usr/bin/sqlite3' }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shepherd-status-'));
  try {
    const now = Date.now();
    const ev = (type, data = {}) => JSON.stringify({ type, data, timestamp: new Date(now).toISOString() });
    const sql = [
      'CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, mode TEXT, is_running INTEGER, was_interrupted INTEGER, execution_location TEXT, archived_at TEXT);',
      'CREATE TABLE workspaces (id TEXT, session_id TEXT, archived_at TEXT);',
      "INSERT INTO sessions VALUES ('aaaaaaaa-1', 'busy one', 'autopilot', 0, 0, 'local', NULL);",
      "INSERT INTO sessions VALUES ('bbbbbbbb-2', 'idle two', NULL, 0, 0, 'local', NULL);",
      "INSERT INTO sessions VALUES ('cccccccc-3', 'archived', NULL, 0, 0, 'local', '2026-11-01');",
    ].join('\n');
    spawnSync('/usr/bin/sqlite3', [path.join(home, 'data.db')], { input: sql });
    fs.mkdirSync(path.join(home, 'session-state', 'aaaaaaaa-1'), { recursive: true });
    fs.writeFileSync(path.join(home, 'session-state', 'aaaaaaaa-1', 'events.jsonl'), `${ev('user.message')}\n${ev('assistant.turn_start')}\n`);
    fs.mkdirSync(path.join(home, 'session-state', 'bbbbbbbb-2'), { recursive: true });
    fs.writeFileSync(path.join(home, 'session-state', 'bbbbbbbb-2', 'events.jsonl'), `${ev('assistant.turn_end')}\n`);
    const r = run(['status', '--json', '--copilot-home', home]);
    assert.equal(r.status, 0, r.stderr);
    const { sessions } = JSON.parse(r.stdout);
    assert.deepEqual(sessions.map((s) => [s.id, s.state]), [['aaaaaaaa-1', 'busy'], ['bbbbbbbb-2', 'idle']], 'the archived session is left out');
    assert.equal(sessions[0].why, 'mid-turn (last assistant.turn_start)');
    const text = run(['status', '--copilot-home', home]);
    assert.match(text.stdout, /^aaaaaaaa  busy one  busy \(mid-turn \(last assistant\.turn_start\)\)  0\.0 MB$/m);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('shepherd restore-history puts a compressed history back and says so', { skip: !fs.existsSync('/usr/bin/gzip') && 'needs /usr/bin/gzip' }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shepherd-restore-'));
  try {
    const id = 'aaaaaaaa-1';
    const file = path.join(home, 'session-state', id, 'events.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.gz`, zlib.gzipSync('{"type":"user.message"}\n'));
    const r = run(['restore-history', id, '--copilot-home', home]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^restored aaaaaaaa-1$/m);
    assert.equal(fs.readFileSync(file, 'utf8'), '{"type":"user.message"}\n');
    const again = run(['restore-history', id, '--json', '--copilot-home', home]);
    assert.equal(again.status, 0);
    assert.equal(JSON.parse(again.stdout).restored, false, 'a second restore has nothing to do');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('shepherd watch with nothing to follow says so and exits 0; watch --status reads its state; flags a verb does not take are usage errors', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shepherd-watchcli-'));
  try {
    const env = { HOME: home };
    const w = run(['watch'], env);
    assert.equal(w.status, 0, w.stderr);
    assert.equal(w.stdout, 'health watch: nothing to follow yet\n');
    assert.equal(run(['watch', '--quiet'], env).stdout, '');
    assert.deepEqual(JSON.parse(run(['watch', '--status', '--json'], env).stdout), { watch: null, last_pass: null, counts: null });
    assert.equal(run(['status', '--quiet']).status, 2);
    assert.equal(run(['install', '--json']).status, 2);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('shepherd install --dry-run prints the launch agent and writes nothing', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shepherd-installcli-'));
  try {
    const r = run(['install', '--dry-run'], { HOME: home });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /<key>Label<\/key><string>bot\.ouro\.shepherd<\/string>/);
    assert.match(r.stdout, /<string>watch<\/string>\s*<string>--every<\/string>\s*<string>60<\/string>\s*<string>--quiet<\/string>/);
    assert.deepEqual(fs.readdirSync(home), []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('shepherd quota and watch --every: bad arguments are usage errors; quota status says when no tick has run', () => {
  assert.equal(run(['quota', 'sweep']).status, 2);
  assert.match(run(['quota', 'sweep']).stderr, /shepherd: usage: quota takes read, plan or status, not "sweep"\. Fix: shepherd quota status\./);
  assert.equal(run(['watch', '--every', '0']).status, 2);
  assert.equal(run(['watch', '--every', '60', '--status']).status, 2);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shepherd-quota-cli-'));
  try {
    const r = run(['quota', 'status'], { SHEPHERD_QUOTA_STATE: path.join(dir, 'none.json') });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'no quota tick has run yet');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
