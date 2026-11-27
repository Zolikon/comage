// Rules for the browser UI that can be checked without a browser (see CLAUDE.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const UI = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui');

test('the UI never opens a native browser dialog', () => {
  const files = readdirSync(UI).filter((f) => /\.(js|mjs|html)$/.test(f));
  assert.ok(files.includes('app.js'));
  for (const f of files) {
    const lines = readFileSync(join(UI, f), 'utf8').split('\n');
    lines.forEach((line, i) => {
      const call = /(?<![\w$.])(?:window\.)?(alert|confirm|prompt)\s*\(/.exec(line);
      assert.equal(call, null, `${f}:${i + 1} calls ${call?.[1]}(): use toast() or ask() instead`);
    });
  }
});

test('the page has the element in-page questions are shown in', () => {
  assert.match(readFileSync(join(UI, 'index.html'), 'utf8'), /<div id="ask" hidden><\/div>/);
  assert.match(readFileSync(join(UI, 'app.js'), 'utf8'), /function ask\(/);
});

// While a round is with Claude the document and its comments make way for the stage (lib/stage.mjs).
test('the page has the stage, outside the document area it replaces', () => {
  const html = readFileSync(join(UI, 'index.html'), 'utf8');
  assert.match(html, /<section id="stage" hidden><\/section>\s*<main>/);
  const app = readFileSync(join(UI, 'app.js'), 'utf8');
  assert.match(app, /from '\/lib\/stage\.mjs'/);
  assert.match(app, /mainEl\.hidden = Boolean\(st\)/); // document and comments go when the stage comes
});

test('the stage is built without anything from outside, and stands still for those who ask for no motion', () => {
  const css = readFileSync(join(UI, 'styles.css'), 'utf8');
  const reduced = /@media \(prefers-reduced-motion: reduce\) \{[^}]*#stage \*[^}]*animation: none !important/.exec(css);
  assert.ok(reduced, 'styles.css switches the stage animations off under prefers-reduced-motion');
  // every animation the stage uses has its keyframes in the stylesheet
  const used = new Set([...css.matchAll(/animation: (st-[a-z]+)/g)].map((x) => x[1]));
  assert.ok(used.size > 5);
  for (const name of used) assert.match(css, new RegExp(`@keyframes ${name} \\{`), `@keyframes ${name}`);
  for (const f of ['index.html', 'app.js', 'styles.css']) {
    const text = readFileSync(join(UI, f), 'utf8');
    assert.doesNotMatch(text, /(?:src|href)=["']https?:|url\(\s*["']?https?:|@import|from ['"]https?:/, `${f} loads nothing from the network`);
  }
});
