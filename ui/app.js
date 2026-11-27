import { normalizeWs, findQuote, makeTextAnchor, pageTitle } from '/lib/text.mjs';
import { stageOf, initials, hues, elapsed, stepAt, REVIEW_STEPS } from '/lib/stage.mjs';

const SEVS = ['BLOCKER', 'MAJOR', 'MINOR', 'NITPICK'];
const SEV_RANK = { USER: 0, NITPICK: 1, MINOR: 2, MAJOR: 3, BLOCKER: 4 };
const $ = (s) => document.querySelector(s);
const docEl = $('#doc');
const wrapEl = $('#doc-wrap');
const mainEl = $('main');
const stageEl = $('#stage');

const ui = {
  data: null, view: null, viewRound: null,
  sev: new Set(), status: 'active', reviewer: '',
  selected: null, form: null, // form: { id, kind: approve|new, text, anchor? }
  plain: '', order: [], loc: new Map(), snapCache: new Map(), hoverBlock: null, selAnchor: null,
};

// ---------- helpers ----------
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const inline = (s) => esc(s).replace(/`([^`\n]+)`/g, '<code>$1</code>');
const sevKey = (c) => (c.author === 'user' ? 'USER' : c.severity);
const whoLabel = (c) => (c.author === 'user' ? 'You' : (c.reviewers.length ? c.reviewers.join(', ') : 'Claude'));
const latest = () => ui.data.review.rounds[ui.data.review.rounds.length - 1];
const viewedRound = () => ui.viewRound ?? latest().n;
const isPast = () => ui.viewRound !== null && ui.viewRound !== latest().n;
const readOnly = () => isPast() || latest().status !== 'open';
// Which outcome a round's request asked for; requests from before modes existed only have aiReview.
const reqMode = (rq) => rq?.mode || (rq?.aiReview ? 'review' : 'fix');
const names = (rq) => rq.reviewers.map((r) => r.persona).join(', ');
const byId = (id) => ui.data.review.comments.find((c) => c.id === id);

async function api(method, path, body) {
  const res = await fetch(path, {
    method, headers: body !== undefined || method !== 'GET' ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : (method !== 'GET' ? '{}' : undefined),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `${res.status} ${res.statusText}`);
  return json;
}

let toastTimer;
function toast(msg, error = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = error ? 'error' : ''; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, error ? 5000 : 2200);
}

// A question the author has to answer before something that can't be taken back, or that throws work
// away. Shown in the page, never as a native browser dialog (see CLAUDE.md). Resolves to true only for the
// confirming button: Cancel, Escape, the backdrop, or another question taking its place all answer no.
const askEl = $('#ask');
let askDone = null;
function closeAsk(answer) {
  if (!askDone) return;
  const done = askDone;
  askDone = null;
  askEl.hidden = true;
  askEl.replaceChildren();
  done(answer);
}
function ask(question, { ok = 'OK', cancel = 'Cancel', danger = false } = {}) {
  closeAsk(false);
  const back = document.activeElement;
  return new Promise((resolve) => {
    askDone = (answer) => { if (back?.isConnected) back.focus(); resolve(answer); };
    const yes = h('button', { class: danger ? 'danger' : 'primary', onclick: () => closeAsk(true) }, ok);
    askEl.replaceChildren(h('div', { class: 'help-card ask-card', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': question },
      h('p', {}, question),
      h('div', { class: 'row' }, h('button', { onclick: () => closeAsk(false) }, cancel), yes)));
    askEl.hidden = false;
    yes.focus();
  });
}
askEl.addEventListener('mousedown', (e) => { if (e.target === askEl) closeAsk(false); });

async function act(fn, okMsg) {
  try { await fn(); if (okMsg) toast(okMsg); } catch (e) { toast(e.message, true); }
  await load();
}

// ---------- loading ----------
async function snapshot(n) {
  if (!ui.snapCache.has(n)) ui.snapCache.set(n, await api('GET', `/api/round/${n}`));
  return ui.snapCache.get(n);
}

let loading = null;
async function load() {
  if (loading) { loading.again = true; return loading.p; }
  loading = { again: false };
  loading.p = (async () => {
    do {
      loading.again = false;
      try {
        const fresh = await api('GET', '/api/state');
        const key = `${ui.viewRound}|${JSON.stringify(fresh)}`;
        if (key === ui.lastKey) continue; // nothing changed: keep DOM (and the user's text selection)
        ui.lastKey = key;
        const statusBefore = ui.data ? latest().status : null; // null: this is the page's first look
        ui.data = fresh;
        const rounds = ui.data.review.rounds;
        if (ui.viewRound !== null && !rounds.some((r) => r.n === ui.viewRound && r.publishedAt)) ui.viewRound = null;
        ui.view = isPast() ? await snapshot(ui.viewRound) : ui.data.article;
        render();
        // Approved while this tab was showing the review (here, in another tab, or by Claude for the
        // author): the tab is done. One that opens an already approved review is there to show it.
        if (statusBefore && statusBefore !== 'approved' && latest().status === 'approved') closeTab();
      } catch (e) { toast(e.message, true); }
    } while (loading.again);
  })();
  const p = loading.p;
  await p;
  loading = null;
  return p;
}
// Closes this tab once its review is approved: the server is stopping and there is nothing left to do
// here. A browser lets a page close its own tab only in some cases (roughly: a tab opened for this page
// that never went anywhere else, which is what `serve` opens). Where it refuses, nothing happens: the tab
// stays, read-only, and its banner says it can be closed.
// The pause before a visible tab goes: long enough to see "Approved" land, short enough not to be waited for.
const CLOSE_TAB_MS = 800;
function closeTab() {
  const go = () => window.close();
  if (document.hidden) go(); // nobody is reading it, and a hidden tab's timers are held back
  else setTimeout(go, CLOSE_TAB_MS);
}

let reloadTimer;
// A hidden tab's timers are held back by the browser (to once a second, later once a minute), and the last
// change of a review comes just before its server stops: there, load at once instead of after the pause.
const scheduleLoad = () => { clearTimeout(reloadTimer); if (document.hidden) load(); else reloadTimer = setTimeout(load, 80); };

// ---------- text index over the rendered article ----------
// Mirrors normalizeWs(textContent).trim(): plain[i] maps to a raw char position.
function buildIndex(root) {
  const nodes = [];
  const walker = (root.ownerDocument || document).createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest('style, script, template') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  let raw = 0;
  let plain = '';
  const map = [];
  let pendingWs = -1;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push({ node: n, rawStart: raw, len: n.data.length });
    for (let i = 0; i < n.data.length; i++, raw++) {
      if (/\s/.test(n.data[i])) { if (pendingWs < 0) pendingWs = raw; continue; }
      if (pendingWs >= 0 && plain.length) { plain += ' '; map.push(pendingWs); }
      pendingWs = -1;
      plain += n.data[i]; map.push(raw);
    }
  }
  return { nodes, plain, map };
}

// Wrap raw intervals [{a,b,id}] in comment highlights.
function applyMarks(index, intervals) {
  for (const info of index.nodes) {
    const s0 = info.rawStart; const e0 = s0 + info.len;
    const iv = intervals.filter((x) => x.a < e0 && x.b > s0);
    if (!iv.length) continue;
    // Whitespace between <tr>/<td>/<li> must not get <mark> wrappers (invalid structure).
    if (!info.node.data.trim() && info.node.parentElement?.matches('table, thead, tbody, tfoot, tr, ul, ol')) continue;
    const cuts = new Set([s0, e0]);
    for (const x of iv) { cuts.add(Math.max(s0, x.a)); cuts.add(Math.min(e0, x.b)); }
    const bounds = [...cuts].sort((a, b) => a - b);
    const frag = document.createDocumentFragment();
    for (let k = 0; k < bounds.length - 1; k++) {
      const s = bounds[k];
      const e = bounds[k + 1];
      let el = document.createTextNode(info.node.data.slice(s - s0, e - s0));
      const cover = iv.filter((x) => x.a <= s && x.b >= e);
      const ids = cover.map((x) => x.id);
      if (ids.length) {
        const cs = ids.map(byId);
        const top = cs.reduce((m, c) => (SEV_RANK[sevKey(c)] > SEV_RANK[sevKey(m)] ? c : m), cs[0]);
        const cls = ['rw-hl', `sev-${sevKey(top)}`];
        if (cs.every((c) => c.status === 'addressed')) cls.push('addressed');
        if (ids.includes(ui.selected)) cls.push('rw-active');
        el = h('mark', { class: cls.join(' '), 'data-ids': ids.join(' ') }, el);
      }
      frag.append(el);
    }
    info.node.replaceWith(frag);
  }
}

function findElement(anchor) {
  let els;
  try { els = [...docEl.querySelectorAll(anchor.tag)]; } catch { return null; }
  if (anchor.tag === 'img' || anchor.tag === 'video') {
    return els.find((e) => (e.getAttribute('src') || '') === anchor.key)
      || els.find((e) => anchor.key && (e.getAttribute('src') || '').endsWith(anchor.key)) || null;
  }
  const q = normalizeWs(anchor.quote || '').trim();
  return els.find((e) => q && normalizeWs(e.textContent).includes(q)) || null;
}

// ---------- the stage: shown instead of the document while the round is with Claude ----------
// What it says and when comes from lib/stage.mjs; this draws it. All of it is decoration: nobody reports
// how far Claude or a reviewer has got, so the picture only says that work is going on.
const STAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 0C13 8 16 11 24 12 16 13 13 16 12 24 11 16 8 13 0 12 8 11 11 8 12 0Z"/></svg>';
const sheet = (lines, ...extra) => h('div', { class: 'st-sheet' }, h('i', { class: 'st-line st-head' }), lines, extra);
const spark = () => h('div', { class: 'st-spark' }, h('i', { class: 'st-halo' }), h('i', { class: 'st-halo' }), h('span', { html: STAR }));

// The author's comments fly into the sheet, its lines are rewritten one after the other, ticks come out.
// Without comments (the first round, which nobody asked anything of yet) the sheet is written on its own.
function fixScene(comments) {
  const lines = [[92, 74], [70, 90], [84, 62], [56, 80], [90, 70], [64, 86], [38, 54]]; // a line's length before and after
  return h('div', { class: 'st-scene', 'aria-hidden': 'true' },
    comments ? [0, 1, 2].map((i) => h('i', { class: `st-chip st-chip-${i}` })) : null,
    sheet(lines.map(([a, b], i) => h('i', { class: 'st-line', style: `--w:${a}%;--w2:${b}%;--d:${(i * 0.8).toFixed(1)}s` }))),
    comments ? [0, 1, 2].map((i) => h('i', { class: `st-tick st-tick-${i}` }, '✓')) : null,
    spark());
}

// A light passes up and down the sheet while passages on it get marked.
function reviewScene() {
  const lines = [88, 72, 92, 60, 84, 76, 44];
  const marks = { 1: 'm0', 3: 'm1', 5: 'm2' };
  return h('div', { class: 'st-scene', 'aria-hidden': 'true' },
    sheet(lines.map((w, i) => h('i', { class: `st-line${marks[i] ? ` st-mark ${marks[i]}` : ''}`, style: `--w:${w}%;--d:${i * 1.1}s` })),
      h('i', { class: 'st-scan' })));
}

// One reviewer of the panel: a face of its own colour, its name and model, and what it is "doing".
function expertEl(r, i, colour) {
  const doing = h('div', { class: 'st-doing' });
  const el = h('div', { class: 'st-expert', role: 'listitem', style: `--hue:${colour};--d:${((i * 0.37) % 1.7).toFixed(2)}s;--in:${(i * 0.07).toFixed(2)}s` },
    h('div', { class: 'st-avatar', 'aria-hidden': 'true' }, h('span', {}, initials(r.persona)), h('i', { class: 'st-note' }), h('i', { class: 'st-note' })),
    h('div', { class: 'st-name', title: r.persona }, r.persona),
    h('div', { class: 'st-model', title: 'Model' }, r.model),
    doing);
  return { el, doing };
}

// Changes a word on the stage, with a small entrance when it is a new one.
function setWord(el, word) {
  if (el.textContent === word) return;
  el.textContent = word;
  el.classList.remove('st-new'); void el.offsetWidth; el.classList.add('st-new');
}

let stageKey = null; // what the stage on screen was built from: it is rebuilt only when that changes,
let stageTick = null; // so that the page's many refreshes while Claude works never restart the animation
function renderStage(st) {
  const key = st ? JSON.stringify(st) : null;
  if (key === stageKey) return;
  stageKey = key;
  clearInterval(stageTick); stageTick = null;
  stageEl.hidden = !st; mainEl.hidden = Boolean(st);
  if (!st) { stageEl.replaceChildren(); return; }

  const working = st.state === 'working';
  const step = st.steps ? h('div', { class: 'st-step', 'aria-hidden': 'true' }) : null;
  const colours = hues(st.reviewers.map((r) => r.persona));
  const experts = st.reviewers.map((r, i) => expertEl(r, i, colours[i]));
  const since = st.since ? h('div', { class: 'st-since' }) : null;
  stageEl.className = `st-${st.scene} st-${st.state}`;
  stageEl.replaceChildren(h('div', { class: 'st-inner' },
    st.scene === 'review' ? reviewScene() : fixScene(st.handed),
    h('h2', { class: 'st-title', role: 'status' }, st.title),
    step,
    experts.length ? h('div', { class: 'st-panel', role: 'list', 'aria-label': 'Reviewers' }, experts.map((x) => x.el)) : null,
    h('p', { class: 'st-text' }, st.text),
    since));

  const built = Date.now();
  const tick = () => {
    const t = Math.floor((Date.now() - built) / 1000);
    if (step) setWord(step, stepAt(st.steps, t));
    experts.forEach((x, i) => setWord(x.doing, working ? stepAt(REVIEW_STEPS, t, i) : 'waiting'));
    if (since) since.textContent = `Handed over ${elapsed(Date.now() - Date.parse(st.since))} ago`;
  };
  tick();
  stageTick = setInterval(tick, 1000);
}

// ---------- filters ----------
// Set aside by the author for this round: still open, asked again next round.
const ignoredForNow = (c) => c.status === 'open' && c.decision?.type === 'ignore';

function passes(c) {
  if (c.round > viewedRound()) return false;
  if (ui.sev.size && !ui.sev.has(sevKey(c))) return false; // no chip picked = all severities
  if (ui.reviewer && !c.reviewers.includes(ui.reviewer)) return false;
  switch (ui.status) {
    case 'active': return c.status !== 'resolved' && !ignoredForNow(c);
    case 'ignored': return ignoredForNow(c);
    case 'needs': return c.author === 'ai' && c.status === 'open' && !c.decision;
    case 'all': return true;
    default: return c.status === ui.status;
  }
}

// ---------- render ----------
function render() {
  const review = ui.data.review;
  const L = latest();
  document.title = pageTitle(ui.data.sessionTitle, ui.view?.title || review.article);
  $('#doc-title').textContent = ui.view?.title || review.article;
  $('#version').textContent = ui.data.version ? `v${ui.data.version}` : '';
  document.body.classList.toggle('read-only', readOnly());
  // The round is with Claude (handed over, or being worked on): nothing may change until it publishes, and
  // the document and its comments make way for the stage.
  const stage = stageOf(review, ui.viewRound);
  const withClaude = Boolean(stage);
  if (readOnly()) {
    // Close whatever could still send a change: an open question, the round dialogs, a comment form, the "Comment" button.
    closeAsk(false);
    if (!dlg.hidden) closeSubmit();
    if (ui.form) { if (ui.form.kind === 'new') closePopover(); ui.form = null; }
    $('#sel-btn').hidden = true;
  }
  if (stage) closePopover(); // a comment card left open would float over the stage
  $('#new-general').disabled = readOnly();

  // Header controls appear only when they can do something.
  const sel = $('#round-select');
  const viewable = review.rounds.filter((r) => r.publishedAt || r.n === L.n).reverse();
  sel.hidden = viewable.length < 2; // one round: nothing to switch to
  sel.replaceChildren(...viewable
    .map((r) => h('option', { value: r.n, selected: r.n === viewedRound() }, r.n === L.n ? `Round ${r.n} (current)` : `Round ${r.n}`)));
  $('#round-label').textContent = `Round ${viewedRound()}`;
  const st = $('#round-status');
  st.hidden = !isPast() && L.status === 'open'; // "open" is the normal state: say nothing
  st.textContent = isPast() ? 'snapshot' : ({ submitted: 'Waiting for Claude', preparing: 'Claude is working', approved: 'Approved' }[L.status] || L.status);
  st.className = `pill st-${isPast() ? 'past' : L.status}${withClaude ? ' working' : ''}`;

  $('#submit-btn').disabled = readOnly();
  $('#review-btn').disabled = readOnly();
  $('#approve-btn').disabled = readOnly();

  const banner = $('#banner');
  const prev = review.rounds[review.rounds.length - 2]; // the round whose request Claude is working on
  let msg = '';
  let info = false;
  if (ui.view?.error) msg = `Document could not be loaded: ${ui.view.error}`;
  else if (isPast()) {
    msg = `Viewing the round ${ui.viewRound} snapshot (read-only). Comments show their current status.`;
    // An earlier round looked at while Claude is at work: say how to get back to watching.
    if (stageOf(review)) msg += ` Claude is at work meanwhile: pick "Round ${L.n} (current)" in the round list to go back.`;
  } else if (L.status === 'preparing') {
    info = reqMode(prev?.request) === 'review';
    msg = info ? `AI review running: ${names(prev.request)}. Findings appear here when they are done.`
      : `Claude is preparing round ${L.n}. Read-only until it publishes.`;
  } else if (L.status === 'submitted') {
    info = true;
    const pickup = 'Claude picks it up if it is waiting; otherwise tell it to continue.';
    msg = reqMode(L.request) === 'review' ? `AI review requested: ${names(L.request)}. ${pickup}`
      : `Round ${L.n} submitted. Asked for fixes only. ${pickup}`;
  } else if (L.status === 'approved') {
    // The end of the review. Its server stops once it has said so, which is why this page goes quiet.
    info = true;
    msg = `Approved on ${new Date(L.approvedAt).toLocaleDateString()}. This review is closed and its server has stopped, so this page no longer updates: you can close this tab. To review the document again, ask Claude to start a new review.`;
  }
  banner.hidden = !msg || withClaude; // the stage says it itself
  banner.textContent = msg;
  banner.className = [info ? 'info' : '', withClaude ? 'busy' : ''].join(' ').trim();

  renderStage(stage);
  if (stage) return; // nothing of the document is on screen

  renderChips();
  renderDoc();
  renderSidebar();
  renderPopover();
}

// One row of severity pills does both jobs: each says how many comments of its kind are unresolved, and
// is the filter for them. The number is the same whatever is filtered, so it reads as the state of the
// review, not of the list.
function renderChips() {
  const unresolved = ui.data.review.comments.filter((c) => c.status !== 'resolved' && c.round <= viewedRound());
  $('#sev-chips').replaceChildren(...[...SEVS, 'USER'].map((s) => {
    const n = unresolved.filter((c) => sevKey(c) === s).length;
    const what = s === 'USER' ? 'from you' : s;
    return h('button', {
      class: `chip sev-${s}${ui.sev.has(s) ? ' on' : ''}${ui.sev.size && !ui.sev.has(s) ? ' dim' : ''}${n ? '' : ' zero'}`,
      'aria-pressed': ui.sev.has(s) ? 'true' : 'false',
      title: `${n} unresolved ${what}. ${ui.sev.has(s) ? 'Click to stop filtering by this' : 'Click to show only these'}`,
      onclick: () => { if (ui.sev.has(s)) ui.sev.delete(s); else ui.sev.add(s); render(); },
    }, s === 'USER' ? 'You' : s, h('span', { class: 'chip-n' }, n));
  }));
  const rf = $('#reviewer-filter');
  const names = [...new Set(ui.data.review.comments.flatMap((c) => c.reviewers))].sort();
  if (ui.reviewer && !names.includes(ui.reviewer)) ui.reviewer = '';
  rf.replaceChildren(h('option', { value: '' }, 'All reviewers'), ...names.map((n) => h('option', { value: n, selected: n === ui.reviewer }, n)));
  $('#status-filter').value = ui.status;
}

function renderDoc() {
  const scroll = wrapEl.scrollTop;
  docEl.innerHTML = ui.view?.html || '';
  for (const a of docEl.querySelectorAll('a[href]')) { a.target = '_blank'; a.rel = 'noopener'; }
  const index = buildIndex(docEl);
  ui.plain = index.plain;
  const { map } = index;

  const intervals = [];

  ui.loc = new Map();
  const visible = ui.data.review.comments.filter(passes);
  for (const c of visible) {
    if (c.anchor.kind === 'text') {
      const hit = findQuote(index.plain, c.anchor);
      if (hit) { intervals.push({ a: map[hit.start], b: map[hit.end - 1] + 1, id: c.id }); ui.loc.set(c.id, { kind: 'text' }); }
      else ui.loc.set(c.id, { kind: 'lost' });
    } else if (c.anchor.kind === 'element') {
      const el = findElement(c.anchor);
      ui.loc.set(c.id, el ? { kind: 'element', el } : { kind: 'lost' });
    } else ui.loc.set(c.id, { kind: 'article' });
  }
  applyMarks(index, intervals);
  for (const [id, l] of ui.loc) {
    if (l.kind !== 'element') continue;
    const c = byId(id);
    l.el.classList.add('rw-el', `sev-${sevKey(c)}`);
    l.el.dataset.ids = `${l.el.dataset.ids || ''} ${id}`.trim();
    if (id === ui.selected) l.el.classList.add('rw-active');
  }
  wrapEl.scrollTop = scroll;
  renderBubbles();
}

function targetFor(id) {
  const l = ui.loc.get(id);
  if (!l || l.kind === 'lost') return null;
  if (l.kind === 'article') return docEl.querySelector('h1') || docEl.firstElementChild || docEl;
  return docEl.querySelector(`[data-ids~="${id}"]`);
}

function topOf(el) {
  return el.getBoundingClientRect().top - wrapEl.getBoundingClientRect().top + wrapEl.scrollTop;
}

function renderBubbles() {
  const layer = $('#bubbles');
  layer.replaceChildren();
  const items = [];
  for (const [id, l] of ui.loc) {
    const el = targetFor(id);
    const c = byId(id);
    l.top = el ? topOf(el) : (l.kind === 'lost' ? Infinity : -1);
    if (el) items.push({ c, top: l.top });
  }
  items.sort((a, b) => a.top - b.top || Number(a.c.id.slice(1)) - Number(b.c.id.slice(1)));
  const left = docEl.offsetLeft + docEl.offsetWidth + 16;
  let last = -Infinity;
  for (const { c, top } of items) {
    const y = Math.max(top, last + 30);
    last = y;
    layer.append(h('button', {
      class: `bubble sev-${sevKey(c)}${c.status === 'addressed' ? ' addressed' : ''}${c.id === ui.selected ? ' rw-active' : ''}`,
      style: `top:${y}px;left:${left}px`, 'data-id': c.id,
      title: `${c.author === 'user' ? 'Your comment' : `${c.severity} · flagged by ${whoLabel(c)}`}: ${c.body.slice(0, 140)}`,
      onclick: (e) => { e.stopPropagation(); select(c.id, { card: true }); openPopover([c.id], e.currentTarget); },
    }, whoLabel(c)));
  }
  // card order: general first, then document order, lost anchors last
  ui.order = [...ui.loc.entries()].sort((a, b) => a[1].top - b[1].top || Number(a[0].slice(1)) - Number(b[0].slice(1))).map(([id]) => id);
}

function renderSidebar() {
  const cards = $('#cards');
  if (!ui.order.length) {
    cards.replaceChildren(h('div', { class: 'empty' }, ui.data.review.comments.length ? 'No comments match the filters.' : 'No comments yet.'));
    return;
  }
  cards.replaceChildren(...ui.order.map((id) => renderCard(byId(id), 'side')));
  restoreFocus();
}

const KIND_LABEL = { fixed: 'fixed', accepted: 'accepted your decline', challenge: 'challenged', reply: 'reply', resolved: 'resolved', reopened: 'reopened' };
const DECISION_LABEL = { approve: 'Approved', decline: 'Declined', ignore: 'Ignored for now' };

function quoteBlock(c) {
  const l = ui.loc.get(c.id);
  const lost = l?.kind === 'lost';
  const jump = () => select(c.id, { doc: true });
  if (c.anchor.kind === 'article') return h('div', { class: 'quote', onclick: jump }, 'Whole document');
  const text = c.anchor.kind === 'element' ? `[${c.anchor.tag}] ${c.anchor.quote || c.anchor.key}` : c.anchor.quote;
  return h('div', {},
    lost ? h('div', { class: 'lost', title: 'The quoted text is no longer in the document' }, '⚠ Text changed since this comment') : null,
    h('div', { class: 'quote', title: text, onclick: jump }, text));
}

function renderCard(c, where) {
  const ro = readOnly();
  const s = sevKey(c);
  const card = h('div', { class: `card sev-${s}${c.id === ui.selected ? ' rw-active' : ''}${c.status === 'resolved' ? ' is-resolved' : ''}`, 'data-id': c.id });
  card.addEventListener('click', (e) => {
    // Anywhere on a sidebar card jumps to it in the article, except controls and while selecting text to copy.
    if (where !== 'side' || e.target.closest('button, textarea, a, .form, .id, .quote')) return;
    if (!window.getSelection().isCollapsed) return;
    select(c.id, { doc: true });
  });

  const head = h('div', { class: 'card-head' },
    h('span', { class: `pill sev sev-${s}` }, c.author === 'user' ? 'You' : c.severity),
    c.reviewers.length ? h('span', { class: 'reviewers', title: 'Flagged by' }, c.reviewers.join(', ')) : null,
    c.status !== 'open' ? h('span', { class: 'pill' }, c.status) : null,
    h('span', { class: 'pill', title: `Created in round ${c.round}` }, `R${c.round}`),
    h('span', { class: 'id', title: 'Show in document', onclick: () => select(c.id, { doc: true }) }, `#${c.id.slice(1)}`));
  card.append(head, quoteBlock(c), h('div', { class: 'body', html: inline(c.body) }));

  if (c.suggestion) {
    const before = c.anchor.kind === 'text' ? c.anchor.quote : null;
    card.append(h('div', { class: 'suggestion' },
      h('div', { class: 'lbl' }, 'Suggested fix', h('button', { class: 'small ghost', title: 'Copy suggestion (y)', onclick: () => copy(c.suggestion) }, 'Copy')),
      before ? h('div', { class: 'before' }, before) : null,
      h('div', { class: 'after' }, c.suggestion)));
  }

  if (c.thread.length) {
    card.append(h('div', { class: 'thread' }, c.thread.map((t) => h('div', { class: `entry ${t.author}` },
      h('span', { class: 'who' }, t.author === 'ai' ? 'Claude' : 'You'),
      h('span', { class: 'kind' }, `${t.kind === 'decision' ? DECISION_LABEL[t.type] : KIND_LABEL[t.kind]} · R${t.round}`),
      t.kind === 'decision' && t.note ? h('div', { class: 'txt', html: inline(t.note) }) : null,
      t.kind !== 'decision' && t.body ? h('div', { class: 'txt', html: inline(t.body) }) : null))));
  }

  if (c.decision && (c.decision.type !== 'ignore' || ignoredForNow(c))) {
    // On an approved review there is no next round: a decision that was still waiting stays undone.
    const hint = latest().status === 'approved'
      ? { approve: ' · not acted on: the document was approved as it stood', decline: ' · not acted on: the document was approved as it stood', ignore: ' · left open: the document was approved as it stood' }[c.decision.type]
      : { approve: ' · Claude applies it next round', decline: ' · Claude accepts or challenges next round', ignore: ' · stays open, comes back next round' }[c.decision.type];
    card.append(h('div', { class: `decision ${c.decision.type}` }, `${DECISION_LABEL[c.decision.type]}${hint}`,
      c.decision.note ? h('div', { class: 'note', html: inline(c.decision.note) }) : null));
  }

  if (!ro && ui.form && ui.form.id === c.id) card.append(formEl(where));
  else if (!ro) {
    const acts = h('div', { class: 'actions' });
    const btn = (label, cls, fn, title) => acts.append(h('button', { class: `small ${cls || ''}`, title, onclick: (e) => { e.stopPropagation(); fn(); } }, label));
    if (c.author === 'ai' && c.status === 'open') {
      if (!c.decision) {
        btn('Approve', 'approve', () => decide(c.id, 'approve'), 'a');
        btn('Approve + comment', 'approve', () => openForm(c.id, 'approve'), 'A');
        btn('Decline', 'decline', () => decide(c.id, 'decline'), 'd');
        btn('Ignore for now', '', () => decide(c.id, 'ignore'), 'i: set it aside for this round; it stays open and comes back next round');
      } else btn('Undo decision', '', () => decide(c.id, 'clear'), 'u');
    }
    if (c.status !== 'resolved') {
      btn('Resolve', '', () => act(() => api('POST', `/api/comments/${c.id}/resolve`), 'Resolved'), 'r');
    } else btn('Reopen', '', () => act(() => api('POST', `/api/comments/${c.id}/reopen`)), 'r');
    if (c.author === 'user' && !c.thread.some((t) => t.author === 'ai')) {
      btn('Delete', 'decline', async () => {
        if (await ask('Delete this comment?', { ok: 'Delete', danger: true })) act(() => api('DELETE', `/api/comments/${c.id}`));
      });
    }
    card.append(acts);
  }
  return card;
}

