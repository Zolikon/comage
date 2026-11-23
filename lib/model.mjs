// ReWriter review state: one review per document.
//   <dir>/index.md  -> <dir>/.rewriter/review.json           (+ rounds/<n>.md snapshots)
//   <dir>/spec.md   -> <dir>/.rewriter/spec.md/review.json   (so several documents can share a folder)
// Every operation loads, mutates and atomically saves, so the CLI and server can share the file.
// The first argument of every operation is a target: a document path, a directory (meaning its
// index.md, or whatever a review started there with --article points at), or a resolved target().
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { expandReviewers, normalizeReviewer } from './reviewers.mjs';
import { renderMarkdown } from './render.mjs';
import { findQuote, makeTextAnchor, plainFromHtml, quoteMatches, stripInlineMd } from './text.mjs';

export const SEVERITIES = ['NITPICK', 'MINOR', 'MAJOR', 'BLOCKER'];
const DECISIONS = ['approve', 'decline', 'ignore', 'clear'];
const REPLY_KINDS = ['fixed', 'accepted', 'challenge', 'reply'];

export class RwError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const now = () => new Date().toISOString();

export function target(p) {
  if (p && typeof p === 'object') return p;
  let isFile;
  try { isFile = statSync(p).isFile(); } catch { isFile = /\.(md|markdown|mdx|txt)$/i.test(p); }
  if (!isFile) return { dir: p, file: null, stateDir: join(p, '.rewriter'), label: p };
  const dir = dirname(p);
  const file = basename(p);
  return { dir, file, stateDir: file === 'index.md' ? join(dir, '.rewriter') : join(dir, '.rewriter', file), label: p };
}

const rwDir = (dir) => target(dir).stateDir;
const statePath = (dir) => join(rwDir(dir), 'review.json');
export const snapshotPath = (dir, n) => join(rwDir(dir), 'rounds', `${n}.md`);

export function load(dir) {
  const p = statePath(dir);
  if (!existsSync(p)) throw new RwError(`no ReWriter review for ${target(dir).label} (run: init)`, 404);
  return JSON.parse(readFileSync(p, 'utf8'));
}

export function save(dir, state) {
  const p = statePath(dir);
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, p);
  return state;
}

function update(dir, fn) {
  const state = load(dir);
  const result = fn(state);
  save(dir, state);
  return result;
}

export function articlePath(dir, state = load(dir)) { const t = target(dir); return join(t.dir, t.file || state.article); }

export function readArticle(dir, round) {
  const state = load(dir);
  const p = round ? snapshotPath(dir, round) : articlePath(dir, state);
  if (!existsSync(p)) throw new RwError(round ? `no snapshot for round ${round}` : `document not found: ${p}`, 404);
  return readFileSync(p, 'utf8');
}

export function articlePlain(dir, round) {
  return plainFromHtml(renderMarkdown(readArticle(dir, round)).html);
}

// opts: a file name (legacy) or { article, type }. `type` is free-form: article, spec, plan, ...
export function init(dir, opts = {}) {
  const o = typeof opts === 'string' ? { article: opts } : opts;
  const t = target(dir);
  const article = t.file || o.article || 'index.md';
  if (!existsSync(join(t.dir, article))) throw new RwError(`document not found: ${join(t.dir, article)}`, 404);
  if (existsSync(statePath(dir))) throw new RwError(`already initialized: ${statePath(dir)}`, 409);
  const docType = String(o.type || 'document').toLowerCase();
  if (!/^[a-z][a-z0-9-]*$/.test(docType)) throw new RwError(`type must be a simple word, e.g. spec (got "${o.type}")`);
  mkdirSync(join(rwDir(dir), 'rounds'), { recursive: true });
  return save(dir, {
    version: 1,
    article,
    docType,
    rounds: [{ n: 1, status: 'preparing', publishedAt: null, submittedAt: null }],
    comments: [],
  });
}

const latest = (state) => state.rounds[state.rounds.length - 1];
export const docType = (state) => state.docType || 'article'; // reviews from before types existed were articles

function requireRound(state, status, who) {
  const r = latest(state);
  if (r.status !== status) {
    throw new RwError(`${who} needs round ${r.n} to be '${status}', but it is '${r.status}'`, 409);
  }
  return r;
}

