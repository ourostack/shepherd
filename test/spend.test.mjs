// `shepherd spend`: the model each lane ran on, from fixture histories and a fake sidebar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spend, renderSpend, tierOf } from '../src/spend.mjs';
import { fakeApp, testDeps, writeHistory, NOW } from './fake-sidebar.mjs';

const H = 3600_000;
const COORD = 'c0000000-0000-4000-8000-000000000001';
const COORD2 = 'c0000000-0000-4000-8000-000000000002';
const OPUS_LANE = 'a0000000-0000-4000-8000-000000000001';
const CHEAP_LANE = 'a0000000-0000-4000-8000-000000000002';
const AUTO_LANE = 'a0000000-0000-4000-8000-000000000003';
const OLD_LANE = 'a0000000-0000-4000-8000-000000000004';

const ws = (id, sessionId, over = {}) => ({ id, name: `Lane ${id}`, checkoutBindings: [], session: { sessionId, executionLocation: 'local' }, ...over });
const change = (model, source = 'sdk', at = NOW - 40 * H) => ({ type: 'session.model_change', data: { newModel: model, source }, at });
// n turns on a model: turn_start, usage_record (weight cost), assistant.message
const turns = (model, n, { cost = 1, at = NOW - H, isAuto = false } = {}) => Array.from({ length: n }, (_, i) => [
  { type: 'assistant.turn_start', data: {}, at: at + i * 10 },
  { type: 'session.usage_record', data: { usage: { model, cost, isAuto } }, at: at + i * 10 + 1 },
  { type: 'assistant.message', data: { model }, at: at + i * 10 + 2 },
]).flat();

const started = (model, type = 'session.start') => ({ type, data: { selectedModel: model }, at: NOW - 40 * H });

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spend-'));
  writeHistory(home, OPUS_LANE, [change('claude-opus-4.6'), ...turns('claude-opus-4.6', 12, { cost: 3 })]);
  writeHistory(home, CHEAP_LANE, [change('claude-sonnet-5.5'), ...turns('claude-sonnet-5.5', 6), ...turns('claude-haiku-4.5', 4, { at: NOW - 2 * 24 * H })]);
  writeHistory(home, AUTO_LANE, [change('auto', 'auto'), ...turns('claude-sonnet-5.5', 3, { isAuto: true })]);
  writeHistory(home, OLD_LANE, [change('claude-opus-4.6'), ...turns('claude-opus-4.6', 30, { at: NOW - 9 * 24 * H })]);
  writeHistory(home, COORD, [change('claude-opus-4.6'), ...turns('claude-opus-4.6', 5)]);
  const app = fakeApp({
    workspaces: [
      ws('wc', COORD), ws('wc2', COORD2),
      ws('w1', OPUS_LANE, { coordinatingCreatorSessionId: COORD2 }),
      ws('w2', CHEAP_LANE, { coordinatingCreatorSessionId: COORD }),
      ws('w3', AUTO_LANE, { coordinatingCreatorSessionId: COORD }),
      ws('w4', OLD_LANE, { coordinatingCreatorSessionId: COORD, archivedAt: '2026-11-10T00:00:00Z' }),
    ],
  });
  return testDeps(home, { app });
}

test('tiers: Opus is expensive; Sonnet, Haiku and mini are cheap; anything else is other', () => {
  assert.deepEqual(['claude-opus-4.6', 'claude-sonnet-5.5', 'claude-haiku-4.5', 'gpt-5-mini', 'gpt-5.3-codex'].map(tierOf), ['expensive', 'cheap', 'cheap', 'cheap', 'other']);
});

test('spend reports each coordinator\'s lanes by model, the cheap share, the lanes with no explicit model, and flags Opus-heavy coordinators', async () => {
  const r = await spend(fixture());
  const first = r.coordinators.find((c) => c.id === COORD);
  assert.equal(first.lanes, 2);
  assert.equal(first.week.turns, 13);
  assert.equal(first.week.cheapTurns, 13);
  assert.equal(first.week.cheapShare, 1);
  assert.equal(first.flagged, false);
  assert.deepEqual(first.noModel, ['Lane w3']);
  const second = r.coordinators.find((c) => c.id === COORD2);
  assert.equal(second.week.expensiveShare, 1);
  assert.equal(second.week.weight, 36);
  assert.equal(second.flagged, true);
  assert.deepEqual(r.flagged, ['Lane wc2']);
  assert.deepEqual(r.noModel.map((s) => s.name), ['Lane w3']);
  const lane = r.sessions.find((s) => s.id === CHEAP_LANE);
  assert.deepEqual(Object.keys(lane.week.byModel).sort(), ['claude-haiku-4.5', 'claude-sonnet-5.5']);
  assert.equal(lane.today.turns, 6);
  assert.equal(r.sessions.find((s) => s.id === COORD).role, 'coordinator');
});

test('a session whose turns are all older than the window is left out, and the text names the decision and the lanes with no model', async () => {
  const r = await spend(fixture());
  assert.equal(r.sessions.some((s) => s.id === OLD_LANE), false);
  const widened = await spend(fixture(), { days: 14 });
  assert.equal(widened.sessions.find((s) => s.id === OLD_LANE).archived, true);
  const text = renderSpend(r);
  assert.match(text, /EXPENSIVE Lane wc2/);
  assert.match(text, /Decision: Lane wc2 run 50% or more/);
  assert.match(text, /No explicit model \(1\): Lane w3 \(3 turns\)/);
});

test('a lane started with a kickoff model is explicit: its session.start (or resume) selectedModel counts, with no model_change', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'spend-'));
  const KICKOFF = 'a0000000-0000-4000-8000-000000000011', RESUMED = 'a0000000-0000-4000-8000-000000000012', AUTO = 'a0000000-0000-4000-8000-000000000013', NONE = 'a0000000-0000-4000-8000-000000000014';
  writeHistory(home, KICKOFF, [started('claude-sonnet-5.5'), ...turns('claude-sonnet-5.5', 4)]);
  writeHistory(home, RESUMED, [started('claude-haiku-4.5', 'session.resume'), ...turns('claude-haiku-4.5', 2)]);
  writeHistory(home, AUTO, [started('auto'), ...turns('claude-opus-4.6', 2, { isAuto: true })]);
  writeHistory(home, NONE, [...turns('claude-opus-4.6', 3)]);
  writeHistory(home, COORD, [change('claude-opus-4.6'), ...turns('claude-opus-4.6', 1)]);
  const app = fakeApp({ workspaces: [ws('wc', COORD), ...[KICKOFF, RESUMED, AUTO, NONE].map((id, i) => ws(`k${i}`, id, { coordinatingCreatorSessionId: COORD }))] });
  const r = await spend(testDeps(home, { app }));
  assert.deepEqual(r.noModel.map((s) => s.name).sort(), ['Lane k2', 'Lane k3']);
});
