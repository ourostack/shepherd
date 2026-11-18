// The inbox duty against a fake GitHub: each rule, and that a person's words are never marked done.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inboxConfig, judge, pollInbox, pollInboxes, resolveToken, classify } from '../src/inbox.mjs';

const ME = 'arimendelow';
const cfg = { account: ME, bots: ['an-updater'], keepLabels: ['ready', 'done'] };
const user = (login, type = 'User') => ({ login, type });

let nextId = 1;
// A notification and the pull request / comment behind it.
function thread({ reason, type = 'PullRequest', author = user(ME), closedBy, comment, labels = [], lastRead, repo = 'o/r', title = 'a change' }) {
  const id = String(nextId++);
  const n = { id, reason, updated_at: '2026-11-18T08:00:00Z', last_read_at: lastRead ?? null, repository: { full_name: repo }, subject: { type, title, url: `https://api.github.com/repos/${repo}/pulls/${id}`, latest_comment_url: comment ? `https://api.github.com/repos/${repo}/issues/comments/${id}` : null } };
  const objects = { [n.subject.url]: { number: Number(id), user: author, labels: labels.map((name) => ({ name })), merged_by: closedBy ?? null } };
  if (comment) objects[n.subject.latest_comment_url] = { user: comment.user, created_at: comment.at ?? '2026-11-18T07:00:00Z' };
  return { n, objects };
}

function fakeGithub(threads, { login = ME, modified } = {}) {
  const objects = Object.assign({ '/user': { login } }, ...threads.map((t) => t.objects));
  const calls = { done: [], list: [] };
  const api = {
    calls,
    async json(url) { return objects[url] ?? null; },
    async request(url, init = {}) {
      calls.list.push({ url, since: init.headers?.['if-modified-since'] });
      const headers = new Map([['x-poll-interval', '60'], ['last-modified', 'Wed, 18 Nov 2026 08:00:00 GMT']]);
      const res = { headers: { get: (k) => headers.get(k) ?? null } };
      if (modified === false && init.headers?.['if-modified-since']) return { ...res, status: 304, ok: false };
      return { ...res, status: 200, ok: true, json: async () => threads.map((t) => t.n) };
    },
    async done(id) { calls.done.push(id); return true; },
  };
  return api;
}

const dirs = [];
function deps0(now = Date.parse('2026-11-18T08:30:00Z')) {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-'));
  dirs.push(state);
  return { state, now: () => now };
}
process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const run = async (threads, opts = {}) => {
  const d = deps0();
  const api = fakeGithub(threads, opts);
  const r = await pollInbox(d, cfg, { api, ...opts });
  return { r, api, d };
};

