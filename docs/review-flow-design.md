# ReWriter: review flow (design)

Date: 2026-11-24 · Status: draft for approval

## Intent

Starting a review takes too much steering. After Claude writes a spec, the author has to invoke the skill
by name before the UI opens; asking in chat for "a DBA and a security reviewer" doesn't open it either; and
the AI review is hidden behind a radio button inside the Submit dialog, so it looks as if it didn't exist.

The author wants this instead:

1. Claude writes a markdown document that needs review (or the author asks for one). ReWriter opens on
   its own.
2. Every round ends in one of two actions, both visible in the UI:
   - **Submit round**: Claude acts on the author's comments and decisions.
   - **AI review**: the reviewers the author picks run as subagents, and their findings land in the UI.

## Goals

- The skill triggers without being named when a document needs the author's review, and when the author
  asks for reviewers by role in chat.
- AI review is a first-class action from round 1 on, not an option of Submit.
- Reviewer findings always end up in the UI, however the review was asked for.

## Non-goals

- Guaranteed triggering. The skill description is a hint to the model; it raises the hit rate, it cannot
  force it.
- Per-reviewer progress in the UI. The banner names the reviewers that are running; findings appear
  together when Claude publishes.
- Changing how reviewers run (one subagent each, in parallel, merge rules, prompt template).

## Anti-goal

ReWriter opening for every markdown file Claude touches (a README edit, notes, a changelog). It is for
documents the author is expected to read and approve.

## Approaches

1. **Two actions and a request mode (chosen).** Two header buttons, each with its own dialog. The round's
   request records `mode: fix | review`. A chat request for reviewers goes through the same door as the
   button, via a new CLI command. One path, so the UI always knows what is running.
2. **Third radio in the existing dialog** ("AI review only"). Least code, but the action stays hidden
   behind **Submit round**, which is the complaint.
3. **A hook instead of the description** (open ReWriter after any `Write` of a `.md` file). Reliable, but
   fires on every markdown file, which is the anti-goal.

## Design

### Triggering (skill description)

Rewrite the description so it leads with the situations, in this order: Claude has just written or
substantially rewritten a spec, plan, design doc or article draft for the user; the user asks to review a
markdown document; the user asks for AI or role-based reviewers on one ("review it with a DBA and a
security reviewer", "run the default panel"); the user says they submitted a round; `/rewriter`. It says
explicitly: open the document in ReWriter instead of asking the user to read the file, and not for READMEs,
notes or small edits.

### Two outcomes per round

The author decided: **AI review means review only.** Reviewers read the document as it stands. Comments
and decisions the author already made in that round are not acted on; they stay as they are and go to
Claude the next time the author presses **Submit round**.

- `submit` takes `mode`: `fix` (default) or `review`. The stored request is
  `{ mode, aiReview, reviewers, note }`; `aiReview` stays as a derived boolean (`mode === 'review'`) so
  "last panel" lookup keeps working. `review` needs at least one reviewer.
- `pending`: when the request's mode is `review`, `needsAction` is empty and the items that would have
  been in it are counted in a new `held` field. The tool enforces "review only", not just the skill text.
- A request saved by the previous version (`aiReview: true`, no `mode`) is read as `review`. The fixes it
  also asked for are not lost: they are held and go out with the next **Submit round**.

### UI

Header: `[AI review] [Submit round]`. Both are disabled when the round is read-only.

- **Submit round** dialog: "N item(s) for Claude to act on. M reviewer comment(s) have no decision and
  carry over.", a note for Claude, Cancel / Submit. With nothing to act on and no note, Submit is disabled
  and the dialog says what to do (comment, decide, or write a note).
- **AI review** dialog: the reviewer checklist that exists today (grouped by profile, last panel
  preselected, model per reviewer, "+ New reviewer"), a note for the reviewers, and, if the author has
  pending items, "Your N pending item(s) stay as they are until you press Submit round." Cancel / Start
  AI review.
- Banner while the author waits:
  - submitted, `review`: "AI review requested: DBA, Security Reviewer. Claude picks it up if it is
    waiting; otherwise tell it to continue."
  - next round preparing after a `review` request: "AI review running: DBA, Security Reviewer. Findings
    appear here when they are done."
  - `fix` keeps today's wording.

### Chat requests take the same path

New CLI command, for when the author asks for reviewers in chat:

```
rewriter request-review <doc> --file reviewers.json [--note "…"]
```

`reviewers.json` is an array of `{ persona, model?, background?, focus? }`. An entry with a `background` is
a new reviewer and is saved with the review; one without is looked up in the registry. The command does
what the **AI review** button does: the open round becomes `submitted` with `mode: review`.

Skill flow:

- **Start (round 1):** `init` → `publish` → `serve` → `wait`, always. The document reaches the author
  untouched and the UI is open.
- **Reviewers asked for in chat** (at the start or later): make sure the review exists and the UI is
  running, then `request-review`, and continue with "Next round". If a round is `submitted` or
  `preparing`, finish and publish it first.
- **Next round:** `next`, `pending`, then by `request.mode`:
  - `fix`: act on `needsAction`, post no new comments.
  - `review`: don't touch the document or the held items; run exactly `request.reviewers`, post their
    findings, `publish`.

A review asked for in round 1 therefore shows its findings in round 2. Round 1 is the untouched document.

### Also touched

- `status` output: says which of the two was asked for.
- Deleting an own comment: allowed in any round as long as Claude hasn't answered it (today: current round
  only). Held comments outlive the round they were written in, so the author must still be able to drop
  them. *(My call, not something the author asked for.)*
- README and the skill's UI reference: the two buttons.
- Tests: `mode` in `submit`/`pending`, legacy request, `request-review`, delete rule.

## Left to the builder

Dialog layout and CSS, a keyboard shortcut for **AI review** if one is free, exact wording of the banner
and CLI messages.
