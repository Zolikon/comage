// Text and anchor utilities shared by the CLI (Node) and the browser UI.
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

// The browser tab's title. Several Claude sessions each have tabs open: the session's title comes first,
// so that it is the part still visible on a narrow tab.
export function pageTitle(sessionTitle, docTitle) {
  return sessionTitle ? `${sessionTitle} · ${docTitle}` : `ReWriter: ${docTitle}`;
}

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
