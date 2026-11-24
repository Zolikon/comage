import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { target } from '../lib/model.mjs';

// Running servers record themselves in a user-level registry (lib/running.mjs). Tests get their own, so
// the suite never writes to the real ~/.claude; child processes inherit it.
process.env.REWRITER_RUNNING ??= mkdtempSync(join(tmpdir(), 'rw-running-'));

export const ARTICLE = `---
title: "Test Article"
---

Use **bold** text in the intro. The cat sat. The cat ran.

## Second section

Another paragraph with \`code\` and a [link](https://example.com).
`;

export function tmpArticle(md = ARTICLE) {
  const dir = mkdtempSync(join(tmpdir(), 'rw-'));
  writeFileSync(join(dir, 'index.md'), md);
  return dir;
}

// An empty project: a folder with a .git folder in it, which is what marks a project root.
export function tmpProject() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rw-proj-')));
  mkdirSync(join(root, '.git'));
  return root;
}

// Where the review state of a document (or folder) lives. Tests ask; they never spell the path out.
export const stateDir = (p) => target(p).stateDir;

// A Claude Code config dir holding one session transcript with the given entries.
export function fakeSession(id, entries = []) {
  const configDir = mkdtempSync(join(tmpdir(), 'rw-claude-'));
  mkdirSync(join(configDir, 'projects', '-some-project'), { recursive: true });
  const file = join(configDir, 'projects', '-some-project', `${id}.jsonl`);
  writeFileSync(file, entries.map((e) => `${JSON.stringify(e)}\n`).join(''));
  return { configDir, file, add: (e) => appendFileSync(file, `${JSON.stringify(e)}\n`) };
}
