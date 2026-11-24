import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as m from '../lib/model.mjs';
import { tmpArticle } from './helpers.mjs';

function opened(items = [{ severity: 'MAJOR', body: 'b1', quote: 'The cat ran' }]) {
  const dir = tmpArticle();
  m.init(dir);
  const created = m.addComments(dir, items);
  m.publish(dir);
  return { dir, created };
}

test('init creates round 1 preparing', () => {
  const dir = tmpArticle();
  const s = m.init(dir);
  assert.deepEqual(s.rounds.map((r) => [r.n, r.status]), [[1, 'preparing']]);
  assert.ok(existsSync(join(dir, '.rewriter', 'review.json')));
  assert.throws(() => m.init(dir), (e) => e.status === 409);
});

test('load on uninitialized dir fails with 404', () => {
  assert.throws(() => m.load(tmpArticle()), (e) => e instanceof m.RwError && e.status === 404);
});

test('addComments strips inline markdown', () => {
  const dir = tmpArticle();
  m.init(dir);
  const [c] = m.addComments(dir, [{ severity: 'minor', body: 'x', quote: '**bold** text', reviewers: ['Writer', 'Writer', 'Junior'] }]);
  assert.equal(c.anchor.kind, 'text');
  assert.equal(c.anchor.quote, 'bold text');
  assert.equal(c.severity, 'MINOR');
  assert.deepEqual(c.reviewers, ['Writer', 'Junior']);
  assert.equal(c.id, 'c1');
  const [l] = m.addComments(dir, [{ severity: 'NITPICK', body: 'y', quote: 'a [link](https://example.com)' }]);
  assert.equal(l.anchor.quote, 'a link');
  assert.equal(l.id, 'c2');
});

test('addComments disambiguates repeated text with prefix', () => {
  const dir = tmpArticle();
  m.init(dir);
  const [c] = m.addComments(dir, [{ severity: 'MINOR', body: 'x', quote: 'The cat', prefix: 'sat. ' }]);
  assert.match(c.anchor.prefix, /sat\. $/);
});

test('addComments rejects unknown quote and bad severity, atomically', () => {
  const dir = tmpArticle();
  m.init(dir);
  assert.throws(() => m.addComments(dir, [
    { severity: 'MAJOR', body: 'ok', quote: 'The cat ran' },
    { severity: 'MAJOR', body: 'bad', quote: 'not in article' },
  ]), (e) => e.status === 400 && /quote not found/.test(e.message));
  assert.throws(() => m.addComments(dir, [{ severity: 'HUGE', body: 'x' }]), (e) => e.status === 400);
  assert.equal(m.load(dir).comments.length, 0);
});

test('addComments without quote anchors to article; element anchor passes through', () => {
  const dir = tmpArticle();
  m.init(dir);
  const [a, b] = m.addComments(dir, [
    { severity: 'BLOCKER', body: 'premise' },
    { severity: 'MINOR', body: 'img', anchor: { kind: 'element', tag: 'img', key: 'a.png' } },
  ]);
  assert.deepEqual(a.anchor, { kind: 'article' });
  assert.equal(b.anchor.kind, 'element');
});

test('publish snapshots and opens', () => {
  const { dir } = opened();
  const s = m.load(dir);
  assert.equal(s.rounds[0].status, 'open');
  assert.equal(readFileSync(join(dir, '.rewriter', 'rounds', '1.md'), 'utf8'), readFileSync(join(dir, 'index.md'), 'utf8'));
  assert.throws(() => m.publish(dir), (e) => e.status === 409);
  assert.throws(() => m.addComments(dir, [{ severity: 'MAJOR', body: 'x' }]), (e) => e.status === 409);
});

test('decision rejected unless round open', () => {
  const dir = tmpArticle();
  m.init(dir);
  const [c] = m.addComments(dir, [{ severity: 'MAJOR', body: 'b' }]);
  assert.throws(() => m.setDecision(dir, c.id, { type: 'approve' }), (e) => e.status === 409);
  m.publish(dir);
  m.setDecision(dir, c.id, { type: 'approve', note: 'yes' });
  m.submit(dir);
  assert.throws(() => m.setDecision(dir, c.id, { type: 'decline' }), (e) => e.status === 409);
  assert.throws(() => m.userComment(dir, { anchor: { kind: 'article' }, body: 'x' }), (e) => e.status === 409);
});

