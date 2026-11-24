// Generic documents: per-file state, document types, submit requests, reviewer registry, wait.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as m from '../lib/model.mjs';
import { listReviewers } from '../lib/reviewers.mjs';
import { createHandler } from '../lib/server.mjs';
import { ARTICLE, tmpArticle } from './helpers.mjs';

process.env.REWRITER_REVIEWERS = join(tmpdir(), 'rw-no-user-reviewers.json'); // ignore the developer's own file

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'rewriter.mjs');

function tmpDocs() {
  const dir = mkdtempSync(join(tmpdir(), 'rw-'));
  writeFileSync(join(dir, 'spec.md'), '# Spec\n\nThe service stores widgets.\n');
  writeFileSync(join(dir, 'plan.md'), '# Plan\n\nStep one: add the table.\n');
  return dir;
}

test('two documents in one folder keep separate reviews', () => {
  const dir = tmpDocs();
  const spec = join(dir, 'spec.md');
  const plan = join(dir, 'plan.md');
  assert.equal(m.init(spec, { type: 'spec' }).docType, 'spec');
  m.init(plan, { type: 'plan' });
  assert.ok(existsSync(join(dir, '.rewriter', 'spec.md', 'review.json')));
  assert.ok(existsSync(join(dir, '.rewriter', 'plan.md', 'review.json')));
  m.addComments(spec, [{ severity: 'MAJOR', body: 'which store?', quote: 'stores widgets' }]);
  assert.throws(() => m.addComments(plan, [{ severity: 'MAJOR', body: 'x', quote: 'stores widgets' }]), /quote not found/);
  m.publish(spec);
  assert.ok(existsSync(join(dir, '.rewriter', 'spec.md', 'rounds', '1.md')));
  assert.equal(m.load(spec).comments.length, 1);
  assert.equal(m.load(plan).comments.length, 0);
  assert.equal(m.load(plan).rounds[0].status, 'preparing');
});

test('a directory and its index.md are the same review; old reviews count as articles', () => {
  const dir = tmpArticle();
  m.init(dir);
  assert.equal(m.load(join(dir, 'index.md')).article, 'index.md');
  assert.throws(() => m.init(join(dir, 'index.md')), (e) => e.status === 409);
  assert.equal(m.docType({ article: 'index.md' }), 'article');
  assert.throws(() => m.init(join(tmpDocs(), 'spec.md'), { type: 'not ok' }), (e) => e.status === 400);
});

test('human-only first round: publish with no comments, author comments, fix only', () => {
  const spec = join(tmpDocs(), 'spec.md');
  m.init(spec, { type: 'spec' });
  m.publish(spec);
  const u = m.userComment(spec, { anchor: { kind: 'article' }, body: 'name the store' });
  m.submit(spec);
  const sub = m.pending(spec);
  assert.deepEqual(sub.request, { mode: 'fix', aiReview: false, reviewers: [], note: '' });
  m.nextRound(spec);
  const p = m.pending(spec);
  assert.equal(p.docType, 'spec');
  assert.equal(p.request.aiReview, false);
  assert.equal(p.held, 0);
  assert.deepEqual(p.needsAction.map((x) => [x.id, x.why]), [[u.id, ['user-comment']]]);
});

test('submit can ask for an AI review with reviewers, models and a new reviewer', () => {
  const spec = join(tmpDocs(), 'spec.md');
  m.init(spec, { type: 'spec' });
  m.publish(spec);
  assert.throws(() => m.submit(spec, { aiReview: true }), /at least one reviewer/);
  assert.throws(() => m.submit(spec, { aiReview: true, reviewers: [{ persona: 'Nobody' }] }), /unknown reviewer: Nobody/);
  assert.throws(() => m.submit(spec, { aiReview: true, custom: [{ persona: 'Sec' }] }), /needs a description/);
  assert.throws(() => m.submit(spec, { aiReview: true, reviewers: [{ persona: 'Architect', model: 'bad model!' }] }), /bad model/);
  assert.equal(m.load(spec).rounds[0].status, 'open');
  m.submit(spec, {
    aiReview: true, note: ' focus on storage ',
    reviewers: [{ persona: 'Architect', model: 'opus' }, { persona: 'Writer' }],
    custom: [{ persona: 'Security Reviewer', background: 'Looks for auth holes.', model: 'haiku' }],
  });
  m.nextRound(spec);
  const { request } = m.pending(spec);
  assert.equal(request.aiReview, true);
  assert.equal(request.note, 'focus on storage');
  assert.deepEqual(request.reviewers.map((r) => [r.persona, r.model, r.profile]), [
    ['Architect', 'opus', 'spec'], ['Writer', '', 'article'], ['Security Reviewer', 'haiku', 'custom'],
  ]);
  assert.ok(request.reviewers.every((r) => r.background));
  assert.ok(request.reviewers[0].focus.length > 0);

  // Next round: different panel, reusing the reviewer defined earlier by name only. Old request is gone once published.
  m.publish(spec);
  assert.equal(m.pending(spec).request, null);
  m.submit(spec, { aiReview: true, reviewers: [{ persona: 'Security Reviewer' }] });
  assert.deepEqual(m.pending(spec).request.reviewers.map((r) => [r.persona, r.model]), [['Security Reviewer', 'haiku']]);
  assert.deepEqual(m.load(spec).rounds.map((r) => r.request.reviewers.length), [3, 1]);
});

