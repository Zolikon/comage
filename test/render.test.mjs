import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../lib/render.mjs';

const md = `---
title: "Prompt Caching, Explained"
description: 'Short one'
date: 2026-07-06
tags: [a, b]
---

Intro paragraph.

| A | B |
|---|---|
| 1 | 2 |

\`\`\`ts
if (a < b) {}
\`\`\`
`;

test('frontmatter stripped and parsed', () => {
  const r = renderMarkdown(md);
  assert.equal(r.title, 'Prompt Caching, Explained');
  assert.equal(r.frontmatter.description, 'Short one');
  assert.equal(r.frontmatter.date, '2026-07-06');
  assert.ok(!r.html.includes('description:'));
});

test('title becomes h1 when body has none', () => {
  const r = renderMarkdown(md);
  assert.match(r.html, /^<h1[^>]*>Prompt Caching, Explained<\/h1>/);
  const r2 = renderMarkdown('---\ntitle: T\n---\n# Own heading\n\ntext');
  assert.equal((r2.html.match(/<h1/g) || []).length, 1);
  assert.equal(r2.title, 'T');
});

test('gfm table and escaped code', () => {
  const r = renderMarkdown(md);
  assert.match(r.html, /<table>/);
  assert.match(r.html, /a &lt; b/);
});

test('no frontmatter: title from first h1', () => {
  const r = renderMarkdown('# Hello\n\nworld');
  assert.equal(r.title, 'Hello');
  assert.deepEqual(r.frontmatter, {});
});

test('strips unquoted event handlers and javascript: urls', () => {
  const r = renderMarkdown('Hi <img src=x onerror=alert(1)> [x](javascript:alert(1)) <a href="JavaScript:alert(2)">y</a>');
  assert.doesNotMatch(r.html, /onerror/i);
  assert.doesNotMatch(r.html, /javascript:/i);
});

test('sanitiser leaves prose and code text alone', () => {
  const r = renderMarkdown('let one = 5 and see javascript:void here\n\n```js\nconst onload = 1;\n```\n');
  assert.match(r.html, /let one = 5/);
  assert.match(r.html, /javascript:void here/);
  assert.match(r.html, /const onload = 1;/);
});