function formEl(where) {
  const f = ui.form;
  const placeholder = { approve: 'Approve, with a note for Claude…', new: 'Your comment for Claude…' }[f.kind];
  const ta = h('textarea', { placeholder, 'data-where': where });
  ta.value = f.text || '';
  ta.addEventListener('input', () => { f.text = ta.value; });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendForm(); }
    if (e.key === 'Escape') { e.preventDefault(); closeForm(); }
  });
  const label = { approve: 'Approve', new: 'Add comment' }[f.kind];
  return h('div', { class: 'form' }, ta, h('div', { class: 'row' },
    h('span', { class: 'muted', style: 'margin-right:auto;font-size:12px' }, '⌘↵ to send'),
    h('button', { class: 'small', onclick: closeForm }, 'Cancel'),
    h('button', { class: 'small primary', onclick: sendForm }, label)));
}

function restoreFocus() {
  if (!ui.form || !ui.form.focus) return;
  const where = ui.form.focus;
  const ta = document.querySelector(`textarea[data-where="${where}"]`) || document.querySelector('#popover textarea, #cards textarea');
  if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
}

function openForm(id, kind) {
  if (readOnly()) return;
  ui.form = { id, kind, text: '', focus: document.querySelector('#popover:not([hidden])') ? 'pop' : 'side' };
  select(id, { card: true, keepPopover: true });
  renderSidebar(); renderPopover(); restoreFocus();
}