test('reviewer registry suggests by document type and merges a user file', () => {
  const names = (type) => listReviewers({ docType: type }).filter((r) => r.suggested).map((r) => r.persona);
  assert.deepEqual(names('article'), ['Lead AI Engineer', 'AI Skeptic', 'Junior Engineer', 'Writer']);
  assert.deepEqual(names('spec'), ['Architect', 'Implementer', 'Test Engineer', 'Scope Skeptic']);
  assert.deepEqual(names('plan').sort(), ['Codebase Verifier', 'Scope Skeptic', 'Sequencer', 'Spec Auditor']);
  assert.deepEqual(names('memo'), ['Critical Reader', 'Editor']);
  const all = listReviewers({ docType: 'spec' }).map((r) => r.persona);
  assert.equal(new Set(all).size, all.length);

  const file = join(mkdtempSync(join(tmpdir(), 'rw-')), 'reviewers.json');
  writeFileSync(file, JSON.stringify({ spec: [{ persona: 'Architect', background: 'Mine.', focus: [], model: 'opus' }, { persona: 'DBA', background: 'Data.', focus: [] }] }));
  const prev = process.env.REWRITER_REVIEWERS;
  process.env.REWRITER_REVIEWERS = file;
  try {
    const mine = listReviewers({ docType: 'spec' });
    assert.deepEqual(mine.find((r) => r.persona === 'Architect'), { persona: 'Architect', background: 'Mine.', focus: [], model: 'opus', profile: 'spec', source: 'user', suggested: true });
    assert.ok(mine.find((r) => r.persona === 'DBA').suggested);
  } finally { process.env.REWRITER_REVIEWERS = prev; }
});

test('server: reviewers endpoint, submit with a request, bad request is a 400', async () => {
  const spec = join(tmpDocs(), 'spec.md');
  m.init(spec, { type: 'spec' });
  m.publish(spec);
  const server = createServer(createHandler(spec));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const st = await (await fetch(`${base}/api/state`)).json();
    assert.equal(st.docType, 'spec');
    assert.equal(st.articleFile, 'spec.md');
    assert.equal(st.article.title, 'Spec');
    const reg = await (await fetch(`${base}/api/reviewers`)).json();
    assert.equal(reg.last, null);
    assert.ok(reg.models.includes('opus'));
    assert.ok(reg.reviewers.find((r) => r.persona === 'Implementer').suggested);
    assert.equal((await post('/api/submit', { mode: 'both' })).status, 400);
    assert.equal((await post('/api/submit', { mode: 'review', reviewers: [] })).status, 400);
    assert.equal((await post('/api/submit', { mode: 'review', reviewers: [{ persona: 'Implementer', model: 'sonnet' }] })).status, 200);
    assert.deepEqual(m.load(spec).rounds[0].request.reviewers, [{ persona: 'Implementer', model: 'sonnet' }]);
    const again = await (await fetch(`${base}/api/reviewers`)).json();
    assert.deepEqual(again.last, [{ persona: 'Implementer', model: 'sonnet' }]);
    assert.equal((await fetch(`${base}/.rewriter/spec.md/review.json`)).status, 404);
  } finally { server.close(); }
});

test('cli: init --type on a file, reviewers, status, wait', async () => {
  const dir = tmpDocs();
  const plan = join(dir, 'plan.md');
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  const init = run('init', plan, '--type', 'plan');
  assert.equal(init.status, 0, init.stderr);
  assert.match(init.stdout, /\(plan, round 1, preparing\)/);
  assert.ok(JSON.parse(run('reviewers', plan).stdout).some((r) => r.persona === 'Sequencer' && r.suggested));
  assert.match(run('status', plan).stdout, /plan\.md \(plan\)/);
  assert.equal(run('status', join(dir, 'spec.md')).status, 1);
  run('publish', plan);
  const timedOut = run('wait', plan, '--timeout', '0');
  assert.equal(timedOut.status, 1);
  assert.match(timedOut.stderr, /timed out/);

  const child = spawn(process.execPath, [CLI, 'wait', plan], { stdio: ['ignore', 'pipe', 'inherit'] });
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d; });
  const done = new Promise((r) => child.on('close', r));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(child.exitCode, null); // still blocking
  m.submit(plan, { aiReview: true, reviewers: [{ persona: 'Sequencer', model: 'haiku' }] });
  assert.equal(await done, 0);
  const p = JSON.parse(stdout);
  assert.equal(p.roundStatus, 'submitted');
  assert.equal(p.request.reviewers[0].model, 'haiku');
  run('next', plan);
  assert.match(run('status', plan).stdout, /AI review by: Sequencer \[haiku\]/);
});

