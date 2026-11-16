// shepherd install: the launch agent's plist runs a valid `shepherd watch --quiet`, and a dry run writes nothing. launchctl
// is a fake here; nothing is loaded and no real ~/Library is touched (HOME is a temp folder).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BIN, LABEL, agentPath, install } from '../src/install.mjs';

const args = (text) => [...text.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)[1].matchAll(/<string>(.*?)<\/string>/g)].map((m) => m[1]);

test('the installed agent runs a valid shepherd watch every 60 s, with the PATH it needs, and loads under its label', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shepherd-install-'));
  try {
    const calls = [];
    const r = await install({ home, node: process.execPath, bin: BIN, uid: 501, launchctl: async (a) => { calls.push(a); return { code: 0, stderr: '' }; } });
    assert.equal(r.ok, true);
    assert.deepEqual(calls.map((c) => c.slice(0, 2)), [['bootout', `gui/501/${LABEL}`], ['bootstrap', 'gui/501']]);
    const text = fs.readFileSync(agentPath(home), 'utf8');
    assert.deepEqual(args(text), [process.execPath, BIN, 'watch', '--quiet']);
    assert.match(text, /<key>StartInterval<\/key><integer>60<\/integer>/);
    assert.match(text, /<key>RunAtLoad<\/key><true\/>/);
    assert.match(text, /\/opt\/homebrew\/bin/);
    assert.match(text, new RegExp(`${path.join(home, '.ouro-cli', 'bin')}</string>`));
    assert.match(text, new RegExp(`<string>${path.join(home, 'Library', 'Logs', 'shepherd-watch.launchd.log')}</string>`));
    // The command the agent runs is a real shepherd command: it exits 0 with nothing to follow.
    const run = spawnSync(args(text)[0], args(text).slice(1), { encoding: 'utf8', env: { ...process.env, HOME: home } });
    assert.equal(run.status, 0, run.stderr);
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
