// What the page shows instead of the document while a round is with Claude (lib/stage.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stageOf, initials, hue, hues, elapsed, stepAt, FIX_STEPS, REVIEW_STEPS } from '../lib/stage.mjs';

const T = '2026-11-27T10:00:00.000Z';
const round = (n, status, extra = {}) => ({ n, status, publishedAt: status === 'preparing' ? null : T, submittedAt: null, ...extra });
const fixReq = { mode: 'fix', aiReview: false, reviewers: [], note: '' };
const reviewReq = { mode: 'review', aiReview: true, reviewers: [{ persona: 'Architect', model: 'opus' }, { persona: 'DBA', model: '' }], note: '' };
const review = (...rounds) => ({ rounds, comments: [] });

test('no stage while the author has the round, or once the review is approved', () => {
  assert.equal(stageOf(review(round(1, 'open'))), null);
  assert.equal(stageOf(review(round(1, 'approved'))), null);
  assert.equal(stageOf({ rounds: [] }), null);
  assert.equal(stageOf(null), null);
});

test('a submitted fix round waits for Claude to pick it up', () => {
  const s = stageOf(review(round(1, 'submitted', { request: fixReq, submittedAt: T })));
  assert.equal(s.scene, 'fix');
  assert.equal(s.state, 'waiting');
  assert.equal(s.round, 2);
  assert.equal(s.since, T);
  assert.deepEqual(s.reviewers, []);
  assert.equal(s.steps, null); // nobody is working yet
  assert.match(s.text, /tell it to continue/);
  assert.match(s.text, /round 2/);
});

test('a round Claude is preparing after a fix request is the working fix scene', () => {
  const s = stageOf(review(round(1, 'submitted', { request: fixReq, submittedAt: T }), round(2, 'preparing')));
  assert.equal(s.scene, 'fix');
  assert.equal(s.state, 'working');
  assert.equal(s.round, 2);
  assert.equal(s.since, T);
  assert.match(s.title, /Claude is working/);
  assert.equal(s.steps, FIX_STEPS);
  assert.match(s.text, /few minutes/);
  assert.match(s.text, /round 2/);
});

test('an AI review names its panel, with the session model for a reviewer that has none', () => {
  const waiting = stageOf(review(round(2, 'submitted', { request: reviewReq, submittedAt: T })));
  assert.equal(waiting.scene, 'review');
  assert.equal(waiting.state, 'waiting');
  assert.deepEqual(waiting.reviewers, [{ persona: 'Architect', model: 'opus' }, { persona: 'DBA', model: 'session' }]);

  const working = stageOf(review(round(2, 'submitted', { request: reviewReq, submittedAt: T }), round(3, 'preparing')));
  assert.equal(working.scene, 'review');
  assert.equal(working.state, 'working');
  assert.equal(working.round, 3);
  assert.match(working.title, /panel/);
  assert.match(working.text, /2 reviewers/);
  assert.match(working.text, /round 3/);
  assert.match(working.text, /patient/);
  assert.equal(working.text.match(/round 3/g).length, 1); // said once
  assert.equal(working.steps, null); // each reviewer has its own words (REVIEW_STEPS)
});

test('one reviewer is not called a panel', () => {
  const one = { ...reviewReq, reviewers: [{ persona: 'Editor', model: 'session' }] };
  const s = stageOf(review(round(1, 'submitted', { request: one }), round(2, 'preparing')));
  assert.doesNotMatch(s.title, /panel/);
  assert.doesNotMatch(s.text, /1 reviewers/);
});

test('requests from before modes existed: aiReview alone means a review, reviewers may be plain names', () => {
  const old = { aiReview: true, reviewers: ['Architect'] };
  const s = stageOf(review(round(1, 'submitted', { request: old })));
  assert.equal(s.scene, 'review');
  assert.deepEqual(s.reviewers, [{ persona: 'Architect', model: 'session' }]);
});

