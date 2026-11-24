// Local HTTP server for the ReWriter UI. Binds 127.0.0.1 only.
import { createServer } from 'node:http';
import { existsSync, readFileSync, watch } from 'node:fs';
import { basename, dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import * as m from './model.mjs';
import { renderMarkdown } from './render.mjs';
import { plainFromHtml } from './text.mjs';
import { listReviewers, MODELS, removeLibraryReviewer, saveLibraryReviewer } from './reviewers.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UI = join(ROOT, 'ui');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.mp4': 'video/mp4',
};

// Article HTML is rendered into the page, so scripts are locked to our own files.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src * data: blob:; media-src *; "
  + "connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
const HEADERS = { 'Cache-Control': 'no-store', 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff' };
const LOCAL_HOST = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i;

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, ...HEADERS });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

function sendFile(res, file) {
  if (!existsSync(file)) return send(res, 404, { error: 'not found' });
  res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream', ...HEADERS });
  res.end(readFileSync(file));
}

// Resolve `rel` inside `base`, refusing anything that escapes it.
function safeJoin(base, rel) {
  const p = normalize(join(base, decodeURIComponent(rel)));
  return p === base || p.startsWith(base + sep) ? p : null;
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) { reject(new m.RwError('body too large', 413)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolveBody({});
      try { resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new m.RwError('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function rendered(md) {
  const r = renderMarkdown(md);
  return { html: r.html, title: r.title, frontmatter: r.frontmatter, plain: plainFromHtml(r.html) };
}

export function createHandler(where) {
  const dir = m.target(where);
  const clients = new Set();

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    const method = req.method;
    // DNS-rebinding guard: only answer requests addressed to the loopback host.
    if (!LOCAL_HOST.test(String(req.headers.host || ''))) throw new m.RwError('unexpected Host header', 403);

    if (method !== 'GET') {
      // Same-origin JSON only: blocks cross-site form posts against this local server.
      const origin = req.headers.origin;
      if (origin && origin !== `http://${req.headers.host}`) throw new m.RwError('cross-origin request refused', 403);
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new m.RwError('expected application/json', 415);
    }

    if (method === 'GET') {
      if (path === '/' || path === '/index.html') return sendFile(res, join(UI, 'index.html'));
      if (path.startsWith('/ui/')) { const f = safeJoin(UI, path.slice(4)); return f ? sendFile(res, f) : send(res, 403, { error: 'forbidden' }); }
      if (path === '/lib/text.mjs') return sendFile(res, join(ROOT, 'lib', 'text.mjs'));
      if (path === '/api/state') {
        const review = m.load(dir);
        let article = null;
        try { article = rendered(m.readArticle(dir)); } catch (e) { article = { error: e.message }; }
        return send(res, 200, { review, article, dir: dir.dir, articleFile: dir.file || review.article, docType: m.docType(review) });
      }
      if (path === '/api/reviewers') {
        const review = m.load(dir);
        const last = [...review.rounds].reverse().find((r) => r.request?.aiReview);
        return send(res, 200, { reviewers: listReviewers(review), models: MODELS, last: last ? last.request.reviewers : null });
      }
      const rm = /^\/api\/round\/(\d+)$/.exec(path);
      if (rm) return send(res, 200, rendered(m.readArticle(dir, Number(rm[1]))));
      if (path === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', ...HEADERS, Connection: 'keep-alive' });
        res.write('retry: 1500\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return undefined;
      }
      // Anything else: an asset referenced by the article (images etc.), relative to the article dir.
      if (!path.startsWith('/api/') && !path.includes('/.rewriter')) {
        const f = safeJoin(dir.dir, path.slice(1));
        if (f && MIME[extname(f).toLowerCase()]) return sendFile(res, f);
      }
      return send(res, 404, { error: 'not found' });
    }

    const body = await readBody(req);
    if (method === 'POST' && path === '/api/comments') return send(res, 200, m.userComment(dir, body));
    if (method === 'POST' && path === '/api/submit') return send(res, 200, m.submit(dir, body));
    // The author's reviewer library (their user file). Saving also drops this review's own copy of that
    // reviewer, so the saved definition is the one in effect.
    if (method === 'PUT' && path === '/api/reviewers') {
      const saved = saveLibraryReviewer(body, m.docType(m.load(dir)));
      m.forgetReviewer(dir, saved.persona);
      return send(res, 200, saved);
    }
    const rv = /^\/api\/reviewers\/([^/]+)$/.exec(path);
    if (rv && method === 'DELETE') {
      let persona;
      try { persona = decodeURIComponent(rv[1]); } catch { throw new m.RwError('bad reviewer name in URL', 400); }
      return send(res, 200, removeLibraryReviewer(persona, m.docType(m.load(dir))));
    }
    const cm = /^\/api\/comments\/(c\d+)(?:\/(decision|reply|resolve|reopen))?$/.exec(path);
    if (cm) {
      const [, id, action] = cm;
      if (method === 'DELETE' && !action) return send(res, 200, m.deleteComment(dir, id));
      if (method === 'POST' && action === 'decision') return send(res, 200, m.setDecision(dir, id, body));
      if (method === 'POST' && action === 'reply') return send(res, 200, m.userReply(dir, id, body.body));
      if (method === 'POST' && action === 'resolve') return send(res, 200, m.resolve(dir, id));
      if (method === 'POST' && action === 'reopen') return send(res, 200, m.reopen(dir, id));
    }
    return send(res, 404, { error: 'not found' });
  }

  const handler = (req, res) => {
    handle(req, res).catch((e) => {
      if (res.headersSent) { res.end(); return; }
      send(res, Number.isInteger(e.status) ? e.status : 500, { error: e.message });
    });
  };

  let timer = null;
  handler.notify = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { for (const c of clients) c.write('event: change\ndata: {}\n\n'); }, 150);
  };
  handler.clients = clients;
  return handler;
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); } catch { /* print URL only */ }
}

export async function startServer(where, { port = 4870, open = true } = {}) {
  const dir = m.target(where);
  const handler = createHandler(dir);
  const articleFile = basename(m.articlePath(dir));
  const watchers = [
    watch(dir.dir, (_, f) => { if (!f || basename(String(f)) === articleFile) handler.notify(); }),
    watch(dir.stateDir, (_, f) => { if (!f || String(f) === 'review.json') handler.notify(); }),
  ];
  const server = createServer(handler);
  for (let p = port; p < port + 20; p++) {
    const ok = await new Promise((res) => {
      server.once('error', () => res(false));
      server.listen(p, '127.0.0.1', () => res(true));
    });
    if (ok) {
      const url = `http://127.0.0.1:${p}/`;
      process.stdout.write(`ReWriter: reviewing ${m.articlePath(dir)}\nReWriter: ${url}\n`);
      if (open) openBrowser(url);
      const close = () => { watchers.forEach((w) => w.close()); server.close(); process.exit(0); };
      process.on('SIGINT', close);
      process.on('SIGTERM', close);
      return { server, url, port: p };
    }
  }
  throw new m.RwError(`no free port in ${port}-${port + 19}`, 500);
}