function closeForm() {
  const wasNew = ui.form?.kind === 'new';
  ui.form = null;
  if (wasNew) closePopover();
  renderSidebar(); renderPopover();
}

async function sendForm() {
  const f = ui.form;
  if (!f) return;
  const text = (f.text || '').trim();
  if (f.kind === 'new' && !text) { toast('Write something first', true); return; }
  try {
    if (f.kind === 'new') {
      const c = await api('POST', '/api/comments', { anchor: f.anchor, body: text });
      ui.selected = c.id;
      ui.form = null;
      closePopover();
      toast('Comment added');
    } else {
      await api('POST', `/api/comments/${f.id}/decision`, { type: f.kind, note: text });
      ui.form = null;
    }
  } catch (e) {
    toast(e.message, true); // keep the form and what was typed
    return;
  }
  await load();
}

function decide(id, type) {
  if (readOnly()) return;
  const c = byId(id);
  if (!c || c.author !== 'ai' || c.status !== 'open') return;
  if (type !== 'clear' && c.decision) return;
  act(() => api('POST', `/api/comments/${id}/decision`, { type }), { approve: 'Approved', decline: 'Declined', ignore: 'Ignored for now' }[type]);
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = h('textarea', {}); ta.value = text; document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
  toast('Suggestion copied');
}

