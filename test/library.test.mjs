// The author's reviewer library: the user file, written from the UI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as m from '../lib/model.mjs';
import { listReviewers, removeLibraryReviewer, saveLibraryReviewer } from '../lib/reviewers.mjs';
import { createHandler } from '../lib/server.mjs';

// Every test gets its own user file; the developer's real one is never touched.
function userFile(content) {
  const f = join(mkdtempSync(join(tmpdir(), 'rw-lib-')), 'sub', 'reviewers.json');
  process.env.REWRITER_REVIEWERS = f;
  if (content !== undefined) { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, content); }
  return f;
}
const read = (f) => JSON.parse(readFileSync(f, 'utf8'));
const find = (name) => listReviewers({ docType: 'spec' }).find((r) => r.persona === name);

test('save adds a new reviewer under "library", creating the file and its directory', () => {
  const f = userFile();
  const saved = saveLibraryReviewer({ persona: ' DBA ', background: 'Owns the database.\n- Migrations', model: 'Sonnet' });
  assert.deepEqual(saved, { persona: 'DBA', background: 'Owns the database.\n- Migrations', focus: [], model: 'sonnet' });
  assert.deepEqual(read(f), { library: [saved] });
  assert.deepEqual([find('DBA').source, find('DBA').profile], ['user', 'library']);
});

test('save changes one hand-written entry and nothing else', () => {
  const before = {
    spec: [{ persona: 'DBA', background: 'old', focus: ['Migrations'], model: 'haiku', enabled: true }, { persona: 'Other', background: 'x' }],
    article: [{ persona: 'DBA', background: 'old copy' }],
  };
  const f = userFile(JSON.stringify(before));
  saveLibraryReviewer({ persona: 'DBA', background: 'new' });
  const after = read(f);
  assert.deepEqual(after.spec[0], { persona: 'DBA', background: 'new', focus: [], model: '', enabled: true });
  assert.deepEqual(after.spec[1], before.spec[1]);
  assert.deepEqual(after.article[0], { persona: 'DBA', background: 'new', focus: [], model: '' });
  assert.equal(after.library, undefined);
});

test('a legacy array file keeps its reviewers', () => {
  const f = userFile(JSON.stringify([{ persona: 'Old Hand', background: 'From before profiles.' }]));
  saveLibraryReviewer({ persona: 'DBA', background: 'new' });
  assert.deepEqual(read(f), { article: [{ persona: 'Old Hand', background: 'From before profiles.' }], library: [{ persona: 'DBA', background: 'new', focus: [], model: '' }] });
});

test('a broken or wrong-shaped user file is an error and stays untouched', () => {
  for (const content of ['{ not json', '"just text"', 'null', '42']) {
    const f = userFile(content);
    assert.throws(() => saveLibraryReviewer({ persona: 'DBA', background: 'x' }), (e) => e.status === 400 && e.message.includes(f), content);
    assert.throws(() => removeLibraryReviewer('DBA'), (e) => e.status === 400, content);
    assert.equal(readFileSync(f, 'utf8'), content);
  }
});

test('save validates before writing anything', () => {
  const f = userFile();
  assert.throws(() => saveLibraryReviewer({ persona: 'DBA' }), /needs a description/);
  assert.throws(() => saveLibraryReviewer({ background: 'x' }), /needs a name/);
  assert.throws(() => saveLibraryReviewer({ persona: 'DBA', background: 'x', model: 'bad model!' }), /bad model/);
  assert.equal(existsSync(f), false);
});

test("the author's copy of a starter wins; removing it brings the starter back", () => {
  userFile();
  assert.equal(find('Architect').source, 'built-in');
  saveLibraryReviewer({ persona: 'Architect', background: 'Mine.' });
  assert.deepEqual([find('Architect').source, find('Architect').background], ['user', 'Mine.']);
  assert.deepEqual(removeLibraryReviewer('Architect'), { removed: 'Architect' });
  assert.equal(find('Architect').source, 'built-in');
  assert.throws(() => removeLibraryReviewer('Architect'), (e) => e.status === 404); // a starter is not in the library
  assert.throws(() => removeLibraryReviewer('Nobody'), (e) => e.status === 404);
});

test('server: save, shadowing, remove, odd names, guards', async () => {
  userFile();
  const dir = mkdtempSync(join(tmpdir(), 'rw-'));
  const spec = join(dir, 'spec.md');
  writeFileSync(spec, '# Spec\n\nThe service stores widgets.\n');
  m.init(spec, { type: 'spec' });
  m.publish(spec);
  m.submit(spec, { mode: 'review', custom: [{ persona: 'DBA', background: 'kept with this document' }] });
  const server = createServer(createHandler(spec));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, p, body, type = 'application/json') => fetch(base + p, { method, headers: { 'content-type': type }, body: body === undefined ? undefined : JSON.stringify(body) });
  const listed = async (name) => (await (await fetch(`${base}/api/reviewers`)).json()).reviewers.find((r) => r.persona === name);
  try {
    assert.equal((await listed('DBA')).source, 'review');
    const put = await call('PUT', '/api/reviewers', { persona: 'DBA', background: 'saved', model: 'opus' });
    assert.equal(put.status, 200);
    assert.deepEqual(await put.json(), { persona: 'DBA', background: 'saved', focus: [], model: 'opus' });
    assert.deepEqual([(await listed('DBA')).source, (await listed('DBA')).background], ['user', 'saved']);
    assert.deepEqual(m.load(spec).customReviewers, []);

    assert.equal((await call('PUT', '/api/reviewers', { persona: 'DBA' })).status, 400);
    assert.equal((await call('PUT', '/api/reviewers', { persona: 'DBA', background: 'x' }, 'text/plain')).status, 415);

    const odd = 'QA/Perf & C++ Reviewer';
    assert.equal((await call('PUT', '/api/reviewers', { persona: odd, background: 'x' })).status, 200);
    const del = await call('DELETE', `/api/reviewers/${encodeURIComponent(odd)}`);
    assert.equal(del.status, 200);
    assert.deepEqual(await del.json(), { removed: odd });
    assert.equal(await listed(odd), undefined);
    assert.equal((await call('DELETE', `/api/reviewers/${encodeURIComponent(odd)}`)).status, 404);
    assert.equal((await call('DELETE', '/api/reviewers/%E0%A4%A')).status, 400);
    assert.equal((await call('DELETE', '/api/reviewers/DBA')).status, 200);
    assert.equal(await listed('DBA'), undefined);
  } finally { server.close(); }
});
