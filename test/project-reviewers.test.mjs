// The project's reviewer library: <project root>/.claude/rewriter/reviewers.json, beside the author's own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as m from '../lib/model.mjs';
import {
  exportLibrary, importLibrary, libraries, listReviewers, projectFile, removeLibraryReviewer, saveLibraryReviewer,
} from '../lib/reviewers.mjs';
import { createHandler } from '../lib/server.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'rewriter.mjs');

// A project (a git checkout) with one document, and a user file of its own: the developer's real library
// is never touched.
function setup() {
  const user = join(mkdtempSync(join(tmpdir(), 'rw-user-')), 'reviewers.json');
  process.env.REWRITER_REVIEWERS = user;
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rw-proj-')));
  mkdirSync(join(root, '.git'));
  const spec = join(root, 'docs', 'spec.md');
  mkdirSync(dirname(spec), { recursive: true });
  writeFileSync(spec, '# Spec\n\nThe service stores widgets.\n');
  return { user, root, spec, file: join(root, '.claude', 'rewriter', 'reviewers.json'), where: { scope: 'project', root } };
}
const write = (file, data) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(data)); };
const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
const named = (list, name) => list.find((r) => r.persona === name);

test("a project's reviewers are listed in that project only, over the author's and under the review's own", () => {
  const { user, root, file } = setup();
  write(user, { library: [{ persona: 'DBA', background: 'mine' }, { persona: 'Sec', background: 'mine too' }] });
  write(file, { library: [{ persona: 'DBA', background: "the project's", model: 'sonnet' }] });
  const here = listReviewers({ docType: 'spec' }, root);
  assert.deepEqual([named(here, 'DBA').source, named(here, 'DBA').background, named(here, 'DBA').model], ['project', "the project's", 'sonnet']);
  assert.equal(named(here, 'Sec').source, 'user');
  assert.equal(new Set(here.map((r) => r.persona)).size, here.length);

  const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'rw-other-')));
  assert.equal(named(listReviewers({ docType: 'spec' }, elsewhere), 'DBA').background, 'mine');
  assert.equal(named(listReviewers({ docType: 'spec' }), 'DBA').background, 'mine'); // no project known

  const own = listReviewers({ docType: 'spec', customReviewers: [{ persona: 'DBA', background: 'this document' }] }, root);
  assert.equal(named(own, 'DBA').source, 'review');
});

test("a project that keeps reviewers for the document decides the default panel alone", () => {
  const { root, file } = setup();
  const suggested = (type) => listReviewers({ docType: type }, root).filter((r) => r.suggested).map((r) => r.persona).sort();
  assert.deepEqual(suggested('spec'), ['Architect', 'Implementer', 'Scope Skeptic', 'Test Engineer']); // no project file: the starters
  write(file, { library: [{ persona: 'DBA', background: 'x' }], plan: [{ persona: 'Release Manager', background: 'y' }] });
  assert.deepEqual(suggested('spec'), ['DBA']); // "library" is for every kind of document
  assert.deepEqual(suggested('plan'), ['DBA', 'Release Manager']);
  write(file, { plan: [{ persona: 'Release Manager', background: 'y' }] });
  assert.deepEqual(suggested('plan'), ['Release Manager']);
  assert.deepEqual(suggested('spec'), ['Architect', 'Implementer', 'Scope Skeptic', 'Test Engineer']); // nothing for specs: the starters again
});

