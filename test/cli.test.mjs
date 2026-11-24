import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateDir, tmpArticle } from './helpers.mjs';
import * as m from '../lib/model.mjs';
import { startServer } from '../lib/server.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'rewriter.mjs');
const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

test('cli init/add/publish/status/pending', () => {
  const dir = tmpArticle();
  assert.equal(run('init', dir).status, 0);
  const add = run('add', dir, '--severity', 'major', '--body', 'tighten', '--quote', 'The cat ran', '--reviewer', 'Writer', '--reviewer', 'Junior', '--suggestion', 'The cat bolted.');
  assert.equal(add.status, 0, add.stderr);
  const [c] = JSON.parse(add.stdout);
  assert.deepEqual(c.reviewers, ['Writer', 'Junior']);
  const file = join(dir, 'batch.json');
  writeFileSync(file, JSON.stringify([{ severity: 'MINOR', body: 'b' }, { severity: 'NITPICK', body: 'n', quote: 'Second section' }]));
  assert.equal(JSON.parse(run('add', dir, '--file', file).stdout).length, 2);
  assert.equal(run('publish', dir).status, 0);
  const st = run('status', dir);
  assert.equal(st.status, 0);
  assert.match(st.stdout, /Round 1 \(open\)/);
  assert.match(st.stdout, /3 open/);
  const p = JSON.parse(run('pending', dir).stdout);
  assert.equal(p.carriedOver, 3);
  const state = JSON.parse(readFileSync(join(stateDir(dir), 'review.json'), 'utf8'));
  assert.equal(state.comments.length, 3);
});

test('cli errors exit 1 with message', () => {
  const dir = tmpArticle();
  run('init', dir);
  const r = run('add', dir, '--severity', 'MAJOR', '--body', 'x', '--quote', 'nope nope');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /quote not found/);
  assert.equal(run('bogus', dir).status, 1);
  assert.equal(run('next', dir).status, 1);
});

test('cli reply via file', () => {
  const dir = tmpArticle();
  run('init', dir);
  run('add', dir, '--severity', 'MAJOR', '--body', 'x');
  run('publish', dir);
  const state = JSON.parse(readFileSync(join(stateDir(dir), 'review.json'), 'utf8'));
  state.rounds[0].status = 'submitted';
  state.comments[0].decision = { type: 'decline', note: 'no', round: 1 };
  writeFileSync(join(stateDir(dir), 'review.json'), JSON.stringify(state));
  assert.equal(run('next', dir).status, 0);
  const f = join(dir, 'r.json');
  writeFileSync(f, JSON.stringify([{ id: 'c1', kind: 'accepted', body: 'fair' }]));
  const r = run('reply', dir, '--file', f);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout)[0].status, 'addressed');
  const r2 = run('reply', dir, 'c1', '--kind', 'reply', '--body', 'more');
  assert.equal(r2.status, 0, r2.stderr);
});

// ---- parallel sessions ----

const runAsync = (env, ...args) => new Promise((done) => {
  const p = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env } });
  let stdout = ''; let stderr = '';
  p.stdout.on('data', (d) => { stdout += d; });
  p.stderr.on('data', (d) => { stderr += d; });
  p.on('close', (status) => done({ status, stdout, stderr }));
});
const as = (session) => (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, REWRITER_SESSION: session } });

test('cli: parallel add calls on one document all land, each with its own id', async () => {
  const dir = tmpArticle();
  run('init', dir);
  const n = 16;
  const results = await Promise.all(Array.from({ length: n }, (_, i) => runAsync({}, 'add', dir, '--severity', 'MINOR', '--body', `b${i}`)));
  assert.deepEqual(results.map((r) => r.status), Array(n).fill(0), results.map((r) => r.stderr).join(''));
  const { comments } = JSON.parse(readFileSync(join(stateDir(dir), 'review.json'), 'utf8'));
  assert.equal(comments.length, n);
  assert.equal(new Set(comments.map((c) => c.id)).size, n);
  assert.deepEqual(comments.map((c) => c.body).sort(), Array.from({ length: n }, (_, i) => `b${i}`).sort());
});