// ---------- selection ----------
function select(id, { doc = false, card = false, keepPopover = false } = {}) {
  ui.selected = id;
  if (!keepPopover && !$('#popover').hidden && $('#popover').dataset.ids !== id) closePopover();
  for (const el of document.querySelectorAll('.rw-active')) el.classList.remove('rw-active');
  for (const el of document.querySelectorAll(`[data-ids~="${id}"], .card[data-id="${id}"], .bubble[data-id="${id}"]`)) el.classList.add('rw-active');
  if (doc) {
    const t = targetFor(id);
    if (t) {
      wrapEl.scrollTo({ top: Math.max(0, topOf(t) - wrapEl.clientHeight / 3), behavior: 'smooth' });
      for (const el of docEl.querySelectorAll(`[data-ids~="${id}"]`)) {
        el.classList.remove('rw-flash'); void el.offsetWidth; el.classList.add('rw-flash');
        el.addEventListener('animationend', () => el.classList.remove('rw-flash'), { once: true });
      }
    } else if (ui.loc.get(id)?.kind === 'lost') toast('The quoted text is no longer in the document');
  }
  // Two smooth scrolls at once can cancel each other, so the card list jumps instantly when the article is scrolling.
  if (card || doc) document.querySelector(`#cards .card[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest', behavior: doc ? 'auto' : 'smooth' });
}

function move(delta) {
  if (!ui.order.length) return;
  const i = ui.order.indexOf(ui.selected);
  const next = ui.order[i < 0 ? (delta > 0 ? 0 : ui.order.length - 1) : (i + delta + ui.order.length) % ui.order.length];
  closePopover();
  select(next, { doc: true, card: true });
}

// ---------- popover ----------
let popAnchorEl = null;
let popMoved = false; // user dragged it: stop re-anchoring until it is reopened
const popDrag = h('div', { class: 'pop-drag', title: 'Drag to move' },
  h('span', { class: 'grip' }, '⠿'), h('span', {}, 'Drag to move'),
  h('button', { class: 'ghost small', title: 'Close (Esc)', onclick: () => { closePopover(); renderSidebar(); } }, '×'));
popDrag.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || e.target.closest('button')) return;
  e.preventDefault(); // keep focus in the form, no text selection while dragging
  const pop = $('#popover');
  const r = pop.getBoundingClientRect();
  const dx = e.clientX - r.left; const dy = e.clientY - r.top;
  const onMove = (ev) => {
    popMoved = true;
    pop.style.left = `${Math.min(Math.max(0, ev.clientX - dx), window.innerWidth - r.width)}px`;
    pop.style.top = `${Math.min(Math.max(0, ev.clientY - dy), window.innerHeight - 40)}px`;
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp);
    document.body.classList.remove('dragging');
  };
  document.body.classList.add('dragging');
  document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
});
function openPopover(ids, anchorEl) {
  const pop = $('#popover');
  pop.dataset.ids = ids.join(' ');
  popAnchorEl = anchorEl;
  popMoved = false;
  pop.hidden = false;
  renderPopover();
}
function closePopover() {
  const pop = $('#popover');
  pop.hidden = true; pop.dataset.ids = ''; popAnchorEl = null;
  if (ui.form?.kind === 'new') ui.form = null;
}
function renderPopover() {
  const pop = $('#popover');
  if (pop.hidden) return;
  if (ui.form?.kind === 'new') {
    const q = ui.form.anchor.kind === 'article' ? 'Whole document' : (ui.form.anchor.quote || `[${ui.form.anchor.tag}]`);
    pop.replaceChildren(popDrag, h('div', { class: 'form-card' }, h('div', { class: 'card-head' }, h('span', { class: 'pill sev sev-USER' }, 'New comment')),
      h('div', { class: 'quote' }, q), formEl('pop')));
  } else {
    const cs = pop.dataset.ids.split(' ').map(byId).filter(Boolean);
    if (!cs.length) { closePopover(); return; }
    pop.replaceChildren(popDrag, ...cs.map((c) => renderCard(c, 'pop')));
  }
  position(pop, popAnchorEl);
  restoreFocus();
}
function position(pop, anchorEl) {
  if (popMoved) return;
  const r = anchorEl && anchorEl.isConnected ? anchorEl.getBoundingClientRect() : (ui.lastRect || { left: 200, right: 200, top: 100, bottom: 100 });
  const w = pop.offsetWidth || 380;
  let left = r.right + 10;
  if (left + w > window.innerWidth - 10) left = Math.max(10, r.left - w - 10);
  const top = Math.min(Math.max(60, r.top), Math.max(60, window.innerHeight - pop.offsetHeight - 10));
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

// ---------- author comments: selection & block ----------
function estimateStart(node, offset) {
  const pre = document.createRange();
  pre.setStart(docEl, 0);
  pre.setEnd(node, offset);
  return normalizeWs(pre.toString()).replace(/^ /, '').length;
}
function anchorFor(quoteRaw, est) {
  const quote = normalizeWs(quoteRaw).trim();
  if (!quote) return null;
  let best = -1;
  for (let i = ui.plain.indexOf(quote); i !== -1; i = ui.plain.indexOf(quote, i + 1)) {
    if (best < 0 || Math.abs(i - est) < Math.abs(best - est)) best = i;
  }
  return best < 0 ? null : makeTextAnchor(ui.plain, best, best + quote.length);
}
function selectionAnchor() {
  const s = window.getSelection();
  if (!s || s.isCollapsed || !s.rangeCount) return null;
  const r = s.getRangeAt(0);
  if (!docEl.contains(r.commonAncestorContainer)) return null;
  return anchorFor(r.toString(), estimateStart(r.startContainer, r.startOffset));
}
function newComment(anchor, rect) {
  if (readOnly() || !anchor) return;
  ui.form = { id: null, kind: 'new', text: '', anchor, focus: 'pop' };
  ui.lastRect = rect;
  $('#sel-btn').hidden = true;
  closeFormInSidebar();
  const pop = $('#popover');
  pop.dataset.ids = '';
  popAnchorEl = null;
  popMoved = false;
  pop.hidden = false;
  renderPopover();
}
function closeFormInSidebar() { document.querySelectorAll('#cards .form').forEach((f) => f.remove()); }

function blockAnchor(block) {
  const media = block.matches('img, video') ? block : (block.textContent.trim() ? null : block.querySelector('img, video'));
  if (media) return { kind: 'element', tag: media.tagName.toLowerCase(), key: media.getAttribute('src') || '', quote: media.getAttribute('alt') || '' };
  return anchorFor(block.textContent, estimateStart(block, 0));
}

const plusBtn = h('button', { class: 'rw-plus', title: 'Comment on this block' }, '+');
plusBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (ui.hoverBlock) newComment(blockAnchor(ui.hoverBlock), ui.hoverBlock.getBoundingClientRect());
});
$('#bubbles').after(plusBtn);
plusBtn.style.position = 'absolute';

docEl.addEventListener('mouseover', (e) => {
  if (readOnly()) { plusBtn.style.opacity = 0; return; }
  const block = e.target.closest('#doc > *:not(ul):not(ol), #doc li, #doc img');
  if (!block || block === ui.hoverBlock) return;
  ui.hoverBlock = block;
  plusBtn.style.top = `${topOf(block)}px`;
  plusBtn.style.left = `${docEl.offsetLeft - 34}px`;
  plusBtn.style.opacity = 1;
});
wrapEl.addEventListener('mouseleave', () => { plusBtn.style.opacity = 0; ui.hoverBlock = null; });

document.addEventListener('mouseup', (e) => {
  if (e.target.closest('#sel-btn, #popover, #sidebar, header')) return;
  setTimeout(() => {
    const btn = $('#sel-btn');
    const a = readOnly() ? null : selectionAnchor();
    ui.selAnchor = a;
    if (!a) { btn.hidden = true; return; }
    const rect = window.getSelection().getRangeAt(0).getBoundingClientRect();
    ui.lastRect = rect;
    btn.style.left = `${rect.right + 4}px`;
    btn.style.top = `${rect.bottom + 4}px`;
    btn.hidden = false;
  }, 0);
});
$('#sel-btn button').addEventListener('mousedown', (e) => e.preventDefault());
$('#sel-btn button').addEventListener('click', () => newComment(ui.selAnchor, ui.lastRect));

docEl.addEventListener('click', (e) => {
  const hit = e.target.closest('[data-ids]');
  if (!hit || !window.getSelection().isCollapsed) return;
  const ids = hit.dataset.ids.split(' ');
  // nested marks: collect ids from all ancestors too
  for (let p = hit.parentElement?.closest('[data-ids]'); p; p = p.parentElement?.closest('[data-ids]')) ids.push(...p.dataset.ids.split(' '));
  const uniq = [...new Set(ids)];
  select(uniq[0], { card: true });
  ui.lastRect = hit.getBoundingClientRect();
  openPopover(uniq, hit);
});

document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('#popover, .bubble, #doc [data-ids], #sel-btn, .rw-plus') && !$('#popover').hidden) {
    if (!(ui.form && ui.form.focus === 'pop' && ui.form.text)) { closePopover(); if (ui.form?.focus === 'pop') ui.form = null; }
  }
});
wrapEl.addEventListener('scroll', () => {
  $('#sel-btn').hidden = true;
  if (!$('#popover').hidden && popAnchorEl) position($('#popover'), popAnchorEl);
});
window.addEventListener('resize', () => { if (!mainEl.hidden) renderBubbles(); });

// ---------- header controls ----------
$('#round-select').addEventListener('change', (e) => {
  const n = Number(e.target.value);
  ui.viewRound = n === latest().n ? null : n;
  closePopover(); ui.form = null;
  load();
});
$('#status-filter').addEventListener('change', (e) => { ui.status = e.target.value; render(); });
$('#reviewer-filter').addEventListener('change', (e) => { ui.reviewer = e.target.value; render(); });
$('#new-general').addEventListener('click', (e) => newComment({ kind: 'article' }, e.target.getBoundingClientRect()));
$('#help-btn').addEventListener('click', () => { $('#help').hidden = false; });
$('#help').addEventListener('click', () => { $('#help').hidden = true; });
// ---------- ending a round: "Submit round" (Claude fixes) or "AI review" (reviewers read, nothing is fixed) ----------
const dlg = $('#submit-dlg');
// A dialog that holds work the author would lose sets dlgGuard: it returns the question to ask before a
// backdrop click or Escape closes it, or '' when there is nothing to lose.
let dlgGuard = null;
const closeSubmit = () => { dlg.hidden = true; dlg.replaceChildren(); dlgGuard = null; };
async function dismissDialog() {
  const question = dlgGuard?.();
  if (question && !(await ask(question, { ok: 'Close', cancel: 'Keep editing' }))) return;
  closeSubmit();
}
const modelLabel = (m) => (m || 'session');

// toFix: what Claude would act on after "Submit round". undecided: reviewer comments with no decision yet,
// or set aside with "Ignore for now".
// total: comments in either group (one can be in both), which is what an approval leaves as it is.
function pendingCounts() {
  const cs = ui.data.review.comments;
  const undecided = cs.filter((c) => c.author === 'ai' && c.status === 'open' && (!c.decision || c.decision.type === 'ignore'));
  const toFix = cs.filter((c) => c.status !== 'resolved' && (c.decision?.type === 'approve' || c.decision?.type === 'decline'
    || (c.author === 'user' && !c.thread.some((t) => t.author === 'ai'))));
  return { undecided: undecided.length, toFix: toFix.length, total: new Set([...undecided, ...toFix]).size };
}

function showDialog(...children) {
  dlg.replaceChildren(h('div', { class: 'help-card submit-card', onclick: (e) => e.stopPropagation() }, ...children));
  dlg.hidden = false;
}

// Posts the request that ends the round; `body` is a function so it is read at click time.
function sendButton(label, done, body, { path = '/api/submit', cls = 'primary' } = {}) {
  const send = h('button', { class: cls, onclick: async () => {
    const payload = await body(); // may ask the author a question first
    if (!payload) return;
    send.disabled = true;
    try { await api('POST', path, payload); } catch (e) { toast(e.message, true); send.disabled = false; return; }
    closeSubmit();
    toast(done);
    await load();
  } }, label);
  return send;
}

function openSubmitDialog() {
  if (readOnly()) return;
  closePopover(); ui.form = null;
  const { toFix, undecided } = pendingCounts();
  const note = h('textarea', { placeholder: 'Note for Claude about this round (optional)…' });
  const send = sendButton('Submit round', 'Round submitted', () => ({ mode: 'fix', note: note.value.trim() }));
  const gate = () => { send.disabled = toFix === 0 && !note.value.trim(); };
  note.addEventListener('input', gate);
  gate();
  showDialog(
    h('h3', {}, `Submit round ${latest().n}`),
    h('p', { class: 'muted' }, `${toFix} item(s) for Claude to act on.${undecided ? ` ${undecided} reviewer comment(s) have no decision and carry over.` : ''}`),
    toFix ? null : h('p', { class: 'muted' }, 'Nothing for Claude to act on yet: comment, decide on a reviewer comment, or write a note below.'),
    note,
    h('div', { class: 'row' }, h('button', { onclick: closeSubmit }, 'Cancel'), send));
}

// "Approve": this version is final. It ends the review, so it always asks first, and it says in so many
// words what will be left undone: an approval must never be a way to lose requests without noticing.
function openApproveDialog() {
  if (readOnly()) return;
  closePopover(); ui.form = null;
  const { toFix, undecided, total } = pendingCounts();
  const note = h('textarea', { placeholder: 'Note (optional)…' });
  const send = sendButton('Approve', 'Approved', () => ({ note: note.value.trim() }), { path: '/api/approve', cls: 'approve-doc' });
  const left = [toFix ? `${toFix} waiting for Claude` : '', undecided ? `${undecided} reviewer comment(s) without a decision` : ''].filter(Boolean).join(', ');
  showDialog(
    h('h3', {}, 'Approve this version'),
    h('p', {}, `Round ${latest().n} of ${ui.view?.title || ui.data.review.article} becomes final and the review is closed. Claude makes no further changes and no reviewers run.`),
    total ? h('p', { class: 'warn' }, `${total} open item(s) will `, h('strong', {}, 'not be acted on'), `: ${left}.`) : null,
    note,
    h('div', { class: 'row' }, h('button', { onclick: closeSubmit }, 'Cancel'), send));
}

// The AI review dialog is a small workbench: the panel (who runs), the library (who exists) and an editor
// for the selected reviewer. The library has four parts: reviewers kept with this document, the project's
// (a file in the project, shared with everyone working in it), the author's own, and the built-in starters.
const SOURCE_TAG = { review: 'this document', project: 'project', user: 'yours', 'built-in': 'starter' };
const SCOPE_LABEL = { project: 'This project', user: 'My library' };
const SAVED_TO = { project: 'this project', user: 'your library' };
// What the editor shows for a stored reviewer: its background, then its focus points as bullets.
const storedDesc = (r) => [r.background, ...(r.focus || []).map((f) => `- ${f}`)].join('\n').trim();
// Where a new reviewer is saved unless the author says otherwise: where they saved the last one.
const SAVE_TO_KEY = 'rewriter.saveTo';
const lastSaveTo = () => { try { return localStorage.getItem(SAVE_TO_KEY); } catch { return null; } };
const rememberSaveTo = (scope) => { try { localStorage.setItem(SAVE_TO_KEY, scope); } catch { /* storage is off: ask again next time */ } };

async function openReviewDialog() {
  if (readOnly()) return;
  let reg;
  try { reg = await api('GET', '/api/reviewers'); } catch (e) { toast(e.message, true); return; }
  closePopover(); ui.form = null;
  const { toFix } = pendingCounts();
  const byName = (name) => reg.reviewers.find((r) => r.persona === name);

  const hasProject = () => Boolean(reg.libraries?.project);
  const defaultSaveTo = () => (lastSaveTo() === 'project' && hasProject() ? 'project' : 'user');

  // panel: [{ persona, model, def }]. def is null for a reviewer used as stored, or { background } for one
  // whose description is saved nowhere: it then runs with this document only.
  // In a request the model "session" means the session's own model; in here that is the empty model.
  const asStored = (r) => ({ persona: r.persona, model: r.model || '', def: null });
  let panel = reg.last
    ? reg.last.filter((p) => byName(p.persona))
      .map((p) => ({ persona: p.persona, model: p.model === 'session' ? '' : (p.model || byName(p.persona).model || ''), def: null }))
    // The document's first AI review: the project's own panel, when the project keeps one.
    : reg.reviewers.filter((r) => r.source === 'project' && r.suggested).map(asStored);
  // The editor: { persona, named, desc, model, saveTo }. `named` is false for a draft, whose name can still
  // be typed; a reviewer that is stored or in the panel keeps its name.
  let sel = null;
  let filter = '';
  let touched = false; // the author did something here that closing would throw away
  dlgGuard = () => (touched ? 'Close the AI review dialog? The panel you set up will be lost.' : '');
  const inPanel = (name) => panel.find((p) => p.persona === name);
  const isSel = (name) => Boolean(sel?.named) && sel.persona === name;
  // What the panel runs for a description: the stored reviewer when it is the stored one, else these words.
  const defFor = (name, desc) => { const r = byName(name); return r && desc.trim() === storedDesc(r) ? null : { background: desc.trim() }; };

  const panelBox = h('div', { class: 'rv-group' });
  const libBox = h('div', { class: 'rv-group' });
  const filterInput = h('input', { type: 'search', class: 'rv-filter', placeholder: 'Filter reviewers…', 'aria-label': 'Filter reviewers' });
  filterInput.addEventListener('input', () => { filter = filterInput.value.trim().toLowerCase(); drawLibrary(); });
  // Escape empties the filter first; only an empty one lets it through to close the dialog.
  filterInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !filterInput.value) return;
    e.stopPropagation();
    filterInput.value = ''; filter = ''; drawLibrary();
  });
  const left = h('div', { class: 'rv-left' },
    panelBox,
    h('div', { class: 'rv-label rv-label-row' }, 'Library',
      h('button', { class: 'small', title: 'Describe a reviewer of your own', onclick: () => openNew() }, '+ New reviewer')),
    filterInput,
    libBox);
  const right = h('div', { class: 'rv-edit' });
  const actions = h('div', { class: 'rv-actions' });
  const models = h('div', { class: 'rv-models' });

  // A reviewer opens as the panel will run it when it is in the panel, as stored otherwise. It is saved
  // back to where it is kept; one that is kept nowhere yet (a starter, a new one) goes where the last went.
  const open = (name) => {
    const p = inPanel(name); const r = byName(name);
    sel = {
      persona: name, named: true,
      desc: p?.def ? p.def.background : (r ? storedDesc(r) : ''),
      model: p ? p.model : (r?.model || ''),
      saveTo: r?.source === 'project' || r?.source === 'user' ? r.source : defaultSaveTo(),
    };
    draw();
  };
  // A draft: empty, or started from another reviewer ("Duplicate").
  const openNew = (from) => {
    sel = { persona: '', named: false, desc: from?.desc || '', model: from?.model || '', saveTo: defaultSaveTo() };
    draw();
  };
  // Does the editor hold something the panel wouldn't run? Edits to a reviewer in the panel apply as they
  // are typed, so this is only about a draft, or a reviewer edited without being in the panel.
  const unapplied = () => {
    if (!sel) return false;
    if (!sel.named) return Boolean(sel.persona.trim() || sel.desc.trim());
    if (inPanel(sel.persona)) return false;
    const r = byName(sel.persona);
    return !r || sel.desc.trim() !== storedDesc(r) || sel.model !== (r.model || '');
  };
  // Before the editor's reviewer goes into the panel or a library: it needs a description, and a draft a
  // name nobody else has.
  const settle = () => {
    const name = sel.persona.trim();
    if (!name || !sel.desc.trim()) { toast('Give the reviewer a name and a description', true); return false; }
    if (!sel.named && (byName(name) || inPanel(name))) { toast(`"${name}" already exists. Pick another name, or edit that one.`, true); return false; }
    sel.persona = name;
    return true;
  };
  // Into the panel: the reviewer in the editor goes as the editor shows it, any other one as stored.
  const putSel = () => {
    if (!settle()) { draw(); return; } // draw: a ticked box that added nothing is unticked again
    sel.named = true;
    panel.push({ persona: sel.persona, model: sel.model, def: defFor(sel.persona, sel.desc) });
    touched = true;
    draw();
  };
  const put = (name) => {
    if (isSel(name)) { putSel(); return; }
    panel.push(asStored(byName(name)));
    touched = true;
    draw();
  };
  // Out of the panel. One that is kept nowhere else stays in the editor as a draft, so a slip loses nothing.
  const drop = (name) => {
    panel = panel.filter((p) => p.persona !== name);
    if (isSel(name) && !byName(name)) sel.named = false;
    touched = true;
    draw();
  };
  // Save the editor's reviewer to the library picked under "Save to". Saving puts nobody in the panel; a
  // reviewer that is in it already runs as saved from here on.
  const save = async () => {
    if (!settle()) return;
    const name = sel.persona; const scope = sel.saveTo;
    try {
      await api('PUT', '/api/reviewers', { persona: name, background: sel.desc.trim(), model: sel.model, scope });
      reg = await api('GET', '/api/reviewers');
    } catch (e) { toast(e.message, true); return; }
    rememberSaveTo(scope);
    sel.named = true;
    const p = inPanel(name);
    if (p) p.def = defFor(name, sel.desc);
    draw();
    // The project's reviewer of that name wins over the author's own: say so, or the save looks lost.
    toast(byName(name)?.source === scope ? `Saved to ${SAVED_TO[scope]}` : `Saved to ${SAVED_TO[scope]}. Here the project's own "${name}" still applies.`);
  };
  // Take the reviewer out of the library it is listed from.
  const remove = async () => {
    const name = sel.persona; const scope = byName(name).source;
    if (!(await ask(`Remove "${name}" from ${SAVED_TO[scope]}?`, { ok: 'Remove', danger: true }))) return;
    try {
      await api('DELETE', `/api/reviewers/${encodeURIComponent(name)}?scope=${scope}`);
      reg = await api('GET', '/api/reviewers');
    } catch (e) { toast(e.message, true); return; }
    if (byName(name)) open(name); // another one of that name is back: the author's own, or a starter
    else { panel = panel.filter((p) => p.persona !== name); sel = null; draw(); }
    toast(`Removed from ${SAVED_TO[scope]}`);
  };

  // A library as a file: someone else imports it, or saves it as their own reviewers.json.
  const exportLibrary = (scope) => {
    if (!reg.reviewers.some((r) => r.source === scope)) { toast(`Nothing is saved in ${SAVED_TO[scope]} yet`, true); return; }
    h('a', { href: `/api/reviewers/export?scope=${scope}`, download: 'reviewers.json' }).click();
  };
  // Such a file, merged into a library: reviewers of the same name are replaced, the rest stays.
  const importLibrary = (scope) => {
    const input = h('input', { type: 'file', accept: '.json,application/json' });
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      let data;
      try { data = JSON.parse(await file.text()); } catch { toast(`${file.name} is not a JSON file`, true); return; }
      const lists = Array.isArray(data) ? [data] : Object.values(data && typeof data === 'object' ? data : {}).filter(Array.isArray);
      const names = [...new Set(lists.flat().map((r) => String(r?.persona || '').trim()).filter(Boolean))];
      if (!names.length) { toast(`No reviewers in ${file.name}`, true); return; }
      const replaced = names.filter((n) => byName(n)?.source === scope).length;
      const question = `Import ${names.length} reviewer(s) from ${file.name} into ${SAVED_TO[scope]}?`
        + (replaced ? ` ${replaced} of them replace(s) a reviewer of the same name.` : '');
      if (!(await ask(question, { ok: 'Import' }))) return;
      let done;
      try {
        done = await api('POST', '/api/reviewers/import', { scope, data });
        reg = await api('GET', '/api/reviewers');
      } catch (e) { toast(e.message, true); return; }
      draw();
      toast(`Imported into ${SAVED_TO[scope]}: ${done.added} new, ${done.updated} replaced`);
    });
    input.click();
  };

  // Two rows under the editor: the panel (does this reviewer run), and the libraries (where is it kept).
  const drawActions = () => {
    const r = sel.named ? byName(sel.persona) : null;
    const p = sel.named ? inPanel(sel.persona) : null;
    const scopes = hasProject() ? ['project', 'user'] : ['user'];
    const kept = Boolean(r) && r.source === sel.saveTo; // "Save" writes over the reviewer being shown
    const same = kept && sel.desc.trim() === storedDesc(r) && sel.model === (r.model || '');
    actions.replaceChildren(
      h('div', { class: 'rv-row' },
        p ? h('button', { onclick: () => drop(sel.persona) }, 'Remove from panel') : h('button', { class: 'primary', onclick: putSel }, 'Add to panel'),
        p?.def ? h('span', { class: 'muted rv-note' }, r ? 'Runs as edited here, with this document only.' : 'Not saved: runs with this document only.') : null),
      h('div', { class: 'rv-row' },
        h('span', { class: 'rv-label' }, 'Save to'),
        scopes.length > 1
          ? h('div', { class: 'rv-models' }, ...scopes.map((s) => h('button', {
            class: s === sel.saveTo ? 'on' : '', title: reg.libraries[s].file, onclick: () => { sel.saveTo = s; drawActions(); },
          }, SCOPE_LABEL[s])))
          : h('span', { class: 'rv-tag', title: reg.libraries?.user?.file }, SCOPE_LABEL.user),
        h('button', { disabled: same, title: same ? 'Nothing to save: it is stored like this' : null, onclick: save }, kept ? 'Update' : 'Save'),
        r?.source === 'project' || r?.source === 'user'
          ? h('button', { class: 'small ghost rv-remove', onclick: remove }, r.source === 'project' ? 'Remove from project' : 'Remove from library') : null));
  };
  // The model, and for a reviewer in the panel that is the model it runs on: no "apply" step.
  const drawModels = () => models.replaceChildren(...reg.models.map((m) => h('button', {
    class: m === sel.model ? 'on' : '',
    onclick: () => {
      sel.model = m; touched = true;
      const p = sel.named && inPanel(sel.persona);
      if (p) { p.model = m; drawPanel(); }
      drawModels(); drawActions();
    },
  }, modelLabel(m))));
  const drawRight = () => {
    if (!sel) { right.replaceChildren(h('p', { class: 'muted' }, 'Tick a reviewer to put it in the panel. Select one to read or edit it, or create a new one.')); return; }
    let head;
    if (!sel.named) {
      head = h('input', { type: 'text', placeholder: 'Name, e.g. Security Reviewer', maxlength: 60 });
      head.value = sel.persona;
      head.addEventListener('input', () => { sel.persona = head.value; touched = true; });
    } else {
      const r = byName(sel.persona);
      head = h('div', { class: 'rv-head' }, h('b', {}, sel.persona), h('span', { class: 'rv-tag' }, r ? SOURCE_TAG[r.source] : 'not saved'),
        h('button', { class: 'small ghost rv-dup', title: 'Start a new reviewer from this one', onclick: () => openNew(sel) }, 'Duplicate'));
    }
    const desc = h('textarea', { placeholder: 'Who they are and what they look for…' });
    desc.value = sel.desc;
    desc.addEventListener('input', () => {
      sel.desc = desc.value; touched = true;
      // In the panel already: it runs as typed, from this keystroke on.
      const p = sel.named && inPanel(sel.persona);
      if (p) { p.def = defFor(sel.persona, sel.desc); drawPanel(); }
      drawActions();
    });
    drawModels(); drawActions();
    right.replaceChildren(head, desc, h('div', { class: 'rv-label' }, 'Model'), models, actions);
    if (!sel.named && !sel.persona) head.focus();
  };
  // The model a panel member runs on, picked on its row.
  const modelSelect = (p) => {
    const s = h('select', { class: 'rv-model', title: 'The model this reviewer runs on', onclick: (e) => e.stopPropagation() },
      ...reg.models.map((m) => h('option', { value: m, selected: m === p.model }, modelLabel(m))));
    // A model the list doesn't know (hand-written in a reviewers file) stays what it is.
    if (!reg.models.includes(p.model)) s.prepend(h('option', { value: p.model, selected: true }, p.model));
    s.addEventListener('change', () => {
      p.model = s.value; touched = true;
      if (isSel(p.persona)) { sel.model = s.value; drawRight(); }
    });
    return s;
  };
  const drawPanel = () => panelBox.replaceChildren(
    h('div', { class: 'rv-label' }, `Panel (${panel.length})`),
    ...(panel.length ? panel.map((p) => h('div', { class: `rv-item${isSel(p.persona) ? ' on' : ''}`, onclick: () => open(p.persona) },
      h('span', { class: 'rv-name' }, p.persona),
      p.def ? h('span', { class: 'rv-tag rv-unsaved', title: 'Its description is saved nowhere: it runs with this document only' }, byName(p.persona) ? 'edited' : 'not saved') : null,
      modelSelect(p),
      h('button', { class: 'small ghost', title: 'Remove from the panel', onclick: (e) => { e.stopPropagation(); drop(p.persona); } }, '✕')))
      : [h('p', { class: 'muted rv-empty' }, 'Nobody in the panel yet. Tick reviewers in the library below, or create your own.')]),
    h('p', { class: 'muted rv-hint' }, 'Each reviewer runs as its own subagent. There is no upper limit, but 2–5 usually cover a document; every extra one costs time and tokens.'));
  const drawLibrary = () => {
    const match = (r) => !filter || `${r.persona}\n${r.background}\n${(r.focus || []).join('\n')}`.toLowerCase().includes(filter);
    const row = (r) => {
      const box = h('input', { type: 'checkbox', title: 'In the panel', 'aria-label': `${r.persona}: in the panel` });
      box.checked = Boolean(inPanel(r.persona));
      box.addEventListener('click', (e) => e.stopPropagation());
      box.addEventListener('change', () => (box.checked ? put(r.persona) : drop(r.persona)));
      return h('div', { class: `rv-item${isSel(r.persona) ? ' on' : ''}`, onclick: () => open(r.persona) },
        box, h('span', { class: 'rv-name', title: r.background }, r.persona),
        r.suggested ? h('span', { class: 'rv-tag', title: 'In the default panel for this document' }, 'default') : null,
        // A starter says which kind of document it is for, any other one its own model.
        h('span', { class: 'rv-tag' }, r.source === 'built-in' ? r.profile : (r.model || '')));
    };
    // One part of the library: its heading, what can be done with all of it, its reviewers (the default
    // panel first), or a line saying what it is for while it is empty.
    const group = (source, label, { file, empty } = {}) => {
      const all = reg.reviewers.filter((r) => r.source === source);
      const shown = all.filter(match).sort((a, b) => Number(b.suggested) - Number(a.suggested) || a.persona.localeCompare(b.persona));
      if (filter ? !shown.length : (!all.length && !empty)) return [];
      return [
        h('div', { class: 'rv-sub' }, h('span', { class: 'rv-sub-name', title: file || null }, `${label} (${all.length})`),
          file ? h('button', { class: 'small ghost', title: `Merge a reviewers.json file into ${SAVED_TO[source]}`, onclick: () => importLibrary(source) }, 'Import') : null,
          file ? h('button', { class: 'small ghost', title: `Download ${SAVED_TO[source]} as reviewers.json, to share`, onclick: () => exportLibrary(source) }, 'Export') : null),
        ...(shown.length ? shown.map(row) : [h('p', { class: 'muted rv-empty' }, empty)]),
      ];
    };
    const { project, user } = reg.libraries || {};
    const rows = [
      ...group('review', 'This document'),
      ...(project ? group('project', `This project: ${project.name}`, { file: project.file, empty: 'No reviewers kept with this project yet. One saved here is in a file in the project, for everyone who works in it.' }) : []),
      ...group('user', 'Yours', { file: user?.file, empty: 'Nothing saved yet. A reviewer saved here is yours in every project.' }),
      ...group('built-in', 'Starters'),
    ];
    libBox.replaceChildren(...(rows.length ? rows : [h('p', { class: 'muted rv-empty' }, `No reviewer matches "${filterInput.value.trim()}".`)]));
  };
  function draw() {
    drawPanel(); drawLibrary(); drawRight();
    // No reviewers, no review: the button says why it is off.
    send.disabled = !panel.length;
    send.title = panel.length ? '' : 'Add at least one reviewer to the panel';
  }

  const note = h('textarea', { placeholder: 'Note for the reviewers (optional), e.g. what to focus on…' });
  note.addEventListener('input', () => { touched = true; });
  const send = sendButton('Start AI review', 'AI review requested', async () => {
    if (!panel.length) { toast('Add at least one reviewer to the panel', true); return null; }
    const blank = panel.find((p) => p.def && !p.def.background);
    if (blank) { toast(`"${blank.persona}" needs a description`, true); return null; }
    if (unapplied() && !(await ask(`"${sel.persona.trim() || 'The new reviewer'}" is not in the panel as you edited it. Start without it?`,
      { ok: 'Start without it', cancel: 'Go back' }))) return null;
    return {
      mode: 'review',
      note: note.value.trim(),
      reviewers: panel.filter((p) => !p.def).map((p) => ({ persona: p.persona, model: p.model || 'session' })),
      custom: panel.filter((p) => p.def).map((p) => ({ persona: p.persona, background: p.def.background, focus: [], model: p.model })),
    };
  });

  const sev = (name, means) => h('li', {}, h('span', { class: `pill sev sev-${name}` }, name), ` ${means}`);
  const help = h('div', { class: 'rv-help', hidden: true },
    h('ol', {},
      h('li', {}, "Every reviewer in the panel runs as its own subagent, all at the same time, each on the model you picked. They read the whole document and don't see each other's findings."),
      h('li', {}, 'Each one reports what it finds from its own angle, and gives every finding a severity:',
        h('ul', {}, sev('BLOCKER', "can't go ahead as written"), sev('MAJOR', 'a real problem'), sev('MINOR', 'worth fixing'), sev('NITPICK', 'taste')),
        'A reviewer with nothing to say reports nothing.'),
      h('li', {}, 'Claude merges findings that make the same point about the same text into one comment. It names every reviewer who raised it and keeps the highest severity. Opposing views stay separate.'),
      h('li', {}, 'All findings arrive together, as comments in the next round. The document itself is not changed.'),
      h('li', {}, 'You approve or decline each comment, or ignore it for now, then press Submit round to have Claude fix what you approved.')));
  const helpBtn = h('button', { class: 'ghost small', title: 'How an AI review works', onclick: () => { help.hidden = !help.hidden; } }, '?');

  draw();
  showDialog(
    h('h3', { class: 'rv-title' }, 'AI review', helpBtn),
    h('p', { class: 'muted' }, 'The reviewers in the panel read the document as it is now. Their findings arrive as comments in the next round.'),
    help,
    toFix ? h('p', { class: 'muted' }, `Your ${toFix} pending item(s) stay as they are until you press Submit round.`) : null,
    h('div', { class: 'rv-panes' }, left, right), note,
    h('div', { class: 'row' }, h('button', { onclick: closeSubmit }, 'Cancel'), send));
  dlg.firstChild.classList.add('wide');
}
$('#submit-btn').addEventListener('click', openSubmitDialog);
$('#review-btn').addEventListener('click', openReviewDialog);
$('#approve-btn').addEventListener('click', openApproveDialog);
// Close on a click that both starts and ends on the backdrop: a text selection dragged out of the card must not.
let pressedBackdrop = false;
dlg.addEventListener('mousedown', (e) => { pressedBackdrop = e.target === dlg; });
dlg.addEventListener('click', (e) => { if (e.target === dlg && pressedBackdrop) dismissDialog(); });

