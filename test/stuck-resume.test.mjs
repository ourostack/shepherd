// Stuck resume, against fakes: a stopped session is resumed once per stop, at most three times a day, and the sessions it leaves
// alone are left alone. The app is the fake socket; histories are temp files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RESUMES_PER_DAY, RESUME_TEXT, resumeStuck, stuckPlan, stuckResumeConfig } from '../src/stuck-resume.mjs';
import { NOW, fakeApp, iso, row, sparseHistory, testDeps, writeHistory } from './fake-sidebar.mjs';

// At 15:49 UTC the stopped session had stopped half an hour earlier.
const STOPPED = iso(NOW - 30 * 60_000);
const TRACKER = 'aaaaaaaa-0000-4000-8000-0000000000b1';
const GIANT = 'aaaaaaaa-0000-4000-8000-0000000000b2';
const SMALL = 'aaaaaaaa-0000-4000-8000-0000000000b3';
const stuck = (id, over = {}) => row(id, { name: 'Long task', state: 'stuck', detail: 'not running, but its loop stopped between turns', lastActivity: STOPPED, ...over });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'stuck-resume-'));
const recorded = (d) => JSON.parse(fs.readFileSync(path.join(d.state, 'stuck-resume.json'), 'utf8'));

test('a stopped session is resumed once per stop, with one message, and the record keeps it', async () => {
  const home = tmp();
  try {
    const app = fakeApp();
    const d = testDeps(home, { app });
    assert.equal(await resumeStuck([stuck(TRACKER)], d), 1);
    assert.deepEqual(app.sent, [{ id: TRACKER, text: RESUME_TEXT }]);
    assert.equal(recorded(d).resumed[TRACKER].name, 'Long task');
    assert.equal(recorded(d).resumed[TRACKER].lastActivity, STOPPED);
    assert.equal(recorded(d).resumed[TRACKER].ok, true);
    assert.equal(await resumeStuck([stuck(TRACKER)], d, NOW + 5 * 60_000), 0, 'the same stop is not resumed twice');
    assert.equal(app.sent.length, 1);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a session that stops again is resumed at most three times a day, and a resume older than a day no longer counts', async () => {
  const home = tmp();
  try {
    const app = fakeApp();
    const d = testDeps(home, { app });
    for (let stop = 0; stop < RESUMES_PER_DAY + 1; stop += 1) {
      await resumeStuck([stuck(TRACKER, { lastActivity: iso(NOW + stop * 60_000) })], d, NOW + stop * 60_000 + 1);
    }
    assert.equal(app.sent.length, RESUMES_PER_DAY);
    await resumeStuck([stuck(TRACKER, { lastActivity: iso(NOW + 25 * 3_600_000) })], d, NOW + 25 * 3_600_000);
    assert.equal(app.sent.length, RESUMES_PER_DAY + 1);
    await resumeStuck([], d, NOW + 50 * 3_600_000);
    assert.deepEqual(recorded(d).resumed, {}, 'the record forgets resumes over a day old');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a running, remote, waiting, idle, day-old, undated or over-500-MB session is left alone', async () => {
  const home = tmp();
  try {
    sparseHistory(home, GIANT, 501 * 1024 * 1024);
    const app = fakeApp();
    const d = testDeps(home, { app });
    const listed = [
      stuck('running', { isRunning: true }),
      stuck('idle', { state: 'idle' }),
      stuck('remote', { remote: true }),
      stuck('asks', { awaiting: 'input' }),
      stuck('old', { lastActivity: iso(NOW - 25 * 3_600_000) }),
      stuck('undated', { lastActivity: null }),
      stuck(GIANT),
    ];
    assert.equal(await resumeStuck(listed, d), 0);
    assert.equal(app.sent.length, 0);
    assert.equal(await resumeStuck([stuck(SMALL)], d), 1);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a refused or failed resume is recorded as not done, and the default send goes through the app', async () => {
  const home = tmp();
  try {
    const app = fakeApp();
    const d = testDeps(home, { app });
    assert.equal(await resumeStuck([stuck(TRACKER)], d, NOW, { send: async () => { throw new Error('socket closed'); } }), 0);
    assert.equal(recorded(d).resumed[TRACKER].ok, false);
    assert.equal(await resumeStuck([stuck(SMALL)], d), 1);
    assert.equal(app.sent[0].id, SMALL);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the plan says which stuck sessions a resume would take, and why it would leave the others, and changes nothing', async () => {
  const home = tmp();
  try {
    const app = fakeApp();
    const d = testDeps(home, { app });
    const plan = stuckPlan([stuck(TRACKER), stuck('running', { isRunning: true }), row('plain')], d);
    assert.deepEqual(plan, [
      { id: TRACKER, name: 'Long task', resume: true, why: 'not running, but its loop stopped between turns' },
      { id: 'running', name: 'Long task', resume: false, why: 'it is running' },
    ]);
    assert.equal(app.sent.length, 0);
    assert.equal(fs.existsSync(path.join(d.state, 'stuck-resume.json')), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the stuck-resume config is off with no file, on only with "enabled": true, and a file that is not JSON is refused', () => {
  const home = tmp();
  try {
    const file = path.join(home, 'stuck-resume.json');
    assert.deepEqual(stuckResumeConfig(file), { enabled: false });
    fs.writeFileSync(file, '{"enabled": true}');
    assert.deepEqual(stuckResumeConfig(file), { enabled: true });
    fs.writeFileSync(file, '{"enabled": "yes"}');
    assert.deepEqual(stuckResumeConfig(file), { enabled: false });
    fs.writeFileSync(file, '{ not json');
    assert.throws(() => stuckResumeConfig(file), (e) => e.code === 'stuck-resume-config' && /is not valid JSON/.test(e.message));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('an idle session on the interrupted banner is resumed once, and the message names what died', async () => {
  const home = tmp();
  try {
    writeHistory(home, TRACKER, [
      { type: 'session.start', data: {} },
      { type: 'subagent.started', data: { toolCallId: 'a1', agentDisplayName: 'Reviewer', agentDescription: 'review the diff', executionMode: 'background' } },
      { type: 'subagent.started', data: { toolCallId: 'a2', agentDisplayName: 'Done one', executionMode: 'background' } },
      { type: 'subagent.completed', data: { toolCallId: 'a2' } },
      { type: 'tool.execution_start', data: { toolName: 'bash', toolCallId: 'b1', arguments: { mode: 'async', shellId: 'sh1', description: 'run the suite' } } },
    ], NOW - 3600_000);
    const app = fakeApp();
    const d = testDeps(home, { app });
    const banner = row(TRACKER, { name: 'Lane', state: 'idle', wasInterrupted: true, lastActivity: STOPPED });
    assert.equal(await resumeStuck([banner], d), 1);
    assert.match(app.sent[0].text, /Reviewer \(review the diff\)/);
    assert.match(app.sent[0].text, /sh1 \(run the suite\)/);
    assert.doesNotMatch(app.sent[0].text, /Done one/);
    assert.equal(await resumeStuck([banner], d, NOW + 60_000), 0);
    assert.equal(await resumeStuck([row(SMALL, { state: 'idle', wasInterrupted: false, lastActivity: STOPPED })], d), 0);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
