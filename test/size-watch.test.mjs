// The size watch: over-limit histories are flagged, their coordinators asked to hand off, and idle giants archived.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IDLE_ARCHIVE_MS, OVERSIZE_BYTES, archivedNote, handoffNudge, noticeOversizedSessions, readMemory, readOversize, shortOfMemory, whereItLeftOff } from '../src/size-watch.mjs';
import { fakeApp, NOW, row, sparseHistory, testDeps, working } from './fake-sidebar.mjs';

const MB = 1024 ** 2;
const GB = 1024 ** 3;
const CALM = { swapUsedBytes: 0, freeBytes: 16 * GB };
const SWAMPED = { swapUsedBytes: 37 * GB, freeBytes: 278 * MB };
const COORDINATOR = '66666666-0000-4000-8000-000000000000';
const GIANT = '55555555-0000-4000-8000-000000000001';
const COLD = '77777777-0000-4000-8000-000000000003';
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), name));

// A test deps whose asks, owner notices and archives are recorded here, with the archive faked (no giant is compressed).
function watchDeps(home, { memory = CALM, tell = async () => ({ ok: true, error: null }), send, archive } = {}) {
  const sent = [];
  const archived = [];
  const d = testDeps(home, { app: fakeApp() });
  return {
    d: {
      ...d,
      memory: () => memory,
      tell,
      send: send ?? (async (id, text) => { sent.push({ id, text }); return { ok: true, error: null }; }),
      archive: archive ?? (async (r, reason, note) => { archived.push({ id: r.id, reason, note }); return true; }),
    },
    sent,
    archived,
  };
}

test('an over-limit history the sidebar no longer lists is flagged, and nothing is messaged or archived', async () => {
  const home = tmp('size-flag-');
  sparseHistory(home, GIANT, OVERSIZE_BYTES + 1);
  sparseHistory(home, 'small', 10 * MB);
  const { d, sent, archived } = watchDeps(home);
  assert.deepEqual((await noticeOversizedSessions([row('small')], d)).nudged, 0);
  assert.deepEqual(Object.keys(readOversize(d)), [GIANT]);
  assert.equal(readOversize(d)[GIANT].unlisted, true);
  assert.deepEqual(sent, []);
  assert.deepEqual(archived, []);
  fs.rmSync(home, { recursive: true, force: true });
});

