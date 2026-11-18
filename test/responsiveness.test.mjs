// The responsiveness bar: readings are numbers only, judged at p95 against the targets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { judge, percentile, readReadings, sample } from '../src/responsiveness.mjs';

const probes = (over = {}) => ({
  loadavg: () => [12.34, 10, 9],
  cores: () => 18,
  swapPct: async () => 40,
  worktrees: async () => ['/a', '/b', '/c', '/d'],
  gitMs: async () => 20,
  appMs: async () => 150,
  ...over,
});
const fresh = (now = 1e12) => ({ state: fs.mkdtempSync(path.join(os.tmpdir(), 'resp-')), now: () => now });

test('percentile picks the nearest rank and ignores missing values', () => {
  assert.equal(percentile([1, 2, 3, 4, 100, null], 95), 100);
  assert.equal(percentile([], 95), null);
  assert.equal(percentile([5], 95), 5);
});

test('a sample times at most three worktrees, keeps numbers only, and survives a failing probe', async () => {
  const d = fresh();
  const asked = [];
  const r = await sample(d, probes({ gitMs: async (dir) => { asked.push(dir); if (dir === '/b') throw new Error('not a repo'); return 20; }, appMs: async () => { throw new Error('down'); } }));
  assert.deepEqual(asked, ['/a', '/b', '/c']);
  assert.deepEqual(r, { at: 1e12, load1: 12.3, cores: 18, swapPct: 40, gitMs: [20, 20], appMs: null });
  assert.deepEqual(readReadings(d), [r]);
  assert.ok(!fs.readFileSync(path.join(d.state, 'responsiveness.jsonl'), 'utf8').includes('/a'), 'no paths are recorded');
});

test('readings older than a day are dropped when the next one is written', async () => {
  const d = fresh(1e12);
  await sample(d, probes());
  d.now = () => 1e12 + 25 * 3600000;
  await sample(d, probes());
  assert.equal(readReadings(d).length, 1);
});

test('the verdict misses a target at p95 and names it', () => {
  const calm = Array.from({ length: 20 }, (_, i) => ({ at: i, load1: 5, swapPct: 50, gitMs: [i === 19 ? 60000 : 30], appMs: 100 }));
  assert.equal(judge(calm).ok, true, 'one slow probe in twenty is under p95');
  const hot = { load1: 80, swapPct: 97, gitMs: [60000], appMs: 5000 };
  const bad = judge([...calm, { at: 99, ...hot }, { at: 100, ...hot }]);
  assert.equal(bad.ok, false);
  assert.equal(bad.misses.length, 3);
  assert.equal(judge([]).ok, false);
});
