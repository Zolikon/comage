import { normalizeWs, findQuote, makeTextAnchor, wordDiff } from '/lib/text.mjs';

const SEVS = ['BLOCKER', 'MAJOR', 'MINOR', 'NITPICK'];
const SEV_RANK = { USER: 0, NITPICK: 1, MINOR: 2, MAJOR: 3, BLOCKER: 4 };
const $ = (s) => document.querySelector(s);
const docEl = $('#doc');
const wrapEl = $('#doc-wrap');

const ui = {
  data: null, view: null, base: null, baseRound: null, viewRound: null,
  diff: true, sev: new Set(), status: 'active', reviewer: '',
  selected: null, form: null, // form: { id, kind: approve|decline|reply|new, text, anchor? }
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
        ui.data = fresh;
        const rounds = ui.data.review.rounds;
        if (ui.viewRound !== null && !rounds.some((r) => r.n === ui.viewRound && r.publishedAt)) ui.viewRound = null;
        ui.view = isPast() ? await snapshot(ui.viewRound) : ui.data.article;
        const b = viewedRound() - 1;
        ui.baseRound = b >= 1 && rounds.find((r) => r.n === b)?.publishedAt ? b : null;
        ui.base = ui.baseRound ? await snapshot(ui.baseRound) : null;
        // Diff base text comes from the same DOM walk as the live article, so both sides agree.
        ui.basePlain = ui.base ? buildIndex(new DOMParser().parseFromString(`<body>${ui.base.html}</body>`, 'text/html').body).plain : '';
        render();
      } catch (e) { toast(e.message, true); }
    } while (loading.again);
  })();
  const p = loading.p;
  await p;
  loading = null;
  return p;
}
let reloadTimer;
const scheduleLoad = () => { clearTimeout(reloadTimer); reloadTimer = setTimeout(load, 80); };

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
  return { nodes, plain, map, rawLen: raw };
}

