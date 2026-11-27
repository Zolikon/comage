// Reviewer registry: built-in profiles (reviewers.default.json), the user's own
// (~/.claude/rewriter/reviewers.json or $REWRITER_REVIEWERS, same shape), the project's own
// (<project root>/.claude/rewriter/reviewers.json, same shape, meant to be committed), and reviewers the
// author defined in the UI for this review (state.customReviewers).
// File shape: { "<profile>": [{ persona, background, focus: [], model?, enabled? }] }.
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const MODELS = ['', 'haiku', 'sonnet', 'opus', 'fable']; // '' = same model as the session
export const SESSION_MODEL = 'session'; // in a round's request: the session's model, even if the reviewer has a default

class ReviewerError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function readProfiles(file) {
  if (!existsSync(file)) return {};
  let data;
  try { data = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new ReviewerError(`${file}: ${e.message}`); }
  return Array.isArray(data) ? { article: data } : data;
}

const HOME_FILE = join(homedir(), '.claude', 'rewriter', 'reviewers.json');
const userFile = () => process.env.REWRITER_REVIEWERS || HOME_FILE;

// The project's reviewers file, or null when the document has no project library: no root is known, or
// the root is the home directory, where that path is the user's own library.
export function projectFile(root) {
  if (!root) return null;
  const file = resolve(root, '.claude', 'rewriter', 'reviewers.json');
  return file === resolve(HOME_FILE) || file === resolve(userFile()) ? null : file;
}

// The two libraries that can be written. where: { scope: 'user' (default) | 'project', root }.
const LIBRARY_NAME = { user: 'your library', project: "this project's reviewers" };
function libraryFile({ scope = 'user', root } = {}) {
  if (scope === 'user') return userFile();
  if (scope !== 'project') throw new ReviewerError(`unknown reviewer library: "${scope}"`);
  const file = projectFile(root);
  if (!file) throw new ReviewerError('this document has no project to keep reviewers in');
  return file;
}

// What the UI shows about each library: where it is, and whether there is a project one at all.
export function libraries(root) {
  const project = projectFile(root);
  return { user: { file: userFile() }, project: project ? { file: project, name: basename(resolve(root)) || root } : null };
}

export function normalizeReviewer(r, full) {
  const persona = String(r?.persona || '').trim();
  if (!persona) throw new ReviewerError('reviewer needs a name');
  if (persona.length > 60) throw new ReviewerError(`reviewer name too long: "${persona.slice(0, 20)}…"`);
  const model = String(r.model || '').trim().toLowerCase();
  if (!/^[a-z0-9.-]*$/.test(model)) throw new ReviewerError(`bad model name for ${persona}: "${r.model}"`);
  if (!full) return { persona, model };
  const background = String(r.background || '').trim();
  if (!background) throw new ReviewerError(`reviewer "${persona}" needs a description of who they are and what they look for`);
  const focus = (Array.isArray(r.focus) ? r.focus : []).map((f) => String(f).trim()).filter(Boolean);
  return { persona, background, focus, model };
}

// ---- the libraries: the user file and the project file, written from the UI ----
// Writers read strictly: a file we can't make sense of is reported, never overwritten.
function readLibrary(file) {
  if (!existsSync(file)) return {};
  let data;
  try { data = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new ReviewerError(`${file}: ${e.message}`); }
  if (Array.isArray(data)) return { article: data };
  if (!data || typeof data !== 'object') throw new ReviewerError(`${file}: expected an object of reviewer lists`);
  return data;
}

// Atomic, and through a symlink: a library kept in a dotfiles repo stays linked, with its permissions.
function writeLibrary(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  const target = existsSync(file) ? realpathSync(file) : file;
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  if (existsSync(target)) chmodSync(tmp, statSync(target).mode & 0o777);
  renameSync(tmp, target);
}

// The copy of a reviewer that listReviewers puts in effect for a document type: the one in that type's
// profile, otherwise the last one in the file. Disabled copies count: saving one enables it.
function copyInEffect(data, persona, docType) {
  const copies = [];
  for (const [profile, list] of Object.entries(data)) {
    if (!Array.isArray(list)) continue;
    list.forEach((x, index) => { if (x?.persona === persona) copies.push({ profile, list, index }); });
  }
  return copies.find((c) => c.profile === docType) || copies[copies.length - 1] || null;
}

// Upsert by name. A reviewer the author already has is updated where it is; copies they keep for other
// document types are different definitions and stay untouched. A new one goes under "library".
// The description is stored whole as `background`, so `focus` is emptied.
export function saveLibraryReviewer(r, docType, where) {
  const { persona, background, model } = normalizeReviewer(r, true);
  const saved = { persona, background, focus: [], model };
  const file = libraryFile(where);
  const data = readLibrary(file);
  const copy = copyInEffect(data, persona, docType);
  if (copy) {
    const { enabled, ...rest } = copy.list[copy.index];
    copy.list[copy.index] = { ...rest, ...saved, ...(enabled === false || enabled === undefined ? {} : { enabled }) };
  } else {
    if (data.library !== undefined && !Array.isArray(data.library)) throw new ReviewerError(`${file}: "library" must be a list of reviewers`);
    (data.library ??= []).push(saved);
  }
  writeLibrary(file, data);
  return saved;
}

