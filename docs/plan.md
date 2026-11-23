# ReWriter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Local PR-style review tool for articles: CLI + Node server + browser UI + skill.

**Architecture:** Pure ESM modules in `lib/` (text/anchor/diff shared with the browser, markdown render, state model). `rewriter.mjs` is both CLI and HTTP server. Vanilla JS UI in `ui/` re-renders from `/api/state`, live via SSE.

**Tech Stack:** Node 22 (built-ins only: `node:http`, `node:fs`, `node:test`), vendored `marked` 18.x ESM, vanilla HTML/CSS/JS.

**Spec:** `.claude/skills/rewriter/docs/design.md`

## Global Constraints

- No runtime `npm install`; only dependency is `vendor/marked.esm.js` (MIT header kept).
- Severities exactly: `NITPICK`, `MINOR`, `MAJOR`, `BLOCKER`.
- Statuses: `open | addressed | resolved`; round status `preparing | open | submitted`.
- Claude never sets `resolved`; only UI/author actions do.
- State lives in `<article>/.rewriter/review.json`; snapshots in `<article>/.rewriter/rounds/<n>.md`.
- All writes atomic (tmp file + rename). Server re-reads state on every request (CLI may write concurrently).
- Not a git repo: "commit" steps are skipped.

## Review Focus

1. Quote appears more than once in the article — prefix/suffix must pick the right one; without context, first match. (Task 1 test `findQuote disambiguates by prefix`.)
2. Quote copied from markdown source with `**bold**`, `` `code` ``, `[link](url)` — `add` must still anchor. (Task 3 test `addComments strips inline markdown`.)
3. Article edited so a quote vanishes — comment remains listed, flagged unanchored, not dropped. (Task 1 test `findQuote returns null`; UI shows "text changed".)
4. Author acts while round not `open` (preparing/submitted) — server returns 409, UI read-only. (Task 3 test `decision rejected unless round open`.)
5. Article with HTML entities / `<` in code / special chars — Node plain text equals browser textContent. (Task 1 test `plainFromHtml decodes entities and collapses whitespace`.)

---

### Task 1: Text, anchor and diff utilities

**Files:** Create `lib/text.mjs`, Test `test/text.test.mjs`

**Interfaces — Produces (also imported by the browser from `/lib/text.mjs`, so no Node imports):**
- `normalizeWs(s: string): string` — collapse `\s+` to one space.
- `plainFromHtml(html: string): string` — strip tags, decode entities (`&amp; &lt; &gt; &quot; &#39; &#NN; &#xNN; &nbsp;`), `normalizeWs`.
- `findQuote(plain: string, anchor: {quote, prefix?, suffix?}): {start:number,end:number}|null` — normalized quote; among all occurrences pick the one with best prefix+suffix match score; null if none.
- `makeTextAnchor(plain: string, start: number, end: number, ctx = 32): {kind:'text', quote, prefix, suffix}`.
- `stripInlineMd(s: string): string` — remove `**`, `__`, `*`, `_` emphasis, backticks, `[text](url)` → `text`, `![alt](src)` → `alt`.
- `tokenize(s: string): {t:string,start:number,end:number}[]` — words and punctuation tokens with offsets.
- `wordDiff(a: string, b: string): {op:'eq'|'ins'|'del', text:string, bStart?:number, bEnd?:number}[]` — LCS over tokens (DP; if `n*m > 4e6`, fall back to per-paragraph granularity by diffing on sentences).

- [ ] Tests: `findQuote disambiguates by prefix` (plain `"the cat sat. the cat ran."`, anchor `{quote:'the cat', prefix:'sat. '}` → `start === 13`); `findQuote returns null` for missing quote; `findQuote tolerates whitespace` (quote with newline); `plainFromHtml decodes entities and collapses whitespace` (`'<p>a &lt;b&gt;\n  &amp; c</p>'` → `'a <b> & c'`); `stripInlineMd` (`'use **bold** and `x` [here](http://u)'` → `'use bold and x here'`); `wordDiff` (`'a b c'`,`'a x c'` → ops eq,del,ins,eq with `ins.text==='x'`).
- [ ] Run `node --test .claude/skills/rewriter/test/` → FAIL, implement, → PASS.

### Task 2: Markdown rendering

**Files:** Create `vendor/marked.esm.js` (copied from `marked@18` npm tarball `lib/marked.esm.js`), `lib/render.mjs`, Test `test/render.test.mjs`

**Interfaces — Produces:** `renderMarkdown(md: string): {html:string, title:string|null, frontmatter:Record<string,string>}` — strip YAML frontmatter (simple `key: value` parse, quotes removed); GFM on; if frontmatter has `title` and body has no leading `# `, prepend `<h1>`.

- [ ] Tests: frontmatter stripped and `title` parsed; table renders `<table>`; `<` in code becomes `&lt;`.
- [ ] Implement, PASS.

### Task 3: State model

**Files:** Create `lib/model.mjs`, Test `test/model.test.mjs`

