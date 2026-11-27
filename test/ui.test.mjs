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
