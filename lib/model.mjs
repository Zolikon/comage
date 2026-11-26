// ReWriter review state: one review per document, all reviews of a project in one place.
//   <root>/docs/spec.md       -> <root>/.rewriter/reviews/docs/spec.md/review.json   (+ rounds/<n>.md snapshots)
//   <root>/article/index.md   -> <root>/.rewriter/reviews/article/index.md/review.json
// <root> is the project the document belongs to (see findRoot). target() is the only place that works
// out where a review lives; everything else asks it.
// Every operation loads, mutates and atomically saves under a lock (review.lock), so the CLI, the server
// and several Claude sessions can share the file.
// A round being prepared belongs to the Claude session that opened it (round.session): Claude-side
// operations take { session } and refuse a different one, so two sessions never work the same round.
// The first argument of every operation is a target: a document path, a directory (meaning its
// index.md, or whatever a review started there with --article points at), or a resolved target().
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { alive, withLock } from './lock.mjs';
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

// The project a document belongs to: the nearest folder, from the document's own upwards, that is a git
// checkout (.git is a folder, or a file in a worktree or a submodule) or already holds reviews. With
// neither anywhere above, the document's own folder. A `.rewriter` folder of the old layout (state beside
// each document) has no `reviews` in it, so it is never taken for a root.
//
// A review that already exists decides before any marker does: a document under review keeps the root its
// review was started in, even if a nearer one appears later (`git init` in a subfolder, say). Otherwise
// one document would end up with two reviews, and the author's page and Claude's commands on different ones.
export function findRoot(docDir, file = 'index.md') {
  let nearest = null;
  for (let d = docDir; ; d = dirname(d)) {
    if (existsSync(join(d, '.rewriter', 'reviews', relative(d, docDir), file, 'review.json'))) return d;
    if (!nearest && (existsSync(join(d, '.git')) || existsSync(join(d, '.rewriter', 'reviews')))) nearest = d;
    if (dirname(d) === d) return nearest || docDir;
  }
}

const realDir = (d) => { try { return realpathSync(d); } catch { return d; } };

// Resolves a document path, or a folder (meaning its index.md), to where its review lives. The folder is
// taken by its real path, so the same document reached through a symlink, or from a session started in
// another directory, is the same review. `key` is the document's path inside the root.
export function target(p) {
  if (p && typeof p === 'object') return p;
  let isFile;
  try { isFile = statSync(p).isFile(); } catch { isFile = /\.(md|markdown|mdx|txt)$/i.test(p); }
  const dir = realDir(isFile ? dirname(p) : p);
  const file = isFile ? basename(p) : null;
  const root = findRoot(dir, file || 'index.md');
  const key = join(relative(root, dir), file || 'index.md');
  return { dir, file, root, key, stateDir: join(root, '.rewriter', 'reviews', key), label: p };
}

// Review state is scaffolding, not part of the project: the folder ignores itself, so it never shows up in
// `git status` and nobody has to edit a .gitignore. A file that is already there is the project's own say.
function ignoreInGit(root) {
  const file = join(root, '.rewriter', '.gitignore');
  if (!existsSync(file)) writeFileSync(file, '*\n');
}

// ---- reviews from before 1.4.0, which kept their state beside the document ----

// Where the old layout kept a document's review: <folder>/.rewriter/ for an index.md (or a folder target),
// <folder>/.rewriter/<file name>/ for any other document.
export function legacyStateDir(t) {
  return t.file && t.file !== 'index.md' ? join(t.dir, '.rewriter', t.file) : join(t.dir, '.rewriter');
}

const hasReview = (stateDir) => existsSync(join(stateDir, 'review.json'));
const removeIfEmpty = (folder) => { try { rmdirSync(folder); } catch { /* not empty, or not there */ } };

