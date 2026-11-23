# ReWriter — design

Date: 2026-11-19 · Status: draft for approval

## Intent

A local, PR-review-style loop for articles. Claude (with any number of reviewers) comments on
words, sentences, paragraphs or elements of an article; the author answers each comment in a
browser UI; Claude reads the answers next round, applies what was approved, accepts or challenges
what was declined, and adds new comments. Like GitHub PR review, but local, file-based and shaped
for prose.

## Goals

- Render an article's `index.md` as HTML, with comments highlighted inline (bubble) and listed in a sidebar.
- Comment = severity (NITPICK / MINOR / MAJOR / BLOCKER, colour-coded) + body + optional suggestion.
- One comment can carry several reviewers ("flagged by Writer, Junior").
- Author actions: approve, approve with comment, decline, decline with comment, ignore, reply, resolve.
- Author can add plain-text comments on any selection or element.
- Rounds: unresolved comments carry over; changed text since the previous round is highlighted;
  Claude's replies (fixed / accepted / challenged) appear in each comment's thread.
- Claude drives everything through a CLI described in a skill.

## Non-goals

- Writing the article; defining reviewers, personas or review guides (the app is decoupled from them).
- Publishing, hosting, multi-user collaboration, auth.
- ReWriter editing `index.md`. Only Claude edits the article.

## Anti-goals

- A build step or `npm install` before first use.
- Comments silently vanishing when the text changes (a lost anchor must stay visible).
- Two writers racing on the article file.

## Decisions (author)

| Topic | Decision |
|---|---|
| Approve with suggestion | Recorded only; Claude applies it next round. |
| Reviewers | Free-form names, 0..n per comment; app knows nothing about personas. |
| Between rounds | Word diff vs. previous round + Claude's replies in threads; earlier rounds viewable read-only. |
| Ignore | "Won't act" — resolves immediately, Claude does not respond. |
| Decline | Claude must accept (addressed) or challenge (back to open) next round. |
| Resolve | Author only. Claude can set `addressed`, never `resolved`. |
| Author comments | Text only (no severity, no suggestion). |
| Handoff | Every click autosaves; "Submit round" locks it; author then tells Claude (`/rewriter next` or plain words). |
| Extras v1 | Filters (severity / reviewer / status) + keyboard shortcuts, copy suggestion + before/after view, dark mode (system). |

## Approaches considered

1. **Zero-dependency Node server + vanilla HTML/JS UI (chosen).** Server reads/writes a JSON file
   next to the article, so Claude sees author input directly. No build, Node 22 already present.
2. **Static HTML + manual JSON export/import.** No server, but the author has to shuffle files and
   live refresh is impossible. Rejected: breaks the "Claude just sees my replies" loop.
3. **React/Vite app or VS Code extension.** Richer UI toolkit; adds a build/install step and a lot
   of weight for one screen. Rejected.

## Layout

```
.claude/skills/rewriter/
  SKILL.md            # how Claude runs a round
  rewriter.mjs        # CLI + server entry
  lib/                # model (state transitions), anchor/text utils, markdown render
  vendor/marked.esm.js  # vendored markdown parser (MIT), no install needed
  ui/                 # index.html, app.js, styles.css
  test/               # node:test suites
  docs/design.md
<article>/.rewriter/
  review.json         # all state
  rounds/<n>.md       # article snapshot per published round
```

## Data model (`review.json`)

```jsonc
{
  "version": 1,
  "article": "index.md",
  "rounds": [{ "n": 1, "status": "preparing|open|submitted", "publishedAt": null, "submittedAt": null }],
  "comments": [{
    "id": "c7",
    "author": "ai|user",
    "reviewers": ["Writer", "Junior"],        // ai only, may be empty
    "severity": "MAJOR",                      // ai only
    "body": "…", "suggestion": "…|null",      // suggestion ai only
    "anchor": { "kind": "text", "quote": "…", "prefix": "…", "suffix": "…" }
           // | { "kind": "element", "tag": "img", "key": "<src>", "quote": "<alt>" }
           // | { "kind": "article" }
    "round": 1,                               // round created in
    "status": "open|addressed|resolved",
    "decision": { "type": "approve|decline|ignore", "note": "…", "round": 1 } | null,
    "thread": [ { "author": "ai|user", "kind": "reply|fixed|accepted|challenge|decision|resolved|reopened", "body": "…", "round": 2, "at": "ISO" } ]
  }]
}
```

