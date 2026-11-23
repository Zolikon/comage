// Text, anchor and diff utilities shared by the CLI (Node) and the browser UI.
// Keep this file free of Node and DOM APIs: the server serves it to the browser as-is.

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', copy: '©',
  reg: '®', trade: '™', times: '×', larr: '←', rarr: '→',
  harr: '↔', middot: '·', bull: '•', deg: '°', euro: '€',
  rArr: '⇒', lArr: '⇐', hArr: '⇔', uarr: '↑', darr: '↓', check: '✓',
  cross: '✗', frac12: '½', frac14: '¼', frac34: '¾', le: '≤', ge: '≥',
  ne: '≠', plusmn: '±', minus: '−', sect: '§', para: '¶', dagger: '†',
  Dagger: '‡', prime: '′', Prime: '″', shy: '­', ensp: ' ', emsp: ' ',
  thinsp: ' ', zwj: '‍', zwnj: '‌', infin: '∞', asymp: '≈', divide: '÷',
  cent: '¢', pound: '£', yen: '¥', iexcl: '¡', iquest: '¿', sbquo: '‚',
  bdquo: '„', lsaquo: '‹', rsaquo: '›', star: '☆', starf: '★', hearts: '♥',
};

export function normalizeWs(s) {
  return String(s).replace(/\s+/g, ' ');
}

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(cp); } catch { return m; }
    }
    const v = NAMED[e]; // HTML entity names are case-sensitive (&rArr; is not &rarr;)
    return v === undefined ? m : v;
  });
}

// Plain text of rendered HTML, matching what the browser computes from the
// article's text nodes: tags removed, entities decoded, whitespace collapsed, trimmed.
export function plainFromHtml(html) {
  const noTags = String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|template)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<(?:[^>"']|"[^"]*"|'[^']*')*>/g, '');
  return normalizeWs(decodeEntities(noTags)).trim();
}

function allIndexes(hay, needle) {
  const out = [];
  if (!needle) return out;
  let i = hay.indexOf(needle);
  while (i !== -1) { out.push(i); i = hay.indexOf(needle, i + 1); }
  return out;
}

function tailMatch(a, b) { // number of matching chars counted from the end
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

function headMatch(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

const noWs = (x) => x.replace(/\s+/g, '');

// All occurrences of an anchor's quote, best match first. Prefix/suffix are compared with
// whitespace removed, so "Later the" matches "Later the " right before the quote.
export function quoteMatches(plain, anchor) {
  if (!anchor || typeof anchor.quote !== 'string') return [];
  const quote = normalizeWs(anchor.quote).trim();
  const prefix = noWs(anchor.prefix || '');
  const suffix = noWs(anchor.suffix || '');
  const out = [];
  for (const h of allIndexes(plain, quote)) {
    const before = noWs(plain.slice(Math.max(0, h - prefix.length * 2 - 8), h));
    const after = noWs(plain.slice(h + quote.length, h + quote.length + suffix.length * 2 + 8));
    out.push({ start: h, end: h + quote.length, score: tailMatch(before, prefix) + headMatch(after, suffix) });
  }
  return out.sort((a, b) => b.score - a.score || a.start - b.start);
}

// Locate a text anchor in normalized plain text: best prefix/suffix match wins, ties go to the first.
export function findQuote(plain, anchor) {
  const best = quoteMatches(plain, anchor)[0];
  return best ? { start: best.start, end: best.end } : null;
}

export function makeTextAnchor(plain, start, end, ctx = 32) {
  return {
    kind: 'text',
    quote: plain.slice(start, end),
    prefix: plain.slice(Math.max(0, start - ctx), start),
    suffix: plain.slice(end, end + ctx),
  };
}

// Remove inline markdown so a quote copied from the .md source matches rendered text.
export function stripInlineMd(s) {
  return String(s)
    .replace(/^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+|\d+[.)][ \t]+)/gm, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`+/g, '')
    .replace(/\*\*|__|~~/g, '')
    .replace(/(^|[^\p{L}\p{N}])[*_]([^*_\n]+)[*_](?=[^\p{L}\p{N}]|$)/gu, '$1$2');
}

const TOKEN = /[\p{L}\p{N}_]+(?:['’][\p{L}\p{N}_]+)*|[^\s\p{L}\p{N}_]/gu;

export function tokenize(s) {
  const out = [];
  for (const m of String(s).matchAll(TOKEN)) out.push({ t: m[0], start: m.index, end: m.index + m[0].length });
  return out;
}

const MAX_CELLS = 4e6;

// Word-level diff of a -> b. Each op carries its text; eq/ins also carry offsets into b.
export function wordDiff(a, b) {
  const A = tokenize(a);
  const B = tokenize(b);
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre].t === B[pre].t) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf].t === B[B.length - 1 - suf].t) suf++;

  const steps = []; // 'eq' | 'del' | 'ins' per token, with indexes
  for (let k = 0; k < pre; k++) steps.push(['eq', k, k]);
  const a0 = pre; const a1 = A.length - suf;
  const b0 = pre; const b1 = B.length - suf;
  const n = a1 - a0; const m = b1 - b0;
  if (n > 0 && m > 0 && (n + 1) * (m + 1) <= MAX_CELLS) {
    const W = m + 1;
    const L = new Uint32Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        L[i * W + j] = A[a0 + i].t === B[b0 + j].t
          ? L[(i + 1) * W + j + 1] + 1
          : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
      }
    }
    let i = 0; let j = 0;
    while (i < n && j < m) {
      if (A[a0 + i].t === B[b0 + j].t) { steps.push(['eq', a0 + i, b0 + j]); i++; j++; }
      else if (L[(i + 1) * W + j] >= L[i * W + j + 1]) { steps.push(['del', a0 + i, -1]); i++; }
      else { steps.push(['ins', -1, b0 + j]); j++; }
    }
    for (; i < n; i++) steps.push(['del', a0 + i, -1]);
    for (; j < m; j++) steps.push(['ins', -1, b0 + j]);
  } else {
    // Too large (or one side empty): report the changed middle as one deletion + one insertion.
    for (let i = a0; i < a1; i++) steps.push(['del', i, -1]);
    for (let j = b0; j < b1; j++) steps.push(['ins', -1, j]);
  }
  for (let k = 0; k < suf; k++) steps.push(['eq', a1 + k, b1 + k]);

  const ops = [];
  for (const [op, ai, bi] of steps) {
    const last = ops[ops.length - 1];
    if (last && last.op === op) {
      if (op === 'del') last._aEnd = A[ai].end; else last.bEnd = B[bi].end;
      continue;
    }
    if (op === 'del') ops.push({ op, _aStart: A[ai].start, _aEnd: A[ai].end });
    else ops.push({ op, bStart: B[bi].start, bEnd: B[bi].end });
  }
  return ops.map((o) => (o.op === 'del'
    ? { op: 'del', text: a.slice(o._aStart, o._aEnd) }
    : { op: o.op, text: b.slice(o.bStart, o.bEnd), bStart: o.bStart, bEnd: o.bEnd }));
}