// ---------- keyboard ----------
document.addEventListener('keydown', (e) => {
  // A question is open: it takes the keyboard. Escape answers no, Tab stays on its two buttons, Enter and
  // Space press the focused one as on any button, and no shortcut reaches what is behind it.
  if (askDone) {
    if (e.key === 'Escape') { e.preventDefault(); closeAsk(false); }
    else if (e.key === 'Tab') {
      e.preventDefault();
      const btns = [...askEl.querySelectorAll('button')];
      btns[(btns.indexOf(document.activeElement) + 1) % btns.length].focus();
    }
    return;
  }
  if (e.target.closest('textarea, input, select') || e.metaKey || e.ctrlKey || e.altKey) {
    if (e.key === 'Escape' && !dlg.hidden && !e.target.closest('.rv-edit')) dismissDialog();
    return;
  }
  if (!dlg.hidden && e.key !== 'Escape') return;
  const id = ui.selected;
  const c = id && byId(id);
  const k = e.key;
  if (k === 'Escape') { $('#help').hidden = true; if (!dlg.hidden) dismissDialog(); closePopover(); if (ui.form) closeForm(); $('#sel-btn').hidden = true; return; }
  if (k === '?') { $('#help').hidden = !$('#help').hidden; return; }
  if (!stageEl.hidden) return; // the stage is up: no comment is on screen to move to or decide on
  if (k === 'j') return move(1);
  if (k === 'k') return move(-1);
  if (k === 'c') { const a = selectionAnchor(); if (a) { e.preventDefault(); newComment(a, window.getSelection().getRangeAt(0).getBoundingClientRect()); } return; }
  if (!c) return;
  if (k === 'a') decide(id, 'approve');
  else if (k === 'A') { e.preventDefault(); if (c.author === 'ai' && c.status === 'open' && !c.decision) openForm(id, 'approve'); }
  else if (k === 'd') decide(id, 'decline');
  else if (k === 'i') decide(id, 'ignore');
  else if (k === 'u') decide(id, 'clear');
  else if (k === 'r' && !readOnly()) act(() => api('POST', `/api/comments/${id}/${c.status === 'resolved' ? 'reopen' : 'resolve'}`));
  else if (k === 'y' && c.suggestion) copy(c.suggestion);
});

// ---------- live updates ----------
const es = new EventSource('/api/events');
es.addEventListener('change', scheduleLoad);
es.onerror = () => { /* server stopped or restarting; EventSource retries */ };

load();