test('the first round, before anything was asked for, is Claude preparing the document', () => {
  const s = stageOf(review(round(1, 'preparing')));
  assert.equal(s.scene, 'fix');
  assert.equal(s.state, 'working');
  assert.equal(s.round, 1);
  assert.equal(s.since, null);
  assert.match(s.title, /preparing the document/);
  assert.equal(s.steps, null); // there are no comments to be "reading" yet
  assert.equal(s.handed, false);
  assert.equal(stageOf(review(round(1, 'submitted', { request: fixReq }), round(2, 'preparing'))).handed, true);
});

test('looking at an earlier round shows that round, not the stage', () => {
  const r = review(round(1, 'submitted', { request: fixReq }), round(2, 'preparing'));
  assert.equal(stageOf(r, 1), null);
  assert.notEqual(stageOf(r, 2), null); // the current round picked by number is still the current round
  assert.notEqual(stageOf(r, null), null);
});

test('initials: two letters at most, from the first two words', () => {
  assert.equal(initials('Architect'), 'AR');
  assert.equal(initials('Security Reviewer'), 'SR');
  assert.equal(initials('senior database administrator'), 'SD');
  assert.equal(initials('DBA'), 'DB');
  assert.equal(initials('  x '), 'X');
  assert.equal(initials('Scope-Skeptic'), 'SS');
  assert.equal(initials(''), '?');
  assert.equal(initials('Éva Őri'), 'ÉŐ');
});

test('hue: the same name always gets the same colour, inside the circle', () => {
  assert.equal(hue('Architect'), hue('Architect'));
  assert.notEqual(hue('Architect'), hue('DBA'));
  for (const n of ['', 'a', 'Security Reviewer', 'Éva']) {
    assert.ok(Number.isInteger(hue(n)) && hue(n) >= 0 && hue(n) < 360, n);
  }
});

test('hues: reviewers on one panel get colours that can be told apart, the same ones every time', () => {
  const panel = ['Lead AI Engineer', 'AI Skeptic', 'Junior Engineer', 'Writer', 'Architect', 'Senior Database Administrator', 'DBA', 'Security Reviewer'];
  const hs = hues(panel);
  assert.deepEqual(hs, hues(panel));
  assert.equal(hs[0], hue(panel[0])); // the first keeps its own colour
  const apart = (a, b) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
  for (let i = 0; i < hs.length; i++) {
    assert.ok(Number.isInteger(hs[i]) && hs[i] >= 0 && hs[i] < 360);
    for (let j = 0; j < i; j++) assert.ok(apart(hs[i], hs[j]) >= 28, `${panel[i]} (${hs[i]}) vs ${panel[j]} (${hs[j]})`);
  }
  assert.equal(hues(Array.from({ length: 40 }, (_, i) => `R${i}`)).length, 40); // a crowd still gets colours, just closer ones
  assert.deepEqual(hues([]), []);
});

test('elapsed: minutes and seconds, hours when it comes to that, never negative', () => {
  assert.equal(elapsed(0), '0:00');
  assert.equal(elapsed(9_400), '0:09');
  assert.equal(elapsed(134_000), '2:14');
  assert.equal(elapsed(3_600_000 + 62_000), '1:01:02');
  assert.equal(elapsed(-5_000), '0:00'); // a clock that is behind the server's
  assert.equal(elapsed(NaN), '0:00');
});

test('stepAt: walks the steps in order, each slot at its own pace and offset', () => {
  assert.ok(FIX_STEPS.length > 2 && REVIEW_STEPS.length > 2);
  assert.equal(stepAt(FIX_STEPS, 0), FIX_STEPS[0]);
  assert.equal(stepAt(FIX_STEPS, 3), FIX_STEPS[0]);
  assert.equal(stepAt(FIX_STEPS, 4), FIX_STEPS[1]);
  assert.equal(stepAt(FIX_STEPS, 4 * FIX_STEPS.length), FIX_STEPS[0]); // wraps around
  // slots are out of step with each other, so a panel doesn't change its words in unison
  const at = (slot) => Array.from({ length: 12 }, (_, t) => stepAt(REVIEW_STEPS, t, slot)).join('|');
  assert.notEqual(at(0), at(1));
  assert.notEqual(at(1), at(2));
  for (let t = 0; t < 40; t++) assert.ok(REVIEW_STEPS.includes(stepAt(REVIEW_STEPS, t, 5)));
});