**Interfaces — Consumes:** Task 1, Task 2. **Produces** (all take `dir` = article dir, read+write state atomically, throw `RwError(message, httpStatus)` on misuse):
- `load(dir)`, `save(dir, state)`, `init(dir, article='index.md')`
- `articlePlain(dir, round?)` → plain text of current article or snapshot
- `addComments(dir, items[])` → created comments. Item: `{severity, body, reviewers?:string[], quote?, prefix?, suffix?, suggestion?, anchor?}`. Requires latest round `preparing`. Quote resolution: verbatim → `stripInlineMd` → error `quote not found: "<q>"`. Stored anchor = `makeTextAnchor` around match. No quote → `{kind:'article'}`. Validates severity.
- `reply(dir, id, {kind:'fixed'|'accepted'|'challenge'|'reply', body, quote?})` — requires `preparing`; effects per design table; `quote` re-anchors.
- `pending(dir)` → `{round, needsAction:[{id, why:'approved'|'declined'|'user-comment'|'user-reply', comment}], carriedOver:number}`.
- `nextRound(dir)` (latest must be `submitted`), `publish(dir)` (latest `preparing` → snapshot, `open`).
- Author ops (require latest `open`, else 409): `setDecision(dir,id,{type,note})`, `userComment(dir,{anchor,body})`, `userReply(dir,id,body)`, `resolve(dir,id)`, `reopen(dir,id)`, `deleteComment(dir,id)` (user-authored, created this round only), `submit(dir)`.
- IDs `c1, c2…` (max+1).

- [ ] Tests: `init creates round 1 preparing`; `addComments strips inline markdown` (article `Use **bold** text`, quote `**bold** text` anchors); `addComments rejects unknown quote`; `publish snapshots and opens`; `decision rejected unless round open` (409); `ignore resolves`; `challenge clears decision and reopens`; `fixed sets addressed and archives decision in thread`; `pending lists approve/decline/user comment/user reply, counts carried-over`; `nextRound requires submitted`.
- [ ] Implement, PASS.

### Task 4: CLI

**Files:** Create `rewriter.mjs`, Test `test/cli.test.mjs`

**Interfaces — Consumes:** Task 3. Commands per design CLI table; `--file` reads a JSON array for `add`/`reply` (reply items `{id, kind, body, quote?}`); `--reviewer` repeatable. Output JSON for `add`/`reply`/`pending`, text for `status`. Errors → stderr, exit 1. `serve` delegates to Task 5.

- [ ] Test: spawn `node rewriter.mjs init|add|publish|status` against a temp dir; assert exit codes and state file.
- [ ] Implement, PASS.

### Task 5: HTTP server + SSE

**Files:** Create `lib/server.mjs`

**Interfaces — Produces:** `startServer(dir, {port=4870, open=true})` — tries port..port+20. Routes:
`GET /` → `ui/index.html`; `GET /ui/*`, `GET /lib/text.mjs` static; `GET /api/state` → `{review, article:{html,title}, plain}`; `GET /api/round/:n` → rendered snapshot; `GET /api/events` SSE (`fs.watch` on article + `.rewriter`, debounced 150ms, event `change`);
`POST /api/comments` `{anchor, body}`; `POST /api/comments/:id/decision` `{type, note}`; `/reply` `{body}`; `/resolve`; `/reopen`; `DELETE /api/comments/:id`; `POST /api/submit`. Errors → `{error}` with RwError status. Path traversal guarded on static routes.

- [ ] Verify with curl against a temp article: state 200, decision 409 while preparing, 200 after publish.

### Task 6: UI

**Files:** Create `ui/index.html`, `ui/styles.css`, `ui/app.js`

Implements design "UI" section. Key mechanics:
- Render article HTML; collect text nodes via TreeWalker; build normalized-offset → (node, offset) map identical to `normalizeWs` semantics; resolve anchors with `findQuote`; wrap ranges per text node in `<mark class="rw-hl sev-x" data-ids>`.
- Margin bubble per comment (positioned at first mark's top, stacked if colliding).
- Selection → `makeTextAnchor`; block gutter "+" → element anchor (`img` key = src) or text anchor of whole block.
- Diff mode: `wordDiff(prevPlain, plain)`; `ins` ranges wrapped `<ins class="rw-ins">`; `del` → `<span class="rw-del" title=removed>`.
- Round selector: past round → `/api/round/:n`, comments with `round<=n`, read-only.
- Keyboard map per design; `?` overlay.

- [ ] Verify in a browser against a real article (headless screenshot or manual): highlights, bubble, actions persist to review.json, SSE refresh.

### Task 7: Skill + end-to-end run

**Files:** Create `SKILL.md`

Documents: when to use, start (`init` → review → `add` → `publish` → `serve` in background), next round (`pending` → edit `index.md` → `reply` → new `add` → `publish`), challenge etiquette (challenge only with a concrete reason; accept declines otherwise), merging duplicate findings into one comment with several reviewers, reviewer definitions external (use whatever guides the user names, e.g. `reviewing-articles` personas; severity mapping must fix→BLOCKER, medium→MAJOR, low→MINOR, nit pick→NITPICK).

- [ ] E2E on a copy of `mcp-or-a-skill/` in a temp dir: init, add 4 comments, publish, simulate author via API, submit, next, pending, reply, publish; UI screenshot shows diff + threads.
