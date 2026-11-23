---
name: rewriter
description: Use when a markdown document (an article draft, a design spec, an implementation plan, or any other doc) is ready for human review, or the user asks to review one, wants it reviewed in ReWriter, asks for AI reviewers on a document, says they finished/submitted a ReWriter round, or types /rewriter (e.g. "/rewriter docs/specs/auth.md", "/rewriter start video-factory", "/rewriter next"). Runs PR-style review rounds in a local browser UI - the author comments and decides, Claude fixes, and on any round the author can ask for an AI review by reviewers and models they pick.
---

# ReWriter

Local PR-style review loop for one markdown document. The author reads it in a browser UI, comments,
and decides on reviewer comments. You (Claude) fix the document and answer. On any round the author may
also ask for an AI review; reviewers always run as subagents. State lives next to the document in
`.rewriter/` (`review.json` + one snapshot per round). Never edit those files by hand: always go through
the CLI.

```bash
rewriter help     # the plugin puts `rewriter` on the Bash tool's PATH; needs Node 22, nothing to install
```

Every command below is run as `rewriter <command> <doc> …`. If the shell reports `rewriter: command not
found`, run `node "${CLAUDE_PLUGIN_ROOT}/rewriter.mjs" <command> <doc> …` instead.

`<doc>` is a path to a markdown file, or a directory (meaning its `index.md`).

| Command | What it does |
|---|---|
| `init <doc> --type T` | start a review: round 1, `preparing`. `T` = `article`, `spec`, `plan`, or any word |
| `add <doc> --file comments.json` | post comments (or one inline: `--severity --body [--quote] [--reviewer]… [--suggestion]`) |
| `reply <doc> --file replies.json` | answer comments (or one inline: `reply <doc> <id> --kind K --body B [--quote Q]`) |
| `pending <doc>` | JSON: what the author asked for (`request`) and what needs you (`needsAction`) |
| `next <doc>` | open the next round after the author submitted |
| `publish <doc>` | snapshot the document, hand the round to the author |
| `wait <doc>` | block until the author submits, then print `pending` |
| `status <doc>` | short summary + what happens next |
| `reviewers <doc>` | JSON: every reviewer available, `suggested` = meant for this document type |
| `serve <doc>` | start the UI (run in background; it live-reloads, start it once per document) |

Round states: `preparing` (you work) → `open` (author works) → `submitted` (back to you).
`add`/`reply` only work while `preparing`. Only the author resolves comments.

## Start a review (round 1)

1. `status <doc>`. If a review exists, continue from its state rather than starting over. Otherwise
   `init <doc> --type T`: pick `T` from what the document is (`article`, `spec`, `plan`; anything else gets
   the generic reviewers).
2. **Default: no AI review in round 1.** The document goes to the author untouched. Run reviewers first
   (see "AI review") only if the user asked for that in chat, e.g. "review it with the default panel".
3. `publish <doc>`.
4. Start `serve <doc>` with `run_in_background` if it isn't already running for this document, and give
   the user the URL it prints.
5. Start `wait <doc>` with `run_in_background`. When it exits, the author has submitted: go to "Next
   round" without waiting to be told. If you can't run it in the background, ask the user to tell you when
   they have pressed **Submit round**.
6. Tell the user: comment in the browser, then press **Submit round** and choose "Fix only" or "Fix, then
   AI review" with the reviewers and models they want.

## Next round (author submitted)

