import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