test('decision can be changed and cleared before submit', () => {
  const { dir, created: [c] } = opened();
  m.setDecision(dir, c.id, { type: 'approve' });
  m.setDecision(dir, c.id, { type: 'decline', note: 'nah' });
  assert.deepEqual(m.load(dir).comments[0].decision.type, 'decline');
  m.setDecision(dir, c.id, { type: 'clear' });
  assert.equal(m.load(dir).comments[0].decision, null);
  assert.throws(() => m.setDecision(dir, c.id, { type: 'maybe' }), (e) => e.status === 400);
});

test('ignore resolves', () => {
  const { dir, created: [c] } = opened();
  m.setDecision(dir, c.id, { type: 'ignore' });
  const s = m.load(dir).comments[0];
  assert.equal(s.status, 'resolved');
  assert.equal(s.decision.type, 'ignore');
});

function toNextRound(dir) { m.submit(dir); m.nextRound(dir); }

test('challenge clears decision and reopens', () => {
  const { dir, created: [c] } = opened();
  m.setDecision(dir, c.id, { type: 'decline', note: 'wrong' });
  toNextRound(dir);
  m.reply(dir, c.id, { kind: 'challenge', body: 'here is why' });
  const s = m.load(dir).comments[0];
  assert.equal(s.status, 'open');
  assert.equal(s.decision, null);
  assert.deepEqual(s.thread.map((t) => [t.author, t.kind]), [['user', 'decision'], ['ai', 'challenge']]);
  assert.equal(s.thread[0].type, 'decline');
  assert.equal(s.thread[0].note, 'wrong');
  assert.equal(s.thread[1].round, 2);
});

test('fixed sets addressed, archives decision, can re-anchor', () => {
  const { dir, created: [c] } = opened();
  m.setDecision(dir, c.id, { type: 'approve' });
  toNextRound(dir);
  writeFileSync(join(dir, 'index.md'), readFileSync(join(dir, 'index.md'), 'utf8').replace('The cat ran.', 'The cat sprinted away.'));
  m.reply(dir, c.id, { kind: 'fixed', body: 'done', quote: 'The cat sprinted away.' });
  const s = m.load(dir).comments[0];
  assert.equal(s.status, 'addressed');
  assert.equal(s.decision, null);
  assert.equal(s.anchor.quote, 'The cat sprinted away.');
  assert.throws(() => m.reply(dir, c.id, { kind: 'resolved', body: 'x' }), (e) => e.status === 400);
});

test('claude cannot reply outside preparing round; never resolves', () => {
  const { dir, created: [c] } = opened();
  assert.throws(() => m.reply(dir, c.id, { kind: 'reply', body: 'x' }), (e) => e.status === 409);
});

test('pending lists approve/decline/user comment/user reply, counts carried-over', () => {
  const { dir, created } = opened([
    { severity: 'MAJOR', body: 'a', quote: 'The cat ran' },
    { severity: 'MINOR', body: 'b', quote: 'Another paragraph' },
    { severity: 'NITPICK', body: 'c' },
    { severity: 'BLOCKER', body: 'd' },
    { severity: 'MINOR', body: 'e' },
  ]);
  const [a, b, c, d] = created;
  m.setDecision(dir, a.id, { type: 'approve' });
  m.setDecision(dir, b.id, { type: 'decline', note: 'no' });
  m.setDecision(dir, c.id, { type: 'ignore' });
  m.userReply(dir, d.id, 'why?');
  const u = m.userComment(dir, { anchor: { kind: 'text', quote: 'Second section', prefix: '', suffix: '' }, body: 'rename' });
  toNextRound(dir);
  const p = m.pending(dir);
  assert.equal(p.round, 2);
  const why = Object.fromEntries(p.needsAction.map((x) => [x.id, x.why]));
  assert.deepEqual(why, { [a.id]: ['approved'], [b.id]: ['declined'], [d.id]: ['user-reply'], [u.id]: ['user-comment'] });
  assert.equal(p.carriedOver, 1);
  assert.equal(p.needsAction.find((x) => x.id === a.id).anchored, true);
});

