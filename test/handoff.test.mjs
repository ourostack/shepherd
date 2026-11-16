// Hand-offs (who succeeds whom, from the first messages) and who coordinates a lane now.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { namedPredecessor, readSuccessions, refreshSuccessions, successorOf } from '../src/handoff.mjs';
import { coordinatorOf, handoffSuccessors, reportTargets } from '../src/coordinator.mjs';
import { row, sessionHistory, testDeps, writeHistory } from './fake-sidebar.mjs';

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const C = 'cccccccc-0000-4000-8000-000000000003';
const TWIN = 'aaaaaaaa-1111-4000-8000-000000000009';
const NO_LOG = 'dddddddd-0000-4000-8000-000000000004';
const known = (value) => [A, B, C].find((id) => id.startsWith(value)) ?? null;
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), name));

test('the Succeeds line names the predecessor, the older wording does where the message opens, and neither takes a placeholder or itself', () => {
  assert.deepEqual(namedPredecessor(`Succeeds: ${A}\n\nCarry on.`, B, known), { predecessor: A, marker: 'structured' });
  assert.deepEqual(namedPredecessor(`# Kickoff\n\n**Succeeds:** ${A.toUpperCase()}\n`, B, known), { predecessor: A, marker: 'structured' });
  assert.equal(namedPredecessor(`${'x'.repeat(17_000)}\nSucceeds: ${A}`, B, known), null, 'past the first 16 KB');
  assert.equal(namedPredecessor(`Kickoffs begin with \`Succeeds: ${A}\` from now on.`, B, known), null, 'inside a sentence');
  assert.equal(namedPredecessor('Succeeds: <predecessor session id>', B, known), null, 'a placeholder');
  assert.equal(namedPredecessor(`Succeeds: ${B}`, B, known), null, 'itself');
  assert.deepEqual(namedPredecessor(`You are the successor of ${A.slice(0, 8)}.`, B, known), { predecessor: A, marker: 'free-text' });
  assert.equal(namedPredecessor(`Hand off to a fresh successor when the history grows. ${A}`, B, known), null, 'not where the message opens');
});

test('successions are read past the start-up events, the successor first turn is recorded, and a pending one waits for its first message', () => {
  const home = tmp('handoff-');
  sessionHistory(home, A, 'Original work.', { turned: true });
  sessionHistory(home, B, `Succeeds: ${A}`);
  const d = testDeps(home, { state: tmp('handoff-state-') });
  let known2 = refreshSuccessions(d, [A, B]);
  assert.equal(known2[B].predecessor, A);
  assert.equal(known2[B].turned, undefined);
  sessionHistory(home, B, `Succeeds: ${A}`, { turned: true });
  known2 = refreshSuccessions(d, [A, B]);
  assert.equal(known2[B].turned, true);
  assert.equal(readSuccessions(d)[B].turned, true, 'recorded in the state folder');
  sessionHistory(home, C, null);
  assert.equal(refreshSuccessions(d, [C])[C].pending, true);
  const hook = { type: 'hook.end', data: { output: 'x'.repeat(1000) } };
  writeHistory(home, C, Array.from({ length: 1100 }, () => hook));
  assert.equal(refreshSuccessions(d, [C])[C].pending, undefined, 'given up after the scan limit');
  fs.rmSync(home, { recursive: true, force: true });
});

test('a chain of hand-offs leads to its newest end, and two sessions that succeed each other retire neither', () => {
  const successions = {
    [B]: { predecessor: A, offset: 0, at: '2026-11-16T10:00:00Z' },
    [C]: { predecessor: B, offset: 0, at: '2026-11-16T12:00:00Z' },
  };
  assert.equal(successorOf(A, successions), C);
  assert.equal(successorOf(C, successions), null);
  assert.equal(successorOf(B, { [C]: { predecessor: B, offset: 0 }, [A]: { predecessor: B, offset: 0, at: '2026-11-16T13:00:00Z' } }), A, 'the newest claim wins');
  assert.equal(successorOf(A, { [B]: { predecessor: A, offset: 0 }, [A]: { predecessor: B, offset: 0 } }), null);
});

test('a short id resolves only when one history matches it, and sub-agent and malformed events are ignored', () => {
  const home = tmp('handoff-short-');
  sessionHistory(home, A, 'Original.');
  sessionHistory(home, TWIN, 'Other.');
  sessionHistory(home, B, 'You are the successor to aaaaaaaa.');
  sessionHistory(home, C, `You are the successor to ${A.slice(0, 13)}.`);
  const d = testDeps(home, { state: tmp('handoff-short-state-') });
  const known2 = refreshSuccessions(d, [A, TWIN, B, C]);
  assert.equal(known2[B].predecessor, null, 'the short id matches two histories');
  assert.equal(known2[C].predecessor, null, 'a prefix of two ids is no id');
  fs.rmSync(home, { recursive: true, force: true });
});

test('a coordinator that handed off and was archived is found from where its lanes report', () => {
  const home = tmp('coordinator-');
  const OLD = '11111111-0000-4000-8000-000000000000';
  const NEW = '22222222-0000-4000-8000-000000000000';
  const NEW_WORKSPACE = '33333333-0000-4000-8000-000000000000';
  const LANE = '44444444-0000-4000-8000-000000000000';
  const send = (target) => JSON.stringify({ type: 'assistant.message', data: { toolRequests: [{ name: 'send_session_message', arguments: { session_id: target } }] } });
  const file = path.join(home, 'session-state', LANE, 'events.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [send(OLD), 'not json send_session_message', send(NEW_WORKSPACE)].join('\n') + '\n');
  const d = testDeps(home, { state: tmp('coordinator-state-') });
  const rows = [row(NEW, { name: 'CIT Pages coordinator', workspaceId: NEW_WORKSPACE, isRunning: true, state: 'working' }), row(LANE, { name: 'Lane', coordinatingCreatorSessionId: OLD })];
  assert.deepEqual(coordinatorOf(rows[1], rows, { d }), { id: NEW, name: 'CIT Pages coordinator', via: 'reports' });
  assert.deepEqual(coordinatorOf(rows[1], rows, { d, successorOf: () => NEW }), { id: NEW, name: 'CIT Pages coordinator', via: 'hand-off' });
  assert.deepEqual(coordinatorOf(rows[1], [rows[1]], { d }), { gone: true, recorded: OLD });
  assert.deepEqual(coordinatorOf(row('boss', { coordinatingCreatorSessionId: 'boss' }), [], { d }), { gone: true, recorded: 'boss' });
  assert.deepEqual(reportTargets(LANE, d), [OLD, NEW_WORKSPACE]);
  assert.deepEqual(reportTargets(LANE, d, send(NEW_WORKSPACE).length + 1), [NEW_WORKSPACE], 'only the end of the history');
  assert.deepEqual(reportTargets(NO_LOG, d), [], 'no log, no targets');
  sessionHistory(home, NEW, `Succeeds: ${OLD}`);
  const d2 = testDeps(home, { state: tmp('coordinator-succ-') });
  refreshSuccessions(d2, [OLD, NEW]);
  assert.equal(handoffSuccessors(d2)(OLD), NEW, 'the hand-off on record');
  fs.rmSync(home, { recursive: true, force: true });
});