test('article in a folder still works by directory', () => {
  const dir = tmpArticle(ARTICLE);
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  assert.match(run('init', dir).stdout, /\.rewriter \(document, round 1/);
  assert.equal(run('init', dir, '--type', 'article').status, 1);
});

test('AI review is review only: pending items are held, then come back on Submit round', () => {
  const spec = join(tmpDocs(), 'spec.md');
  m.init(spec, { type: 'spec' });
  m.addComments(spec, [{ severity: 'MAJOR', body: 'which store?', quote: 'stores widgets' }, { severity: 'MINOR', body: 'say why' }]);
  m.publish(spec);
  m.setDecision(spec, 'c1', { type: 'approve' });
  m.userReply(spec, 'c2', 'why?');
  const u = m.userComment(spec, { anchor: { kind: 'article' }, body: 'name the store' });
  const r = m.submit(spec, { mode: 'review', reviewers: [{ persona: 'Architect' }], note: 'storage only' });
  assert.deepEqual(r.request, { mode: 'review', aiReview: true, reviewers: [{ persona: 'Architect', model: '' }], note: 'storage only' });
  let p = m.pending(spec); // submitted
  assert.equal(p.request.mode, 'review');
  assert.deepEqual([p.needsAction.length, p.held], [0, 3]);
  m.nextRound(spec);
  p = m.pending(spec); // preparing round 2
  assert.deepEqual([p.needsAction.length, p.held], [0, 3]);
  m.addComments(spec, [{ severity: 'MINOR', body: 'from the architect', reviewers: ['Architect'] }]);
  m.publish(spec);
  m.submit(spec, { mode: 'fix' });
  m.nextRound(spec);
  p = m.pending(spec);
  assert.deepEqual([p.request.mode, p.held, p.carriedOver], ['fix', 0, 1]);
  assert.deepEqual(Object.fromEntries(p.needsAction.map((x) => [x.id, x.why])),
    { c1: ['approved'], c2: ['user-reply'], [u.id]: ['user-comment'] });
  assert.equal(m.load(spec).comments[0].decision.type, 'approve');
});

test('submit mode: bad value rejected, requests saved by 1.0.0 read as review', () => {
  const spec = join(tmpDocs(), 'spec.md');
  m.init(spec, { type: 'spec' });
  m.publish(spec);
  assert.throws(() => m.submit(spec, { mode: 'both' }), /mode must be fix or review/);
  assert.throws(() => m.submit(spec, { mode: 'review' }), /at least one reviewer/);
  assert.equal(m.load(spec).rounds[0].status, 'open');
  assert.equal(m.requestMode({ aiReview: true, reviewers: [] }), 'review');
  assert.equal(m.requestMode({ aiReview: false }), 'fix');
  assert.equal(m.requestMode({ mode: 'fix', aiReview: true }), 'fix');
  assert.equal(m.requestMode(null), 'fix');
  m.userComment(spec, { anchor: { kind: 'article' }, body: 'mine' });
  m.submit(spec, { aiReview: true, reviewers: [{ persona: 'Architect' }] });
  const state = m.load(spec);
  delete state.rounds[0].request.mode; // what 1.0.0 wrote
  m.save(spec, state);
  const p = m.pending(spec);
  assert.deepEqual([p.request.mode, p.request.aiReview, p.held, p.needsAction.length], ['review', true, 1, 0]);
});

test('a held comment can be deleted in a later round, an answered one cannot', () => {
  const spec = join(tmpDocs(), 'spec.md');
  m.init(spec, { type: 'spec' });
  m.addComments(spec, [{ severity: 'MINOR', body: 'reviewer comment' }]);
  m.publish(spec);
  const held = m.userComment(spec, { anchor: { kind: 'article' }, body: 'held' });
  const answered = m.userComment(spec, { anchor: { kind: 'article' }, body: 'answered' });
  m.submit(spec, { mode: 'review', reviewers: [{ persona: 'Architect' }] });
  m.nextRound(spec);
  m.reply(spec, answered.id, { kind: 'reply', body: 'noted' });
  m.publish(spec);
  assert.deepEqual(m.deleteComment(spec, held.id), { deleted: held.id });
  assert.throws(() => m.deleteComment(spec, answered.id), (e) => e.status === 403);
  assert.throws(() => m.deleteComment(spec, 'c1'), (e) => e.status === 403);
});