test('user reply on addressed comment reopens it; resolve/reopen', () => {
  const { dir, created: [c] } = opened();
  m.setDecision(dir, c.id, { type: 'approve' });
  toNextRound(dir);
  m.reply(dir, c.id, { kind: 'fixed', body: 'done' });
  m.publish(dir);
  m.userReply(dir, c.id, 'not quite');
  assert.equal(m.load(dir).comments[0].status, 'open');
  m.resolve(dir, c.id);
  assert.equal(m.load(dir).comments[0].status, 'resolved');
  m.reopen(dir, c.id);
  assert.equal(m.load(dir).comments[0].status, 'open');
});

test('user can delete own comment, not a reviewer comment', () => {
  const { dir, created: [c] } = opened();
  const u = m.userComment(dir, { anchor: { kind: 'article' }, body: 'mine' });
  assert.equal(u.author, 'user');
  assert.throws(() => m.deleteComment(dir, c.id), (e) => e.status === 403);
  m.deleteComment(dir, u.id);
  assert.equal(m.load(dir).comments.length, 1);
});

test('nextRound requires submitted', () => {
  const { dir } = opened();
  assert.throws(() => m.nextRound(dir), (e) => e.status === 409);
  m.submit(dir);
  m.nextRound(dir);
  assert.deepEqual(m.load(dir).rounds.map((r) => r.status), ['submitted', 'preparing']);
});

test('articlePlain reads snapshots by round', () => {
  const { dir } = opened();
  writeFileSync(join(dir, 'index.md'), '# New\n\nchanged');
  assert.equal(m.articlePlain(dir), 'New changed');
  assert.match(m.articlePlain(dir, 1), /The cat sat/);
});

test('addComments: ambiguous quote without context fails; markdown in prefix is stripped', () => {
  const dir = tmpArticle('The model said yes. Later the **model** said no.\n');
  m.init(dir);
  assert.throws(() => m.addComments(dir, [{ severity: 'MINOR', body: 'x', quote: 'model said' }]), (e) => e.status === 400 && /occurs 2 times/.test(e.message));
  const [c] = m.addComments(dir, [{ severity: 'MINOR', body: 'x', quote: '**model** said', prefix: 'yes. Later the' }]);
  assert.match(c.anchor.prefix, /Later the $/);
});

test('element anchor tag is validated', () => {
  const dir = tmpArticle();
  m.init(dir);
  assert.throws(() => m.addComments(dir, [{ severity: 'MINOR', body: 'x', anchor: { kind: 'element', tag: '[' } }]), (e) => e.status === 400);
});

test('replies batch is atomic', () => {
  const { dir, created: [c] } = opened();
  m.setDecision(dir, c.id, { type: 'approve' });
  m.submit(dir); m.nextRound(dir);
  assert.throws(() => m.replies(dir, [{ id: c.id, kind: 'fixed', body: 'ok' }, { id: 'c99', kind: 'fixed', body: 'no' }]), (e) => e.status === 404);
  assert.equal(m.load(dir).comments[0].thread.length, 0);
  const res = m.replies(dir, [{ id: c.id, kind: 'fixed', body: 'ok' }]);
  assert.equal(res[0].status, 'addressed');
});

// ---- several Claude sessions on one document ----

function submittedRound() {
  const dir = tmpArticle();
  m.init(dir, { session: 'A' });
  m.publish(dir, { session: 'A' });
  m.submit(dir);
  return dir;
}

test('the session that opens a round holds it: another session cannot add, reply or publish', () => {
  const dir = submittedRound();
  m.nextRound(dir, { session: 'A' });
  for (const act of [
    () => m.addComments(dir, [{ severity: 'MINOR', body: 'x' }], { session: 'B' }),
    () => m.replies(dir, [{ id: 'c1', kind: 'reply', body: 'x' }], { session: 'B' }),
    () => m.publish(dir, { session: 'B' }),
  ]) assert.throws(act, (e) => e.status === 409 && /another Claude session/.test(e.message));
  assert.equal(m.load(dir).comments.length, 0);
  assert.equal(m.addComments(dir, [{ severity: 'MINOR', body: 'x' }], { session: 'A' }).length, 1);
  assert.equal(m.publish(dir, { session: 'A' }).status, 'open');
});