function getComment(state, id) {
  const c = state.comments.find((x) => x.id === id);
  if (!c) throw new RwError(`no comment ${id}`, 404);
  return c;
}

function nextId(state) {
  const max = state.comments.reduce((acc, c) => Math.max(acc, Number(c.id.slice(1)) || 0), 0);
  return `c${max + 1}`;
}

// Resolve a quote (possibly copied from markdown source) to a stored text anchor.
// Tries the text verbatim, then with inline markdown stripped. A quote that occurs more than
// once with no prefix/suffix telling the copies apart is an error, not a silent first match.
function resolveTextAnchor(plain, { quote, prefix, suffix }) {
  const tries = [
    { quote, prefix: stripInlineMd(prefix || ''), suffix: stripInlineMd(suffix || '') },
    { quote: stripInlineMd(quote), prefix: stripInlineMd(prefix || ''), suffix: stripInlineMd(suffix || '') },
  ];
  for (const a of tries) {
    const hits = quoteMatches(plain, a);
    if (!hits.length) continue;
    if (hits.length > 1 && hits[0].score === hits[1].score) {
      throw new RwError(`quote occurs ${hits.length} times in the document: "${quote}". Add "prefix" (the words just before it) or "suffix" to pick one`, 400);
    }
    return makeTextAnchor(plain, hits[0].start, hits[0].end);
  }
  throw new RwError(`quote not found in document: "${quote}"`, 400);
}

function validateAnchor(anchor) {
  if (!anchor || typeof anchor !== 'object') throw new RwError('anchor required');
  if (anchor.kind === 'article') return { kind: 'article' };
  if (anchor.kind === 'text') {
    if (!anchor.quote || typeof anchor.quote !== 'string') throw new RwError('text anchor needs a quote');
    return { kind: 'text', quote: anchor.quote, prefix: anchor.prefix || '', suffix: anchor.suffix || '' };
  }
  if (anchor.kind === 'element') {
    if (!/^[a-z][a-z0-9]*$/i.test(String(anchor.tag || ''))) throw new RwError('element anchor needs a plain tag name, e.g. "img"');
    return { kind: 'element', tag: String(anchor.tag).toLowerCase(), key: String(anchor.key || ''), quote: String(anchor.quote || '') };
  }
  throw new RwError(`unknown anchor kind: ${anchor.kind}`);
}

const archiveDecision = (c) => {
  if (!c.decision) return;
  c.thread.push({ author: 'user', kind: 'decision', type: c.decision.type, note: c.decision.note || '', round: c.decision.round, at: c.decision.at });
  c.decision = null;
};

// ---- Claude side (round must be 'preparing') ----

export function addComments(dir, items) {
  if (!Array.isArray(items) || !items.length) throw new RwError('no comments given');
  return update(dir, (state) => {
    const round = requireRound(state, 'preparing', 'adding comments');
    let plain = null;
    const created = [];
    for (const it of items) {
      const severity = String(it.severity || '').toUpperCase();
      if (!SEVERITIES.includes(severity)) throw new RwError(`severity must be one of ${SEVERITIES.join(', ')} (got "${it.severity}")`);
      if (!it.body || typeof it.body !== 'string') throw new RwError('comment body required');
      let anchor;
      if (it.anchor) anchor = validateAnchor(it.anchor);
      else if (it.quote) {
        plain ??= articlePlain(dir);
        anchor = resolveTextAnchor(plain, it);
      } else anchor = { kind: 'article' };
      if (anchor.kind === 'text' && it.anchor) {
        plain ??= articlePlain(dir);
        anchor = resolveTextAnchor(plain, anchor);
      }
      const c = {
        id: '',
        author: 'ai',
        reviewers: [...new Set((it.reviewers || []).map(String).filter(Boolean))],
        severity,
        body: it.body,
        suggestion: it.suggestion ? String(it.suggestion) : null,
        anchor,
        round: round.n,
        status: 'open',
        decision: null,
        thread: [],
        createdAt: now(),
      };
      created.push(c);
    }
    for (const c of created) { c.id = nextId(state); state.comments.push(c); }
    return created;
  });
}