test('cli: add reads a batch from stdin with --file -', () => {
  const dir = tmpArticle();
  run('init', dir);
  const r = spawnSync(process.execPath, [CLI, 'add', dir, '--file', '-'], { encoding: 'utf8', input: JSON.stringify([{ severity: 'MINOR', body: 'from stdin' }]) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout)[0].body, 'from stdin');
});

test('cli: the session id comes from the environment; a second session is refused until it claims', () => {
  const dir = tmpArticle();
  const a = as('session-a'); const b = as('session-b');
  assert.equal(a('init', dir).status, 0);
  const refused = b('add', dir, '--severity', 'MINOR', '--body', 'x');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /another Claude session/);
  assert.match(b('status', dir).stdout, /another Claude session/);
  assert.doesNotMatch(a('status', dir).stdout, /another Claude session/);
  assert.equal(JSON.parse(b('pending', dir).stdout).otherSession, 'session-a');
  assert.equal(b('claim', dir).status, 0);
  assert.equal(b('add', dir, '--severity', 'MINOR', '--body', 'x').status, 0);
  assert.equal(a('publish', dir).status, 1);
  assert.equal(b('publish', dir).status, 0);
});

test('cli: of two sessions answering the same submitted round, exactly one gets it', async () => {
  const dir = tmpArticle();
  run('init', dir); run('publish', dir);
  const state = JSON.parse(readFileSync(join(stateDir(dir), 'review.json'), 'utf8'));
  state.rounds[0].status = 'submitted';
  writeFileSync(join(stateDir(dir), 'review.json'), JSON.stringify(state));
  const [x, y] = await Promise.all([runAsync({ REWRITER_SESSION: 'session-a' }, 'next', dir), runAsync({ REWRITER_SESSION: 'session-b' }, 'next', dir)]);
  assert.deepEqual([x.status, y.status].sort(), [0, 1]);
  assert.match(x.status ? x.stderr : y.stderr, /picked up by another Claude session/);
  assert.equal(JSON.parse(readFileSync(join(stateDir(dir), 'review.json'), 'utf8')).rounds.length, 2);
});

// ---- running: the review UIs of the calling session (what the footer shows) ----
// The server lives in this process, so the CLI is run without blocking it (runAsync, never spawnSync).

test('running lists this session\'s live servers, as JSON and as lines', async () => {
  const registry = { REWRITER_RUNNING: mkdtempSync(join(tmpdir(), 'rw-running-')), REWRITER_SESSION: '' };
  const kept = process.env.REWRITER_RUNNING;
  process.env.REWRITER_RUNNING = registry.REWRITER_RUNNING;
  const dir = tmpArticle();
  run('init', dir);
  const s = await startServer(dir, { open: false, log: () => {}, session: 'sess-a' });
  try {
    const mine = await runAsync({ ...registry, CLAUDE_CODE_SESSION_ID: 'sess-a' }, 'running', '--json');
    assert.equal(mine.status, 0, mine.stderr);
    assert.deepEqual(JSON.parse(mine.stdout), [{ name: basename(dir), url: s.url, document: realpathSync(join(dir, 'index.md')) }]);
    const other = await runAsync({ ...registry, CLAUDE_CODE_SESSION_ID: 'sess-a' }, 'running', '--json', '--session', 'sess-b');
    assert.equal(other.stdout.trim(), '[]');
    assert.equal(other.status, 0);
    const lines = await runAsync({ ...registry, CLAUDE_CODE_SESSION_ID: '' }, 'running', '--session', 'sess-a');
    assert.equal(lines.stdout, `${basename(dir)}  ${s.url}\n`);
    const all = await runAsync({ ...registry, CLAUDE_CODE_SESSION_ID: '' }, 'running', '--json');
    assert.equal(JSON.parse(all.stdout).length, 1, 'no session id: every live server');
  } finally { await s.close(); process.env.REWRITER_RUNNING = kept; }
});

test('running with nothing running prints [] or nothing, and exits 0', async () => {
  const registry = { REWRITER_RUNNING: join(mkdtempSync(join(tmpdir(), 'rw-running-')), 'not-there-yet'), REWRITER_SESSION: '', CLAUDE_CODE_SESSION_ID: 'sess-a' };
  const json = await runAsync(registry, 'running', '--json');
  assert.deepEqual([json.status, json.stdout.trim(), json.stderr], [0, '[]', '']);
  const lines = await runAsync(registry, 'running');
  assert.deepEqual([lines.status, lines.stdout, lines.stderr], [0, '', '']);
});

