import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as m from '../lib/model.mjs';
import { stateDir, tmpArticle, tmpProject } from './helpers.mjs';

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
  assert.ok(existsSync(join(stateDir(dir), 'review.json')));
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
  assert.equal(readFileSync(join(stateDir(dir), 'rounds', '1.md'), 'utf8'), readFileSync(join(dir, 'index.md'), 'utf8'));
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

function toNextRound(dir) { m.submit(dir); m.nextRound(dir); }

test('ignore is for now: the comment stays open and is undecided again in the next round', () => {
  const { dir, created: [c] } = opened();
  m.setDecision(dir, c.id, { type: 'ignore' });
  let s = m.load(dir).comments[0];
  assert.equal(s.status, 'open');
  assert.equal(s.decision.type, 'ignore');
  toNextRound(dir);
  s = m.load(dir).comments[0];
  assert.equal(s.status, 'open');
  assert.equal(s.decision, null);
  assert.deepEqual(s.thread.map((x) => [x.author, x.kind, x.type, x.round]), [['user', 'decision', 'ignore', 1]]);
  const p = m.pending(dir);
  assert.deepEqual([p.needsAction.length, p.carriedOver], [0, 1]); // nothing for Claude to do with it
  m.publish(dir);
  m.setDecision(dir, c.id, { type: 'approve' }); // the author is asked again, and can decide now
  assert.equal(m.load(dir).comments[0].decision.type, 'approve');
});

test('an approval leaves a comment ignored for now as not acted on', () => {
  const { dir, created: [c] } = opened();
  m.setDecision(dir, c.id, { type: 'ignore' });
  m.approve(dir);
  assert.equal(m.pending(dir).notActedOn, 1);
});

test('only an approval carries a note', () => {
  const { dir, created: [a, b] } = opened([{ severity: 'MAJOR', body: 'a' }, { severity: 'MINOR', body: 'b' }]);
  m.setDecision(dir, a.id, { type: 'approve', note: 'but keep the heading' });
  m.setDecision(dir, b.id, { type: 'decline', note: 'because' });
  const [sa, sb] = m.load(dir).comments;
  assert.equal(sa.decision.note, 'but keep the heading');
  assert.equal(sb.decision.note, '');
  assert.equal(m.userReply, undefined); // the author answers with a decision or a new comment, not in the thread
});

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

test('pending lists approve/decline/user comment, counts carried-over', () => {
  const { dir, created } = opened([
    { severity: 'MAJOR', body: 'a', quote: 'The cat ran' },
    { severity: 'MINOR', body: 'b', quote: 'Another paragraph' },
    { severity: 'NITPICK', body: 'c' },
    { severity: 'BLOCKER', body: 'd' },
    { severity: 'MINOR', body: 'e' },
  ]);
  const [a, b, c] = created;
  m.setDecision(dir, a.id, { type: 'approve' });
  m.setDecision(dir, b.id, { type: 'decline', note: 'no' });
  m.setDecision(dir, c.id, { type: 'ignore' });
  const u = m.userComment(dir, { anchor: { kind: 'text', quote: 'Second section', prefix: '', suffix: '' }, body: 'rename' });
  toNextRound(dir);
  const p = m.pending(dir);
  assert.equal(p.round, 2);
  const why = Object.fromEntries(p.needsAction.map((x) => [x.id, x.why]));
  assert.deepEqual(why, { [a.id]: ['approved'], [b.id]: ['declined'], [u.id]: ['user-comment'] });
  assert.equal(p.carriedOver, 3); // ignored for now, and the two nobody decided on
  assert.equal(p.needsAction.find((x) => x.id === a.id).anchored, true);
});

