import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import * as m from '../lib/model.mjs';
import { createHandler } from '../lib/server.mjs';
import { tmpArticle } from './helpers.mjs';

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
    assert.match(st.article.plain, /The cat ran/);
    assert.equal((await post('/api/comments/c1/decision', { type: 'approve' })).status, 409);
    m.publish(dir);
    assert.equal((await post('/api/comments/c1/decision', { type: 'approve', note: 'ok' })).status, 200);
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
    assert.equal((await fetch(`${base}/.rewriter/review.json`)).status, 404);
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