// Moves a review of the old layout to where reviews live now. Only the review itself moves (review.json and
// its snapshots); locks and a server record belong to processes of the old version and are dropped. With a
// review already in the new place, the old one is left exactly as it is.
function moveLegacy(t, log) {
  const old = legacyStateDir(t);
  if (hasReview(t.stateDir) || !hasReview(old)) return;
  mkdirSync(join(t.root, '.rewriter'), { recursive: true });
  withLock(join(t.root, '.rewriter', 'migrate.lock'), () => {
    if (hasReview(t.stateDir) || !hasReview(old)) return; // another process moved it while this one waited
    mkdirSync(t.stateDir, { recursive: true });
    ignoreInGit(t.root);
    if (existsSync(join(old, 'rounds'))) renameSync(join(old, 'rounds'), join(t.stateDir, 'rounds'));
    renameSync(join(old, 'review.json'), join(t.stateDir, 'review.json')); // last: this file is what says "there is a review here"
    // A server of the old version that is still up keeps looking in the old place and now finds nothing.
    try {
      const server = JSON.parse(readFileSync(join(old, 'server.json'), 'utf8'));
      if (Number.isInteger(server.pid) && alive(server.pid)) {
        log(`rewriter: an older ReWriter server is still running for this document at ${server.url}: it no longer sees the review. Stop it and run serve again.\n`);
      }
    } catch { /* no old server on record */ }
    for (const leftover of ['review.lock', 'serve.lock', 'server.json']) rmSync(join(old, leftover), { force: true });
    removeIfEmpty(old);
    removeIfEmpty(join(t.dir, '.rewriter'));
    log(`rewriter: moved the review of ${join(t.dir, t.file || 'index.md')} to ${t.stateDir}\n`);
  });
}

// ---- an approved review is over, and its state goes ----

// How long an approved review may lie around. Normally it is removed about a second after the approval,
// by the process that saw it happen (the UI server, or `rewriter approve`); this is for the ones that
// process never got to, and for reviews approved by a version that kept them.
const APPROVED_KEEP_MS = 60000;

// Removes a document's review: its folder, then every folder above it that this leaves empty, up to
// `.rewriter` itself when all that is left in it is the .gitignore ReWriter put there. A project with no
// review in progress holds nothing of ReWriter. Never touches anything outside <root>/.rewriter/.
// Returns false when there was nothing to remove.
export function removeReview(p) {
  const t = target(p);
  const top = join(t.root, '.rewriter');
  const reviews = join(top, 'reviews');
  const inside = relative(reviews, t.stateDir);
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new RwError(`not a review folder, nothing removed: ${t.stateDir}`, 500);
  }
  if (!existsSync(t.stateDir)) return false;
  rmSync(t.stateDir, { recursive: true, force: true });
  for (let d = dirname(t.stateDir); ; d = dirname(d)) {
    try { rmdirSync(d); } catch { return true; } // still holds another review
    if (d === reviews) break;
  }
  try {
    const ignore = join(top, '.gitignore');
    const left = readdirSync(top);
    const onlyOurIgnore = left.length === 1 && left[0] === '.gitignore' && readFileSync(ignore, 'utf8') === '*\n';
    if (onlyOurIgnore) rmSync(ignore);
    if (onlyOurIgnore || left.length === 0) rmdirSync(top);
  } catch { /* something else lives there: leave it */ }
  return true;
}

const approvedRoundOf = (t) => {
  try {
    const last = JSON.parse(readFileSync(join(t.stateDir, 'review.json'), 'utf8')).rounds.at(-1);
    return last?.status === 'approved' ? last : null;
  } catch { return null; }
};

// Removes a review because it was approved, a moment after that approval: only if it is still that very
// approval. In between, the document may have got a new review (init over an approved one), and that one
// is not this caller's to remove. Checked under the review's lock, so nothing changes between look and act.
export function removeApproved(p, approvedAt) {
  const t = target(p);
  if (!hasReview(t.stateDir)) return false;
  return withLock(join(t.stateDir, 'review.lock'), () => {
    const round = approvedRoundOf(t);
    return Boolean(round) && round.approvedAt === approvedAt && removeReview(t);
  });
}

