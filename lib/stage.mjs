// While a round is with Claude the page shows a stage instead of the document: what is there by now is
// out of date, and nothing on it can be acted on. This module decides whether there is a stage and what
// it says; the page (ui/app.js) draws it. Pure, so that it runs in the browser and under test alike.

// What a round's request asked for; requests from before modes existed only have aiReview.
const modeOf = (request) => request?.mode || (request?.aiReview ? 'review' : 'fix');

const PICKUP = 'if it is waiting; otherwise tell it to continue';

// What Claude, or a reviewer, is shown to be doing. Decoration: nobody reports real progress.
export const FIX_STEPS = ['Reading your comments…', 'Finding the passages…', 'Rewriting…', 'Checking the changes…', 'Answering each comment…'];
export const REVIEW_STEPS = ['reading…', 'checking a claim…', 'taking notes…', 'thinking…', 're-reading a passage…', 'weighing severity…', 'writing a finding…'];

// The stage for a review as the page sees it, or null when the document itself is to be shown: the author
// has the round, the review is approved, or the author is looking at an earlier round (viewRound).
//   scene:     'fix' (Claude acts on the author's comments) or 'review' (the panel reads the document)
//   state:     'waiting' (handed over, not picked up yet) or 'working'
//   round:     the round that appears when Claude is done
//   handed:    the author handed something over; false for the first round, which Claude sets up unasked
//   since:     when the author handed the round over (ISO), or null for the first round
//   reviewers: the panel of an AI review, [{ persona, model }]; each is shown going through REVIEW_STEPS
//   steps:     what Claude is shown to be doing in turn while it acts on comments, else null
export function stageOf(review, viewRound = null) {
  const rounds = review?.rounds || [];
  const last = rounds[rounds.length - 1];
  if (!last || (last.status !== 'submitted' && last.status !== 'preparing')) return null;
  if (viewRound !== null && viewRound !== last.n) return null;
  const waiting = last.status === 'submitted';
  // The round whose request Claude is acting on. The first round has none: Claude is setting the review up.
  const asked = waiting ? last : rounds[rounds.length - 2];
  const request = asked?.request || null;
  const scene = request && modeOf(request) === 'review' ? 'review' : 'fix';
  const round = waiting ? last.n + 1 : last.n;
  const reviewers = scene === 'review'
    ? (request.reviewers || []).map((r) => (typeof r === 'string' ? { persona: r } : r))
      .map((r) => ({ persona: String(r.persona || ''), model: r.model || 'session' }))
    : [];
  const ready = `This page updates by itself when round ${round} is ready.`;
  const base = { scene, state: waiting ? 'waiting' : 'working', round, handed: Boolean(request), since: asked?.submittedAt || null, reviewers, steps: null };

  if (scene === 'review') {
    const many = reviewers.length !== 1;
    if (waiting) {
      return { ...base,
        title: many ? 'The panel is getting ready' : 'The reviewer is getting ready',
        text: `Claude calls ${many ? 'the reviewers' : 'the reviewer'} in ${PICKUP}. ${ready}` };
    }
    return { ...base,
      title: many ? 'Your panel is reviewing the document' : 'Your reviewer is reading the document',
      text: `${many ? `${reviewers.length} reviewers read it side by side and don't see each other's notes. Their findings arrive together` : 'The findings arrive'}`
        + `, as comments in round ${round}. This can take a few minutes: please be patient. This page updates by itself.` };
  }
  if (!request) return { ...base, title: 'Claude is preparing the document', text: ready };
  if (waiting) {
    return { ...base, title: 'Your comments are on their way to Claude', text: `Claude picks them up ${PICKUP}. ${ready}` };
  }
  return { ...base,
    steps: FIX_STEPS,
    title: 'Claude is working on your comments',
    text: `This can take a few minutes, and there is nothing for you to do meanwhile. ${ready}` };
}

// The step shown `t` seconds in. Each slot (a reviewer's place in the panel) has its own pace and starts
// somewhere else, so that a panel doesn't change its words in unison.
export function stepAt(steps, t, slot = 0) {
  const pace = 4 + (slot % 3);
  return steps[(Math.floor(Math.max(0, t) / pace) + slot * 2) % steps.length];
}

// Two letters for a reviewer's avatar: the first letters of its first two words, or of its only word.
export function initials(name) {
  const words = String(name || '').split(/[\s\-_/.,]+/).filter(Boolean).map((w) => Array.from(w));
  if (!words.length) return '?';
  const letters = words.length > 1 ? [words[0][0], words[1][0]] : words[0].slice(0, 2);
  return letters.join('').toUpperCase();
}

// A colour of its own for a reviewer: the same name gives the same hue (0..359) every time.
export function hue(name) {
  let n = 0;
  for (const ch of String(name || '')) n = (n * 31 + ch.codePointAt(0)) >>> 0;
  return n % 360;
}

// The hues of a whole panel, in its order. Names can land on nearly the same colour; a reviewer whose hue is
// too close to one before it moves on round the circle until it is free (or, in a crowd, gives up trying).
export function hues(names) {
  const apart = (a, b) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
  const out = [];
  for (const name of names) {
    let x = hue(name);
    for (let tries = 0; tries < 24 && out.some((y) => apart(x, y) < 28); tries++) x = (x + 47) % 360;
    out.push(x);
  }
  return out;
}

// How long ago, as m:ss (h:mm:ss from an hour on).
export function elapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000)) || 0;
  const two = (n) => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${two(m)}:${two(s % 60)}` : `${m}:${two(s % 60)}`;
}
