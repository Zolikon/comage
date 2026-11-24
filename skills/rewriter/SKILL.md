---
name: rewriter
description: Use whenever a markdown document needs the user's review - right after you write or substantially rewrite a design spec, implementation plan, design doc or article draft for the user (open it in ReWriter straight away instead of asking them to read the file), when the user asks to review a markdown document, asks for AI or role-based reviewers on one ("review it with a DBA and a security reviewer", "run the default panel"), says they submitted or finished a ReWriter round, or types /rewriter (e.g. "/rewriter docs/specs/auth.md", "/rewriter next"). Not for READMEs, notes, changelogs or small edits. Opens a local browser UI for PR-style review rounds where the author comments and decides, Claude fixes, and reviewer subagents post their findings.
---

# ReWriter

Local PR-style review loop for one markdown document. The author reads it in a browser UI, comments,
and decides on reviewer comments. Every round ends in one of three ways, and the author picks which:
**Submit round** (you act on the author's comments and decisions), **AI review** (reviewers run as
subagents and post findings; nothing is fixed in that round) or **Approve** (the document is final as it
stands: the review is closed, its UI stops and its state is removed). The state of every review in
progress lives in `<project root>/.rewriter/` (the root is the git repository the document is in; without
one, the document's own folder). Never edit those files by hand: always go through the CLI. The folder
ignores itself in git, and a review from an older version, kept beside its document, moves there by itself
the first time a command touches it.

```bash
rewriter help     # the plugin puts `rewriter` on the Bash tool's PATH; needs Node 22, nothing to install
```

Every command below is run as `rewriter <command> <doc> …`. If the shell reports `rewriter: command not
found`, run `node "${CLAUDE_PLUGIN_ROOT}/rewriter.mjs" <command> <doc> …` instead.

`<doc>` is a path to a markdown file, or a directory (meaning its `index.md`).

| Command | What it does |
|---|---|
| `init <doc> --type T` | start a review: round 1, `preparing`. `T` = `article`, `spec`, `plan`, or any word |
| `add <doc> --file -` | post comments, a JSON array on stdin (or one inline: `--severity --body [--quote] [--reviewer]… [--suggestion]`) |
| `reply <doc> --file -` | answer comments, a JSON array on stdin (or one inline: `reply <doc> <id> --kind K --body B [--quote Q]`) |
| `pending <doc>` | JSON: what the author asked for (`request`, with its `mode`), what needs you (`needsAction`), what waits (`held`) |
| `next <doc>` | open the next round after the author submitted; the round is then yours (this session's) |
| `claim <doc>` | take over a round that another Claude session started and left unfinished |
| `publish <doc>` | snapshot the document, hand the round to the author |
| `wait <doc>` | block until the author ends the round (any of the three buttons), then print `pending`; prints `{ "roundStatus": "gone" }` if there is no review (any more) |
| `approve <doc>` | approve for the author, as the UI's **Approve** button does: the review is closed, its UI stops and its state is removed (`--note`) |
| `status <doc>` | short summary + what happens next |
| `reviewers <doc>` | JSON: every reviewer available, `suggested` = meant for this document type |
| `request-review <doc> --file -` | ask for an AI review for the author, as the UI's **AI review** button does; the panel is a JSON array on stdin (also `--reviewer NAME`…, `--note`) |
| `serve <doc>` | start the UI (run in background; it live-reloads), or print the URL of the server already running for this document |
| `running` | no `<doc>`. The review UIs running for this session, one `name  url` line each (`--json` for JSON). The user sees the same list under their prompt |

Round states: `preparing` (you work) → `open` (author works) → `submitted` (back to you) or `approved`
(the end of the review: its state is removed about a second later).
`add`/`reply` only work while `preparing`. Only the author resolves comments.

## Start a review (round 1)

Do this without being asked whenever the description applies, including for a document you wrote yourself
in this turn. Don't ask "shall I open it in ReWriter?": open it.

1. `status <doc>`. If a review exists, continue from its state rather than starting over. If it answers
   "no ReWriter review", there is none: `init <doc> --type T` (the one exception is a review you had open
   in this session, see "Next round" step 1): pick `T` from what the document is (`article`, `spec`, `plan`; anything else gets
   the generic reviewers).
2. `publish <doc>`. Round 1 is always the untouched document: post no comments of your own.
3. Run `serve <doc>` with `run_in_background` and give the user the URL it prints. A document has one
   server, whichever session started it: if one is already running, `serve` prints `already running` with
   that URL and exits at once. That is not an error; use the URL.
4. If the user asked for reviewers in chat, go to "Reviewers asked for in chat" now.
5. Start `wait <doc>` with `run_in_background`. When it exits, the author has ended the round: read what
   `wait` printed first, then go to "Next round" (or to "Approved", if it says `approved` or `gone`)
   without waiting to be told. If you can't run it in the background, ask the user to tell you when
   they have pressed a button.
6. Tell the user in one or two lines: the document is open in the browser; comment and press **Submit
   round** to have you fix things, press **AI review** to have reviewers read it first, or press
   **Approve** when it is good as it stands.

## Reviewers asked for in chat

"Review it with a DBA and a security reviewer", "run the default panel": the findings belong in the UI,
never in chat. Do what the **AI review** button does:

1. Make sure the review exists and the UI is running ("Start a review", steps 1-3). If the round is
   `submitted` or `preparing`, finish it first ("Next round") so that a round is `open`.
2. Build the panel. `reviewers <doc>` lists who exists. "Default panel" = the `suggested` entries. A role
   that isn't listed is a new reviewer: write its `persona`, a `background` (who they are, what they look
   for) and `focus` bullets from what the user said.
3. Pipe the panel, an array of `{ persona, model?, background?, focus? }`, into
   `request-review <doc> --file -` (heredoc, as shown under "Comment format"). Only new reviewers need
   `background` and `focus`; a reviewer that is already listed is used as listed, whatever else the entry
   says. `model` overrides the reviewer's own model for this round; `"session"` means your
   session's model even when the reviewer has one of its own. For listed reviewers alone, `request-review <doc> --reviewer "Architect" --reviewer "DBA"` is
   enough.
4. Continue with "Next round", once. A `wait` you started earlier exits at this point, because
   `request-review` ended the round: that is this same request, not a second one.

## Next round (the author pressed a button)

1. If a `wait` brought you here, read what `wait` printed first: `roundStatus` `approved` or `gone` means
   the review is over, go to "Approved" instead and do not run `status` (it would answer "no ReWriter
   review"). Otherwise `status <doc>`. If the round is still `open`, the author hasn't pressed a button
   yet. If it says the round is held by another Claude session, stop: see "Several Claude sessions".
   If it answers "no ReWriter review" for a review you had open in this session (you had published it
   and were waiting, or the session was resumed), that review is over: the author approved it, or it was
   removed, while no `wait` of yours was watching. Go to "Approved" and treat it as `gone`. Do not run
   `init`: that would start the finished review over.
2. `next <doc>`, then `pending <doc>`. `request.mode` says which of the two the author chose. If `next`
   fails with "picked up by another Claude session", that session got there first: stop the same way.
3. **`fix`** (Submit round): read `request.note` first, it is the author's instruction for this round.
   Then act on each `needsAction` item; its `why` says what it needs:
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
   Post no new comments of your own.
4. **`review`** (AI review): don't edit the document and don't reply to anything. `held` counts the
   author's pending items; they wait for the author's next **Submit round**. Run the AI review (below)
   with exactly `request.reviewers`. `request.note` is addressed to the reviewers.
5. `publish <doc>`. The running UI refreshes by itself. If you're not sure the server is still up, run
   `serve <doc>` again: it reuses a running one, and a restarted one comes back on the same URL.
6. Start `wait <doc>` in the background again.
7. Report in chat. After `fix`: fixed N, accepted N, challenged N (with ids). After `review`: N new
   comments and by which reviewers, plus the author's shortlist (below).

## Approved (the author pressed Approve)

The author accepted the document as it stands. What `wait` printed shows `roundStatus: "approved"` and
`request.mode: "approve"`; `request.note` is what they wrote, if anything. The review is over: its UI
server stops by itself and its state is removed about a second after the approval. From then on `status`
and `pending` answer "no ReWriter review" for that document. That is expected, not an error.

If `wait` printed `roundStatus: "gone"` instead, there is no review and `wait` did not see why (it was
approved and cleaned up before `wait` started or between two looks, or removed by hand). It is over all
the same: say that the review was closed and ask the author whether they approved it. Do not claim it was
approved, and do nothing further until they answer.

- Do not run `next`, `publish`, `serve` or another `wait`, and do not edit the document. Nothing is fixed
  after an approval, not even items the author had asked for: `notActedOn` counts what was left open.
- Report in one line: approved, plus "N open item(s) left as they were" when `notActedOn` is not zero.
- Then, if the document is a step in work you are doing for the user in this session (you wrote the spec
  in order to plan it, the plan in order to execute it), carry on with that work: an approved spec is ready
  to be planned, an approved plan to be executed. If you were only asked to review the document, or the
  work it belongs to is another session's, report and stop.
- **Approval given in chat** ("approved", "looks good, ship it" about a document under review): run
  `approve <doc>`, with their words as `--note` if they said more than that. It needs an `open` round: if
  the round is `preparing` and yours, `publish` first; if it is `submitted`, run `next` and `publish`
  first, acting on nothing. Then the same three points apply. A `wait` you started earlier exits at this
  point, because `approve` ended the round: that is this same approval, not a second one.
- **An approved document has to change after all:** nothing of the old review is left, comments included.
  Make the change the author asked for; if it then needs their review, that is a new review from round 1
  ("Start a review").
- `serve` refuses a review that was approved. There is nothing to show.

## AI review

Who reviews: exactly `request.reviewers` from `pending`, no more, no fewer. Each has `persona`,
`background`, `focus`, `model`. Both the UI button and `request-review` put them there, so there is no
other source.

Running them:

- **One subagent per reviewer, all dispatched in parallel, every time.** Never review in the main
  conversation, and never let reviewers see each other's output.
- **Agent type:** every reviewer runs as the plugin's own reviewer agent, `subagent_type: "comage:reviewer"`.
  It carries the review rules and the output format, starts with no knowledge of this conversation, and
  can read and search (files, the web) but not edit or run anything. Use no other agent type for a
  reviewer: not a fork, not a general-purpose or exploring agent, not another plugin's reviewer.
- **Model:** pass the reviewer's `model` to the subagent (`haiku`, `sonnet`, `opus`, `fable`). Empty means
  don't set one, so it runs on the session's model.
- **Prompt:** fill `${CLAUDE_SKILL_DIR}/reviewer-prompt.md` per reviewer; the filled template is the whole
  prompt:
  - `{{persona}}`, `{{background}}`, `{{focus}}` (one `- ` bullet per focus area; omit the list if empty).
  - `{{document}}`: absolute path of the document.
  - `{{docKind}}`, `{{context}}`, `{{blocker}}`: from the table below.
  - `{{scope}}`: first AI review of this document = "Review the whole document."; later ones = "Review the
    whole document as it stands now. These points are already raised, don't repeat them: …" followed by
    the open comments' quotes and one-line bodies. For a long document where little changed, narrow it to
    "Review only these passages, changed since the last round: …". If `request.note` is not empty, add
    "The author asks: <note>".
- Each subagent returns a JSON array of `{severity, quote, body, suggestion?}`. Set `reviewers` to its
  persona and post everything in one `add` call (see "Comment format").
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

Comments are a JSON array, piped to `add` on stdin. Use a quoted heredoc: the shell then leaves the text
alone (quotes, backticks, `$`), and no temp file is left for another session to trip over.

```bash
rewriter add <doc> --file - <<'REWRITER_JSON'
[
  { "severity": "MINOR", "reviewers": ["Architect"], "quote": "…", "body": "…" }
]
REWRITER_JSON
```

The array:

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

Replies go to `reply <doc> --file -` the same way: an array on stdin, also all-or-nothing:

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

`rewriter reviewers <doc>` lists every reviewer there is. They come from three places, later ones winning
on a name clash:

1. Built-in starters in `${CLAUDE_PLUGIN_ROOT}/reviewers.default.json`, keyed by document type (`article`,
   `spec`, `plan`, `generic`). The type only decides which ones are `suggested` (the "default panel").
2. The author's library, `~/.claude/rewriter/reviewers.json`: same shape, any keys. The UI saves under
   `library`.
3. Reviewers kept with this review only.

```json
{ "library": [{ "persona": "DBA", "background": "Owns the production database…", "focus": ["Migrations", "Query cost"], "model": "sonnet" }] }
```

In the AI review dialog the author can save a reviewer, or a change to one, to their library, or use it
with this document only; those stay with the review, as do new reviewers you pass to `request-review`.
When the user asks for a reviewer to be available everywhere, add it to their library file (keep what is
already in it).

## Several Claude sessions

Any number of sessions can run reviews at the same time, each on its own documents: nothing is shared
between two documents' reviews. One document has one review, one server and, while a round is `preparing`,
one session working on it: the session that ran `next` (or `init`, for round 1). The CLI reads your session
id from the environment; you pass nothing.

- `status` says "held by another Claude session", or `next`, `add`, `reply` or `publish` fails with
  "another Claude session": that session is doing this round. Stop. Don't edit the document, don't retry,
  don't start another `wait` for it. Tell the user in one line that the document's review is running in
  another session.
- `claim <doc>` takes the round over. Run it only when the user confirms the other session is gone (closed
  or crashed mid-round), then continue from `status`.
- Never pick a port or look for a running server yourself: `serve` does both.
- Send one batch per `add` or `reply` call rather than several calls at once.

## Rules

- Edit the document only while the round is `preparing` (between `init` or `next` and `publish`), or when
  it has no review.
- Never set or fake `resolved`, and never edit `.rewriter/` files directly.
- Keep replies short. The author reads them in a sidebar.
- `<project root>/.rewriter/` is review scaffolding. It ignores itself in git (it holds a `.gitignore`), and
  it is gone once no review is in progress: never add it to a commit, and don't remove it by hand.
- One review per document: a spec and its plan are two reviews, each with its own `serve` and `wait`.

## UI (for reference when the author asks)

Highlights and margin bubbles are coloured by severity (author comments are purple). Clicking either opens
the comment. The sidebar has filters (severity, reviewer, status; resolved comments are hidden by default).
To comment, select text, or use the `+` beside a block, or "General comment". The header has three buttons.
**Approve** asks for confirmation, warns when open items will not be acted on, then closes the review:
the page says "Approved" and its tab closes by itself. Where the browser doesn't let a page close its
tab, the page stays, read-only, and says it can be closed; it no longer updates, because its server has
stopped.
**Submit round** opens a dialog with the count of items for Claude and a note. **AI review** opens a
dialog with a panel of the reviewers that will run (the last panel used on this document is preloaded), a
library (the author's saved reviewers, then the built-in starters), and an editor for the selected
reviewer: its description, its model, and buttons to use it as is or to save the change to the library. **Export**
downloads the author's library as `reviewers.json` for sharing (someone else saves it as their own library
file), and **?** explains how a review runs.
The author can delete an own comment until Claude has answered it. While a round is with you the UI is
locked and says so: "Waiting for Claude" (`submitted`) or "Claude is working" (`preparing`). It unlocks
when you `publish`. Earlier rounds can be viewed read-only.
Keys: `j/k` move, `a/A` approve (with comment), `d/D` decline (with comment), `i` ignore, `u` undo,
`r` resolve/reopen, `R` reply, `y` copy suggestion, `c` comment on selection, `?` help.
Ignore means "won't act": it resolves the comment and needs no reply from you.
