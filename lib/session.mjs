// The title Claude Code shows for a session, read from the session's transcript:
//   <config dir>/projects/<project>/<session id>.jsonl
// Claude Code appends {"type":"ai-title","aiTitle":…} when it (re)titles a session and
// {"type":"custom-title","customTitle":…} when the user names it; the user's name wins. This is Claude
// Code's own file format, not a published interface: whatever can't be read gives null, never an error.
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const defaultConfigDir = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');

// Transcripts grow to megabytes and the title can change at any time, so each one is read once and
// after that only what was appended since. Keyed by file: { offset, rest, ai, custom }.
const scans = new Map();
const found = new Map(); // `${configDir}|${id}` -> transcript path

function transcript(configDir, id) {
  const key = `${configDir}|${id}`;
  const known = found.get(key);
  if (known && existsSync(known)) return known;
  const projects = join(configDir, 'projects');
  for (const project of readdirSync(projects)) {
    const file = join(projects, project, `${id}.jsonl`);
    if (existsSync(file)) { found.set(key, file); return file; }
  }
  return null;
}

function scan(file) {
  const { size } = statSync(file);
  let s = scans.get(file);
  if (!s || size < s.offset) { s = { offset: 0, rest: '', ai: null, custom: null }; scans.set(file, s); }
  if (size === s.offset) return s;
  const buf = Buffer.alloc(size - s.offset);
  const fd = openSync(file, 'r');
  let got;
  try { got = readSync(fd, buf, 0, buf.length, s.offset); } finally { closeSync(fd); }
  s.offset += got;
  const lines = (s.rest + buf.toString('utf8', 0, got)).split('\n');
  s.rest = lines.pop(); // a line still being written
  for (const line of lines) {
    if (!line.includes('-title"')) continue; // skip the JSON parse for everything that can't be a title entry
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.type === 'ai-title' && typeof entry.aiTitle === 'string') s.ai = entry.aiTitle;
    if (entry?.type === 'custom-title' && typeof entry.customTitle === 'string') s.custom = entry.customTitle;
  }
  return s;
}

// What a Claude Code session id looks like: the only shape taken from the outside as one.
export const isSessionId = (id) => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id);

export function sessionTitle(id, { configDir = defaultConfigDir() } = {}) {
  if (!isSessionId(id)) return null;
  try {
    const file = transcript(configDir, id);
    if (!file) return null;
    const s = scan(file);
    return (s.custom || s.ai || '').trim() || null;
  } catch { return null; }
}
