// shepherd place: each branch of the answer (cloud, mini, laptop), the cloud 403 windows, the laptop heartbeat, and the report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LIMITS, blockCloud, clearCloud, cloudState, decide, laptopBeat, laptopState, miniState, place, placeConfigFile, report } from '../src/place.mjs';
import { fakeHistoryDeps } from './fake-history.mjs';
import { historyFile } from '../src/index.mjs';

const NOW = 1e12;
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), n));
const fresh = () => ({ state: tmp('place-'), now: () => NOW });
const calm = miniState({ swapPct: 40, load1: 4, cores: 18 });
const busy = miniState({ swapPct: 97, load1: 60, cores: 18 });
const beat = (over = {}) => ({ at: new Date(NOW - 5 * 60000).toISOString(), interval_sec: 600, hub: { connected: true }, disk: { free_gb: 100 }, ...over });
const up = laptopState(beat(), NOW);
const down = laptopState(null, NOW);
const open = { blocked: false };
const blocked = { blocked: true, minutesLeft: 30 };

test('a lane that needs nothing local goes to the cloud', () => {
  assert.equal(decide({ mini: busy, laptop: up, cloud: open }).place, 'cloud');
  assert.equal(decide({ mini: calm, laptop: down, cloud: open }).place, 'cloud');
});

test('a local lane goes to the mini while it has room, and to the laptop once it is loaded', () => {
  assert.equal(decide({ local: true, mini: calm, laptop: up, cloud: open }).place, 'mini');
  const r = decide({ local: true, mini: busy, laptop: up, cloud: open });
  assert.equal(r.place, 'laptop');
  assert.match(r.why, /swap 97% full/);
});

test('a loaded mini with no fresh laptop is still the only home, and the reason says so', () => {
  const r = decide({ local: true, mini: busy, laptop: down, cloud: open });
  assert.equal(r.place, 'mini');
  assert.match(r.why, /no laptop heartbeat/);
});

test('a lane that needs mini-only state goes to the mini even when it is loaded', () => {
  assert.equal(decide({ local: true, miniOnly: true, mini: busy, laptop: up, cloud: open }).place, 'mini');
  assert.equal(decide({ miniOnly: true, mini: calm, laptop: up, cloud: open }).why, 'it needs state only the mini has');
});

test('while cloud is blocked by a 403, a lane that could go there goes where there is room', () => {
  assert.equal(decide({ mini: calm, laptop: up, cloud: blocked }).place, 'mini');
  const r = decide({ mini: busy, laptop: up, cloud: blocked });
  assert.equal(r.place, 'laptop');
  assert.match(r.why, /cloud is blocked for 30 more min/);
  assert.equal(decide({ mini: busy, laptop: down, cloud: blocked }).place, 'mini');
});

test('the mini is loaded by swap or by load per core, and unreadable numbers never load it', () => {
  assert.equal(miniState({ swapPct: LIMITS.swapPct, load1: 1, cores: 18 }).loaded, true);
  assert.equal(miniState({ swapPct: 10, load1: 18 * LIMITS.loadPerCore, cores: 18 }).loaded, true);
  assert.equal(miniState({ swapPct: 89, load1: 5, cores: 18 }).loaded, false);
  assert.equal(miniState({ swapPct: null, load1: null, cores: 18 }).loaded, false);
});

test('the laptop is ready only with a fresh heartbeat, a connected hub and disk to spare', () => {
  assert.equal(laptopState(beat(), NOW).ready, true);
  assert.match(laptopState(beat({ at: new Date(NOW - 21 * 60000).toISOString() }), NOW).why, /21 min old/);
  assert.equal(laptopState(beat({ at: new Date(NOW - 19 * 60000).toISOString() }), NOW).ready, true);
  assert.match(laptopState(beat({ hub: { connected: false } }), NOW).why, /hub is not connected/);
  assert.match(laptopState(beat({ disk: { free_gb: 3 } }), NOW).why, /3 GB free/);
  assert.equal(laptopState({ interval_sec: 600 }, NOW).ready, false);
});