test('a state change on a pull request an agent opened as the owner is marked done, with its reason', async () => {
  const t = thread({ reason: 'state_change', closedBy: user('github-actions[bot]', 'Bot') });
  const { r, api, d } = await run([t]);
  assert.deepEqual(api.calls.done, [t.n.id]);
  assert.equal(r.done[0].rule, 'state_change-by-bot');
  assert.match(r.done[0].why, /github-actions\[bot\]/);
  const log = fs.readFileSync(path.join(d.state, 'inbox-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(log.length, 1);
  assert.equal(log[0].reason, 'state_change');
  assert.equal(JSON.parse(fs.readFileSync(path.join(d.state, 'inbox-counts.json'), 'utf8')).days['2026-11-18'].markedDone, 1);
});

test('author, subscribed and ci_activity on an agent or bot pull request are marked done', async () => {
  const ts = [
    thread({ reason: 'author', author: user('ouro-current[bot]', 'Bot'), comment: { user: user('ouro-current[bot]', 'Bot') } }),
    thread({ reason: 'subscribed', author: user('an-updater') }),
    thread({ reason: 'ci_activity', comment: { user: user(ME) } }),
    thread({ reason: 'subscribed', type: 'Issue', author: user(ME), closedBy: user(ME) }),
  ];
  const { r } = await run(ts);
  assert.equal(r.done.length, 4);
  assert.deepEqual(r.kept, []);
});

test('a human\'s mention is never marked done', async () => {
  const ts = [
    thread({ reason: 'mention', comment: { user: user('somebody') } }),
    thread({ reason: 'team_mention', comment: { user: user('somebody') } }),
    thread({ reason: 'comment', comment: { user: user('somebody') } }),
    thread({ reason: 'assign', author: user('somebody') }),
  ];
  const { r, api } = await run(ts);
  assert.deepEqual(api.calls.done, []);
  assert.equal(r.kept.length, 4);
  assert.deepEqual(r.kept.map((k) => k.rule).sort(), ['human-comment', 'human-comment', 'reason', 'reason']);
});

test('a comment or mention by a bot or the owner on their own thread is marked done; a person\'s thread or a lost comment stays', async () => {
  const ts = [
    thread({ reason: 'comment', type: 'Issue', author: user('github-actions[bot]', 'Bot'), comment: { user: user('github-actions[bot]', 'Bot') } }),
    thread({ reason: 'mention', author: user(ME), comment: { user: user(ME) } }),
    thread({ reason: 'comment', author: user('aurokin'), comment: { user: user('github-actions[bot]', 'Bot') } }),
    thread({ reason: 'comment', author: user(ME) }),
  ];
  const { r } = await run(ts);
  assert.equal(r.done.length, 2);
  assert.deepEqual(r.kept.map((k) => k.rule).sort(), ['human-author', 'unknown']);
});

test('a person\'s comment, merge, close or pull request keeps an otherwise automatic thread', async () => {
  const ts = [
    thread({ reason: 'subscribed', comment: { user: user('somebody') } }),
    thread({ reason: 'state_change', closedBy: user('somebody') }),
    thread({ reason: 'author', author: user('somebody') }),
    thread({ reason: 'review_requested', author: user('somebody') }),
    thread({ reason: 'subscribed', author: user('an-updater'), comment: { user: user('somebody') } }),
  ];
  const { r, api } = await run(ts);
  assert.deepEqual(api.calls.done, []);
  assert.deepEqual(r.kept.map((k) => k.rule), ['human-comment', 'human-closed', 'human-author', 'review-by-person', 'human-comment']);
});

test('a human comment the owner already read does not keep it, an unread one does', async () => {
  const read = thread({ reason: 'subscribed', comment: { user: user('somebody'), at: '2026-11-18T06:00:00Z' }, lastRead: '2026-11-18T07:00:00Z' });
  const unread = thread({ reason: 'subscribed', comment: { user: user('somebody'), at: '2026-11-18T07:30:00Z' }, lastRead: '2026-11-18T07:00:00Z' });
  const { r } = await run([read, unread]);
  assert.deepEqual(r.done.map((x) => x.id), [read.n.id]);
  assert.deepEqual(r.kept.map((x) => x.id), [unread.n.id]);
});

test('a review request on a bot\'s update pull request is marked done; on the owner\'s own or a person\'s it is not', async () => {
  const bot = thread({ reason: 'review_requested', author: user('ouro-current[bot]', 'Bot'), title: 'Update to Ouro UI v1.3.276' });
  const mine = thread({ reason: 'review_requested', author: user(ME) });
  const { r } = await run([bot, mine]);
  assert.deepEqual(r.done.map((x) => x.rule), ['review-requested-on-bot-pr']);
  assert.equal(r.kept[0].rule, 'review-by-person');
});

test('something marked ready or done for the owner stays: by label or by the keep list', async () => {
  const labelled = thread({ reason: 'state_change', closedBy: user('github-actions[bot]', 'Bot'), labels: ['Ready'] });
  const listed = thread({ reason: 'subscribed', repo: 'o/keep' });
  const d = deps0();
  fs.writeFileSync(path.join(d.state, 'inbox-keep.json'), JSON.stringify([`o/keep#${listed.objects[listed.n.subject.url].number}`]));
  const r = await pollInbox(d, cfg, { api: fakeGithub([labelled, listed]) });
  assert.deepEqual(r.kept.map((k) => k.rule), ['keep-label', 'keep-list']);
  assert.deepEqual(r.done, []);
});

test('anything it cannot read is kept, and another kind of subject is left alone', async () => {
  const broken = thread({ reason: 'state_change' });
  delete broken.objects[broken.n.subject.url];
  const release = thread({ reason: 'subscribed', type: 'Release' });
  const { r, api } = await run([broken, release]);
  assert.deepEqual(api.calls.done, []);
  assert.deepEqual(r.kept.map((k) => k.rule), ['unknown', 'subject']);
});

test('a failed workflow run (ci_activity on a CheckSuite) is marked done and logged; a mention on one is not', async () => {
  const suite = thread({ reason: 'ci_activity', type: 'CheckSuite', title: 'ci workflow run failed for main branch' });
  const run2 = thread({ reason: 'ci_activity', type: 'WorkflowRun' });
  const mention = thread({ reason: 'mention', type: 'CheckSuite' });
  const { r, api, d } = await run([suite, run2, mention]);
  assert.deepEqual(api.calls.done, [suite.n.id, run2.n.id]);
  assert.equal(r.done[0].rule, 'ci-run');
  assert.match(r.done[0].why, /red-main/);
  assert.equal(r.kept[0].rule, 'subject');
  assert.equal(fs.readFileSync(path.join(d.state, 'inbox-log.jsonl'), 'utf8').trim().split('\n').length, 2);
});

test('a token for a different account is refused, in a plan too, and the match is exact', async () => {
  const t = thread({ reason: 'state_change', closedBy: user('github-actions[bot]', 'Bot') });
  for (const login of ['arimendelow_microsoft', 'arimendelo']) {
    for (const apply of [true, false]) {
      const api = fakeGithub([t], { login });
      await assert.rejects(pollInbox(deps0(), cfg, { api, apply }), /not arimendelow's/);
      assert.deepEqual(api.calls.list, [], 'nothing was read');
    }
  }
});

test('the account\'s own token is chosen ahead of the shell\'s GH_TOKEN', () => {
  const asked = [];
  const run = (a) => { asked.push(a); return `gh-token-of-${a}\n`; };
  const env = { GH_TOKEN: 'the-shells-token' };
  assert.equal(resolveToken({ account: 'arimendelow' }, env, run), 'gh-token-of-arimendelow');
  assert.equal(resolveToken({ account: 'arimendelow_microsoft' }, { ...env, SHEPHERD_INBOX_TOKEN_ARIMENDELOW_MICROSOFT: 'pinned' }, run), 'pinned');
  assert.equal(resolveToken({ account: 'x' }, env, () => { throw new Error('no'); }), 'the-shells-token');
  assert.throws(() => resolveToken({ account: 'x' }, {}, () => ''), /no GitHub token for x/);
});

test('every configured account is read with its own token and its own state, and one failing does not stop the other', async () => {
  const d = deps0();
  const mine = thread({ reason: 'state_change', closedBy: user('github-actions[bot]', 'Bot') });
  const work = thread({ reason: 'ci_activity', type: 'CheckSuite', repo: 'gim-home/x' });
  const ledger = path.join(d.state, 'ledger.json');
  const c = { enabled: true, ledger, accounts: [{ ...cfg, account: 'arimendelow_microsoft' }, cfg] };
  const apis = { arimendelow_microsoft: fakeGithub([work], { login: 'arimendelow_microsoft' }), [ME]: fakeGithub([mine]) };
  const r = await pollInboxes(d, c, { apis });
  assert.deepEqual(r.map((x) => [x.account, x.done.length]), [['arimendelow_microsoft', 1], [ME, 1]]);
  assert.deepEqual(apis.arimendelow_microsoft.calls.done, [work.n.id]);
  const out = JSON.parse(fs.readFileSync(ledger, 'utf8'));
  assert.equal(out.accounts[ME].days['2026-11-18'].markedDone, 1);
  assert.equal(out.accounts.arimendelow_microsoft.days['2026-11-18'].markedDone, 1);

  const bad = { arimendelow_microsoft: fakeGithub([], { login: 'someone' }), [ME]: fakeGithub([]) };
  const r2 = await pollInboxes(deps0(), c, { apis: bad });
  assert.match(r2[0].error, /someone/);
  assert.equal(r2[1].listed, 0);
});

test('plan marks nothing and writes nothing', async () => {
  const t = thread({ reason: 'state_change', closedBy: user('github-actions[bot]', 'Bot') });
  const { r, api, d } = await run([t], { apply: false });
  assert.equal(r.done.length, 1);
  assert.deepEqual(api.calls.done, []);
  assert.deepEqual(fs.readdirSync(d.state), []);
});

test('a token that is not the account\'s is refused', async () => {
  const d = deps0();
  await assert.rejects(pollInbox(d, cfg, { api: fakeGithub([], { login: 'someone-else' }) }), /someone-else/);
});

test('polls are conditional and wait for X-Poll-Interval', async () => {
  const d = deps0(Date.parse('2026-11-18T08:30:00Z'));
  const t = thread({ reason: 'subscribed' });
  const api = fakeGithub([t], { modified: false });
  assert.equal((await pollInbox(d, cfg, { api })).done.length, 1);
  const again = await pollInbox(d, cfg, { api });
  assert.equal(again.skipped, true, 'not due for 60 s');
  d.now = () => Date.parse('2026-11-18T08:31:30Z');
  const third = await pollInbox(d, cfg, { api });
  assert.equal(third.notModified, true);
  assert.equal(api.calls.list.at(-1).since, 'Wed, 18 Nov 2026 08:00:00 GMT');
});

test('classify and config', () => {
  assert.equal(classify(user('ARIMendelow'), cfg), 'owner');
  assert.equal(classify(user('app/ouro-current'), cfg), 'bot');
  assert.equal(classify(user('someone'), cfg), 'human');
  assert.equal(classify(null, cfg), 'unknown');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-cfg-'));
  try {
    assert.equal(inboxConfig(path.join(dir, 'none.json')).enabled, false);
    fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify({ enabled: true, bots: ['X'], ledger: '/tmp/l.json' }));
    const c = inboxConfig(path.join(dir, 'c.json'));
    assert.deepEqual([c.enabled, c.accounts.map((a) => a.account), c.accounts[0].bots, c.ledger], [true, ['arimendelow'], ['x'], '/tmp/l.json']);
    fs.writeFileSync(path.join(dir, 'm.json'), JSON.stringify({ enabled: true, bots: ['x'], accounts: ['a', { account: 'B', bots: ['y'] }, 'A', 7] }));
    const m = inboxConfig(path.join(dir, 'm.json'));
    assert.deepEqual(m.accounts.map((a) => [a.account, a.bots]), [['a', ['x']], ['B', ['y']]]);
    fs.writeFileSync(path.join(dir, 'bad.json'), '{');
    assert.throws(() => inboxConfig(path.join(dir, 'bad.json')), /not valid JSON/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('judge keeps a thread with no facts', () => {
  assert.equal(judge({ reason: 'subscribed', subject: { type: 'PullRequest' } }, null, cfg).done, false);
});
