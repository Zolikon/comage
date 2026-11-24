// Which ReWriter servers are running on this machine, and for which Claude sessions: one record per
// server in ~/.claude/rewriter/running/<pid>-<port>.json (or $REWRITER_RUNNING). A server writes its own
// record and removes it when it stops; nothing else writes here. `rewriter running` reads them, which is
// how a session's footer finds the review UIs that session opened. See docs/session-footer-design.md.
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { alive } from './lock.mjs';

export const runningDir = () => process.env.REWRITER_RUNNING || join(homedir(), '.claude', 'rewriter', 'running');

const recordFile = (pid, port) => join(runningDir(), `${pid}-${port}.json`);

// record: { pid, port, url, document, startedAt, sessions }. `document` is what the server's /api/ping
// reports, so a record can be checked against the server it names.
export function writeRunning(record) {
  mkdirSync(runningDir(), { recursive: true });
  const file = recordFile(record.pid, record.port);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(tmp, file);
}

export function removeRunning(pid, port) {
  try { rmSync(recordFile(pid, port), { force: true }); } catch { /* nothing to remove */ }
}

// What the server at `url` says about itself, or null if nothing there answers as a ReWriter server.
export async function pingServer(url) {
  try {
    const info = await (await fetch(`${url}api/ping`, { signal: AbortSignal.timeout(1000) })).json();
    return info?.rewriter === true ? info : null;
  } catch { return null; }
}

// How a document is named in a short list: its file, or its folder when the file is an index.md.
export function docName(document) {
  const file = basename(document);
  return file === 'index.md' ? basename(dirname(document)) : file;
}

function readRecords() {
  let names;
  try { names = readdirSync(runningDir()); } catch { return []; }
  const records = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = join(runningDir(), name);
    let r;
    try { r = JSON.parse(readFileSync(file, 'utf8')); } catch { continue; }
    const ok = r && typeof r === 'object' && Number.isInteger(r.pid) && typeof r.url === 'string'
      && typeof r.document === 'string' && Array.isArray(r.sessions);
    if (ok) records.push({ ...r, file });
  }
  return records;
}

// The servers that are up right now, oldest first: those `session` asked for, or all of them without one.
// A record proves nothing by itself, so each server is asked, and must answer as the process the record
// names: after a crash or a reboot the old record is still there, a new server may have taken the port
// back, and the old pid may belong to anything. A record whose process is gone is deleted; one that
// merely doesn't answer, or isn't answered by its own server, is left alone.
export async function listRunning({ session = null } = {}) {
  const live = await Promise.all(readRecords().map(async (r) => {
    if (!alive(r.pid)) { try { rmSync(r.file, { force: true }); } catch { /* someone else did */ } return null; }
    if (session && !r.sessions.includes(session)) return null;
    const info = await pingServer(r.url);
    return info && info.pid === r.pid && info.document === r.document ? r : null;
  }));
  return live.filter(Boolean)
    .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)))
    .map((r) => ({ name: docName(r.document), url: r.url, document: r.document }));
}