test('save, export and remove act on the library that is named', () => {
  const { user, root, file, where } = setup();
  const saved = saveLibraryReviewer({ persona: 'DBA', background: 'Owns the database.', model: 'Opus' }, 'spec', where);
  assert.deepEqual(read(file), { library: [saved] });
  assert.equal(existsSync(user), false);
  assert.deepEqual(JSON.parse(exportLibrary(where)), { library: [saved] });
  assert.deepEqual(JSON.parse(exportLibrary()), { library: [] }); // the author's own: still empty

  saveLibraryReviewer({ persona: 'DBA', background: 'Mine.' }, 'spec'); // no scope: the author's library
  assert.equal(read(user).library[0].background, 'Mine.');
  assert.equal(named(listReviewers({ docType: 'spec' }, root), 'DBA').source, 'project');

  assert.deepEqual(removeLibraryReviewer('DBA', 'spec', where), { removed: 'DBA' });
  assert.equal(named(listReviewers({ docType: 'spec' }, root), 'DBA').source, 'user'); // the author's own is back
  assert.throws(() => removeLibraryReviewer('DBA', 'spec', where), (e) => e.status === 404 && /this project's reviewers/.test(e.message));
});

test('a document without a project has no project library', () => {
  const { root, file } = setup();
  const one = { persona: 'DBA', background: 'x' };
  assert.throws(() => saveLibraryReviewer(one, 'spec', { scope: 'project' }), /no project/);
  assert.throws(() => saveLibraryReviewer(one, 'spec', { scope: 'team', root }), /unknown reviewer library/);
  assert.equal(existsSync(file), false);
  // In the home directory that path is the author's own library, not a project's.
  assert.equal(projectFile(homedir()), null);
  assert.equal(libraries(homedir()).project, null);
  process.env.REWRITER_REVIEWERS = file;
  assert.equal(projectFile(root), null);
  assert.deepEqual(listReviewers({ docType: 'spec' }, root).filter((r) => r.source === 'project'), []);
});

test('import merges a reviewers file by name, list by list, and writes nothing when an entry is bad', () => {
  const { file, where } = setup();
  write(file, { spec: [{ persona: 'DBA', background: 'old', focus: ['a'] }, { persona: 'Keep', background: 'k' }] });
  const done = importLibrary({
    spec: [{ persona: ' DBA ', background: 'new', model: 'Opus' }],
    library: [{ persona: 'Sec', background: 's', focus: ['Auth'], enabled: false }],
  }, where);
  assert.deepEqual(done, { added: 1, updated: 1, personas: ['DBA', 'Sec'] });
  assert.deepEqual(read(file), {
    spec: [{ persona: 'DBA', background: 'new', focus: [], model: 'opus' }, { persona: 'Keep', background: 'k' }],
    library: [{ persona: 'Sec', background: 's', focus: ['Auth'], model: '', enabled: false }],
  });
  assert.deepEqual(importLibrary([{ persona: 'QA', background: 'q' }], where).personas, ['QA']); // a plain list goes to "library"
  assert.equal(read(file).library[1].persona, 'QA');

  const before = readFileSync(file, 'utf8');
  assert.throws(() => importLibrary({ library: [{ persona: 'Fine', background: 'x' }, { persona: 'Bad' }] }, where), /needs a description/);
  assert.throws(() => importLibrary({ library: 'nope' }, where), /must be a list/);
  assert.throws(() => importLibrary({ spec: [] }, where), /no reviewers/);
  assert.throws(() => importLibrary('text', where), /expected a reviewers file/);
  assert.throws(() => importLibrary(null, where), /expected a reviewers file/);
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('server: the libraries are named, and save, import, export and remove take a scope', async () => {
  const { user, root, spec, file } = setup();
  m.init(spec, { type: 'spec' });
  m.publish(spec);
  const server = createServer(createHandler(spec));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, p, body) => fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const registry = async () => (await fetch(`${base}/api/reviewers`)).json();
  try {
    assert.deepEqual((await registry()).libraries, { user: { file: user }, project: { file, name: basename(root) } });

    const put = await call('PUT', '/api/reviewers', { persona: 'DBA', background: 'Owns the database.', model: 'opus', scope: 'project' });
    assert.equal(put.status, 200);
    assert.equal(read(file).library[0].persona, 'DBA');
    assert.equal(existsSync(user), false);
    const listed = named((await registry()).reviewers, 'DBA');
    assert.deepEqual([listed.source, listed.suggested], ['project', true]);
    assert.equal((await call('PUT', '/api/reviewers', { persona: 'X', background: 'x', scope: 'team' })).status, 400);

    const imported = await call('POST', '/api/reviewers/import', { scope: 'project', data: { library: [{ persona: 'Sec', background: 'Auth holes.' }] } });
    assert.deepEqual(await imported.json(), { added: 1, updated: 0, personas: ['Sec'] });
    assert.equal((await call('POST', '/api/reviewers/import', { scope: 'project', data: 'text' })).status, 400);
    assert.equal((await call('POST', '/api/reviewers/import', { data: { library: [{ persona: 'Bad' }] } })).status, 400);
    assert.equal(existsSync(user), false);

    const exported = await fetch(`${base}/api/reviewers/export?scope=project`);
    assert.deepEqual(await exported.json(), read(file));
    assert.deepEqual(await (await fetch(`${base}/api/reviewers/export`)).json(), { library: [] });

    assert.equal((await call('DELETE', '/api/reviewers/DBA')).status, 404); // not in the author's library
    assert.equal((await call('DELETE', '/api/reviewers/DBA?scope=project')).status, 200);
    assert.equal(named((await registry()).reviewers, 'DBA'), undefined);

    // A project reviewer runs like any other: the request carries its definition.
    assert.equal((await call('POST', '/api/submit', { mode: 'review', reviewers: [{ persona: 'Sec', model: 'haiku' }] })).status, 200);
    assert.deepEqual(m.pending(spec).request.reviewers.map((r) => [r.persona, r.background, r.model, r.source]), [['Sec', 'Auth holes.', 'haiku', 'project']]);
  } finally { server.close(); }
});

test('cli: reviewers lists the project library, and request-review takes a reviewer from it', () => {
  const { spec, file } = setup();
  write(file, { library: [{ persona: 'DBA', background: 'Owns the database.' }] });
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  assert.equal(run('init', spec, '--type', 'spec').status, 0);
  run('publish', spec);
  const listed = JSON.parse(run('reviewers', spec).stdout);
  assert.deepEqual(listed.filter((r) => r.suggested).map((r) => [r.persona, r.source]), [['DBA', 'project']]);
  const asked = run('request-review', spec, '--reviewer', 'DBA');
  assert.equal(asked.status, 0, asked.stderr);
  assert.equal(JSON.parse(asked.stdout).request.reviewers[0].background, 'Owns the database.');
});
