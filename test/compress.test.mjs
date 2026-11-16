import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compressHistory, historyFile, restoreHistory } from '../src/index.mjs';
import { NOW, fakeHistoryDeps } from './fake-history.mjs';

const ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const BODY = `${'{"type":"user.message","data":{"content":"hi"}}\n'.repeat(50)}`;
const ARCHIVED = [{ id: ID, archived_at: '2026-11-15T00:00:00Z' }];
const LIVE = [{ id: ID, archived_at: null }];

async function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shepherd-compress-'));
  const file = historyFile(home, ID);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, BODY);
  try { return await fn({ home, file, gz: `${file}.gz` }); } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

test('compressHistory: an archived session is compressed, the original removed, and one ledger row written', async () => {
  await withHome(async ({ home, file, gz }) => {
    const ledger = [];
    const r = await compressHistory(fakeHistoryDeps(home, { sql: async () => ARCHIVED, ledger }), ID);
    assert.equal(r.ok, true, r.why);
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.existsSync(gz), true);
    assert.equal(r.before, Buffer.byteLength(BODY));
    assert.equal(r.after, fs.statSync(gz).size);
    assert.deepEqual(ledger, [{ at: new Date(NOW).toISOString(), kind: 'history-compressed', by: 'shepherd', session: ID, before: r.before, after: r.after }]);
    const back = await restoreHistory(fakeHistoryDeps(home), ID);
    assert.equal(back.restored, true);
    assert.equal(fs.readFileSync(file, 'utf8'), BODY, 'nothing is lost in the round trip');
  });
});

test('compressHistory refuses a live session, an open file, a failed lsof, an existing .gz and a missing history, leaving the file untouched', async () => {
  const cases = [
    ['live', { sql: async () => LIVE }, /lists it as live/],
    ['open', { sql: async () => ARCHIVED, openBy: async () => ['4242'] }, /process 4242 has the history open/],
    ['lsof', { sql: async () => ARCHIVED, openBy: async () => { throw new Error('lsof missing'); } }, /lsof could not say.*lsof missing/],
    ['gz', { sql: async () => ARCHIVED, pre: (f) => fs.writeFileSync(`${f}.gz`, 'old') }, /already compressed/],
  ];
  for (const [name, opts, why] of cases) {
    await withHome(async ({ home, file, gz }) => {
      const ledger = [];
      if (opts.pre) opts.pre(file);
      const r = await compressHistory(fakeHistoryDeps(home, { ...opts, ledger }), ID);
      assert.equal(r.ok, false, name);
      assert.match(r.why, why, name);
      assert.equal(fs.readFileSync(file, 'utf8'), BODY, `${name}: the history is untouched`);
      assert.equal(ledger.length, 0, `${name}: no ledger row`);
      if (name !== 'gz') assert.equal(fs.existsSync(gz), false, `${name}: no .gz written`);
    });
  }
  await withHome(async ({ home, file }) => {
    fs.rmSync(file);
    const r = await compressHistory(fakeHistoryDeps(home, { sql: async () => ARCHIVED }), ID);
    assert.equal(r.ok, false);
    assert.match(r.why, /no events\.jsonl/);
  });
});

test('compressHistory compresses a session the app does not list at all', async () => {
  await withHome(async ({ home, gz }) => {
    const r = await compressHistory(fakeHistoryDeps(home), ID);
    assert.equal(r.ok, true, r.why);
    assert.equal(fs.existsSync(gz), true);
  });
});

test('compressHistory with dryRun changes nothing and writes no ledger row', async () => {
  await withHome(async ({ home, file, gz }) => {
    const ledger = [];
    const r = await compressHistory(fakeHistoryDeps(home, { sql: async () => ARCHIVED, ledger }), ID, { dryRun: true });
    assert.equal(r.ok, true);
    assert.equal(r.after, null);
    assert.equal(fs.readFileSync(file, 'utf8'), BODY);
    assert.equal(fs.existsSync(gz), false);
    assert.equal(ledger.length, 0);
  });
});