// Apply a batch of replies atomically: any invalid item aborts the whole batch.
export function replies(dir, items) {
  if (!Array.isArray(items) || !items.length) throw new RwError('no replies given');
  return update(dir, (state) => {
    const round = requireRound(state, 'preparing', 'replying');
    let plain = null;
    return items.map(({ id, kind, body, quote, prefix, suffix } = {}) => {
      if (!id) throw new RwError('reply needs a comment id');
      if (!REPLY_KINDS.includes(kind)) throw new RwError(`reply kind must be one of ${REPLY_KINDS.join(', ')} (got "${kind}")`);
      if (!body || typeof body !== 'string') throw new RwError(`reply body required (${id})`);
      const c = getComment(state, id);
      if (c.status === 'resolved') throw new RwError(`${id} is resolved`, 409);
      if (quote) {
        plain ??= articlePlain(dir);
        c.anchor = resolveTextAnchor(plain, { quote, prefix, suffix });
      }
      if (kind !== 'reply') archiveDecision(c);
      c.thread.push({ author: 'ai', kind, body, round: round.n, at: now() });
      if (kind === 'fixed' || kind === 'accepted') c.status = 'addressed';
      if (kind === 'challenge') c.status = 'open';
      return c;
    });
  });
}

export function reply(dir, id, fields = {}) {
  return replies(dir, [{ ...fields, id }])[0];
}

function lastSubmitted(state) {
  return [...state.rounds].reverse().find((r) => r.status === 'submitted') || null;
}

export function pending(dir) {
  const state = load(dir);
  const r = latest(state);
  const submitted = lastSubmitted(state);
  let plain = null;
  try { plain = articlePlain(dir); } catch { /* article missing: anchors unknown */ }
  const needsAction = [];
  let carriedOver = 0;
  for (const c of state.comments) {
    if (c.status === 'resolved') continue;
    const why = [];
    if (c.decision?.type === 'approve') why.push('approved');
    if (c.decision?.type === 'decline') why.push('declined');
    const last = c.thread[c.thread.length - 1];
    if (last?.author === 'user' && last.kind === 'reply') why.push('user-reply');
    else if (c.author === 'user' && !c.thread.some((t) => t.author === 'ai')) why.push('user-comment');
    if (!why.length) { carriedOver++; continue; }
    const anchored = c.anchor.kind !== 'text' || plain === null ? null : Boolean(findQuote(plain, c.anchor));
    needsAction.push({ id: c.id, why, anchored, comment: c });
  }
  // What the author asked for when submitting: only meaningful until the round after it is published.
  const asked = r.status === 'submitted' ? r : (r.status === 'preparing' ? state.rounds[state.rounds.length - 2] : null);
  const req = asked?.request || null;
  return {
    round: r.n,
    roundStatus: r.status,
    lastSubmittedRound: submitted ? submitted.n : null,
    docType: docType(state),
    request: req ? { ...req, reviewers: expandReviewers(state, req.reviewers) } : null,
    needsAction,
    carriedOver,
  };
}

export function nextRound(dir) {
  return update(dir, (state) => {
    const r = requireRound(state, 'submitted', 'starting a new round');
    const nr = { n: r.n + 1, status: 'preparing', publishedAt: null, submittedAt: null };
    state.rounds.push(nr);
    return nr;
  });
}

export function publish(dir) {
  return update(dir, (state) => {
    const r = requireRound(state, 'preparing', 'publishing');
    mkdirSync(join(rwDir(dir), 'rounds'), { recursive: true });
    writeFileSync(snapshotPath(dir, r.n), readFileSync(articlePath(dir, state), 'utf8'));
    r.status = 'open';
    r.publishedAt = now();
    return r;
  });
}

// ---- Author side (round must be 'open') ----

export function setDecision(dir, id, { type, note } = {}) {
  if (!DECISIONS.includes(type)) throw new RwError(`decision must be one of ${DECISIONS.join(', ')}`);
  return update(dir, (state) => {
    const round = requireRound(state, 'open', 'deciding');
    const c = getComment(state, id);
    if (c.author !== 'ai') throw new RwError('decisions apply to reviewer comments only');
    if (c.status !== 'open') throw new RwError(`${id} is ${c.status}; reopen it first`, 409);
    if (type === 'clear') { c.decision = null; return c; }
    c.decision = { type, note: note ? String(note) : '', round: round.n, at: now() };
    if (type === 'ignore') c.status = 'resolved'; // decision kept so the UI can show "ignored"
    return c;
  });
}

