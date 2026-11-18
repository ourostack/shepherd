// `shepherd watch --every`: passes run on a fake clock, never overlap, and one duty's failure does not stop the others.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runResident } from '../src/resident.mjs';

function fakeClock() {
  let t = 0;
  return { now: () => t, advance: (ms) => { t += ms; }, sleep: async (ms) => { t += ms; } };
}

test('passes start a full interval apart, and a slow pass pushes the next one back instead of overlapping it', async () => {
  const c = fakeClock();
  const durations = [90000, 5000, 5000];
  const starts = [];
  const sleeps = [];
  let running = 0;
  let maxRunning = 0;
  let passes = 0;
  const duty = (name, work) => ({ name, run: async () => { running++; maxRunning = Math.max(maxRunning, running); await work(); running--; } });
  const duties = [
    duty('health watch', async () => { starts.push(c.now()); c.advance(durations[passes++]); }),
    duty('quota balancer', async () => { c.advance(1000); }),
  ];
  await runResident({ everyMs: 60000, duties, now: c.now, sleep: async (ms) => { sleeps.push(ms); await c.sleep(ms); }, stop: () => passes >= 3 });
  assert.deepEqual(starts, [0, 91000, 151000]);
  assert.deepEqual(sleeps, [0, 54000], 'each sleep is what is left of the interval after the pass');
  assert.equal(maxRunning, 1, 'duties never run at the same time');
});

test('a duty that throws is logged, and the other duties of that pass still run', async () => {
  const c = fakeClock();
  const ran = [];
  const logged = [];
  const duties = [
    { name: 'health watch', run: async () => { ran.push('health'); throw new Error('the app is not serving'); } },
    { name: 'quota balancer', run: async () => { ran.push('quota'); } },
  ];
  await runResident({ everyMs: 60000, duties, now: c.now, sleep: c.sleep, stop: () => ran.length >= 2, log: (line) => logged.push(line) });
  assert.deepEqual(ran, ['health', 'quota']);
  assert.deepEqual(logged, ['shepherd: health watch failed: the app is not serving']);
});

test('the retire duty does nothing with no retire.json, and a bad one fails that duty alone', async () => {
  const { watchDuties } = await import('../src/resident.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resident-retire-'));
  const was = process.env.SHEPHERD_RETIRE_CONFIG;
  try {
    process.env.SHEPHERD_RETIRE_CONFIG = path.join(dir, 'retire.json');
    const retire = watchDuties({ copilotHome: dir }).find((d) => d.name === 'retire');
    await retire.run();
    fs.writeFileSync(process.env.SHEPHERD_RETIRE_CONFIG, '{ not json');
    const ran = [];
    const logged = [];
    const duties = [retire, { name: 'quota balancer', run: async () => { ran.push('quota'); } }];
    await runResident({ everyMs: 60000, duties, now: () => 0, sleep: async () => {}, stop: () => ran.length >= 1, log: (line) => logged.push(line) });
    assert.deepEqual(ran, ['quota']);
    assert.match(logged[0], /^shepherd: retire failed: .*is not valid JSON/);
  } finally {
    if (was === undefined) delete process.env.SHEPHERD_RETIRE_CONFIG;
    else process.env.SHEPHERD_RETIRE_CONFIG = was;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the wake runners and the stuck resume do nothing until their configs enable them, so nothing runs twice', async () => {
  const { watchDuties: duties } = await import('../src/resident.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resident-wakes-'));
  const keys = ['HOME', 'SHEPHERD_WAKES_CONFIG', 'SHEPHERD_STUCK_RESUME_CONFIG'];
  const was = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    process.env.HOME = dir;
    process.env.SHEPHERD_WAKES_CONFIG = path.join(dir, 'wakes.json');
    process.env.SHEPHERD_STUCK_RESUME_CONFIG = path.join(dir, 'stuck-resume.json');
    const marker = path.join(dir, 'ran');
    const runner = { name: 'issues', command: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'); process.stdout.write('{"wakes":[]}')`] };
    fs.writeFileSync(process.env.SHEPHERD_WAKES_CONFIG, JSON.stringify({ enabled: false, runners: [runner] }));
    const watch = duties({ copilotHome: dir });
    await watch.find((d) => d.name === 'wake runners').run();
    await watch.find((d) => d.name === 'stuck resume').run();
    assert.equal(fs.existsSync(marker), false, 'a runner in a disabled config does not run');
    fs.writeFileSync(process.env.SHEPHERD_WAKES_CONFIG, JSON.stringify({ enabled: true, runners: [runner] }));
    await watch.find((d) => d.name === 'wake runners').run();
    assert.equal(fs.existsSync(marker), true, 'an enabled runner runs on the pass');
    assert.equal(fs.existsSync(path.join(dir, 'Library', 'Caches', 'shepherd', 'wake-runners.json')), true, 'and its state is kept');
  } finally {
    for (const k of keys) if (was[k] === undefined) delete process.env[k]; else process.env[k] = was[k];
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a duty that never settles is logged and skipped, so the duties after it still run every pass and it never overlaps itself', async () => {
  const ran = [];
  const logged = [];
  let stuckStarts = 0;
  const duties = [
    { name: 'inbox', maxMs: 20, run: () => { stuckStarts++; return new Promise(() => {}); } },
    { name: 'wake runners', run: async () => { ran.push('wakes'); } },
  ];
  await runResident({ everyMs: 0, duties, sleep: async () => {}, stop: () => ran.length >= 3, log: (line) => logged.push(line) });
  assert.deepEqual(ran, ['wakes', 'wakes', 'wakes']);
  assert.equal(stuckStarts, 1, 'the stuck duty is not started again while it is still running');
  assert.deepEqual(logged, ['shepherd: inbox still running after 0s; the pass moves on']);
});