1. `status <doc>`. If the round is still `open`, the author hasn't pressed **Submit round** yet.
2. `next <doc>`, then `pending <doc>`. Read `request.note` first: it is the author's instruction for this
   round. Then act on each `needsAction` item; its `why` says what it needs:
   - `approved`: apply the fix to the document (follow the author's note if there is one). Reply with
     `fixed` and one line on what changed. If the quoted text changed, pass the new text as `quote` so the
     comment re-anchors.
   - `declined`: read the author's note. Default to `accepted` (one-line acknowledgement). Use `challenge`
     only with a concrete reason: a factual error, broken code, or a contradiction with the spec or the
     codebase. Challenge a comment at most once. If the author declines again, accept.
   - `user-comment`: the author's own note. Do it and reply `fixed`, answer with `reply`, or push back with
     `challenge` and a reason.
   - `user-reply`: answer the latest message (`reply`, `fixed` or `challenge`).
   Comments that are open with no decision are carried over: leave them alone and don't re-post them.
3. If `request.aiReview` is true, run the AI review (below) with exactly `request.reviewers`, after the
   fixes. If it is false, post no new comments of your own: the author asked for fixes only.
4. `publish <doc>`. The running UI refreshes by itself (if the server isn't running, start it).
5. Start `wait <doc>` in the background again.
6. Report in chat: fixed N, accepted N, challenged N (with ids), new comments N by which reviewers.

## AI review

Who reviews, in order of precedence:

1. `request.reviewers` from `pending` (the author picked them in the UI): each has `persona`,
   `background`, `focus`, `model`. Use exactly these, no more, no fewer.
2. Reviewers the user named in chat. Look names up in `reviewers <doc>`; for an unknown name, write a
   persona from what the user said.
3. Otherwise the `suggested` entries from `reviewers <doc>`.

Running them:

- **One subagent per reviewer, all dispatched in parallel, every time.** Never review in the main
  conversation, and never let reviewers see each other's output.
- **Model:** pass the reviewer's `model` to the subagent (`haiku`, `sonnet`, `opus`, `fable`). Empty means
  don't set one, so it runs on the session's model.
- **Prompt:** fill `${CLAUDE_SKILL_DIR}/reviewer-prompt.md` per reviewer:
  - `{{persona}}`, `{{background}}`, `{{focus}}` (one `- ` bullet per focus area; omit the list if empty).
  - `{{document}}`: absolute path of the document.
  - `{{docKind}}`, `{{context}}`, `{{blocker}}`: from the table below.
  - `{{scope}}`: first AI review of this document = "Review the whole document."; later ones = "Review the
    whole document as it stands now. These points are already raised, don't repeat them: …" followed by
    the open comments' quotes and one-line bodies. For a long document where little changed, narrow it to
    "Review only these passages, changed since the last round: …".
- Each subagent returns a JSON array of `{severity, quote, body, suggestion?}`. Set `reviewers` to its
  persona and post via `add --file`.
- **Merge, don't average.** Merge only findings on the same text making the same point. Opposing views
  (one says cut, another says expand) stay as separate comments. Never soften a verdict while merging, and
  never invent findings for a reviewer who returned `[]`.
- **Author's shortlist in chat** after publishing: the BLOCKERs, plus where reviewers pull in opposite
  directions, without resolving it for the author.

| Type | `{{docKind}}` | `{{context}}` | `{{blocker}}` |
|---|---|---|---|
| `article` | a technical article | "Also read any files under its `code/` folder that it references." Add the audience and guidelines if the repo defines them (e.g. its CLAUDE.md). | "E.g. a wrong fact, misleading claim, broken code, or prose the audience can't follow." |
| `spec` | a design spec that an engineer will implement | "It describes a change to the codebase at `<repo root>`. Read the code it touches to check its claims and its fit." Name the original request or ticket if there is one. | "E.g. a design that can't work, contradicts the existing code, or leaves a decision open that the implementer can't make alone." |
| `plan` | an implementation plan that an engineer or coding agent will execute step by step | "It implements the spec at `<spec path>` in the codebase at `<repo root>`. Read the spec first, and check the plan's file, symbol and command references against the code." If there is no spec, name the request it implements. | "E.g. a step that can't be executed as written, a missed spec requirement, or a reference to code that doesn't exist." |
| other | a document (say what it is and who reads it) | Whatever a reviewer needs to judge it: audience, purpose, related files. | "E.g. it would mislead or fail its intended reader." |

Ask the user only if you can't tell what a plan implements or which codebase a spec targets.

## Comment format

`comments.json` is an array. Write it next to the document's state (`.rewriter/tmp-*.json`) and delete it
after `add`.

```json
[
  {
    "severity": "MAJOR",
    "reviewers": ["Architect", "Implementer"],
    "quote": "Sessions are stored in memory.",
    "body": "Two instances behind the load balancer won't share sessions; the spec assumes one process.",
    "suggestion": "Sessions are stored in Redis, keyed by session id."
  },
  { "severity": "BLOCKER", "reviewers": ["Scope Skeptic"], "body": "Nothing here says why the existing queue can't do this." }
]
```

- **severity**: `BLOCKER` (can't go ahead as written), `MAJOR` (real problem), `MINOR` (worth fixing),
  `NITPICK` (taste).
- **quote**: exact text from the document, a phrase to a paragraph. It may be copied from the markdown
  source (`**bold**`, `` `code` ``, links and `## ` heading markers are stripped automatically). If the
  text occurs more than once, the batch fails with `quote occurs N times`: add `"prefix"` (a few words
  just before it) or `"suffix"` (just after it) and retry. No quote = comment on the whole document. An
  unknown quote fails the whole batch with `quote not found`: fix the quote and retry. Nothing is saved
  from a failed batch.
- **reviewers**: free-form names, 0..n. When several reviewers flag the same issue on the same text, post
  **one** comment listing all of them, with the highest severity and a merged body.
- **suggestion** (optional): replacement text for the quote, ready to paste. Omit it when the fix isn't a
  drop-in replacement and describe the fix in the body instead.

`replies.json` is an array too, and is also all-or-nothing:

```json
[
  { "id": "c2", "kind": "fixed", "body": "Moved sessions to Redis.", "quote": "Sessions are stored in Redis, keyed by session id." },
  { "id": "c3", "kind": "accepted", "body": "Fair, single instance is a stated constraint." },
  { "id": "c6", "kind": "challenge", "body": "`auth/session.ts` already exports `rotate()`; the plan would duplicate it." }
]
```

`kind`: `fixed` | `accepted` | `challenge` | `reply`. `quote` (+ optional `prefix`) re-anchors the comment on
the new text after an edit.

## Reviewers

Built-in profiles live in `${CLAUDE_PLUGIN_ROOT}/reviewers.default.json` (`rewriter reviewers <doc>` lists
them), keyed by document type (`article`, `spec`, `plan`,
`generic`). The user's own go in `~/.claude/rewriter/reviewers.json`, same shape, and win on a name clash:

```json
{ "spec": [{ "persona": "DBA", "background": "Owns the production database…", "focus": ["Migrations", "Query cost"], "model": "sonnet" }] }
```

Reviewers the author defines in the Submit dialog are saved with that review and can be picked again in
later rounds. When the user asks for a reviewer to be available everywhere, add it to their file.

## Rules

- Edit the document only while the round is `preparing` (between `next` and `publish`).
- Never set or fake `resolved`, and never edit `.rewriter/` files directly.
- Keep replies short. The author reads them in a sidebar.
- `.rewriter/` is review scaffolding. Don't publish or commit it with the document unless the user wants
  the review history kept.
- One review per document: a spec and its plan are two reviews, each with its own `serve` and `wait`.

## UI (for reference when the author asks)

Highlights and margin bubbles are coloured by severity (author comments are purple). Clicking either opens
the comment. The sidebar has filters (severity, reviewer, status; resolved comments are hidden by default).
To comment, select text, or use the `+` beside a block, or "General comment". **Submit round** opens a
dialog: "Fix only" or "Fix, then AI review", with a checklist of reviewers (grouped by profile, last
panel preselected), a model per reviewer, "+ New reviewer", and a note for Claude. The "Changes since round
N" toggle shows inserted text in green and removals as red markers. Earlier rounds can be viewed read-only.
Keys: `j/k` move, `a/A` approve (with comment), `d/D` decline (with comment), `i` ignore, `u` undo,
`r` resolve/reopen, `R` reply, `y` copy suggestion, `c` comment on selection, `f` toggle changes, `?` help.
Ignore means "won't act": it resolves the comment and needs no reply from you.