export function userComment(dir, { anchor, body } = {}) {
  if (!body || typeof body !== 'string' || !body.trim()) throw new RwError('comment body required');
  return update(dir, (state) => {
    const round = requireRound(state, 'open', 'commenting');
    const c = {
      id: nextId(state),
      author: 'user',
      reviewers: [],
      severity: null,
      body: body.trim(),
      suggestion: null,
      anchor: validateAnchor(anchor),
      round: round.n,
      status: 'open',
      decision: null,
      thread: [],
      createdAt: now(),
    };
    state.comments.push(c);
    return c;
  });
}

export function userReply(dir, id, body) {
  if (!body || typeof body !== 'string' || !body.trim()) throw new RwError('reply body required');
  return update(dir, (state) => {
    const round = requireRound(state, 'open', 'replying');
    const c = getComment(state, id);
    c.thread.push({ author: 'user', kind: 'reply', body: body.trim(), round: round.n, at: now() });
    if (c.status !== 'open') {
      c.status = 'open';
    }
    return c;
  });
}

export function resolve(dir, id) {
  return update(dir, (state) => {
    const round = requireRound(state, 'open', 'resolving');
    const c = getComment(state, id);
    c.status = 'resolved';
    c.thread.push({ author: 'user', kind: 'resolved', body: '', round: round.n, at: now() });
    return c;
  });
}

export function reopen(dir, id) {
  return update(dir, (state) => {
    const round = requireRound(state, 'open', 'reopening');
    const c = getComment(state, id);
    if (c.status === 'open') return c;
    c.status = 'open';
    if (c.decision?.type === 'ignore') c.decision = null;
    c.thread.push({ author: 'user', kind: 'reopened', body: '', round: round.n, at: now() });
    return c;
  });
}

export function deleteComment(dir, id) {
  return update(dir, (state) => {
    const round = requireRound(state, 'open', 'deleting');
    const c = getComment(state, id);
    if (c.author !== 'user' || c.round !== round.n || c.thread.some((t) => t.author === 'ai')) {
      throw new RwError('only your own comments from the current round can be deleted', 403);
    }
    state.comments = state.comments.filter((x) => x.id !== id);
    return { deleted: id };
  });
}

// req (all optional): { aiReview, reviewers: [{persona, model?}], custom: [{persona, background, focus?, model?}], note }
// Without aiReview the next round only acts on the author's decisions and comments.
export function submit(dir, req = {}) {
  return update(dir, (state) => {
    const r = requireRound(state, 'open', 'submitting');
    const aiReview = Boolean(req.aiReview);
    const custom = (Array.isArray(req.custom) ? req.custom : []).map((c) => normalizeReviewer(c, true));
    const picked = (Array.isArray(req.reviewers) ? req.reviewers : []).map((c) => normalizeReviewer(c, false));
    const reviewers = [...new Map([...picked, ...custom].map((x) => [x.persona, { persona: x.persona, model: x.model }])).values()];
    if (aiReview && !reviewers.length) throw new RwError('pick at least one reviewer for an AI review');
    if (custom.length) {
      const all = new Map((state.customReviewers || []).map((x) => [x.persona, x]));
      for (const c of custom) all.set(c.persona, c);
      state.customReviewers = [...all.values()];
    }
    if (aiReview) {
      const known = new Set(expandReviewers(state, reviewers).filter((x) => x.background).map((x) => x.persona));
      const missing = reviewers.filter((x) => !known.has(x.persona)).map((x) => x.persona);
      if (missing.length) throw new RwError(`unknown reviewer: ${missing.join(', ')}`);
    }
    r.request = { aiReview, reviewers: aiReview ? reviewers : [], note: req.note ? String(req.note).trim() : '' };
    r.status = 'submitted';
    r.submittedAt = now();
    return r;
  });
}
