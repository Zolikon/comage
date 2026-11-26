import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as m from '../lib/model.mjs';
import { createHandler, startServer } from '../lib/server.mjs';
import { fakeSession, stateDir, tmpArticle, tmpProject } from './helpers.mjs';
import { listRunning, runningDir } from '../lib/running.mjs';

async function boot() {
  const dir = tmpArticle();
  m.init(dir);
  m.addComments(dir, [{ severity: 'MAJOR', body: 'x', quote: 'The cat ran' }]);
  const server = createServer(createHandler(dir));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { dir, server, base, post };
}

test('state, round gating, decisions, static guards', async () => {
  const { dir, server, base, post } = await boot();
  try {
    const st = await (await fetch(`${base}/api/state`)).json();
    assert.equal(st.review.comments.length, 1);
    assert.equal(st.article.title, 'Test Article');
    assert.equal(st.version, JSON.parse(readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8')).version); // shown beside the logo
    assert.match(st.article.plain, /The cat ran/);
    assert.equal((await post('/api/comments/c1/decision', { type: 'approve' })).status, 409);
    m.publish(dir);
    assert.equal((await post('/api/comments/c1/decision', { type: 'approve', note: 'ok' })).status, 200);
    assert.equal((await post('/api/comments/c1/reply', { body: 'hm' })).status, 404); // the author no longer answers in the thread
    assert.equal((await fetch(`${base}/api/round/1`)).status, 200);
    const uc = await post('/api/comments', { anchor: { kind: 'article' }, body: 'mine' });
    assert.equal((await uc.json()).id, 'c2');
    assert.equal((await fetch(`${base}/api/comments/c2`, { method: 'DELETE', headers: { 'content-type': 'application/json' } })).status, 200);
    // CSRF guards
    assert.equal((await fetch(`${base}/api/submit`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status, 415);
    assert.equal((await fetch(`${base}/api/submit`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body: '{}' })).status, 403);
    // static
    assert.equal((await fetch(`${base}/lib/text.mjs`)).status, 200);
    assert.equal((await fetch(`${base}/ui/..%2f..%2frewriter.mjs`)).status, 403);
    assert.equal((await fetch(`${base}/.rewriter/reviews/index.md/review.json`)).status, 404);
    assert.equal((await post('/api/submit', {})).status, 200);
    assert.equal(m.load(dir).rounds[0].status, 'submitted');
  } finally { server.close(); }
});

test('rejects foreign Host header (DNS rebinding) and sends CSP', async () => {
  const { server, base } = await boot();
  const { request } = await import('node:http');
  try {
    const status = await new Promise((res) => {
      const u = new URL(base);
      request({ host: u.hostname, port: u.port, path: '/api/state', headers: { host: `evil.example:${u.port}` } }, (r) => { r.resume(); res(r.statusCode); }).end();
    });
    assert.equal(status, 403);
    const page = await fetch(`${base}/`);
    assert.match(page.headers.get('content-security-policy') || '', /script-src 'self'/);
  } finally { server.close(); }
});

// ---- one server per document, shared by every Claude session ----

const freePort = () => new Promise((res) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});
const record = (dir) => join(stateDir(dir), 'server.json');
const DEAD_PID = 2147483646;

async function serve(dir, opts = {}) {
  const lines = [];
  const opened = [];
  const s = await startServer(dir, { open: false, log: (t) => lines.push(t), opener: (u) => opened.push(u), ...opts });
  return { ...s, out: () => lines.join(''), opened };
}

function reviewed() {
  const dir = tmpArticle();
  m.init(dir);
  return dir;
}

test('a second serve for the same document reuses the running server instead of starting another', async () => {
  const dir = reviewed();
  const first = await serve(dir, { port: await freePort() });
  try {
    assert.equal(first.reused, false);
    const second = await serve(dir);
    assert.equal(second.reused, true);
    assert.equal(second.url, first.url);
    assert.match(second.out(), /already running/);
    assert.ok(second.out().includes(first.url));
    const ping = await (await fetch(`${first.url}api/ping`)).json();
    assert.equal(ping.document, realpathSync(join(dir, 'index.md')));
  } finally { await first.close(); }
  assert.equal(existsSync(record(dir)), false, 'a stopped server removes its record');
});

test('reusing a server opens the browser only when no tab is showing the document', async () => {
  const dir = reviewed();
  const first = await serve(dir, { port: await freePort() });
  const tab = new AbortController();
  try {
    const noTab = await serve(dir, { open: true });
    assert.deepEqual(noTab.opened, [first.url]);
    const sse = await fetch(`${first.url}api/events`, { signal: tab.signal });
    await sse.body.getReader().read();
    const withTab = await serve(dir, { open: true });
    assert.deepEqual(withTab.opened, []);
  } finally { tab.abort(); await first.close(); }
});

test('two documents in one folder get a server each', async () => {
  const dir = tmpArticle();
  writeFileSync(join(dir, 'spec.md'), '# Spec\n');
  writeFileSync(join(dir, 'plan.md'), '# Plan\n');
  m.init(join(dir, 'spec.md')); m.init(join(dir, 'plan.md'));
  const base = await freePort();
  const spec = await serve(join(dir, 'spec.md'), { port: base });
  const plan = await serve(join(dir, 'plan.md'), { port: base });
  try {
    assert.equal(plan.reused, false);
    assert.notEqual(plan.port, spec.port);
    assert.match((await (await fetch(`${plan.url}api/ping`)).json()).document, /plan\.md$/);
    assert.match((await (await fetch(`${spec.url}api/ping`)).json()).document, /spec\.md$/);
  } finally { await spec.close(); await plan.close(); }
});

test('a record left by a dead server is ignored, and its port is taken again so the old URL keeps working', async () => {
  const dir = reviewed();
  const port = await freePort();
  writeFileSync(record(dir), JSON.stringify({ pid: DEAD_PID, port, url: `http://127.0.0.1:${port}/` }));
  const s = await serve(dir);
  try {
    assert.equal(s.reused, false);
    assert.equal(s.port, port);
    assert.equal(JSON.parse(readFileSync(record(dir), 'utf8')).pid, process.pid);
  } finally { await s.close(); }
});

test('a record whose port now serves another document is not reused', async () => {
  const other = await serve(reviewed(), { port: await freePort() });
  const dir = reviewed();
  writeFileSync(record(dir), JSON.stringify({ pid: process.pid, port: other.port, url: other.url }));
  const s = await serve(dir, { port: await freePort() });
  try {
    assert.equal(s.reused, false);
    assert.notEqual(s.port, other.port);
  } finally { await s.close(); await other.close(); }
});

test('the server stops by itself when no browser tab has been connected for the idle time', async () => {
  const dir = reviewed();
  const s = await serve(dir, { port: await freePort(), idleMinutes: 0.002 });
  await Promise.race([s.closed, new Promise((_, no) => setTimeout(() => no(new Error('still running after 3s')), 3000))]);
  assert.equal(existsSync(record(dir)), false);
  await assert.rejects(fetch(`${s.url}api/ping`));
});

test('a connected browser tab keeps the server running past the idle time', async () => {
  const dir = reviewed();
  const s = await serve(dir, { port: await freePort(), idleMinutes: 0.002 });
  const tab = new AbortController();
  try {
    const sse = await fetch(`${s.url}api/events`, { signal: tab.signal });
    await sse.body.getReader().read();
    await new Promise((r) => setTimeout(r, 500));
    assert.equal((await fetch(`${s.url}api/ping`)).status, 200);
  } finally { tab.abort(); await s.close(); }
});

test('a tab that connects is told to reload, so it catches up after the server was restarted', async () => {
  const { server, base } = await boot();
  const tab = new AbortController();
  try {
    const reader = (await fetch(`${base}/api/events`, { signal: tab.signal })).body.getReader();
    let text = '';
    const deadline = Date.now() + 1000;
    while (!text.includes('event: change') && Date.now() < deadline) {
      const chunk = await Promise.race([reader.read(), new Promise((r) => setTimeout(() => r(null), 300))]);
      if (!chunk || chunk.done) break;
      text += Buffer.from(chunk.value).toString('utf8');
    }
    assert.match(text, /event: change/);
  } finally { tab.abort(); server.close(); server.closeAllConnections(); }
});

// ---- the page is named after the Claude session working on the review ----

const titled = (id, title) => fakeSession(id, [{ type: 'ai-title', aiTitle: title, sessionId: id }]);

async function bootFor(dir, opts) {
  const handler = createHandler(dir, opts);
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const stop = () => { server.close(); server.closeAllConnections(); };
  return { base, stop, title: async () => (await (await fetch(`${base}/api/state`)).json()).sessionTitle };
}

test('state carries the title of the session that holds the latest round', async () => {
  const a = titled('sess-a', 'Session A title');
  writeFileSync(join(a.configDir, 'projects', '-some-project', 'sess-b.jsonl'), `${JSON.stringify({ type: 'custom-title', customTitle: 'Session B name' })}\n`);
  const dir = tmpArticle();
  m.init(dir, { session: 'sess-a' });
  const s = await bootFor(dir, { configDir: a.configDir });
  try {
    assert.equal(await s.title(), 'Session A title');
    a.add({ type: 'ai-title', aiTitle: 'Session A, retitled' });
    assert.equal(await s.title(), 'Session A, retitled');
    m.claim(dir, { session: 'sess-b' }); // another session takes the round over: the page follows it
    assert.equal(await s.title(), 'Session B name');
    m.publish(dir, { session: 'sess-b' }); m.submit(dir); m.nextRound(dir); // a round opened by hand, no session
    assert.equal(await s.title(), 'Session B name', 'falls back to the last session that worked on the review');
  } finally { s.stop(); }
});

test('a review with no session on record is named after the session that started the server; none gives null', async () => {
  const a = titled('sess-a', 'Started the server');
  const dir = tmpArticle();
  m.init(dir);
  const withSession = await bootFor(dir, { configDir: a.configDir, session: 'sess-a' });
  const without = await bootFor(dir, { configDir: a.configDir });
  try {
    assert.equal(await withSession.title(), 'Started the server');
    assert.equal(await without.title(), null);
  } finally { withSession.stop(); without.stop(); }
});

test('an open tab is told to reload when the session title changes', async () => {
  const a = titled('sess-a', 'Before');
  const dir = tmpArticle();
  m.init(dir, { session: 'sess-a' });
  const s = await bootFor(dir, { configDir: a.configDir, titlePollMs: 25 });
  const tab = new AbortController();
  try {
    const reader = (await fetch(`${s.base}/api/events`, { signal: tab.signal })).body.getReader();
    let pendingRead = null; // a read that outlived its time window still owns the next chunk
    const changes = async (ms) => {
      let n = 0;
      const until = Date.now() + ms;
      while (Date.now() < until) {
        pendingRead ??= reader.read();
        const chunk = await Promise.race([pendingRead, new Promise((r) => setTimeout(() => r(null), until - Date.now()))]);
        if (!chunk) break;
        pendingRead = null;
        if (chunk.done) break;
        n += Buffer.from(chunk.value).toString('utf8').split('event: change').length - 1;
      }
      return n;
    };
    assert.equal(await changes(300), 1, 'only the reload sent on connect while the title stays the same');
    a.add({ type: 'ai-title', aiTitle: 'After' });
    assert.equal(await changes(500), 1);
    assert.equal(await s.title(), 'After');
  } finally { tab.abort(); s.stop(); }
});

// ---- the registry of running servers (lib/running.mjs), which a session's footer reads ----

const rec = (s) => JSON.parse(readFileSync(join(runningDir(), `${process.pid}-${s.port}.json`), 'utf8'));
const announce = (s, body) => fetch(`${s.url}api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('a running server is in the registry with the session that started it, and leaves it when it stops', async () => {
  const dir = reviewed();
  const s = await serve(dir, { port: await freePort(), session: 'sess-a' });
  try {
    const r = rec(s);
    assert.deepEqual(r.sessions, ['sess-a']);
    assert.equal(r.url, s.url);
    assert.equal(r.pid, process.pid);
    assert.equal(r.document, realpathSync(join(dir, 'index.md')));
    assert.equal((await (await fetch(`${s.url}api/ping`)).json()).pid, process.pid, 'a record is matched to its server by pid');
    assert.deepEqual((await listRunning({ session: 'sess-a' })).map((x) => x.url), [s.url]);
  } finally { await s.close(); }
  assert.equal(existsSync(join(runningDir(), `${process.pid}-${s.port}.json`)), false);
});

// The footer asks every few seconds whether its servers are up. That must not count as someone using them.
test('being asked whether it is alive does not keep an idle server running', async () => {
  const dir = reviewed();
  const s = await serve(dir, { port: await freePort(), idleMinutes: 0.002, session: 'sess-a' });
  const poll = setInterval(() => { listRunning({ session: 'sess-a' }).catch(() => {}); }, 20);
  try {
    await Promise.race([s.closed, new Promise((_, no) => setTimeout(() => no(new Error('still running after 3s')), 3000))]);
  } finally { clearInterval(poll); await s.close(); }
});

test('a session that finds the server running is added to its record, once', async () => {
  const dir = reviewed();
  const first = await serve(dir, { port: await freePort(), session: 'sess-a' });
  try {
    await serve(dir, { session: 'sess-b' });
    await serve(dir, { session: 'sess-b' });
    await serve(dir, { session: 'sess-a' });
    assert.deepEqual(rec(first).sessions, ['sess-a', 'sess-b']);
    assert.deepEqual((await listRunning({ session: 'sess-b' })).map((x) => x.url), [first.url]);
  } finally { await first.close(); }
});

test('a server started by hand has no sessions; reusing it by hand adds none', async () => {
  const dir = reviewed();
  const first = await serve(dir, { port: await freePort() });
  try {
    assert.deepEqual(rec(first).sessions, []);
    await serve(dir);
    assert.deepEqual(rec(first).sessions, []);
  } finally { await first.close(); }
});

test('POST /api/sessions ignores an id that is not a session id', async () => {
  const dir = reviewed();
  const s = await serve(dir, { port: await freePort(), session: 'sess-a' });
  try {
    for (const body of [{ session: '../x' }, { session: 42 }, {}]) assert.equal((await announce(s, body)).status, 200);
    assert.deepEqual(rec(s).sessions, ['sess-a']);
  } finally { await s.close(); }
});

test('reusing a server that does not know /api/sessions still hands out its URL', async () => {
  const dir = reviewed();
  const document = realpathSync(join(dir, 'index.md'));
  const old = createServer((req, res) => {
    const known = req.url === '/api/ping';
    res.writeHead(known ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(known ? { rewriter: true, document, tabs: 1 } : { error: 'not found' }));
  });
  await new Promise((r) => old.listen(0, '127.0.0.1', r));
  const { port } = old.address();
  writeFileSync(record(dir), JSON.stringify({ pid: process.pid, port, url: `http://127.0.0.1:${port}/` }));
  try {
    const s = await serve(dir, { session: 'sess-a' });
    assert.equal(s.reused, true);
    assert.equal(s.url, `http://127.0.0.1:${port}/`);
  } finally { old.close(); }
});

test('a registry that cannot be written does not stop the server', async () => {
  const dir = reviewed();
  const kept = process.env.REWRITER_RUNNING;
  const file = join(tmpArticle(), 'a-file');
  writeFileSync(file, '');
  process.env.REWRITER_RUNNING = join(file, 'running'); // under a regular file: can't be created
  let s;
  try {
    s = await serve(dir, { port: await freePort(), session: 'sess-a' });
    assert.equal((await fetch(`${s.url}api/ping`)).status, 200);
    assert.equal((await announce(s, { session: 'sess-b' })).status, 200);
  } finally { await s?.close(); process.env.REWRITER_RUNNING = kept; }
});

// ---- approve: the review is closed, and a server that sees it happen stops ----

const post = (s, path, body, headers = { 'content-type': 'application/json' }) => fetch(`${s.url}${path.slice(1)}`, { method: 'POST', headers, body: JSON.stringify(body) });
// 5 s: a lost file-change event is made up for by the server's own 2 s check, plus its 1 s goodbye.
const stopped = (s) => Promise.race([s.closed, new Promise((_, no) => { setTimeout(() => no(new Error('still running after 5s')), 5000).unref(); })]);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

test('approving in the UI closes the review and stops its server', async () => {
  const dir = reviewed();
  const s = await serve(dir, { port: await freePort(), session: 'sess-a' });
  try {
    m.publish(dir);
    const res = await post(s, '/api/approve', { note: 'final' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, 'approved');
    await stopped(s);
    assert.deepEqual(await listRunning({ session: 'sess-a' }), []);
    // The review is over, so nothing of it stays: not its state, not the folders that held it.
    assert.throws(() => m.load(dir), (e) => e.status === 404);
    assert.equal(existsSync(join(dir, '.rewriter')), false);
    assert.equal(existsSync(join(dir, 'index.md')), true);
  } finally { await s.close(); }
});

test('after an approval inside a project, the project holds no trace of ReWriter', async () => {
  const root = tmpProject();
  mkdirSync(join(root, 'docs'));
  const doc = join(root, 'docs', 'spec.md');
  writeFileSync(doc, '# Spec\n\nText.\n');
  m.init(doc);
  const s = await serve(doc, { port: await freePort() });
  try {
    m.publish(doc);
    assert.equal(existsSync(join(root, '.rewriter', 'reviews', 'docs', 'spec.md', 'review.json')), true);
    assert.equal((await post(s, '/api/approve', {})).status, 200);
    await stopped(s);
    assert.equal(existsSync(join(root, '.rewriter')), false);
  } finally { await s.close(); }
});

test('approving from the CLI side stops a running server too', async () => {
  const dir = reviewed();
  const s = await serve(dir, { port: await freePort() });
  try {
    m.publish(dir);
    m.approve(dir);
    await stopped(s);
  } finally { await s.close(); }
});

test('open tabs are told to reload before the server goes away', async () => {
  const dir = reviewed();
  const s = await serve(dir, { port: await freePort() });
  const tabs = [new AbortController(), new AbortController()];
  try {
    m.publish(dir);
    const readers = [];
    for (const tab of tabs) {
      const reader = (await fetch(`${s.url}api/events`, { signal: tab.signal })).body.getReader();
      await reader.read(); // the reload every tab gets when it connects
      readers.push(reader);
    }
    await pause(300); // let the publish above settle, so the next event is the approval
    m.approve(dir);
    for (const reader of readers) {
      const { value } = await reader.read();
      assert.match(new TextDecoder().decode(value), /event: change/);
    }
    await stopped(s);
  } finally { tabs.forEach((t) => t.abort()); await s.close(); }
});

test('approve is refused when the round is not open, and the server keeps running', async () => {
  const dir = reviewed(); // round 1 still being prepared
  const s = await serve(dir, { port: await freePort() });
  try {
    assert.equal((await post(s, '/api/approve', {})).status, 409);
    await pause(1500);
    assert.equal((await fetch(`${s.url}api/ping`)).status, 200);
  } finally { await s.close(); }
});

test('a review started inside the goodbye second is not removed by the old server', async () => {
  const dir = reviewed();
  const s = await serve(dir, { port: await freePort() });
  try {
    m.publish(dir);
    await pause(300);
    assert.equal((await post(s, '/api/approve', {})).status, 200);
    m.init(dir); // the document is reviewed again at once
    m.addComments(dir, [{ severity: 'MINOR', body: 'belongs to the new review' }]);
    await stopped(s);
    assert.equal(m.load(dir).comments.length, 1, 'the new review is still there');
  } finally { await s.close(); }
});

test('a server refuses to start on an approved review', async () => {
  const dir = reviewed();
  m.publish(dir);
  m.approve(dir);
  await assert.rejects(serve(dir, { port: await freePort() }), (e) => e.status === 409 && /was approved/.test(e.message));
  assert.equal(existsSync(record(dir)), false, 'and leaves no server record behind');
});

test('POST /api/approve sits behind the same guards as the other writes', async () => {
  const dir = reviewed();
  const s = await serve(dir, { port: await freePort() });
  try {
    m.publish(dir);
    assert.equal((await post(s, '/api/approve', {}, { 'content-type': 'text/plain' })).status, 415);
    assert.equal((await post(s, '/api/approve', {}, { 'content-type': 'application/json', origin: 'http://evil.example' })).status, 403);
    assert.equal(m.load(dir).rounds.at(-1).status, 'open');
  } finally { await s.close(); }
});

test('the server is closed before the review is removed, so no tab is sent to a state that is gone', async () => {
  const dir = reviewed();
  const s = await serve(dir, { port: await freePort() });
  const tab = new AbortController();
  try {
    m.publish(dir);
    const reader = (await fetch(`${s.url}api/events`, { signal: tab.signal })).body.getReader();
    await reader.read(); // the reload every tab gets when it connects
    await pause(300);
    m.approve(dir);
    const seen = [];
    for (;;) { // read until the server hangs up
      let chunk;
      try { chunk = await reader.read(); } catch { break; }
      if (chunk.done) break;
      seen.push(existsSync(join(stateDir(dir), 'review.json')));
    }
    assert.ok(seen.length >= 1, 'the tab was told about the approval');
    assert.ok(seen.every(Boolean), 'every time the tab was told to reload, the state was still there to load');
    await stopped(s);
  } finally { tab.abort(); await s.close(); }
});