test('resolve and reopen an addressed comment', () => {
  const { dir, created: [c] } = opened();
  m.setDecision(dir, c.id, { type: 'approve' });
  toNextRound(dir);
  m.reply(dir, c.id, { kind: 'fixed', body: 'done' });
  m.publish(dir);
  assert.equal(m.load(dir).comments[0].status, 'addressed');
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
  const lock = join(stateDir(dir), 'review.lock');
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

test('an approved review refuses everything, and says it is closed', () => {
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
  assert.throws(() => m.nextRound(dir, { session: 's1' }), /The review is approved and closed\./);
  assert.doesNotThrow(() => m.reopen, 'reopening a comment is still a thing');
  assert.equal(m.reopenReview, undefined, 'reopening a review is not: an approved review is deleted');
  assert.equal(m.load(dir).comments[0].status, 'open', 'approving resolves nothing');
});

// ---- an approved review is over, so its state goes: nothing of ReWriter stays in a project with no review ----

function reviewedIn(root, rel) {
  const doc = join(root, rel);
  mkdirSync(dirname(doc), { recursive: true });
  writeFileSync(doc, '# Doc\n\nSome text.\n');
  m.init(doc);
  m.publish(doc);
  return doc;
}

test('removeReview removes the review, its empty parents and the .rewriter folder it emptied', () => {
  const root = tmpProject();
  const doc = reviewedIn(root, join('docs', 'a', 'spec.md'));
  assert.equal(m.removeReview(doc), true);
  assert.equal(existsSync(join(root, '.rewriter')), false);
  assert.equal(existsSync(doc), true, 'the document is not ReWriter\'s to remove');
  assert.equal(m.removeReview(doc), false, 'nothing left to remove');
});

test('removeReview leaves another review under the same root, and its folders, alone', () => {
  const root = tmpProject();
  const gone = reviewedIn(root, join('docs', 'a', 'spec.md'));
  const stays = reviewedIn(root, join('docs', 'plan.md'));
  m.removeReview(gone);
  assert.equal(existsSync(stateDir(gone)), false);
  assert.equal(existsSync(join(root, '.rewriter', 'reviews', 'docs', 'a')), false, 'the emptied folder above it goes too');
  assert.equal(m.load(stays).rounds.length, 1);
  assert.equal(existsSync(join(root, '.rewriter', '.gitignore')), true);
});

test('removeReview keeps a .rewriter folder that holds anything else', () => {
  const root = tmpProject();
  const doc = reviewedIn(root, 'spec.md');
  mkdirSync(join(root, '.rewriter', 'old.md'));
  writeFileSync(join(root, '.rewriter', 'old.md', 'review.json'), '{}'); // another document's review, old layout
  m.removeReview(doc);
  assert.equal(existsSync(join(root, '.rewriter', 'old.md', 'review.json')), true);
  assert.equal(existsSync(join(root, '.rewriter', 'reviews')), false);
});

test('removeReview keeps a .gitignore that is not the one ReWriter wrote', () => {
  const root = tmpProject();
  const doc = reviewedIn(root, 'spec.md');
  writeFileSync(join(root, '.rewriter', '.gitignore'), 'rounds/\n');
  m.removeReview(doc);
  assert.equal(readFileSync(join(root, '.rewriter', '.gitignore'), 'utf8'), 'rounds/\n');
});

test('removeReview refuses a state folder outside <root>/.rewriter/reviews', () => {
  const root = tmpProject();
  const doc = reviewedIn(root, 'spec.md');
  const elsewhere = join(root, 'precious');
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, 'review.json'), '{}');
  assert.throws(() => m.removeReview({ ...m.target(doc), stateDir: elsewhere }), /not a review folder/);
  assert.equal(existsSync(join(elsewhere, 'review.json')), true);
});

test('locate sweeps an approval older than a minute and keeps a fresh one', () => {
  const root = tmpProject();
  const doc = reviewedIn(root, 'spec.md');
  m.approve(doc);
  m.locate(doc, { log: () => {} });
  assert.equal(m.load(doc).rounds[0].status, 'approved', 'a fresh approval is still there for whoever is waiting');
  const file = join(stateDir(doc), 'review.json');
  const state = JSON.parse(readFileSync(file, 'utf8'));
  state.rounds[0].approvedAt = new Date(Date.now() - 61000).toISOString();
  writeFileSync(file, JSON.stringify(state));
  m.locate(doc, { log: () => {} });
  assert.throws(() => m.load(doc), (e) => e.status === 404);
  assert.equal(existsSync(join(root, '.rewriter')), false);
});

test('init over an approved review starts a new one', () => {
  const { dir } = opened();
  m.approve(dir);
  const state = m.init(dir, { type: 'plan' });
  assert.deepEqual([state.rounds.length, state.rounds[0].status, state.comments.length, state.docType], [1, 'preparing', 0, 'plan']);
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

test('claim on an approved review says the review is closed', () => {
  const dir = tmpOpen();
  m.approve(dir);
  assert.throws(() => m.claim(dir, { session: 's1' }), /The review is approved and closed\./);
});

// The removal comes a second after the approval. Whatever happened in that second must survive it.
test('removeApproved removes the approval it was asked about, and nothing that took its place', () => {
  const { dir } = opened();
  const at = m.approve(dir).approvedAt;
  m.init(dir); // the document is reviewed again before the old review was cleaned up
  m.addComments(dir, [{ severity: 'MINOR', body: 'new review, new comment' }]);
  assert.equal(m.removeApproved(dir, at), false);
  assert.equal(m.load(dir).comments.length, 1);

  const other = tmpOpen();
  assert.equal(m.removeApproved(other, 'some other time'), false, 'open review: not approved, not removed');
  const at2 = m.approve(other).approvedAt;
  assert.equal(m.removeApproved(other, at2), true);
  assert.throws(() => m.load(other), (e) => e.status === 404);
});

test('a document whose name starts with two dots can be approved and removed', () => {
  const root = tmpProject();
  const doc = reviewedIn(root, '..draft.md');
  m.approve(doc);
  assert.equal(m.removeReview(doc), true);
  assert.equal(existsSync(join(root, '.rewriter')), false);
});

test('init over an approved review works when that review was what made the folder a root', () => {
  const top = tmpProject();
  rmSync(join(top, '.git'), { recursive: true }); // no git: the root is whatever folder holds reviews
  mkdirSync(join(top, 'sub'));
  writeFileSync(join(top, 'first.md'), '# First\n');
  m.init(join(top, 'first.md')); // makes <top> a root
  const doc = join(top, 'sub', 'doc.md');
  writeFileSync(doc, '# Doc\n');
  m.init(doc);
  m.publish(doc);
  m.removeReview(join(top, 'first.md')); // …and now only this document's review keeps it one
  m.approve(doc);
  const state = m.init(doc);
  assert.equal(state.rounds[0].status, 'preparing');
  assert.equal(m.load(doc).rounds.length, 1);
});
