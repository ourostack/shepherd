// Repository trust, against a real SQLite file shaped like the app's tables: untrusted local repository projects get the three
// rows, trusted and remote ones are left alone, and a second run changes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deps } from '../src/sessions.mjs';
import { trustAll, trustConfig, untrusted } from '../src/trust.mjs';

const HASH = 'a'.repeat(64);
const SCHEMA = `CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, container_kind TEXT, main_repo_path TEXT);
CREATE TABLE project_host_trust (project_id TEXT, host_id TEXT, trusted_config_sha256 TEXT, trusted_config_accepted_at TEXT, PRIMARY KEY (project_id, host_id));
CREATE TABLE project_future_config_trust (project_id TEXT PRIMARY KEY, accepted_at TEXT);
CREATE TABLE project_trust_revisions (project_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, local_revision INTEGER NOT NULL DEFAULT 0);`;

function appHome(extra = '') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'trust-'));
  const sql = `${SCHEMA}
INSERT INTO projects VALUES ('p1', 'trusted', 'repository', '/r/p1'), ('p2', 'new one', 'repository', '/r/p2'), ('p3', 'o''brien', 'repository', '/r/p3'),
  ('p4', 'remote', 'repository', 'remote://o/r'), ('p5', 'folder', 'folder', '/r/p5');
INSERT INTO project_host_trust VALUES ('p1', 'local', '${HASH}', '2026-01-01T00:00:00.000Z');
INSERT INTO project_future_config_trust VALUES ('p1', '2026-01-01T00:00:00.000Z');
INSERT INTO project_trust_revisions VALUES ('p1', 1, 0);${extra}`;
  execFileSync('/usr/bin/sqlite3', [path.join(home, 'data.db'), sql]);
  return home;
}
const count = (home, table) => Number(execFileSync('/usr/bin/sqlite3', [path.join(home, 'data.db'), `SELECT count(*) FROM ${table}`]).toString());

test('trusting adds the three rows for each untrusted local repository project, once', async () => {
  const home = appHome();
  try {
    const d = { ...deps({ copilotHome: home, state: path.join(home, 'state') }), now: () => Date.parse('2026-11-17T00:00:00Z') };
    assert.deepEqual((await untrusted(d)).map((p) => p.id), ['p2', 'p3']);
    const r = await trustAll(d);
    assert.deepEqual(r.trusted.map((p) => p.name), ['new one', 'o\'brien']);
    for (const t of ['project_host_trust', 'project_future_config_trust', 'project_trust_revisions']) assert.equal(count(home, t), 3, t);
    const row = (await d.sql("SELECT * FROM project_host_trust WHERE project_id = 'p2'"))[0];
    assert.equal(row.trusted_config_sha256, HASH);
    assert.equal(row.trusted_config_accepted_at, '2026-11-17T00:00:00.000Z');
    assert.deepEqual(await trustAll(d), { trusted: [], skipped: null }, 'the second run changes nothing');
    assert.equal(count(home, 'project_host_trust'), 3);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a project with only part of the rows gets the missing ones and keeps its own', async () => {
  const home = appHome("\nINSERT INTO project_host_trust VALUES ('p2', 'local', 'keep', '2026-02-02T00:00:00.000Z');");
  try {
    const d = deps({ copilotHome: home, state: path.join(home, 'state') });
    await trustAll(d);
    assert.equal((await d.sql("SELECT trusted_config_sha256 AS h FROM project_host_trust WHERE project_id = 'p2'"))[0].h, 'keep');
    assert.equal(count(home, 'project_future_config_trust'), 3);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('with no trusted project to copy a hash from, nothing is written and the reason is given', async () => {
  const home = appHome("\nDELETE FROM project_host_trust;");
  try {
    const d = deps({ copilotHome: home, state: path.join(home, 'state') });
    const r = await trustAll(d);
    assert.deepEqual(r.trusted, []);
    assert.match(r.skipped, /no config hash/);
    assert.equal(count(home, 'project_host_trust'), 0);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the config is off without a file, on when it says so, and an error when it is not JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trust-cfg-'));
  try {
    assert.deepEqual(trustConfig(path.join(dir, 'none.json')), { enabled: false });
    fs.writeFileSync(path.join(dir, 'on.json'), '{ "enabled": true }');
    assert.deepEqual(trustConfig(path.join(dir, 'on.json')), { enabled: true });
    fs.writeFileSync(path.join(dir, 'bad.json'), '{');
    assert.throws(() => trustConfig(path.join(dir, 'bad.json')), /not valid JSON/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