function sweepApproved(t, log) {
  const round = approvedRoundOf(t);
  if (!round || Date.now() - Date.parse(round.approvedAt) <= APPROVED_KEEP_MS) return;
  if (removeApproved(t, round.approvedAt)) {
    log(`rewriter: removed the finished review of ${join(t.dir, t.file || 'index.md')} (approved ${String(round.approvedAt).slice(0, 10)})\n`);
  }
}

// target(), plus the housekeeping every command starts with: a review still in the old place is moved, and
// one that was approved a while ago is removed. The CLI resolves its document through this; target()
// itself only works out paths and changes nothing.
export function locate(p, { log = (line) => process.stderr.write(line) } = {}) {
  const t = target(p);
  moveLegacy(t, log);
  sweepApproved(t, log);
  return t;
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

function update(dir, fn, { lockTimeout } = {}) {
  load(dir); // not initialized: say so, rather than fail on the lock
  return withLock(join(rwDir(dir), 'review.lock'), () => {
    const state = load(dir);
    const result = fn(state);
    save(dir, state);
    return result;
  }, lockTimeout === undefined ? undefined : { timeout: lockTimeout });
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

// opts: a file name (legacy) or { article, type, session }. `type` is free-form: article, spec, plan, ...
export function init(dir, opts = {}) {
  const o = typeof opts === 'string' ? { article: opts } : opts;
  let t = target(dir);
  const article = t.file || o.article || 'index.md';
  if (!existsSync(join(t.dir, article))) throw new RwError(`document not found: ${join(t.dir, article)}`, 404);
  const docType = String(o.type || 'document').toLowerCase();
  if (!/^[a-z][a-z0-9-]*$/.test(docType)) throw new RwError(`type must be a simple word, e.g. spec (got "${o.type}")`);
  // An approved review is over: reviewing the document again starts afresh. Removing it may have removed
  // what made a folder the root, so where the new review goes is worked out again.
  if (approvedRoundOf(t)) { removeReview(t); t = target(t.label); }
  mkdirSync(join(t.stateDir, 'rounds'), { recursive: true });
  ignoreInGit(t.root);
  return withLock(join(t.stateDir, 'review.lock'), () => {
    if (existsSync(statePath(t))) throw new RwError(`already initialized: ${statePath(t)}`, 409);
    return save(t, {
      version: 1,
      article,
      docType,
      rounds: [{ n: 1, status: 'preparing', session: o.session || null, publishedAt: null, submittedAt: null }],
      comments: [],
    });
  });
}

const latest = (state) => state.rounds[state.rounds.length - 1];
export const docType = (state) => state.docType || 'article'; // reviews from before types existed were articles

function requireRound(state, status, who) {
  const r = latest(state);
  if (r.status !== status) {
    // An approved round is the end of the review: say the one way on, instead of leaving the caller to guess.
    const closed = r.status === 'approved' ? '. The review is approved and closed.' : '';
    throw new RwError(`${who} needs round ${r.n} to be '${status}', but it is '${r.status}'${closed}`, 409);
  }
  return r;
}

const shortId = (session) => (session.length > 12 ? `${session.slice(0, 8)}…` : session);

// The session holding the round, when it isn't the caller. A caller or a round without a session id
// (the CLI run by hand, a review from before sessions were recorded) is never held back.
const heldByOther = (round, session) => (round.session && session && round.session !== session ? round.session : null);

function requireHolder(round, session, who) {
  const other = heldByOther(round, session);
  if (other) {
    throw new RwError(`${who} refused: round ${round.n} is held by another Claude session (${shortId(other)}). `
      + 'Leave the round to that session. Only if it is gone: `claim` takes the round over', 409);
  }
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

export function addComments(dir, items, opts = {}) {
  if (!Array.isArray(items) || !items.length) throw new RwError('no comments given');
  return update(dir, (state) => {
    const round = requireRound(state, 'preparing', 'adding comments');
    requireHolder(round, opts.session, 'adding comments');
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
  }, opts);
}

// Apply a batch of replies atomically: any invalid item aborts the whole batch.
export function replies(dir, items, opts = {}) {
  if (!Array.isArray(items) || !items.length) throw new RwError('no replies given');
  return update(dir, (state) => {
    const round = requireRound(state, 'preparing', 'replying');
    requireHolder(round, opts.session, 'replying');
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
  }, opts);
}

export function reply(dir, id, fields = {}, opts = {}) {
  return replies(dir, [{ ...fields, id }], opts)[0];
}

// Which of the two outcomes a round's request asked for. Requests saved before modes existed have only
// `aiReview`; those count as a review.
export function requestMode(request) {
  return request?.mode || (request?.aiReview ? 'review' : 'fix');
}

function lastSubmitted(state) {
  return [...state.rounds].reverse().find((r) => r.status === 'submitted') || null;
}

export function pending(dir, { session } = {}) {
  const state = load(dir);
  const r = latest(state);
  const submitted = lastSubmitted(state);
  let plain = null;
  try { plain = articlePlain(dir); } catch { /* article missing: anchors unknown */ }
  // What the author asked for when ending the round: only meaningful until the round after it is published.
  const approved = r.status === 'approved';
  const asked = r.status === 'submitted' || approved ? r : (r.status === 'preparing' ? state.rounds[state.rounds.length - 2] : null);
  const req = asked?.request || null;
  const mode = requestMode(req);
  // An AI review acts on nothing: what the author left pending is held for their next "Submit round".
  const reviewOnly = Boolean(req) && mode === 'review';
  const needsAction = [];
  let carriedOver = 0;
  let held = 0;
  // An approved document stays as it is: whatever was still open is counted, and nothing is asked for.
  let notActedOn = 0;
  for (const c of state.comments) {
    if (c.status === 'resolved') continue;
    const why = [];
    if (c.decision?.type === 'approve') why.push('approved');
    if (c.decision?.type === 'decline') why.push('declined');
    if (c.author === 'user' && !c.thread.some((t) => t.author === 'ai')) why.push('user-comment');
    // What the approval dialog warned about: items waiting for Claude, and reviewer comments nobody decided
    // on. A comment Claude already dealt with is not something left undone.
    if (approved) { if (why.length || (c.author === 'ai' && c.status === 'open' && (!c.decision || c.decision.type === 'ignore'))) notActedOn++; continue; }
    if (!why.length) { carriedOver++; continue; }
    if (reviewOnly) { held++; continue; }
    const anchored = c.anchor.kind !== 'text' || plain === null ? null : Boolean(findQuote(plain, c.anchor));
    needsAction.push({ id: c.id, why, anchored, comment: c });
  }
  return {
    round: r.n,
    roundStatus: r.status,
    lastSubmittedRound: submitted ? submitted.n : null,
    docType: docType(state),
    // Another Claude session is preparing this round: the caller must not act on it.
    otherSession: r.status === 'preparing' ? heldByOther(r, session) : null,
    request: req ? { ...req, mode, aiReview: mode === 'review', reviewers: expandReviewers(state, req.reviewers) } : null,
    needsAction,
    held,
    carriedOver,
    notActedOn,
  };
}

// Opens the next round and gives it to the calling session. Two sessions answering the same "Submit
// round" both get here: the lock lets one through, the other is told the round is taken.
export function nextRound(dir, { session } = {}) {
  return update(dir, (state) => {
    const cur = latest(state);
    const other = cur.status === 'preparing' ? heldByOther(cur, session) : null;
    if (other) {
      throw new RwError(`round ${cur.n} was already picked up by another Claude session (${shortId(other)}). `
        + 'That session handles it: nothing to do here', 409);
    }
    const r = requireRound(state, 'submitted', 'starting a new round');
    const nr = { n: r.n + 1, status: 'preparing', session: session || null, publishedAt: null, submittedAt: null };
    state.rounds.push(nr);
    // "Ignore for now" lasted for the round that just ended: those comments are undecided again.
    for (const c of state.comments) if (c.status === 'open' && c.decision?.type === 'ignore') archiveDecision(c);
    return nr;
  });
}

// Take over a round another session started preparing and left (it crashed or was closed).
export function claim(dir, { session } = {}) {
  if (!session) throw new RwError('no session id: claim is for a Claude session (or pass --session)');
  return update(dir, (state) => {
    const r = latest(state);
    if (r.status !== 'preparing') {
      const closed = r.status === 'approved' ? '. The review is approved and closed.' : '';
      throw new RwError(`nothing to claim: round ${r.n} is '${r.status}', no session is working on it${closed}`, 409);
    }
    r.session = session;
    return r;
  });
}

export function publish(dir, opts = {}) {
  return update(dir, (state) => {
    const r = requireRound(state, 'preparing', 'publishing');
    requireHolder(r, opts.session, 'publishing');
    mkdirSync(join(rwDir(dir), 'rounds'), { recursive: true });
    writeFileSync(snapshotPath(dir, r.n), readFileSync(articlePath(dir, state), 'utf8'));
    r.status = 'open';
    r.publishedAt = now();
    return r;
  }, opts);
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
    // Only an approval carries a note. "ignore" is "not now": the comment stays open and undecided for
    // this round, and nextRound takes the decision off again so the author is asked once more.
    c.decision = { type, note: type === 'approve' && note ? String(note) : '', round: round.n, at: now() };
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
    requireRound(state, 'open', 'deleting');
    const c = getComment(state, id);
    if (c.author !== 'user' || c.thread.some((t) => t.author === 'ai')) {
      throw new RwError('only your own comments that Claude has not answered can be deleted', 403);
    }
    state.comments = state.comments.filter((x) => x.id !== id);
    return { deleted: id };
  });
}

// Drop this review's own copy of a reviewer, so that the library's definition is the one in effect.
export function forgetReviewer(dir, persona) {
  return update(dir, (state) => {
    const before = state.customReviewers || [];
    const kept = before.filter((x) => x.persona !== persona);
    if (kept.length === before.length) return false;
    state.customReviewers = kept;
    return true;
  });
}

// req (all optional): { mode, reviewers: [{persona, model?}], custom: [{persona, background, focus?, model?}], note }
// mode 'fix' (default): the next round acts on the author's decisions and comments, nothing else.
// mode 'review': the next round is an AI review by `reviewers`, nothing is fixed (see pending).
// `aiReview: true` without a mode is the older way of asking for a review.
// The third way a round ends: the author accepts the document as it stands. The round becomes `approved`,
// which is final: nothing is fixed, nobody reviews, and no comment or decision is touched. The status is
// set so that everyone watching can see it (the tabs, a `wait`); about a second later the process that saw
// it removes the review (removeReview). A document that has to change afterwards gets a new review.
export function approve(dir, { note } = {}) {
  return update(dir, (state) => {
    const r = requireRound(state, 'open', 'approving');
    r.request = { mode: 'approve', aiReview: false, reviewers: [], note: note ? String(note).trim() : '' };
    r.status = 'approved';
    r.approvedAt = now();
    return r;
  });
}

export function submit(dir, req = {}) {
  return update(dir, (state) => {
    const r = requireRound(state, 'open', 'submitting');
    const mode = req.mode ?? (req.aiReview ? 'review' : 'fix');
    if (mode !== 'fix' && mode !== 'review') throw new RwError(`mode must be fix or review (got "${mode}")`);
    const aiReview = mode === 'review';
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
    r.request = { mode, aiReview, reviewers: aiReview ? reviewers : [], note: req.note ? String(req.note).trim() : '' };
    r.status = 'submitted';
    r.submittedAt = now();
    return r;
  });
}
