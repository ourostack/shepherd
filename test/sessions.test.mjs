import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAX_HISTORY_BYTES, STALE_MS, ShepherdError, deps, snapshot } from '../src/index.mjs';

const BIG = 'aaaaaaaa-0000-4000-8000-000000000001', SMALL = 'bbbbbbbb-0000-4000-8000-000000000002', OLD = 'cccccccc-0000-4000-8000-000000000003';
const NOW = Date.parse('2026-11-16T12:00:00Z');
const ev = (type, data = {}, at = NOW) => JSON.stringify({ type, data, timestamp: new Date(at).toISOString() });
const MID = [ev('user.message'), ev('assistant.turn_start')];

// Fake deps: rows from the sessions query, histories by id.
const fakeDeps = (rows, histories = {}) => ({
  now: () => NOW,
  sleep: async () => {},
  sql: async () => rows,
  historySize: (id) => (id === BIG ? MAX_HISTORY_BYTES + 1 : 1000),
  history: (id) => histories[id] || { lines: [], mtime: 0 },
  exchange: async () => [],
});

test('snapshot: busy and idle sessions, an over-cap history held back with its reason, a stale one idle', async () => {
  const rows = [
    { id: BIG, title: 'big', running: 1, workspace_id: 'w1' },
    { id: SMALL, title: 'small', running: 0, workspace_id: null, loc: 'local' },
    { id: OLD, title: 'old', running: 1, workspace_id: null },
  ];
  const histories = {
    [SMALL]: { lines: MID, mtime: NOW },
    [OLD]: { lines: [ev('assistant.turn_start', {}, NOW - STALE_MS - 1000)], mtime: NOW - STALE_MS - 1000 },
  };
  const s = await snapshot(fakeDeps(rows, histories));
  const [big, small, old] = s;
  assert.equal(big.state, 'idle');
  assert.match(big.why, /500 MB resume cap/);
  assert.equal(big.workspaceId, 'w1');
  assert.equal(small.state, 'busy');
  assert.equal(small.workspaceId, null);
  assert.equal(old.state, 'idle');
  assert.equal(old.stale, true);
  assert.match(old.why, /over 24 h ago/);
});

test('snapshot: a session whose id starts with a skip entry, or that is remote, is left out', async () => {
  const rows = [
    { id: SMALL, title: 's', running: 0, loc: 'local' },
    { id: BIG, title: 'b', running: 0, loc: 'remote' },
  ];
  const s = await snapshot(fakeDeps(rows, { [SMALL]: { lines: MID, mtime: NOW } }), NOW, ['bbbbbbbb']);
  assert.deepEqual(s, []);
});

test('snapshot: a session the app marks running is busy even when its history shows no work', async () => {
  const rows = [{ id: SMALL, title: 's', running: 1 }];
  const [s] = await snapshot(fakeDeps(rows, { [SMALL]: { lines: [ev('assistant.turn_end')], mtime: NOW } }));
  assert.equal(s.state, 'busy');
  assert.equal(s.why, 'the app marks it running');
});

test('deps.sql: no database says where it looked and how to fix it', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shepherd-nodb-'));
  try {
    await assert.rejects(deps({ copilotHome: home }).sql('SELECT 1'), (e) => {
      assert.ok(e instanceof ShepherdError);
      assert.equal(e.code, 'no-database');
      assert.match(e.message, /there is no GitHub Copilot app database at .*data\.db\. Fix: open the GitHub Copilot app/);
      return true;
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
