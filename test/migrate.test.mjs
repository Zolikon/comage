// Reviews from before 1.4.0 kept their state beside the document (<folder>/.rewriter/…). The first command
// that touches such a document moves its review to the project root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as m from '../lib/model.mjs';
import { tmpProject } from './helpers.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'rewriter.mjs');

// A document with a review in the old layout, as 1.3.0 left it: round 1 published, no comments.
function oldReview(folder, file = 'index.md') {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, file), '# Old\n\nReviewed before the move.\n');
  const old = file === 'index.md' ? join(folder, '.rewriter') : join(folder, '.rewriter', file);
  mkdirSync(join(old, 'rounds'), { recursive: true });
  writeFileSync(join(old, 'review.json'), JSON.stringify({
    version: 1, article: file, docType: 'spec', comments: [],
    rounds: [{ n: 1, status: 'open', session: null, publishedAt: '2026-01-01T00:00:00.000Z', submittedAt: null }],
  }));
  writeFileSync(join(old, 'rounds', '1.md'), '# Old\n\nReviewed before the move.\n');
  return { doc: join(folder, file), old };
}

const collect = () => { const lines = []; return { lines, log: (x) => lines.push(x) }; };

test('an old review of a named document moves, and works afterwards', () => {
  const root = tmpProject();
  const { doc } = oldReview(join(root, 'docs'), 'spec.md');
  const { lines, log } = collect();
  const t = m.locate(doc, { log });
  assert.equal(existsSync(join(t.stateDir, 'review.json')), true);
  assert.equal(existsSync(join(t.stateDir, 'rounds', '1.md')), true);
  assert.equal(existsSync(join(root, 'docs', '.rewriter')), false, 'the emptied old folder is removed');
  assert.match(lines.join(''), /^rewriter: moved the review of .*spec\.md to .*reviews.*\n$/);
  assert.equal(m.load(t).rounds.length, 1);
  assert.equal(m.submit(doc, { note: 'still a working review' }).status, 'submitted');
  assert.equal(readFileSync(join(root, '.rewriter', '.gitignore'), 'utf8'), '*\n');
});

test('an old review of an index.md moves out of the .rewriter folder itself', () => {
  const root = tmpProject();
  const { old } = oldReview(join(root, 'article'));
  const t = m.locate(join(root, 'article'), { log: () => {} });
  assert.equal(t.key, join('article', 'index.md'));
  assert.equal(m.load(t).rounds[0].status, 'open');
  assert.equal(existsSync(old), false);
});

test('two documents in one old folder: the second still moves after the first did', () => {
  const root = tmpProject();
  const a = oldReview(join(root, 'docs'), 'a.md');
  const b = oldReview(join(root, 'docs'), 'b.md');
  m.locate(a.doc, { log: () => {} });
  assert.equal(existsSync(join(b.old, 'review.json')), true, 'the other document was not touched');
  const second = collect();
  const t = m.locate(b.doc, { log: second.log });
  assert.equal(m.load(t).article, 'b.md');
  assert.equal(second.lines.length, 1);
  assert.equal(existsSync(join(root, 'docs', '.rewriter')), false);
});

test('both places hold a review: the new one is used and the old one is left alone', () => {
  const root = tmpProject();
  const { doc, old } = oldReview(join(root, 'docs'), 'spec.md');
  const fresh = m.target(doc);
  mkdirSync(fresh.stateDir, { recursive: true });
  writeFileSync(join(fresh.stateDir, 'review.json'), JSON.stringify({ version: 1, article: 'spec.md', docType: 'plan', comments: [], rounds: [{ n: 1, status: 'preparing' }] }));
  const { lines, log } = collect();
  const t = m.locate(doc, { log });
  assert.equal(m.load(t).docType, 'plan');
  assert.equal(existsSync(join(old, 'review.json')), true);
  assert.deepEqual(lines, []);
});

test('nothing to move: locate is target', () => {
  const root = tmpProject();
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'docs', 'new.md'), '# New\n');
  const { lines, log } = collect();
  assert.deepEqual(m.locate(join(root, 'docs', 'new.md'), { log }), m.target(join(root, 'docs', 'new.md')));
  assert.deepEqual(lines, []);
  assert.equal(existsSync(join(root, '.rewriter')), false, 'looking leaves nothing behind');
});

test('a root that has an old-style review of its own index.md, beside another document\'s', () => {
  const root = tmpProject();
  oldReview(root); // <root>/.rewriter/review.json
  const other = oldReview(root, 'other.md'); // <root>/.rewriter/other.md/review.json
  const t = m.locate(root, { log: () => {} });
  assert.equal(t.stateDir, join(root, '.rewriter', 'reviews', 'index.md'));
  assert.equal(m.load(t).article, 'index.md');
  assert.equal(existsSync(join(root, '.rewriter', 'review.json')), false);
  assert.equal(existsSync(join(other.old, 'review.json')), true, 'the other document\'s old review is still where it was');
});

test('an old server still running for a moved review is pointed out', () => {
  const root = tmpProject();
  const { doc, old } = oldReview(join(root, 'docs'), 'spec.md');
  writeFileSync(join(old, 'server.json'), JSON.stringify({ pid: process.pid, port: 4999, url: 'http://127.0.0.1:4999/' }));
  const { lines, log } = collect();
  m.locate(doc, { log });
  assert.match(lines.join(''), /older ReWriter server.*http:\/\/127\.0\.0\.1:4999\//);
});

test('an old review that was approved long ago is removed, and the message says that', () => {
  const root = tmpProject();
  const { doc, old } = oldReview(join(root, 'docs'), 'spec.md');
  const state = JSON.parse(readFileSync(join(old, 'review.json'), 'utf8'));
  Object.assign(state.rounds[0], { status: 'approved', approvedAt: '2026-01-02T00:00:00.000Z' });
  writeFileSync(join(old, 'review.json'), JSON.stringify(state));
  const { lines, log } = collect();
  m.locate(doc, { log });
  assert.match(lines.join(''), /removed the finished review of .*spec\.md \(approved /);
  assert.throws(() => m.load(doc), (e) => e.status === 404);
  assert.equal(existsSync(join(root, '.rewriter')), false);
  assert.equal(existsSync(join(root, 'docs', '.rewriter')), false);
});

const runAsync = (...args) => new Promise((done) => {
  const p = spawn(process.execPath, [CLI, ...args]);
  let stdout = ''; let stderr = '';
  p.stdout.on('data', (d) => { stdout += d; });
  p.stderr.on('data', (d) => { stderr += d; });
  p.on('close', (status) => done({ status, stdout, stderr }));
});

test('two processes moving the same review at once both succeed', async () => {
  const root = tmpProject();
  const { doc } = oldReview(join(root, 'docs'), 'spec.md');
  const both = await Promise.all([runAsync('status', doc), runAsync('status', doc)]);
  assert.deepEqual(both.map((r) => r.status), [0, 0], both.map((r) => r.stderr).join(''));
  for (const r of both) assert.match(r.stdout, /Round 1 \(open\)/);
  assert.equal(both.filter((r) => /moved the review/.test(r.stderr)).length, 1, 'exactly one of them moved it');
});
