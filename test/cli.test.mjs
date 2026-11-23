import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpArticle } from './helpers.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'rewriter.mjs');
const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

test('cli init/add/publish/status/pending', () => {
  const dir = tmpArticle();
  assert.equal(run('init', dir).status, 0);
  const add = run('add', dir, '--severity', 'major', '--body', 'tighten', '--quote', 'The cat ran', '--reviewer', 'Writer', '--reviewer', 'Junior', '--suggestion', 'The cat bolted.');
  assert.equal(add.status, 0, add.stderr);
  const [c] = JSON.parse(add.stdout);
  assert.deepEqual(c.reviewers, ['Writer', 'Junior']);
  const file = join(dir, 'batch.json');
  writeFileSync(file, JSON.stringify([{ severity: 'MINOR', body: 'b' }, { severity: 'NITPICK', body: 'n', quote: 'Second section' }]));
  assert.equal(JSON.parse(run('add', dir, '--file', file).stdout).length, 2);
  assert.equal(run('publish', dir).status, 0);
  const st = run('status', dir);
  assert.equal(st.status, 0);
  assert.match(st.stdout, /Round 1 \(open\)/);
  assert.match(st.stdout, /3 open/);
  const p = JSON.parse(run('pending', dir).stdout);
  assert.equal(p.carriedOver, 3);
  const state = JSON.parse(readFileSync(join(dir, '.rewriter', 'review.json'), 'utf8'));
  assert.equal(state.comments.length, 3);
});

test('cli errors exit 1 with message', () => {
  const dir = tmpArticle();
  run('init', dir);
  const r = run('add', dir, '--severity', 'MAJOR', '--body', 'x', '--quote', 'nope nope');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /quote not found/);
  assert.equal(run('bogus', dir).status, 1);
  assert.equal(run('next', dir).status, 1);
});

test('cli reply via file', () => {
  const dir = tmpArticle();
  run('init', dir);
  run('add', dir, '--severity', 'MAJOR', '--body', 'x');
  run('publish', dir);
  const state = JSON.parse(readFileSync(join(dir, '.rewriter', 'review.json'), 'utf8'));
  state.rounds[0].status = 'submitted';
  state.comments[0].decision = { type: 'decline', note: 'no', round: 1 };
  writeFileSync(join(dir, '.rewriter', 'review.json'), JSON.stringify(state));
  assert.equal(run('next', dir).status, 0);
  const f = join(dir, 'r.json');
  writeFileSync(f, JSON.stringify([{ id: 'c1', kind: 'accepted', body: 'fair' }]));
  const r = run('reply', dir, '--file', f);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout)[0].status, 'addressed');
  const r2 = run('reply', dir, 'c1', '--kind', 'reply', '--body', 'more');
  assert.equal(r2.status, 0, r2.stderr);
});