### Round lifecycle

- `init` → round 1 `preparing`. Claude adds comments. `publish` snapshots `index.md`, round → `open`.
- Author works in UI while round `open`; `Submit round` → `submitted`.
- `next` → new round `preparing`. `pending` lists what needs Claude. Claude edits the article, posts
  replies and new comments, then `publish`.
- UI is read-only (banner) unless the latest round is `open`.

### Comment transitions

| Event | Effect |
|---|---|
| Author approve / decline (± note) | `decision` set (changeable until submit). |
| Author ignore | decision `ignore`, status `resolved`. |
| Author reply | thread entry; Claude must answer next round. |
| Author resolve / reopen | status `resolved` / back to `open`. |
| Claude `fixed` (after approve) / `accepted` (after decline) | status `addressed`, decision archived into thread. Optional new anchor quote. |
| Claude `challenge` | status `open`, decision archived and cleared — author decides again. |
| Claude `reply` | thread entry only (answers to author comments/replies). |

"Needs Claude" (shown by `pending`): non-resolved comments in the last submitted round with a
decision approve/decline, author-created comments without an AI answer, or a thread whose last
entry is the author's. Open comments with no decision just carry over.

## Anchoring

- Plain text of the rendered article = concatenated text nodes, whitespace collapsed. Node side
  derives the same string by stripping tags from the marked HTML and decoding entities, so CLI and
  browser agree.
- Text anchor = quote + up to 32 chars of prefix/suffix for disambiguation (W3C text-quote style).
- CLI `add` accepts a quote copied from markdown source; if not found verbatim, it retries with
  inline markdown stripped (`**`, `` ` ``, links). Still not found → error, so Claude fixes the quote.
- Anchors resolve live in the browser on every render. A quote no longer present is shown in the
  sidebar as "text changed" with the original quote — never dropped.
- Claude's `fixed` reply may pass `--quote` to re-anchor onto the new text.

## UI

- Two columns: article (max ~720px, same typography as existing previews) | sidebar (~400px).
- Header: article title, round selector, "Compare with round n-1" diff toggle, counts per severity, Submit round.
- Highlights: background tint in severity colour (author comments: purple dashed); a numbered
  bubble in the right margin of the paragraph; click → popover with comment + actions.
- Sidebar cards: severity pill, reviewers, body, suggestion before/after (+ copy), thread, action
  buttons; filters by severity, reviewer, status (open / addressed / needs decision / resolved — resolved hidden by default).
- Author commenting: select text → floating "Comment" button; or hover a block (heading, image,
  code, table, list) → "＋" gutter button to comment on the whole element.
- Diff: word-level LCS between previous published snapshot and current article; inserted words
  tinted green, deletions shown as a small red marker with the removed text in a tooltip.
- Keyboard: `j/k` next/prev, `a`/`A` approve (with comment), `d`/`D` decline (with comment), `i`
  ignore, `r` resolve, `c` comment on selection, `f` diff toggle, `?` help, `Esc` close.
- Severity colours: NITPICK grey, MINOR blue, MAJOR amber, BLOCKER red. Dark mode via `prefers-color-scheme`.
- Live: server pushes Server-Sent Events when `index.md` or `review.json` change; UI re-renders.

## CLI (`node .claude/skills/rewriter/rewriter.mjs <cmd> <articleDir> …`)

| Command | Purpose |
|---|---|
| `init` | create `.rewriter/`, round 1 preparing |
| `serve [--port 4870] [--no-open]` | start UI server, open browser |
| `add --severity S --body B [--reviewer R]… [--quote Q] [--suggestion X]` / `add --file comments.json` | add AI comments (batch JSON array supported) |
| `reply <id> --kind fixed|accepted|challenge|reply --body B [--quote Q]` / `reply --file replies.json` | Claude answers |
| `pending` | JSON digest of what needs Claude this round |
| `next` | open a new preparing round (requires last submitted) |
| `publish` | snapshot article, round → open |
| `status` | human summary |

## Left to the builder

Port fallback, exact styling, popover placement, LCS implementation details, test layout.