// A library as a file someone else can save as their own reviewers.json, or import.
export function exportLibrary(where) {
  const data = readLibrary(libraryFile(where));
  return `${JSON.stringify(Object.keys(data).length ? data : { library: [] }, null, 2)}\n`;
}

// Merge a reviewers file (an exported library, or a plain list) into a library. A reviewer is matched by
// name inside its own list: one that is there is replaced, a new one is added, the rest stays as it is.
// Everything is checked before anything is written.
export function importLibrary(incoming, where) {
  const lists = Array.isArray(incoming) ? { library: incoming } : incoming;
  if (!lists || typeof lists !== 'object') throw new ReviewerError('expected a reviewers file: an object of reviewer lists');
  const file = libraryFile(where);
  const data = readLibrary(file);
  const names = new Set();
  let added = 0;
  let updated = 0;
  for (const [profile, list] of Object.entries(lists)) {
    if (!Array.isArray(list)) throw new ReviewerError(`"${profile}" must be a list of reviewers`);
    // An own property, whatever the key is called ("__proto__" included).
    if (!Object.hasOwn(data, profile)) Object.defineProperty(data, profile, { value: [], enumerable: true, writable: true, configurable: true });
    const target = data[profile];
    if (!Array.isArray(target)) throw new ReviewerError(`${file}: "${profile}" must be a list of reviewers`);
    for (const r of list) {
      const entry = normalizeReviewer(r, true);
      if (r.enabled === false) entry.enabled = false;
      const at = target.findIndex((x) => x?.persona === entry.persona);
      if (at < 0) { target.push(entry); added++; } else { target[at] = entry; updated++; }
      names.add(entry.persona);
    }
  }
  if (!names.size) throw new ReviewerError('no reviewers in that file');
  writeLibrary(file, data);
  return { added, updated, personas: [...names] };
}

export function removeLibraryReviewer(persona, docType, where) {
  const file = libraryFile(where);
  const data = readLibrary(file);
  const copy = copyInEffect(data, persona, docType);
  if (!copy) throw new ReviewerError(`"${persona}" is not in ${LIBRARY_NAME[where?.scope || 'user']}`, 404);
  copy.list.splice(copy.index, 1);
  writeLibrary(file, data);
  return { removed: persona };
}

// Every reviewer the author can pick, one entry per persona. Later sources win on a name clash:
// built-in < user file < project file < this review's own.
// `suggested` marks the default panel. A project that keeps reviewers for this document (under the
// document's type, or under "library", which is for every type) decides it alone; otherwise it is the
// reviewers of the document's type, or the generic ones when the type has none.
export function listReviewers(state, root) {
  const type = state.docType || 'article';
  const out = new Map();
  const add = (r, profile, source) => {
    if (!r || r.enabled === false || !r.persona) return;
    const prev = out.get(r.persona);
    if (prev && prev.source === source && prev.profile === type) return; // keep the copy from this type's profile
    out.set(r.persona, {
      persona: r.persona, background: r.background || '', focus: r.focus || [], model: r.model || '', profile, source,
    });
  };
  const project = projectFile(root);
  for (const [source, file] of [['built-in', join(ROOT, 'reviewers.default.json')], ['user', userFile()], ...(project ? [['project', project]] : [])]) {
    for (const [profile, list] of Object.entries(readProfiles(file))) for (const r of Array.isArray(list) ? list : []) add(r, profile, source);
  }
  for (const r of state.customReviewers || []) add(r, 'custom', 'review');
  const all = [...out.values()];
  const ofProject = (r) => r.source === 'project' && (r.profile === type || r.profile === 'library');
  const hasProject = all.some(ofProject);
  const hasProfile = all.some((r) => r.profile === type);
  return all.map((r) => ({ ...r, suggested: hasProject ? ofProject(r) : r.profile === (hasProfile ? type : 'generic') }));
}

// [{persona, model}] -> full definitions. A per-round model overrides the reviewer's default; the model
// "session" asks for the session's own model (reported as ''), which an empty model can't say for a
// reviewer that has a default.
export function expandReviewers(state, picked = [], root) {
  const all = new Map(listReviewers(state, root).map((r) => [r.persona, r]));
  return picked.map((p) => {
    const def = all.get(p.persona);
    const model = p.model === SESSION_MODEL ? '' : (p.model || def?.model || '');
    return def ? { ...def, model } : { persona: p.persona, background: '', focus: [], model };
  });
}