// Wrap raw intervals [{a,b,ids?,ins?}] and insert deletion markers [{at,text}] in one pass.
function applyMarks(index, intervals, points) {
  for (const info of index.nodes) {
    const s0 = info.rawStart; const e0 = s0 + info.len;
    const iv = intervals.filter((x) => x.a < e0 && x.b > s0);
    const isLast = info === index.nodes[index.nodes.length - 1];
    const pts = points.filter((p) => (p.at >= s0 && p.at < e0) || (isLast && p.at === e0));
    if (!iv.length && !pts.length) continue;
    // Whitespace between <tr>/<td>/<li> must not get <mark>/<ins> wrappers (invalid structure).
    if (!info.node.data.trim() && info.node.parentElement?.matches('table, thead, tbody, tfoot, tr, ul, ol')) continue;
    const cuts = new Set([s0, e0]);
    for (const x of iv) { cuts.add(Math.max(s0, x.a)); cuts.add(Math.min(e0, x.b)); }
    for (const p of pts) cuts.add(p.at);
    const bounds = [...cuts].sort((a, b) => a - b);
    const frag = document.createDocumentFragment();
    for (let k = 0; k < bounds.length; k++) {
      const s = bounds[k];
      for (const p of pts.filter((q) => q.at === s)) frag.append(h('span', { class: 'rw-del', title: `Removed: ${p.text}` }));
      if (k === bounds.length - 1) break;
      const e = bounds[k + 1];
      let el = document.createTextNode(info.node.data.slice(s - s0, e - s0));
      const cover = iv.filter((x) => x.a <= s && x.b >= e);
      if (cover.some((x) => x.ins)) el = h('ins', { class: 'rw-ins' }, el);
      const ids = cover.filter((x) => x.id).map((x) => x.id);
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

// ---------- filters ----------
function passes(c) {
  if (c.round > viewedRound()) return false;
  if (ui.sev.size && !ui.sev.has(sevKey(c))) return false; // no chip picked = all severities
  if (ui.reviewer && !c.reviewers.includes(ui.reviewer)) return false;
  switch (ui.status) {
    case 'active': return c.status !== 'resolved';
    case 'needs': return c.author === 'ai' && c.status === 'open' && !c.decision;
    case 'all': return true;
    default: return c.status === ui.status;
  }
}

// ---------- render ----------
function render() {
  const review = ui.data.review;
  const L = latest();
  document.title = `ReWriter: ${ui.view?.title || review.article}`;
  $('#doc-title').textContent = ui.view?.title || review.article;
  document.body.classList.toggle('read-only', readOnly());
  // The round is with Claude (handed over, or being worked on): nothing may change until it publishes.
  const withClaude = !isPast() && (L.status === 'submitted' || L.status === 'preparing');
  if (readOnly()) {
    // Close whatever could still send a change: the round dialogs, a comment or reply form, the "Comment" button.
    if (!dlg.hidden) closeSubmit();
    if (ui.form) { if (ui.form.kind === 'new') closePopover(); ui.form = null; }
    $('#sel-btn').hidden = true;
  }
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
  st.textContent = isPast() ? 'snapshot' : ({ submitted: 'Waiting for Claude', preparing: 'Claude is working' }[L.status] || L.status);
  st.className = `pill st-${isPast() ? 'past' : L.status}${withClaude ? ' working' : ''}`;

  $('#diff-wrap').hidden = !ui.base; // no previous round: nothing to diff against
  $('#diff-toggle').checked = Boolean(ui.base) && ui.diff;
  $('#diff-label').textContent = ui.base ? `Changes since round ${ui.baseRound}` : 'Changes';

  const unresolved = review.comments.filter((c) => c.status !== 'resolved' && c.round <= viewedRound());
  $('#counts').replaceChildren(...[...SEVS, 'USER'].map((s) => {
    const n = unresolved.filter((c) => sevKey(c) === s).length;
    return h('span', { class: `pill sev sev-${s}${n ? '' : ' zero'}`, title: `${n} unresolved ${s === 'USER' ? 'from you' : s}` }, `${s === 'USER' ? 'You' : s} ${n}`);
  }));
  $('#submit-btn').disabled = readOnly();
  $('#review-btn').disabled = readOnly();

  const banner = $('#banner');
  const prev = review.rounds[review.rounds.length - 2]; // the round whose request Claude is working on
  let msg = '';
  let info = false;
  if (ui.view?.error) msg = `Document could not be loaded: ${ui.view.error}`;
  else if (isPast()) msg = `Viewing the round ${ui.viewRound} snapshot (read-only). Comments show their current status.`;
  else if (L.status === 'preparing') {
    info = reqMode(prev?.request) === 'review';
    msg = info ? `AI review running: ${names(prev.request)}. Findings appear here when they are done.`
      : `Claude is preparing round ${L.n}. Read-only until it publishes.`;
  } else if (L.status === 'submitted') {
    info = true;
    const pickup = 'Claude picks it up if it is waiting; otherwise tell it to continue.';
    msg = reqMode(L.request) === 'review' ? `AI review requested: ${names(L.request)}. ${pickup}`
      : `Round ${L.n} submitted. Asked for fixes only. ${pickup}`;
  }
  banner.hidden = !msg; banner.textContent = msg;
  banner.className = [info ? 'info' : '', withClaude ? 'busy' : ''].join(' ').trim();

  renderChips();
  renderDoc();
  renderSidebar();
  renderPopover();
}

function renderChips() {
  $('#sev-chips').replaceChildren(...[...SEVS, 'USER'].map((s) => h('button', {
    class: `chip sev-${s}${ui.sev.has(s) ? ' on' : ''}${ui.sev.size && !ui.sev.has(s) ? ' dim' : ''}`,
    'aria-pressed': ui.sev.has(s) ? 'true' : 'false',
    title: ui.sev.has(s) ? 'Click to stop filtering by this' : `Show only ${s === 'USER' ? 'your comments' : s}`,
    onclick: () => { if (ui.sev.has(s)) ui.sev.delete(s); else ui.sev.add(s); render(); },
  }, s === 'USER' ? 'You' : s)));
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
  const rawAt = (i) => (i < map.length ? map[i] : index.rawLen);

  const intervals = [];
  const points = [];
  if (ui.base && ui.diff) {
    let pos = 0;
    for (const op of wordDiff(ui.basePlain, index.plain)) {
      if (op.op === 'del') { points.push({ at: rawAt(pos), text: op.text }); continue; }
      if (op.op === 'ins') intervals.push({ a: rawAt(op.bStart), b: map[op.bEnd - 1] + 1, ins: true });
      pos = op.bEnd;
    }
  }

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
  applyMarks(index, intervals, points);
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
const DECISION_LABEL = { approve: 'Approved', decline: 'Declined', ignore: 'Ignored' };

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
    c.status !== 'open' ? h('span', { class: 'pill' }, c.decision?.type === 'ignore' ? 'ignored' : c.status) : null,
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

  if (c.decision) {
    const hint = { approve: ' · Claude applies it next round', decline: ' · Claude accepts or challenges next round', ignore: '' }[c.decision.type];
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
        btn('Decline + comment', 'decline', () => openForm(c.id, 'decline'), 'D');
        btn('Ignore', '', () => decide(c.id, 'ignore'), "i: won't act, resolves it");
      } else btn('Undo decision', '', () => decide(c.id, 'clear'), 'u');
    }
    if (c.status !== 'resolved') {
      btn('Reply', '', () => openForm(c.id, 'reply'), 'R');
      btn('Resolve', '', () => act(() => api('POST', `/api/comments/${c.id}/resolve`), 'Resolved'), 'r');
    } else btn('Reopen', '', () => act(() => api('POST', `/api/comments/${c.id}/reopen`)), 'r');
    if (c.author === 'user' && !c.thread.some((t) => t.author === 'ai')) {
      btn('Delete', 'decline', () => { if (confirm('Delete this comment?')) act(() => api('DELETE', `/api/comments/${c.id}`)); });
    }
    card.append(acts);
  }
  return card;
}

function formEl(where) {
  const f = ui.form;
  const placeholder = { approve: 'Approve, with a note for Claude…', decline: 'Why decline? Claude reads this next round…', reply: 'Reply…', new: 'Your comment for Claude…' }[f.kind];
  const ta = h('textarea', { placeholder, 'data-where': where });
  ta.value = f.text || '';
  ta.addEventListener('input', () => { f.text = ta.value; });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendForm(); }
    if (e.key === 'Escape') { e.preventDefault(); closeForm(); }
  });
  const label = { approve: 'Approve', decline: 'Decline', reply: 'Send reply', new: 'Add comment' }[f.kind];
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
  if ((f.kind === 'reply' || f.kind === 'new') && !text) { toast('Write something first', true); return; }
  try {
    if (f.kind === 'new') {
      const c = await api('POST', '/api/comments', { anchor: f.anchor, body: text });
      ui.selected = c.id;
      ui.form = null;
      closePopover();
      toast('Comment added');
    } else {
      if (f.kind === 'reply') await api('POST', `/api/comments/${f.id}/reply`, { body: text });
      else await api('POST', `/api/comments/${f.id}/decision`, { type: f.kind, note: text });
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
  act(() => api('POST', `/api/comments/${id}/decision`, { type }), { approve: 'Approved', decline: 'Declined', ignore: 'Ignored (resolved)' }[type]);
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
window.addEventListener('resize', () => { renderBubbles(); });

// ---------- header controls ----------
$('#round-select').addEventListener('change', (e) => {
  const n = Number(e.target.value);
  ui.viewRound = n === latest().n ? null : n;
  closePopover(); ui.form = null;
  load();
});
$('#diff-toggle').addEventListener('change', (e) => { ui.diff = e.target.checked; render(); });
$('#status-filter').addEventListener('change', (e) => { ui.status = e.target.value; render(); });
$('#reviewer-filter').addEventListener('change', (e) => { ui.reviewer = e.target.value; render(); });
$('#new-general').addEventListener('click', (e) => newComment({ kind: 'article' }, e.target.getBoundingClientRect()));
$('#help-btn').addEventListener('click', () => { $('#help').hidden = false; });
$('#help').addEventListener('click', () => { $('#help').hidden = true; });
// ---------- ending a round: "Submit round" (Claude fixes) or "AI review" (reviewers read, nothing is fixed) ----------
const dlg = $('#submit-dlg');
const closeSubmit = () => { dlg.hidden = true; dlg.replaceChildren(); };
const modelLabel = (m) => (m || 'session');

// toFix: what Claude would act on after "Submit round". undecided: reviewer comments with no decision yet.
function pendingCounts() {
  const cs = ui.data.review.comments;
  return {
    undecided: cs.filter((c) => c.author === 'ai' && c.status === 'open' && !c.decision).length,
    toFix: cs.filter((c) => c.status !== 'resolved' && (c.decision?.type === 'approve' || c.decision?.type === 'decline'
      || (c.author === 'user' && !c.thread.some((t) => t.author === 'ai')) || c.thread[c.thread.length - 1]?.author === 'user')).length,
  };
}

function showDialog(...children) {
  dlg.replaceChildren(h('div', { class: 'help-card submit-card', onclick: (e) => e.stopPropagation() }, ...children));
  dlg.hidden = false;
}

// Posts the request that ends the round; `body` is a function so it is read at click time.
function sendButton(label, done, body) {
  const send = h('button', { class: 'primary', onclick: async () => {
    const payload = body();
    if (!payload) return;
    send.disabled = true;
    try { await api('POST', '/api/submit', payload); } catch (e) { toast(e.message, true); send.disabled = false; return; }
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

// The AI review dialog is a small workbench: the panel (who runs), the library (who exists) and an editor
// for the selected reviewer. Reviewers can be saved to the author's library or used with this document only.
const SOURCE_TAG = { review: 'this document', user: 'yours', 'built-in': 'starter' };
const SOURCE_ORDER = ['review', 'user', 'built-in'];
// What the editor shows for a stored reviewer: its background, then its focus points as bullets.
const storedDesc = (r) => [r.background, ...(r.focus || []).map((f) => `- ${f}`)].join('\n').trim();

async function openReviewDialog() {
  if (readOnly()) return;
  let reg;
  try { reg = await api('GET', '/api/reviewers'); } catch (e) { toast(e.message, true); return; }
  closePopover(); ui.form = null;
  const { toFix } = pendingCounts();
  const byName = (name) => reg.reviewers.find((r) => r.persona === name);

  // panel: [{ persona, model, def }]. def is null for a reviewer used as stored, or { background } for one
  // used with a description that isn't saved anywhere yet.
  let panel = (reg.last || []).filter((p) => byName(p.persona))
    .map((p) => ({ persona: p.persona, model: p.model || byName(p.persona).model || '', def: null }));
  let sel = null; // the editor: { persona, isNew, desc, model }
  const inPanel = (name) => panel.find((p) => p.persona === name);
  const putInPanel = (entry) => {
    const i = panel.findIndex((p) => p.persona === entry.persona);
    if (i < 0) panel.push(entry); else panel[i] = entry;
  };

  const left = h('div', { class: 'rv-left' });
  const right = h('div', { class: 'rv-edit' });
  const actions = h('div', { class: 'rv-actions' });
  const models = h('div', { class: 'rv-models' });

  const openStored = (name) => { const r = byName(name); sel = { persona: name, isNew: false, desc: storedDesc(r), model: r.model || '' }; draw(); };
  const openFromPanel = (name) => {
    const p = inPanel(name); const r = byName(name);
    sel = { persona: name, isNew: !r, desc: p.def ? p.def.background : storedDesc(r), model: p.model };
    draw();
  };
  // Does the editor hold something the panel wouldn't run as shown?
  const unapplied = () => {
    if (!sel) return false;
    const name = sel.persona.trim(); const p = inPanel(name); const r = byName(name);
    if (!p && !r) return Boolean(name || sel.desc.trim());
    const desc = p?.def ? p.def.background : storedDesc(r);
    const model = p ? p.model : (r.model || '');
    return sel.desc.trim() !== desc || sel.model !== model;
  };
  const valid = () => {
    const name = sel.persona.trim();
    if (!name || !sel.desc.trim()) { toast('Give the reviewer a name and a description', true); return false; }
    if (sel.isNew && byName(name)) { toast(`"${name}" already exists. Opened it.`); openStored(name); return false; }
    return true;
  };
  const use = () => {
    if (!valid()) return;
    const name = sel.persona.trim(); const r = byName(name); const desc = sel.desc.trim();
    putInPanel({ persona: name, model: sel.model, def: !r || desc !== storedDesc(r) ? { background: desc } : null });
    sel.persona = name;
    draw();
  };
  const save = async () => {
    if (!valid()) return;
    const name = sel.persona.trim(); const { model } = sel;
    try {
      await api('PUT', '/api/reviewers', { persona: name, background: sel.desc.trim(), model });
      reg = await api('GET', '/api/reviewers');
    } catch (e) { toast(e.message, true); return; }
    putInPanel({ persona: name, model, def: null });
    sel = { persona: name, isNew: false, desc: storedDesc(byName(name)), model };
    draw();
    toast('Saved to your library');
  };
  const removeFromLibrary = async () => {
    const name = sel.persona;
    if (!confirm(`Remove "${name}" from your library?`)) return;
    try {
      await api('DELETE', `/api/reviewers/${encodeURIComponent(name)}`);
      reg = await api('GET', '/api/reviewers');
    } catch (e) { toast(e.message, true); return; }
    if (byName(name)) openStored(name); // a starter of that name is back
    else { panel = panel.filter((p) => p.persona !== name); sel = null; draw(); }
    toast('Removed from your library');
  };

  const drawActions = () => {
    const r = sel.isNew ? null : byName(sel.persona);
    const dirty = Boolean(r) && (sel.desc.trim() !== storedDesc(r) || sel.model !== (r.model || ''));
    let btns;
    if (!r) btns = [['Save & use', save, true], ['Use once', use]];
    else if (r.source === 'review') btns = [['Save & use', save], ['Use', use, true]];
    else if (dirty) btns = [['Update & use', save, true], ['Use without updating', use]];
    else btns = [['Use', use, true]];
    actions.replaceChildren(...btns.map(([label, fn, primary]) => h('button', { class: primary ? 'primary' : '', onclick: fn }, label)));
    if (r?.source === 'user') actions.append(h('button', { class: 'small ghost rv-remove', onclick: removeFromLibrary }, 'Remove from library'));
  };
  const drawModels = () => models.replaceChildren(...reg.models.map((m) => h('button', {
    class: m === sel.model ? 'on' : '', onclick: () => { sel.model = m; drawModels(); drawActions(); },
  }, modelLabel(m))));
  const drawRight = () => {
    if (!sel) { right.replaceChildren(h('p', { class: 'muted' }, 'Select a reviewer to see or edit it, or create a new one.')); return; }
    let head;
    if (sel.isNew) {
      head = h('input', { type: 'text', placeholder: 'Name, e.g. Security Reviewer', maxlength: 60 });
      head.value = sel.persona;
      head.addEventListener('input', () => { sel.persona = head.value; });
    } else head = h('div', { class: 'rv-head' }, h('b', {}, sel.persona), h('span', { class: 'rv-tag' }, SOURCE_TAG[byName(sel.persona).source]));
    const desc = h('textarea', { placeholder: 'Who they are and what they look for…' });
    desc.value = sel.desc;
    desc.addEventListener('input', () => { sel.desc = desc.value; drawActions(); });
    drawModels(); drawActions();
    right.replaceChildren(head, desc, h('div', { class: 'rv-label' }, 'Model'), models, actions);
    if (sel.isNew && !sel.persona) head.focus();
  };
  const drawLeft = () => {
    const library = [...reg.reviewers].sort((a, b) => SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source) || a.persona.localeCompare(b.persona));
    const on = (name) => (sel && !sel.isNew && sel.persona === name ? ' on' : '');
    left.replaceChildren(
      h('div', { class: 'rv-label' }, `Panel (${panel.length})`),
      ...(panel.length ? panel.map((p) => h('div', { class: `rv-item${sel && sel.persona === p.persona ? ' on' : ''}`, onclick: () => openFromPanel(p.persona) },
        h('span', { class: 'rv-name' }, p.persona), h('span', { class: 'rv-tag' }, modelLabel(p.model)),
        h('button', { class: 'small ghost', title: 'Remove from the panel', onclick: (e) => { e.stopPropagation(); panel = panel.filter((x) => x !== p); draw(); } }, '✕')))
        : [h('p', { class: 'muted rv-empty' }, 'No reviewers yet. Pick one from the library or create a new one.')]),
      h('div', { class: 'rv-label' }, 'Library'),
      ...library.map((r) => h('div', { class: `rv-item${on(r.persona)}`, onclick: () => openStored(r.persona) },
        h('span', { class: 'rv-check' }, inPanel(r.persona) ? '✓' : ''),
        h('span', { class: 'rv-name' }, r.persona), h('span', { class: 'rv-tag' }, SOURCE_TAG[r.source]))),
      h('button', { class: 'small ghost rv-new', onclick: () => { sel = { persona: '', isNew: true, desc: '', model: '' }; draw(); } }, '+ New reviewer'));
  };
  function draw() { drawLeft(); drawRight(); }

  const note = h('textarea', { placeholder: 'Note for the reviewers (optional), e.g. what to focus on…' });
  const send = sendButton('Start AI review', 'AI review requested', () => {
    if (!panel.length) { toast('Add at least one reviewer to the panel', true); return null; }
    if (unapplied() && !confirm(`"${sel.persona.trim() || 'The new reviewer'}" has changes you have not applied. Start without them?`)) return null;
    return {
      mode: 'review',
      note: note.value.trim(),
      reviewers: panel.filter((p) => !p.def).map((p) => ({ persona: p.persona, model: p.model })),
      custom: panel.filter((p) => p.def).map((p) => ({ persona: p.persona, background: p.def.background, focus: [], model: p.model })),
    };
  });

  draw();
  showDialog(
    h('h3', {}, 'AI review'),
    h('p', { class: 'muted' }, 'The reviewers in the panel read the document as it is now. Their findings arrive as comments in the next round.'),
    toFix ? h('p', { class: 'muted' }, `Your ${toFix} pending item(s) stay as they are until you press Submit round.`) : null,
    h('div', { class: 'rv-panes' }, left, right), note,
    h('div', { class: 'row' }, h('button', { onclick: closeSubmit }, 'Cancel'), send));
  dlg.firstChild.classList.add('wide');
}
$('#submit-btn').addEventListener('click', openSubmitDialog);
$('#review-btn').addEventListener('click', openReviewDialog);
dlg.addEventListener('click', closeSubmit);

// ---------- keyboard ----------
document.addEventListener('keydown', (e) => {
  if (e.target.closest('textarea, input, select') || e.metaKey || e.ctrlKey || e.altKey) {
    if (e.key === 'Escape' && !dlg.hidden && !e.target.closest('.rv-edit')) closeSubmit();
    return;
  }
  if (!dlg.hidden && e.key !== 'Escape') return;
  const id = ui.selected;
  const c = id && byId(id);
  const k = e.key;
  if (k === 'Escape') { $('#help').hidden = true; closeSubmit(); closePopover(); if (ui.form) closeForm(); $('#sel-btn').hidden = true; return; }
  if (k === '?') { $('#help').hidden = !$('#help').hidden; return; }
  if (k === 'j') return move(1);
  if (k === 'k') return move(-1);
  if (k === 'f') { if (ui.base) { ui.diff = !ui.diff; render(); } return; }
  if (k === 'c') { const a = selectionAnchor(); if (a) { e.preventDefault(); newComment(a, window.getSelection().getRangeAt(0).getBoundingClientRect()); } return; }
  if (!c) return;
  if (k === 'a') decide(id, 'approve');
  else if (k === 'A') { e.preventDefault(); if (c.author === 'ai' && c.status === 'open' && !c.decision) openForm(id, 'approve'); }
  else if (k === 'd') decide(id, 'decline');
  else if (k === 'D') { e.preventDefault(); if (c.author === 'ai' && c.status === 'open' && !c.decision) openForm(id, 'decline'); }
  else if (k === 'i') decide(id, 'ignore');
  else if (k === 'u') decide(id, 'clear');
  else if (k === 'R') { e.preventDefault(); if (c.status !== 'resolved') openForm(id, 'reply'); }
  else if (k === 'r' && !readOnly()) act(() => api('POST', `/api/comments/${id}/${c.status === 'resolved' ? 'reopen' : 'resolve'}`));
  else if (k === 'y' && c.suggestion) copy(c.suggestion);
});

// ---------- live updates ----------
const es = new EventSource('/api/events');
es.addEventListener('change', scheduleLoad);
es.onerror = () => { /* server stopped or restarting; EventSource retries */ };

load();
