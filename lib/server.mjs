// Local HTTP server for the ReWriter UI. Binds 127.0.0.1 only.
// One server per document, whichever Claude session asks: a running server records itself in
// <stateDir>/server.json, and a later `serve` for the same document hands out that server's URL.
import { createServer } from 'node:http';
import { existsSync, readFileSync, realpathSync, renameSync, rmSync, watch, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import * as m from './model.mjs';
import { acquire } from './lock.mjs';
import { renderMarkdown } from './render.mjs';
import { isSessionId, sessionTitle } from './session.mjs';
import { pingServer, removeRunning, writeRunning } from './running.mjs';
import { plainFromHtml } from './text.mjs';
import { exportLibrary, listReviewers, MODELS, removeLibraryReviewer, saveLibraryReviewer } from './reviewers.mjs';

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

// opts.session: the Claude session that started the server, used to name the page when the review itself
// has no session on record. opts.onSession: called with the id of each Claude session that says it uses
// this server (`serve` finding it already running). opts.onApproved: called when the author approved the
// document through this server. opts.configDir and opts.titlePollMs are there for tests.
export function createHandler(where, { session = null, onSession = () => {}, onApproved = () => {}, configDir, titlePollMs = 3000 } = {}) {
  const dir = m.target(where);
  const clients = new Set();
  let lastActivity = Date.now();

  // The page is named after the session working on the review: the one holding the latest round, else
  // the last one that held a round, else the one that started this server.
  const currentTitle = () => {
    let review = null;
    try { review = m.load(dir); } catch { /* no review (yet) */ }
    const holder = [...(review?.rounds || [])].reverse().find((r) => r.session)?.session || session;
    return sessionTitle(holder, configDir ? { configDir } : undefined);
  };
  // Session titles change while a session runs (Claude Code retitles it, the user renames it), and
  // nothing in the review changes when they do: while a tab is open, look again every few seconds.
  let shownTitle = null;
  let titleTimer = null;
  const watchTitle = () => {
    if (titleTimer) return;
    shownTitle = currentTitle();
    titleTimer = setInterval(() => {
      const title = currentTitle();
      if (title === shownTitle) return;
      shownTitle = title;
      handler.notify();
    }, titlePollMs);
    titleTimer.unref();
  };
  const unwatchTitle = () => { clearInterval(titleTimer); titleTimer = null; };

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    const method = req.method;
    // "Are you there?" is not someone using the server: a session's footer asks every few seconds
    // (`rewriter running`), and a server nobody looks at must still stop after its idle time.
    const isPing = method === 'GET' && path === '/api/ping';
    if (!isPing) lastActivity = Date.now();
    // DNS-rebinding guard: only answer requests addressed to the loopback host.
    if (!LOCAL_HOST.test(String(req.headers.host || ''))) throw new m.RwError('unexpected Host header', 403);

    if (method !== 'GET') {
      // Same-origin JSON only: blocks cross-site form posts against this local server.
      const origin = req.headers.origin;
      if (origin && origin !== `http://${req.headers.host}`) throw new m.RwError('cross-origin request refused', 403);
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new m.RwError('expected application/json', 415);
    }

    if (method === 'GET') {
      // Lets `serve` and `running` tell that this server is alive, which document it shows, and (by its
      // pid) that it is the server a record names and not a later one on the same port.
      if (isPing) return send(res, 200, { rewriter: true, document: documentId(dir), pid: process.pid, tabs: clients.size });
      if (path === '/' || path === '/index.html') return sendFile(res, join(UI, 'index.html'));
      if (path.startsWith('/ui/')) { const f = safeJoin(UI, path.slice(4)); return f ? sendFile(res, f) : send(res, 403, { error: 'forbidden' }); }
      if (path === '/lib/text.mjs') return sendFile(res, join(ROOT, 'lib', 'text.mjs'));
      if (path === '/api/state') {
        const review = m.load(dir);
        let article = null;
        // An approved review shows what was approved (that round's snapshot), not whatever the file holds now.
        const last = review.rounds.at(-1);
        try { article = rendered(m.readArticle(dir, last?.status === 'approved' ? last.n : undefined)); } catch (e) { article = { error: e.message }; }
        shownTitle = currentTitle();
        return send(res, 200, { review, article, dir: dir.dir, articleFile: dir.file || review.article, docType: m.docType(review), sessionTitle: shownTitle });
      }
      if (path === '/api/reviewers') {
        const review = m.load(dir);
        const last = [...review.rounds].reverse().find((r) => r.request?.aiReview);
        return send(res, 200, { reviewers: listReviewers(review), models: MODELS, last: last ? last.request.reviewers : null });
      }
      if (path === '/api/reviewers/export') {
        const body = exportLibrary();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="reviewers.json"', ...HEADERS });
        return res.end(body);
      }
      const rm = /^\/api\/round\/(\d+)$/.exec(path);
      if (rm) return send(res, 200, rendered(m.readArticle(dir, Number(rm[1]))));
      if (path === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', ...HEADERS, Connection: 'keep-alive' });
        // A tab that (re)connects may have missed changes, e.g. while the server was restarted: reload.
        res.write('retry: 1500\n\nevent: change\ndata: {}\n\n');
        clients.add(res);
        watchTitle();
        req.on('close', () => { clients.delete(res); lastActivity = Date.now(); if (!clients.size) unwatchTitle(); });
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
    // The third way to end a round: the document is final, the review is closed (and this server stops).
    if (method === 'POST' && path === '/api/approve') {
      const round = m.approve(dir, { note: body?.note });
      send(res, 200, round);
      onApproved();
      return undefined;
    }
    // A Claude session that found this server running: recorded, so its footer can show this server.
    if (method === 'POST' && path === '/api/sessions') {
      if (isSessionId(body?.session)) onSession(body.session);
      return send(res, 200, { ok: true });
    }
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
  handler.lastActivity = () => lastActivity;
  return handler;
}

// ---- which server shows which document ----

const recordFile = (dir) => join(dir.stateDir, 'server.json');

function documentId(dir) {
  const p = m.articlePath(dir);
  try { return realpathSync(p); } catch { return p; }
}

function readRecord(dir) {
  try { return JSON.parse(readFileSync(recordFile(dir), 'utf8')); } catch { return null; }
}

// The server already showing this document, if there is one. The record alone proves nothing: that
// process may be gone, and its port may belong to another document's server by now. So ask the port.
async function findRunning(dir, record) {
  if (!Number.isInteger(record?.port)) return null;
  const url = `http://127.0.0.1:${record.port}/`;
  const info = await pingServer(url);
  return info?.document === documentId(dir) ? { url, port: record.port, tabs: info.tabs } : null;
}

// Tells a running server that `session` uses it too. A server from before sessions were recorded answers
// 404, and one that is busy may not answer in time: either way the URL is still good, so nothing is thrown.
async function announce(url, session) {
  try {
    await fetch(`${url}api/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session }), signal: AbortSignal.timeout(1000),
    });
  } catch { /* the footer link is all that is lost */ }
}

function listen(server, port) {
  return new Promise((res) => {
    const failed = () => { server.off('listening', ok); res(false); };
    const ok = () => { server.off('error', failed); res(true); };
    server.once('error', failed);
    server.once('listening', ok);
    server.listen(port, '127.0.0.1');
  });
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); } catch { /* print URL only */ }
}

const DEFAULT_PORT = 4870;
// How long a server stays up after its review was approved: long enough for open tabs to fetch the final state.
const APPROVED_STOP_MS = 1000;
// File-change events can be lost (a write right after the watch starts, a busy machine), and a lost one
// would leave an approved review's server running for good. So the question is also asked on a timer.
const APPROVED_POLL_MS = 2000;
const PORT_TRIES = 20;

// opts: port (first of 20 to try), open (the browser), idleMinutes (stop after this long with no browser
// tab connected and no request; 0 = never), session (the Claude session starting it, see createHandler),
// log and opener (replaceable output and browser launcher).
// Resolves to { url, port, reused, close(), closed }. `reused` means a server for this document was
// already running: nothing was started, and `closed` is already resolved.
export async function startServer(where, { port, open = true, idleMinutes = 120, session = null, log = (t) => process.stdout.write(t), opener = openBrowser } = {}) {
  const dir = m.target(where);
  const doc = m.articlePath(dir);
  // Two sessions starting `serve` for one document at the same moment: the second waits and reuses.
  const release = acquire(join(dir.stateDir, 'serve.lock'), { timeout: 10000 });
  try {
    const record = readRecord(dir);
    const running = await findRunning(dir, record);
    if (running) {
      if (isSessionId(session)) await announce(running.url, session);
      log(`ReWriter: already running for ${doc}\nReWriter: ${running.url}\n`);
      if (open && !running.tabs) opener(running.url);
      return { url: running.url, port: running.port, reused: true, close: async () => {}, closed: Promise.resolve() };
    }

    // The registry of running servers (lib/running.mjs): this server's record, and who asked for it.
    const sessions = isSessionId(session) ? [session] : [];
    let registered = null;
    const register = () => {
      if (!registered) return;
      try { writeRunning({ ...registered, sessions }); } catch { /* no footer link; the review still works */ }
    };
    // An approved review is closed, so its server has nothing left to do: when this one sees its review
    // become approved (the UI button, or `rewriter approve` from a session), it tells the tabs and stops.
    // "Become": a server started on a review that is already approved is there to show it, and stays, until
    // that review is reopened and approved again. And a review reopened before the server has gone keeps it.
    // Which round is approved, if the latest one is: a number, so that "approved again after a reopen" is
    // seen as new even when this server never caught the review in between (file-change events get lost).
    const approvedRound = () => {
      try { const r = m.load(dir).rounds.at(-1); return r?.status === 'approved' ? r.n : null; } catch { return null; }
    };
    let closing = false;
    let seenApproved = approvedRound(); // the approval this server already knows about (the one it started on)
    let stopTimer = null;
    const stopIfApproved = () => {
      if (closing) return;
      const n = approvedRound();
      if (n === null) { clearTimeout(stopTimer); stopTimer = null; return; } // not approved, or reopened in time
      if (n === seenApproved) return;
      seenApproved = n;
      handler.notify();
      clearTimeout(stopTimer);
      stopTimer = setTimeout(() => {
        if (approvedRound() !== n) return; // reopened in the meantime
        log(`ReWriter: ${doc} was approved, the review is closed: stopping\n`);
        close();
      }, APPROVED_STOP_MS);
      stopTimer.unref();
    };
    let approvalTimer = null;
    const handler = createHandler(dir, {
      session,
      onSession: (id) => { if (!sessions.includes(id)) { sessions.push(id); register(); } },
      onApproved: () => stopIfApproved(),
    });
    const articleFile = basename(doc);
    const server = createServer(handler);
    // A restarted server takes its old port back when it can, so the URL the author has still works.
    const first = port ?? DEFAULT_PORT;
    const ports = Array.from({ length: PORT_TRIES }, (_, i) => first + i);
    if (port === undefined && Number.isInteger(record?.port)) ports.unshift(record.port);
    let bound = null;
    for (const p of ports) {
      if (await listen(server, p)) { bound = p; break; }
    }
    if (bound === null) throw new m.RwError(`no free port in ${first}-${first + PORT_TRIES - 1}`, 500);

    const url = `http://127.0.0.1:${bound}/`;
    const tmp = `${recordFile(dir)}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ pid: process.pid, port: bound, url, document: doc, startedAt: new Date().toISOString() }, null, 2)}\n`);
    renameSync(tmp, recordFile(dir));
    registered = { pid: process.pid, port: bound, url, document: documentId(dir), startedAt: new Date().toISOString() };
    register();
    const watchers = [
      watch(dir.dir, (_, f) => { if (!f || basename(String(f)) === articleFile) handler.notify(); }),
      watch(dir.stateDir, (_, f) => { if (!f || String(f) === 'review.json') { handler.notify(); stopIfApproved(); } }),
    ];

    let idleTimer = null;
    let finished;
    const closed = new Promise((res) => { finished = res; });
    const onSignal = () => { close(); process.exit(0); };
    function close() {
      if (closing) return closed;
      closing = true;
      clearInterval(idleTimer);
      clearTimeout(stopTimer);
      clearInterval(approvalTimer);
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      watchers.forEach((w) => w.close());
      const mine = readRecord(dir);
      if (mine?.pid === process.pid && mine.port === bound) rmSync(recordFile(dir), { force: true });
      removeRunning(process.pid, bound);
      server.close(() => finished());
      server.closeAllConnections();
      return closed;
    }
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);

    approvalTimer = setInterval(stopIfApproved, APPROVED_POLL_MS);
    approvalTimer.unref();

    // A server nobody looks at would hold its port for good (its session may be long gone).
    const idleMs = idleMinutes * 60000;
    if (idleMs > 0) {
      idleTimer = setInterval(() => {
        if (handler.clients.size || Date.now() - handler.lastActivity() < idleMs) return;
        log(`ReWriter: no browser tab for ${idleMinutes} minutes, stopping (run serve again to reopen ${url})\n`);
        close();
      }, Math.min(60000, Math.max(20, idleMs / 2)));
    }

    log(`ReWriter: reviewing ${doc}\nReWriter: ${url}\n`);
    if (open) opener(url);
    return { server, url, port: bound, reused: false, close, closed };
  } finally { release(); }
}