test('a second session running next on a round already picked up is told so', () => {
  const dir = submittedRound();
  m.nextRound(dir, { session: 'A' });
  assert.throws(() => m.nextRound(dir, { session: 'B' }), (e) => e.status === 409 && /picked up by another Claude session/.test(e.message));
  assert.equal(m.load(dir).rounds.length, 2);
});

test('claim hands a round being prepared to the calling session', () => {
  const dir = submittedRound();
  m.nextRound(dir, { session: 'A' });
  assert.throws(() => m.claim(dir, {}), (e) => e.status === 400);
  m.claim(dir, { session: 'B' });
  assert.equal(m.publish(dir, { session: 'B' }).status, 'open');
  assert.throws(() => m.claim(dir, { session: 'A' }), (e) => e.status === 409); // nothing to claim while the author has it
});

test('pending names the other session holding the round, and nobody when it is the caller', () => {
  const dir = submittedRound();
  m.nextRound(dir, { session: 'A' });
  assert.equal(m.pending(dir, { session: 'B' }).otherSession, 'A');
  assert.equal(m.pending(dir, { session: 'A' }).otherSession, null);
  assert.equal(m.pending(dir).otherSession, null);
});

test('callers without a session id, and rounds without one, are not held back', () => {
  const dir = submittedRound();
  m.nextRound(dir, { session: 'A' });
  assert.equal(m.addComments(dir, [{ severity: 'MINOR', body: 'by hand' }]).length, 1);
  m.publish(dir); m.submit(dir);
  m.nextRound(dir);
  assert.equal(m.addComments(dir, [{ severity: 'MINOR', body: 'x' }], { session: 'B' }).length, 1);
});

test('an update waits for the review lock instead of overwriting a concurrent writer', () => {
  const dir = tmpArticle();
  m.init(dir);
  const lock = join(dir, '.rewriter', 'review.lock');
  writeFileSync(lock, String(process.pid)); // a live holder
  assert.throws(() => m.addComments(dir, [{ severity: 'MINOR', body: 'x' }], { lockTimeout: 80 }), (e) => e.status === 503);
  assert.equal(m.load(dir).comments.length, 0);
  rmSync(lock);
  assert.equal(m.addComments(dir, [{ severity: 'MINOR', body: 'x' }]).length, 1);
  assert.equal(existsSync(lock), false);
});

// ---- approve: the author accepts the document as it stands, and the review is closed ----

const refused = (fn) => assert.throws(fn, (e) => e.status === 409, 'expected a 409');

test('approve closes an open round, on round 1 as well', () => {
  const dir = tmpArticle();
  m.init(dir);
  m.publish(dir);
  const r = m.approve(dir, { note: '  ship it  ' });
  assert.equal(r.status, 'approved');
  assert.ok(r.approvedAt);
  assert.deepEqual(r.request, { mode: 'approve', aiReview: false, reviewers: [], note: 'ship it' });
  assert.equal(m.approve(tmpOpen()).request.note, '', 'no note is an empty note');
});

function tmpOpen() {
  const dir = tmpArticle();
  m.init(dir);
  m.publish(dir);
  return dir;
}

test('approve is refused unless the round is open', () => {
  const dir = tmpArticle();
  m.init(dir);
  refused(() => m.approve(dir)); // preparing
  m.publish(dir);
  m.submit(dir, { note: 'fix it' });
  refused(() => m.approve(dir)); // submitted: a second tab got there first
  assert.equal(m.load(dir).rounds[0].status, 'submitted', 'nothing changed');
  const done = tmpOpen();
  m.approve(done);
  refused(() => m.approve(done)); // approved already
});

