// Where a document's review state lives: <project root>/.rewriter/reviews/<path of the document>/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as m from '../lib/model.mjs';
import { tmpProject } from './helpers.mjs';

const bare = () => realpathSync(mkdtempSync(join(tmpdir(), 'rw-loc-')));
function doc(folder, name = 'doc.md') {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, name), '# A\n\nText.\n');
  return join(folder, name);
}

test('state of a document lives under the nearest .git folder, keyed by its path', () => {
  const root = tmpProject();
  const t = m.target(doc(join(root, 'docs', 'specs'), 'auth.md'));
  assert.equal(t.root, root);
  assert.equal(t.key, join('docs', 'specs', 'auth.md'));
  assert.equal(t.stateDir, join(root, '.rewriter', 'reviews', 'docs', 'specs', 'auth.md'));
});

test('a .git file marks a root as well (worktrees)', () => {
  const root = bare();
  writeFileSync(join(root, '.git'), 'gitdir: /somewhere/else\n');
  assert.equal(m.target(doc(join(root, 'docs'))).root, root);
});

test('a folder that already holds .rewriter/reviews is a root', () => {
  const a = bare();
  mkdirSync(join(a, '.rewriter', 'reviews'), { recursive: true });
  const t = m.target(doc(join(a, 'b')));
  assert.equal(t.root, a);
  assert.equal(t.key, join('b', 'doc.md'));
});

test('the nearest marker wins', () => {
  const a = bare();
  mkdirSync(join(a, '.git'));
  mkdirSync(join(a, 'b', '.git'), { recursive: true });
  assert.equal(m.target(doc(join(a, 'b', 'c'))).root, join(a, 'b'));
});

test('no marker: the document\'s own folder is the root', () => {
  const a = bare();
  const t = m.target(doc(join(a, 'notes')));
  assert.equal(t.root, join(a, 'notes'));
  assert.equal(t.key, 'doc.md');
  assert.equal(t.stateDir, join(a, 'notes', '.rewriter', 'reviews', 'doc.md'));
});

test('an old-style .rewriter folder is not a root marker', () => {
  const root = tmpProject();
  mkdirSync(join(root, 'docs', '.rewriter', 'x.md'), { recursive: true });
  writeFileSync(join(root, 'docs', '.rewriter', 'x.md', 'review.json'), '{}');
  assert.equal(m.target(doc(join(root, 'docs'), 'x.md')).root, root);
});

test('a folder target and its index.md share one state', () => {
  const root = tmpProject();
  const file = doc(join(root, 'my-article'), 'index.md');
  const byFolder = m.target(join(root, 'my-article'));
  assert.equal(byFolder.stateDir, m.target(file).stateDir);
  assert.equal(byFolder.key, join('my-article', 'index.md'));
});

test('a symlinked path gives the same state as the real one', () => {
  const root = tmpProject();
  const real = doc(join(root, 'docs'));
  const link = join(bare(), 'link');
  symlinkSync(join(root, 'docs'), link);
  assert.equal(m.target(join(link, 'doc.md')).stateDir, m.target(real).stateDir);
});

test('a review keeps its root when a nearer marker appears later', () => {
  const root = tmpProject();
  const spec = doc(join(root, 'work', 'proj', 'docs'), 'spec.md');
  m.init(spec);
  mkdirSync(join(root, 'work', 'proj', '.git')); // `git init` in a subfolder, mid-review
  assert.equal(m.target(spec).root, root, 'the review that exists decides');
  assert.equal(m.load(spec).rounds.length, 1);
  const other = doc(join(root, 'work', 'proj', 'docs'), 'other.md');
  assert.equal(m.target(other).root, join(root, 'work', 'proj'), 'a document with no review yet takes the nearer root');
});

test('init writes a self-ignoring .rewriter/.gitignore once', () => {
  const root = tmpProject();
  m.init(doc(join(root, 'docs'), 'a.md'));
  const ignore = join(root, '.rewriter', '.gitignore');
  assert.equal(readFileSync(ignore, 'utf8'), '*\n');
  writeFileSync(ignore, 'keep\n');
  m.init(doc(join(root, 'docs'), 'b.md'));
  assert.equal(readFileSync(ignore, 'utf8'), 'keep\n', 'an existing file is left alone');
});