test('cloud 403 windows are per repository or global, expire, and clear', () => {
  const d = fresh();
  blockCloud(d, { repo: 'o/a', minutes: 30 });
  assert.deepEqual([cloudState(d, 'o/a').blocked, cloudState(d, 'o/b').blocked], [true, false]);
  assert.equal(cloudState(d, 'o/a').minutesLeft, 30);
  blockCloud(d, { minutes: 10 });
  assert.equal(cloudState(d, 'o/b').blocked, true);
  assert.equal(cloudState({ ...d, now: () => NOW + 11 * 60000 }, 'o/b').blocked, false, 'the window ends');
  clearCloud(d, { repo: 'o/a' });
  assert.equal(cloudState(d, 'o/a').blocked, true, 'the global window still holds');
  clearCloud(d);
  assert.equal(cloudState(d, 'o/a').blocked, false);
});

test('place reads the probes, answers, and keeps a one-line record', async () => {
  const d = fresh();
  const probes = { loadavg: () => [60, 50, 40], cores: () => 18, swapPct: async () => 97, laptop: async () => beat() };
  const r = await place(d, { repo: 'o/a', local: true }, probes);
  assert.equal(r.place, 'laptop');
  assert.equal(r.start.route, 'hub');
  assert.match(r.start.command, /session laptop open/);
  assert.deepEqual(r.mini, { swapPct: 97, load1: 60, cores: 18, loaded: true, why: 'swap 97% full, load 60 on 18 cores' });
  const log = fs.readFileSync(path.join(d.state, 'place-log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(log.map((l) => [l.place, l.repo]), [['laptop', 'o/a']]);
  const cloud = await place(d, {}, probes);
  assert.equal(cloud.place, 'cloud');
  assert.equal(cloud.start, undefined);
});

test('report counts lanes by where they ran and coordinator, and splits the local ones by what they touched', async () => {
  const home = tmp('place-report-');
  const call = (cmd) => `${JSON.stringify({ type: 'tool.execution_start', data: { arguments: { command: cmd } } })}\n`;
  const write = (id, text) => { fs.mkdirSync(path.join(home, 'session-state', id), { recursive: true }); fs.writeFileSync(historyFile(home, id), text); };
  write('a', call('launchctl list'));
  write('b', call('npm test'));
  const lanes = [
    { id: 'a', loc: 'local', env: null, coord: 'one' },
    { id: 'b', loc: 'local', env: null, coord: 'one' },
    { id: 'c', loc: 'local', env: null, coord: 'one' },
    { id: 'd', loc: '{"kind":"remote"}', env: 'managed-sandbox', coord: 'two' },
    { id: 'e', loc: '{"kind":"remote"}', env: 'ssh', coord: 'two' },
  ];
  const d = { ...fakeHistoryDeps(home, { sql: async () => lanes }), state: tmp('place-state-') };
  const r = await report(d, { days: 7 });
  assert.deepEqual([r.lanes, r.cloud, r.mini, r.remote, r.neededLocal, r.couldCloud, r.noHistory], [5, 1, 3, 1, 1, 1, 1]);
  assert.deepEqual(r.byCoordinator.map((c) => [c.coordinator, c.cloud, c.mini, c.remote]), [['one', 0, 3, 0], ['two', 1, 0, 1]]);
});

test('the laptop config is read from ~/.config/shepherd (or SHEPHERD_PLACE_CONFIG), then from the state folder', async () => {
  const dir = tmp('place-cfg-');
  const gh = path.join(dir, 'gh');
  fs.writeFileSync(gh, '#!/bin/sh\necho \'{"interval_sec":600}\'\n', { mode: 0o755 });
  assert.equal(placeConfigFile({}, '/h'), path.join('/h', '.config', 'shepherd', 'place.json'));
  const cfg = path.join(dir, 'place.json');
  assert.equal(placeConfigFile({ SHEPHERD_PLACE_CONFIG: cfg }, '/h'), cfg);
  const d = { state: dir };
  const saved = process.env.SHEPHERD_PLACE_CONFIG;
  try {
    process.env.SHEPHERD_PLACE_CONFIG = cfg;
    assert.equal(await laptopBeat(d), null, 'no config anywhere: no laptop');
    fs.writeFileSync(path.join(dir, 'place.json'), JSON.stringify({ laptop: { gist: 'g', gh } }));
    assert.deepEqual(await laptopBeat(d), { interval_sec: 600 }, 'the state folder copy still works');
    fs.writeFileSync(cfg, JSON.stringify({ laptop: { gist: 'g', gh: '/nonexistent' } }));
    assert.equal(await laptopBeat(d), null, 'the config file wins over the state folder copy');
  } finally {
    if (saved === undefined) delete process.env.SHEPHERD_PLACE_CONFIG; else process.env.SHEPHERD_PLACE_CONFIG = saved;
  }
});
