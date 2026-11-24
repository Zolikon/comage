# ReWriter: reviewer workbench (design)

Date: 2026-11-24 · Status: draft for approval · Builds on `docs/review-flow-design.md` (branch `review-flow`)

## Intent

The AI review dialog is a checklist of built-in reviewers grouped by document type (spec, article, plan).
That steers the author toward panels someone else designed. The author wants to define reviewers of their
own, tune them when picking them, and decide each time whether a reviewer or a change is kept for later
or used once. Separately, while Claude is working on a round the UI must say so clearly and be locked.

## Goals

- One reviewer library, not organised by document type. The author's saved reviewers come first.
- Picking a reviewer opens it: description (editable), model, then an explicit "add to the panel" step.
- A new reviewer, or a change to an existing one, can be saved to the library or used without saving.
- Saved reviewers are available in every document and every project.
- While a round is in Claude's hands, a visible "working" indicator and no way to change anything.

## Non-goals

- A project-level (team-shared) reviewer file.
- Renaming a saved reviewer (save under a new name, remove the old one).
- Locking the UI when Claude is busy with something else in the terminal and no round has been handed
  over (the author chose A: improve the existing lock).
- Changing how reviewers run, or the chat path (`request-review`, "default panel").

## Anti-goal

Losing a reviewer definition the author already has. `~/.claude/rewriter/reviewers.json` may be
hand-written; the UI must never overwrite it when it can't parse it, and must keep entries it doesn't touch.

## Approaches

1. **Two-pane dialog (chosen).** The AI review dialog gets a list on the left (active panel, then library)
   and the selected reviewer on the right. Everything happens where the review is started.
2. **Separate "Reviewers" screen** for managing the library, plus the simple checklist. Cleaner separation,
   but the author asked for edit-while-picking, and it adds a second place to go.
3. **Checklist with rows that expand inline.** Least code, but no explicit "add to the panel" step, and a
   long list gets longer.

Where saved reviewers live: the existing user file `~/.claude/rewriter/reviewers.json` (chosen, it is
already read and already means "mine, everywhere"), written by the local server.

## Design

### The dialog

```
┌ AI review ───────────────────────────────────────────────────┐
│ The reviewers in the panel read the document as it is now…   │
│ ┌──────────────────────────┬───────────────────────────────┐ │
│ │ PANEL (2)                │ Security Reviewer             │ │
│ │  Architect      opus  ✕  │ ┌───────────────────────────┐ │ │
│ │  DBA         session  ✕  │ │ Who they are and what     │ │ │
│ │ LIBRARY                  │ │ they look for (editable)  │ │ │
│ │  DBA              yours  │ └───────────────────────────┘ │ │
│ │  Security Reviewer    ◀  │ Model                         │ │
│ │  Architect      starter  │ (session)(haiku)(sonnet)      │ │
│ │  …                       │ (opus)(fable)                 │ │
│ │  + New reviewer          │ [Update & use] [Use without   │ │
│ │                          │  updating]   Remove from lib. │ │
│ └──────────────────────────┴───────────────────────────────┘ │
│ Note for the reviewers…              [Cancel] [Start AI review]│
└──────────────────────────────────────────────────────────────┘
```

- **Panel**: the reviewers that will run, each with its model and a remove (✕). It starts as the panel
  last used on this document, otherwise empty. Clicking a panel entry opens it on the right again.
  **Start AI review** needs at least one.
- **Library**: one flat list. Order: reviewers kept with this document, the author's saved ones, then the
  built-in starters. A small tag says which (`this document`, `yours`, `starter`). No grouping by document
  type and nothing pre-ticked by it.
- **Right side** (empty until something is selected): name (editable only for a new reviewer), one
  description field, model as pills (`session` = the session's model), and the buttons:

  | Situation | Buttons |
  |---|---|
  | Existing reviewer, nothing changed | **Use** |
  | Existing reviewer, description or model changed | **Update & use** · **Use without updating** |
  | New reviewer | **Save & use** · **Use once** |

  Every button adds the reviewer to the panel (or replaces its entry there).
  **Update & use** / **Save & use** write it to the library first. **Use without updating** / **Use once**
  keep the definition with this document only, where it stays available for later rounds.
  A saved reviewer of the author's also has **Remove from library**.
- "Update" on a built-in starter saves the author's own copy under the same name; the author's copy wins
  from then on. Removing that copy brings the starter back.
- A new reviewer needs a name and a description. A name that already exists opens that reviewer instead
  of creating a second one.

### Data

- A reviewer stays `{ persona, background, focus[], model }`. The description field shows `background`
  followed by the `focus` items as `- ` lines. Saving stores the whole text as `background` and an empty
  `focus`, so nothing is lost and the reviewer prompt keeps working.
- New server endpoints, same guards as the existing ones (loopback host, JSON content type, same origin):
  - `PUT /api/reviewers` with `{ persona, background, model }`: upsert into the user file by name. An
    entry that already exists there is updated in place, in whatever profile it sits; otherwise it is
    added under the profile key `library`. Also drops a same-named reviewer kept with this document, so
    the saved one is the one in effect.
  - `DELETE /api/reviewers/<persona>`: remove it from the user file. 404 if it isn't there.
  - The file is written atomically, its directory created if missing. A file that exists but can't be
    parsed is an error shown to the author; it is not touched.
- `GET /api/reviewers` keeps its shape. Each entry already carries `source` (`built-in`, `user`,
  `review`), which gives the tags.
- "Used once" reviewers travel as `custom` in the submit request, as new reviewers do today, and are kept
  in the review's own list.
- `suggested` stays in `rewriter reviewers` output for the chat path ("run the default panel"). The UI no
  longer uses it.

### While Claude works

The lock already exists (the round is read-only once it is `submitted` or `preparing`). It becomes obvious:

- A pulsing pill in the header next to the round label: **Waiting for Claude** (`submitted`: handed over,
  not picked up yet) or **Claude is working** (`preparing`).
- The banner keeps its text and gets a spinner.
- Everything that changes state is disabled or hidden: both header buttons, "+ General comment", the `+`
  beside blocks, the selection "Comment" button, and every action on a comment card. Reading, filtering,
  the changes toggle and earlier rounds keep working.
- When Claude publishes, the UI unlocks by itself, as today.

## Calls I made

- Any difference in description *or* model counts as a change and offers the two buttons.
- **Remove from library** is included although not asked for: without it a mistyped saved reviewer can
  only be removed by editing a JSON file.
- "Use once" keeps the reviewer for this document's later rounds, not for a single round, because the
  next round usually reruns the same panel.
- The panel starts empty on a document's first AI review.

## Left to the builder

Widths, colours and the pill/spinner animation; exact error wording; keyboard handling inside the dialog.
