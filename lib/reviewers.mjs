// Reviewer registry: built-in profiles (reviewers.default.json), the user's own
// (~/.claude/rewriter/reviewers.json or $REWRITER_REVIEWERS, same shape), and reviewers the author
// defined in the UI for this review (state.customReviewers).
// File shape: { "<profile>": [{ persona, background, focus: [], model?, enabled? }] }.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const MODELS = ['', 'haiku', 'sonnet', 'opus', 'fable']; // '' = same model as the session

class ReviewerError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

function readProfiles(file) {
  if (!existsSync(file)) return {};
  let data;
  try { data = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new ReviewerError(`${file}: ${e.message}`); }
  return Array.isArray(data) ? { article: data } : data;
}

const userFile = () => process.env.REWRITER_REVIEWERS || join(homedir(), '.claude', 'rewriter', 'reviewers.json');

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

// Every reviewer the author can pick, one entry per persona. `suggested` marks the ones meant for this
// document type. Later sources win on a name clash: built-in < user file < this review's own.
export function listReviewers(state) {
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
  for (const [source, file] of [['built-in', join(ROOT, 'reviewers.default.json')], ['user', userFile()]]) {
    for (const [profile, list] of Object.entries(readProfiles(file))) for (const r of list || []) add(r, profile, source);
  }
  for (const r of state.customReviewers || []) add(r, 'custom', 'review');
  const all = [...out.values()];
  const hasProfile = all.some((r) => r.profile === type);
  return all.map((r) => ({ ...r, suggested: r.profile === (hasProfile ? type : 'generic') }));
}

// [{persona, model}] -> full definitions; a per-round model overrides the reviewer's default.
export function expandReviewers(state, picked = []) {
  const all = new Map(listReviewers(state).map((r) => [r.persona, r]));
  return picked.map((p) => {
    const def = all.get(p.persona);
    return def ? { ...def, model: p.model || def.model } : { persona: p.persona, background: '', focus: [], model: p.model || '' };
  });
}