// ---- approve: the third way a round ends ----

test('cli approve prints the approval, then removes the review', () => {
  const dir = tmpArticle();
  run('init', dir);
  run('add', dir, '--severity', 'MINOR', '--body', 'left open', '--quote', 'The cat ran');
  run('publish', dir);
  const a = run('approve', dir, '--note', 'good');
  assert.equal(a.status, 0, a.stderr);
  const p = JSON.parse(a.stdout);
  assert.deepEqual([p.roundStatus, p.request.mode, p.request.note, p.notActedOn], ['approved', 'approve', 'good', 1]);
  // The review is over: its state is gone, and so is every folder ReWriter made for it.
  assert.equal(existsSync(join(dir, '.rewriter')), false);
  const st = run('status', dir);
  assert.notEqual(st.status, 0);
  assert.match(st.stderr, /no ReWriter review/);
  // A document that has to change after all gets a new review, from round 1.
  assert.equal(run('init', dir).status, 0);
  assert.match(run('status', dir).stdout, /Round 1 \(preparing\)/);
  assert.notEqual(run('approve', dir).status, 0, 'a round being prepared cannot be approved');
});

test('cli status inside the minute after an approval says the review is closed', () => {
  const dir = tmpArticle();
  m.init(dir);
  m.publish(dir);
  m.approve(dir); // through the model: nothing has removed the state yet
  const st = run('status', dir).stdout;
  assert.match(st, /Round 1 \(approved\)/);
  assert.match(st, /Next: nothing\. The author approved this version; the review is closed and its state is being removed\./);
  assert.doesNotMatch(st, /reopen/);
});

test('reopen is no longer a command', () => {
  const dir = tmpArticle();
  run('init', dir);
  const r = run('reopen', dir);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown command: reopen/);
  assert.doesNotMatch(run('help').stdout, /reopen/);
});

test('a review started while the approved one waits to be removed survives', async () => {
  const dir = tmpArticle();
  run('init', dir);
  run('publish', dir);
  const approving = runAsync({}, 'approve', dir);
  await new Promise((r) => setTimeout(r, 450)); // approved, and `approve` is in its pause before removing
  assert.equal(run('init', dir).status, 0);
  run('add', dir, '--severity', 'MINOR', '--body', 'belongs to the new review');
  assert.equal((await approving).status, 0);
  const st = run('status', dir);
  assert.match(st.stdout, /Round 1 \(preparing\)/, st.stderr);
  assert.match(st.stdout, /1 open/);
});

test('approve leaves the removing to a running server', async () => {
  const dir = tmpArticle();
  run('init', dir);
  const s = await startServer(dir, { open: false, log: () => {} });
  try {
    run('publish', dir);
    const a = await runAsync({}, 'approve', dir);
    assert.equal(a.status, 0, a.stderr);
    // `approve` is back at once: the server removes the review, after it has told its tabs.
    assert.equal(existsSync(join(stateDir(dir), 'review.json')), true);
    await s.closed;
    assert.equal(existsSync(join(dir, '.rewriter')), false);
  } finally { await s.close(); }
});

test('wait on a document with no review says gone, and does not suggest starting one', async () => {
  const dir = tmpArticle();
  const out = await runAsync({}, 'wait', dir, '--timeout', '5');
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout), { roundStatus: 'gone' });
  assert.doesNotMatch(out.stderr, /init/);
});

test('wait says gone when the review disappears without an approval', async () => {
  const dir = tmpArticle();
  run('init', dir);
  run('publish', dir);
  const waiting = runAsync({}, 'wait', dir, '--timeout', '10');
  await new Promise((r) => setTimeout(r, 600));
  m.removeReview(dir);
  const out = await waiting;
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout), { roundStatus: 'gone' });
});

test('wait exits when the author approves', async () => {
  const dir = tmpArticle();
  run('init', dir);
  run('publish', dir);
  const waiting = runAsync({}, 'wait', dir, '--timeout', '10');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(run('approve', dir).status, 0);
  const out = await waiting;
  assert.equal(out.status, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout).roundStatus, 'approved');
});
