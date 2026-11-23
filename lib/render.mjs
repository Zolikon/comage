// Markdown -> HTML for the review UI (vendored marked, GFM on).
import { Marked } from '../vendor/marked.esm.js';
import { decodeEntities } from './text.mjs';

const marked = new Marked({ gfm: true, async: false });

function parseFrontmatter(md) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(md);
  if (!m) return { frontmatter: {}, body: md };
  const frontmatter = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    frontmatter[kv[1]] = v;
  }
  return { frontmatter, body: md.slice(m[0].length) };
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderMarkdown(md) {
  const { frontmatter, body } = parseFrontmatter(String(md));
  let html = marked.parse(body)
    .replace(/<script\b[\s\S]*?<\/script>/gi, '') // local tool, but never execute article scripts
    .replace(/<[a-z][a-z0-9-]*\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi, (tag) => tag // only inside real tags
      .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/(\s(?:href|src|xlink:href|action|formaction)\s*=\s*["']?)\s*(?:javascript|vbscript|data:text\/html)[^"'\s>]*/gi, '$1#'));
  // Defence in depth only: the UI page also sends a strict Content-Security-Policy.
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  let title = frontmatter.title || null;
  if (!h1 && title) html = `<h1>${escapeHtml(title)}</h1>\n${html}`;
  if (!title && h1) title = decodeEntities(h1[1].replace(/<[^>]*>/g, '')).trim();
  return { html, title, frontmatter };
}
