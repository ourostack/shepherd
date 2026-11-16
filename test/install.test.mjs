// shepherd install: the launch agent's plist runs a valid `shepherd watch --every 60 --quiet`, and a dry run writes nothing. launchctl
// is a fake here; nothing is loaded and no real ~/Library is touched (HOME is a temp folder).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BIN, LABEL, agentPath, install } from '../src/install.mjs';

const args = (text) => [...text.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)[1].matchAll(/<string>(.*?)<\/string>/g)].map((m) => m[1]);

test('the installed agent keeps a valid shepherd watch --every 60 running, with the PATH it needs, and loads under its label', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shepherd-install-'));
  try {
    const calls = [];
    const r = await install({ home, node: process.execPath, bin: BIN, uid: 501, launchctl: async (a) => { calls.push(a); return { code: 0, stderr: '' }; } });
    assert.equal(r.ok, true);
    assert.deepEqual(calls.map((c) => c.slice(0, 2)), [['bootout', `gui/501/${LABEL}`], ['bootstrap', 'gui/501']]);
    const text = fs.readFileSync(agentPath(home), 'utf8');
    assert.deepEqual(args(text), [process.execPath, BIN, 'watch', '--every', '60', '--quiet']);
    assert.doesNotMatch(text, /StartInterval/);
    assert.match(text, /<key>KeepAlive<\/key><true\/>/);
    assert.match(text, /<key>RunAtLoad<\/key><true\/>/);
    assert.match(text, /\/opt\/homebrew\/bin/);
    assert.match(text, new RegExp(`${path.join(home, '.ouro-cli', 'bin')}</string>`));
    assert.match(text, new RegExp(`<string>${path.join(home, 'Library', 'Logs', 'shepherd-watch.launchd.log')}</string>`));
    // The command the agent runs is a real shepherd command that stays resident: it starts, reports nothing with nothing to
    // follow, and is still running when the timeout ends it.
    const run = spawnSync(args(text)[0], args(text).slice(1), { encoding: 'utf8', env: { ...process.env, HOME: home }, timeout: 2000 });
    assert.equal(run.signal, 'SIGTERM', `the watch should still be running: ${run.stderr}`);
    assert.equal(run.stderr, '');
    assert.equal(run.stdout, '');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('install --dry-run prints the plist and writes nothing', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shepherd-dry-'));
  try {
    const calls = [];
    const r = await install({ home, dry: true, launchctl: async (a) => { calls.push(a); return { code: 0, stderr: '' }; } });
    assert.equal(r.dry_run, true);
    assert.match(r.text, new RegExp(`<key>Label</key><string>${LABEL}</string>`));
    assert.deepEqual(calls, [], 'launchctl is not called');
    assert.deepEqual(fs.readdirSync(home), [], 'nothing is created in home');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('stableNode: a Homebrew Cellar node becomes the stable link, so an upgrade never breaks the job', async () => {
  const { stableNode } = await import('../src/install.mjs');
  const has = (p) => p === '/opt/homebrew/bin/node';
  assert.equal(stableNode('/opt/homebrew/Cellar/node@22/22.23.4_2/bin/node', has), '/opt/homebrew/bin/node');
  assert.equal(stableNode('/Users/a/.nvm/versions/node/v22.1.0/bin/node', has), '/Users/a/.nvm/versions/node/v22.1.0/bin/node');
});
