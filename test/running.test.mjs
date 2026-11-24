import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import './helpers.mjs';
import { docName, listRunning, removeRunning, runningDir, writeRunning } from '../lib/running.mjs';

// Each test gets a registry of its own.
const freshRegistry = () => { process.env.REWRITER_RUNNING = mkdtempSync(join(tmpdir(), 'rw-running-')); };

// Answers /api/ping the way a ReWriter server showing `document` does.
async function fakeServer(document) {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ rewriter: true, document, pid: process.pid, tabs: 0 }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { port, url: `http://127.0.0.1:${port}/`, close: () => server.close() };
}

const record = (s, document, over = {}) => ({
  pid: process.pid, port: s.port, url: s.url, document, startedAt: '2026-11-24T10:00:00.000Z', sessions: [], ...over,
});

test('docName: the file name, or the folder name for an index.md', () => {
  assert.equal(docName('/a/b/auth.md'), 'auth.md');
  assert.equal(docName('/a/my-article/index.md'), 'my-article');
});

test('no registry directory yet: nothing is running', async () => {
  process.env.REWRITER_RUNNING = join(mkdtempSync(join(tmpdir(), 'rw-')), 'missing');
  assert.deepEqual(await listRunning({ session: 's1' }), []);
});

test('lists the live servers of the calling session, oldest first', async () => {
  freshRegistry();
  const a = await fakeServer('/docs/a.md');
  const b = await fakeServer('/docs/b.md');
  try {
    writeRunning(record(a, '/docs/a.md', { startedAt: '2026-11-24T10:00:00.000Z', sessions: ['s1'] }));
    writeRunning(record(b, '/docs/b.md', { startedAt: '2026-11-24T09:00:00.000Z', sessions: ['s1', 's2'] }));
    assert.deepEqual((await listRunning({ session: 's1' })).map((x) => x.name), ['b.md', 'a.md']);
    assert.deepEqual((await listRunning({ session: 's2' })).map((x) => x.name), ['b.md']);
    assert.deepEqual(await listRunning({ session: 's3' }), []);
    const all = await listRunning();
    assert.equal(all.length, 2, 'no session: every live server');
    assert.deepEqual(all[0], { name: 'b.md', url: b.url, document: '/docs/b.md' });
  } finally { a.close(); b.close(); }
});

test('a record whose pid is dead is deleted; one whose port answers for another document is skipped and kept', async () => {
  freshRegistry();
  const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
  const other = await fakeServer('/other.md');
  try {
    writeRunning({ pid: deadPid, port: 1, url: 'http://127.0.0.1:1/', document: '/gone.md', startedAt: '2026-11-24T10:00:00.000Z', sessions: [] });
    writeRunning(record(other, '/mine.md'));
    assert.deepEqual(await listRunning(), []);
    assert.equal(existsSync(join(runningDir(), `${deadPid}-1.json`)), false, 'what a crashed server left is cleared');
    assert.equal(existsSync(join(runningDir(), `${process.pid}-${other.port}.json`)), true);
  } finally { other.close(); }
});

test('broken and foreign files in the registry are skipped', async () => {
  freshRegistry();
  mkdirSync(runningDir(), { recursive: true });
  writeFileSync(join(runningDir(), 'x.json'), '{not json');
  writeFileSync(join(runningDir(), 'notes.txt'), 'hello');
  writeFileSync(join(runningDir(), '7.json'), '[]');
  writeFileSync(join(runningDir(), '8.json'), 'null');
  assert.deepEqual(await listRunning(), []);
});

test('writeRunning creates the directory and removeRunning takes the record away, twice without error', () => {
  process.env.REWRITER_RUNNING = join(mkdtempSync(join(tmpdir(), 'rw-')), 'deep', 'running');
  const file = join(runningDir(), `${process.pid}-4870.json`);
  writeRunning({ pid: process.pid, port: 4870, url: 'http://127.0.0.1:4870/', document: '/d.md', startedAt: 'x', sessions: [] });
  assert.equal(existsSync(file), true);
  removeRunning(process.pid, 4870);
  assert.equal(existsSync(file), false);
  removeRunning(process.pid, 4870);
});

// After a crash or a reboot the old record is still there, the new server takes the old port back, and
// the old pid may belong to any process by now.
test('a record left by an earlier server on the same port is not listed beside the live one', async () => {
  freshRegistry();
  const a = await fakeServer('/docs/a.md');
  try {
    writeRunning(record(a, '/docs/a.md', { sessions: ['s1'] }));
    writeRunning(record(a, '/docs/a.md', { pid: process.ppid, sessions: ['s1'] })); // alive, but not that server
    assert.deepEqual((await listRunning({ session: 's1' })).map((x) => x.url), [a.url]);
  } finally { a.close(); }
});