test('a running giant and its smaller coordinator are asked at once, and again only once the giant has grown by half', async () => {
  const home = tmp('size-ask-');
  sparseHistory(home, GIANT, 514 * MB);
  const { d, sent } = watchDeps(home);
  const rows = [row(GIANT, { name: 'Ouro fix: labs', coordinatingCreatorSessionId: COORDINATOR, ...working }), row(COORDINATOR, { state: 'idle' })];
  const first = await noticeOversizedSessions(rows, d);
  assert.deepEqual([first.nudged, first.archived], [1, 0]);
  assert.deepEqual(sent.map((m) => m.id), [COORDINATOR, GIANT]);
  assert.match(sent[0].text, /514 MB history[\s\S]*checkpoint[\s\S]*archive[\s\S]*Keep images out of chat/);
  assert.equal(readOversize(d)[GIANT].nudges, 1);
  sparseHistory(home, GIANT, Math.floor(514 * MB * 1.49));
  await noticeOversizedSessions(rows, d);
  assert.equal(sent.length, 2, 'not yet 1.5 times its size at the last ask');
  sparseHistory(home, GIANT, Math.ceil(514 * MB * 1.5));
  await noticeOversizedSessions(rows, d);
  assert.equal(sent.length, 4);
  assert.match(sent[2].text, /This is ask 2: it was 514 MB at the last one/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('a giant with no coordinator it can reach is put to the owner once, and tried again when the owner could not be told', async () => {
  const home = tmp('size-owner-');
  sparseHistory(home, COLD, 2 * GB);
  const told = [];
  let answer = { ok: false, error: 'down' };
  const { d } = watchDeps(home, { tell: async (text) => { told.push(text); return answer; } });
  const rows = [row(COLD, { state: 'idle', isRunning: false })];
  assert.deepEqual((await noticeOversizedSessions(rows, d)).nudged, 0);
  assert.equal(readOversize(d)[COLD].to, 'owner');
  assert.equal(readOversize(d)[COLD].nudgedAt, undefined);
  answer = { ok: true, error: null };
  assert.equal((await noticeOversizedSessions(rows, d)).nudged, 1);
  assert.equal((await noticeOversizedSessions(rows, d)).nudged, 0, 'told once');
  assert.equal(told.length, 2);
  assert.match(told[0], /cannot be nudged without reloading them[\s\S]*"session 7777" \(2.0 GB\)/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('an idle giant asked more than 30 minutes ago is archived, worktree kept, and its coordinator is told where it left off', async () => {
  const home = tmp('size-archive-');
  const askedAt = NOW - 40 * 60_000;
  sparseHistory(home, GIANT, 600 * MB, '{"command":"git push -q -u origin HEAD:skills-fix"}\n{"content":"https://github.com/example/project/pull/412"}\n');
  const iso = (ms) => new Date(ms).toISOString();
  const rows = (lastActivity) => [row(GIANT, { name: 'Lane', state: 'idle', isRunning: false, coordinatingCreatorSessionId: COORDINATOR, lastActivity: iso(lastActivity) }), row(COORDINATOR)];
  const { d, sent, archived } = watchDeps(home);
  fs.mkdirSync(path.join(home, 'state'), { recursive: true });
  fs.writeFileSync(path.join(home, 'state', 'oversize.json'), JSON.stringify({ sessions: { [GIANT]: { bytes: 600 * MB, name: 'Lane', nudgedAt: iso(askedAt), nudgedBytes: 600 * MB, nudges: 1, to: COORDINATOR } } }));
  const at = (ms) => ({ ...d, now: () => ms });
  assert.equal((await noticeOversizedSessions(rows(askedAt + 5 * 60_000), at(askedAt + IDLE_ARCHIVE_MS + 60_000))).archived, 0, 'active after the ask');
  assert.equal((await noticeOversizedSessions(rows(askedAt - 60_000), at(askedAt + IDLE_ARCHIVE_MS - 1))).archived, 0, 'not yet 30 minutes');
  assert.equal((await noticeOversizedSessions(rows(askedAt - 60_000), at(askedAt + IDLE_ARCHIVE_MS))).archived, 1);
  const where = 'branch work in example/project; last push `git push -q -u origin HEAD:skills-fix`; last pull request https://github.com/example/project/pull/412';
  assert.deepEqual(archived, [{ id: GIANT, reason: 'oversize-idle', note: `600 MB; ${where}` }]);
  assert.equal(sent.at(-1).id, COORDINATOR);
  assert.equal(sent.at(-1).text, archivedNote('Lane', GIANT, 600 * MB, where));
  fs.rmSync(home, { recursive: true, force: true });
});

test('under memory pressure the idle giants go at once, largest first, and a running or waiting one never does', async () => {
  const home = tmp('size-pressure-');
  sparseHistory(home, 'big', 1_097 * MB);
  sparseHistory(home, 'mid', 565 * MB);
  sparseHistory(home, 'run', 742 * MB);
  sparseHistory(home, 'wait', 900 * MB);
  const order = [];
  const { d, sent } = watchDeps(home, { memory: SWAMPED, archive: async (r) => { order.push(r.id); return true; } });
  const rows = [row('mid', { state: 'idle', isRunning: false }), row('big', { state: 'idle', isRunning: false }), row('run', working), row('wait', { state: 'waiting', isRunning: false, awaiting: 'input' })];
  const r = await noticeOversizedSessions(rows, d);
  assert.equal(r.archived, 2);
  assert.deepEqual(order, ['big', 'mid']);
  assert.ok(sent.every((m) => m.id === 'run'), 'only the running giant is asked');
  fs.rmSync(home, { recursive: true, force: true });
});

test('a plan reports the flags, asks and archives it would make and changes nothing', async () => {
  const home = tmp('size-plan-');
  sparseHistory(home, GIANT, 600 * MB);
  const { d, sent, archived } = watchDeps(home);
  const r = await noticeOversizedSessions([row(GIANT, { state: 'idle', isRunning: false, lastActivity: new Date(NOW - 3600_000).toISOString() })], d, { apply: false });
  assert.deepEqual(r.actions.map((a) => [a.what, a.done]), [['flag', false], ['owner', false]]);
  assert.deepEqual(sent, []);
  assert.deepEqual(archived, []);
  assert.equal(fs.existsSync(path.join(d.state, 'oversize.json')), false);
  fs.rmSync(home, { recursive: true, force: true });
});

test('where a session left off names its branch, cuts credentials from a push URL, and says so when there is nothing', () => {
  const home = tmp('size-where-');
  sparseHistory(home, 'ws', 20 * MB, '{"command":"git push -q https://x-access-token:TOKEN@github.com/example/website.git feature/x 2>&1 | grep -v x"}\n');
  const d = testDeps(home);
  assert.equal(whereItLeftOff({ id: 'ws', branch: 'home', projectRepo: 'example/website' }, d), 'branch home in example/website; last push `git push -q https://github.com/example/website.git feature/x`');
  assert.equal(whereItLeftOff({ id: 'missing', branch: null, projectRepo: null }, d), 'no push or pull request in the end of its history');
  fs.rmSync(home, { recursive: true, force: true });
});

test('memory is read from sysctl on macOS and from meminfo elsewhere, and an unreadable swap counts as none', () => {
  assert.equal(readMemory('darwin', () => 'total = 26624.00M  used = 25629.12M  free = 994.88M  (encrypted)\n').swapUsedBytes, 25629.12 * MB);
  assert.equal(readMemory('linux', () => 'MemTotal: 100 kB\nSwapTotal:     4096 kB\nSwapFree:      1024 kB\n').swapUsedBytes, 3072 * 1024);
  assert.equal(readMemory('linux', () => 'MemTotal: 100 kB\n').swapUsedBytes, 0);
  assert.equal(readMemory('darwin', () => { throw new Error('no sysctl'); }).swapUsedBytes, 0);
  assert.equal(shortOfMemory(SWAMPED), true);
  assert.equal(shortOfMemory({ swapUsedBytes: 9 * GB, freeBytes: 16 * GB }), true);
  assert.equal(shortOfMemory({ swapUsedBytes: 7 * GB, freeBytes: 2 * GB }), false);
});

test('the hand-off ask says the size in MB, and counts asks', () => {
  assert.match(handoffNudge('A\nname', 700 * MB), /700 MB history/);
  assert.match(handoffNudge('A', 2 * GB, 1), /This is ask 2\./);
});