test('an approved review refuses everything but reopen, and says how to go on', () => {
  const { dir } = opened();
  m.approve(dir);
  refused(() => m.addComments(dir, [{ severity: 'MINOR', body: 'late' }]));
  refused(() => m.replies(dir, [{ id: 'c1', kind: 'reply', body: 'late' }]));
  refused(() => m.nextRound(dir, { session: 's1' }));
  refused(() => m.publish(dir));
  refused(() => m.submit(dir, { note: 'late' }));
  refused(() => m.setDecision(dir, 'c1', { type: 'approve' }));
  refused(() => m.userComment(dir, { anchor: { kind: 'article' }, body: 'late' }));
  refused(() => m.claim(dir, { session: 's1' }));
  assert.throws(() => m.nextRound(dir, { session: 's1' }), /approved and closed\. `reopen` starts a new round/);
  assert.equal(m.load(dir).comments[0].status, 'open', 'approving resolves nothing');
});

test('reopen starts a new round for the caller, only on an approved review', () => {
  const dir = tmpOpen();
  refused(() => m.reopenReview(dir, { session: 's1' }));
  m.approve(dir);
  const r = m.reopenReview(dir, { session: 's1' });
  assert.deepEqual([r.n, r.status, r.session], [2, 'preparing', 's1']);
  assert.equal(m.load(dir).rounds[0].status, 'approved');
  refused(() => m.addComments(dir, [{ severity: 'MINOR', body: 'x' }], { session: 's2' })); // the round is s1's
});

test('a reopened review can be approved again; both approvals stay in the history', () => {
  const dir = tmpOpen();
  m.approve(dir);
  m.reopenReview(dir);
  m.publish(dir);
  m.approve(dir, { note: 'again' });
  assert.deepEqual(m.load(dir).rounds.map((r) => r.status), ['approved', 'approved']);
  assert.equal(m.pending(dir).request.note, 'again');
});

test('pending on an approved review: nothing to act on, and how much was left', () => {
  const { dir } = opened([
    { severity: 'MAJOR', body: 'b1', quote: 'The cat ran' },
    { severity: 'MINOR', body: 'b2', quote: 'The cat sat' },
  ]);
  m.setDecision(dir, 'c1', { type: 'approve' }); // a fix the author asked for; c2 stays undecided
  m.userComment(dir, { anchor: { kind: 'article' }, body: 'mine' });
  m.approve(dir, { note: 'ok' });
  const p = m.pending(dir);
  assert.equal(p.roundStatus, 'approved');
  assert.equal(p.request.mode, 'approve');
  assert.equal(p.request.note, 'ok');
  assert.deepEqual([p.needsAction, p.held, p.carriedOver, p.notActedOn], [[], 0, 0, 3]);
});

test('pending on a review that is not approved has notActedOn 0', () => {
  const { dir } = opened();
  assert.equal(m.pending(dir).notActedOn, 0);
  assert.equal(m.pending(dir).carriedOver, 1);
});

test('notActedOn counts what the author still had open, not what Claude already fixed', () => {
  const { dir } = opened([
    { severity: 'MAJOR', body: 'b1', quote: 'The cat ran' },
    { severity: 'MINOR', body: 'b2', quote: 'The cat sat' },
  ]);
  m.setDecision(dir, 'c1', { type: 'approve' });
  m.submit(dir, {});
  m.nextRound(dir);
  m.replies(dir, [{ id: 'c1', kind: 'fixed', body: 'done' }]); // c1 is addressed; c2 was never decided
  m.publish(dir);
  m.approve(dir);
  assert.equal(m.pending(dir).notActedOn, 1);
});

test('after reopen, what the approval left open waits for the author: nothing is asked of Claude', () => {
  const { dir } = opened();
  m.setDecision(dir, 'c1', { type: 'approve' });
  m.userComment(dir, { anchor: { kind: 'article' }, body: 'mine' });
  m.approve(dir);
  m.reopenReview(dir, { session: 's1' });
  const p = m.pending(dir, { session: 's1' });
  assert.deepEqual([p.roundStatus, p.request.mode, p.needsAction, p.held], ['preparing', 'approve', [], 2]);
});

test('claim on an approved review says the review is closed', () => {
  const dir = tmpOpen();
  m.approve(dir);
  assert.throws(() => m.claim(dir, { session: 's1' }), /approved and closed\. `reopen` starts a new round/);
});
