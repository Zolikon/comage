import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeWs, pageTitle, plainFromHtml, findQuote, quoteMatches, makeTextAnchor, stripInlineMd,
} from '../lib/text.mjs';

test('normalizeWs collapses whitespace', () => {
  assert.equal(normalizeWs(' a \n\t b  '), ' a b ');
});

test('plainFromHtml decodes entities and collapses whitespace', () => {
  assert.equal(plainFromHtml('<p>a &lt;b&gt;\n  &amp; c</p>'), 'a <b> & c');
  assert.equal(plainFromHtml('<p>x&#39;s &#x41;&nbsp;&quot;q&quot;</p>'), 'x\'s A "q"');
});

test('plainFromHtml separates blocks like textContent does', () => {
  assert.equal(plainFromHtml('<h1>Title</h1>\n<p>Body</p>\n'), 'Title Body');
});

test('findQuote disambiguates by prefix', () => {
  const plain = 'the cat sat. the cat ran.';
  assert.deepEqual(findQuote(plain, { quote: 'the cat', prefix: 'sat. ' }), { start: 13, end: 20 });
  assert.deepEqual(findQuote(plain, { quote: 'the cat' }), { start: 0, end: 7 });
  assert.deepEqual(findQuote(plain, { quote: 'the cat', suffix: ' ran' }), { start: 13, end: 20 });
});

test('findQuote returns null for missing quote', () => {
  assert.equal(findQuote('hello world', { quote: 'goodbye' }), null);
  assert.equal(findQuote('hello world', { quote: '' }), null);
});

test('findQuote tolerates whitespace', () => {
  assert.deepEqual(findQuote('one two three', { quote: 'two\n  three' }), { start: 4, end: 13 });
});

test('makeTextAnchor round-trips through findQuote', () => {
  const plain = 'alpha beta gamma. alpha beta delta.';
  const a = makeTextAnchor(plain, 18, 28);
  assert.equal(a.kind, 'text');
  assert.equal(a.quote, 'alpha beta');
  assert.deepEqual(findQuote(plain, a), { start: 18, end: 28 });
});

test('stripInlineMd removes inline markdown', () => {
  assert.equal(stripInlineMd('use **bold** and `x` [here](http://u)'), 'use bold and x here');
  assert.equal(stripInlineMd('an ![alt text](a.png) and _em_ *it*'), 'an alt text and em it');
});

test('stripInlineMd removes block markers at line start', () => {
  assert.equal(stripInlineMd('## The harness-design lens'), 'The harness-design lens');
  assert.equal(stripInlineMd('> quoted\n- item one\n1. first'), 'quoted\nitem one\nfirst');
  assert.equal(stripInlineMd('C# is fine - here'), 'C# is fine - here');
});

test('findQuote prefix/suffix match ignores boundary whitespace', () => {
  const plain = 'The model said yes. Later the model said no.';
  assert.equal(findQuote(plain, { quote: 'model said', prefix: 'Later the' }).start, 30);
  assert.equal(findQuote(plain, { quote: 'model said', suffix: 'no.' }).start, 30);
});

test('quoteMatches reports ties', () => {
  const plain = 'The model said yes. Later the model said no.';
  const m = quoteMatches(plain, { quote: 'model said' });
  assert.equal(m.length, 2);
  assert.equal(m[0].score, m[1].score);
});

test('plainFromHtml: case-sensitive entities, more names, quoted ">" in attributes, style dropped', () => {
  assert.equal(plainFromHtml('<p>&rArr; &rarr; &check; &frac12;</p>'), '⇒ → ✓ ½');
  assert.equal(plainFromHtml('<p><span title="a>b">x</span></p>'), 'x');
  assert.equal(plainFromHtml('<style>p{}</style><p>y</p>'), 'y');
});

test('pageTitle leads with the session title, so tabs of different sessions can be told apart', () => {
  assert.equal(pageTitle('Auth spec review', 'Auth design'), 'Auth spec review · Auth design');
  assert.equal(pageTitle(null, 'Auth design'), 'ReWriter: Auth design');
  assert.equal(pageTitle('', 'Auth design'), 'ReWriter: Auth design');
});
