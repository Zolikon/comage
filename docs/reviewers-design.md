# ReWriter: reviewer panel setup (design)

## Intent

ReWriter should guide the whole review, starting with *who* reviews. Before round 1 the author sets up a
panel of 1–5 reviewers in the UI; Claude then runs each enabled reviewer as its own subagent and posts the
merged findings as ReWriter comments (existing flow from there on).

## Decisions (author)

- Reviewer fields: **persona** (also the name), **background/expertise**, **focus areas** (1–4), plus an
  **on/off toggle** (keep a reviewer but skip it for a round).
- Panel is **per article**, started from a default panel. A **"Save as default"** button makes the current
  panel the starting panel for future reviews.
- Default panel out of the box: the four `reviewing-articles` personas (Lead AI Engineer, AI Skeptic,
  Junior Engineer, Writer), rewritten into the three fields.
- **Later rounds:** the panel re-reviews the changed passages each round; the panel stays editable whenever
  the author has the round (setup and every `open` round).
- The existing `mcp-or-a-skill` review is restarted under the new flow.
- The old `reviewing-articles` skill is retired (archived at `docs/legacy-reviewing-articles.md`). Its
  reusable parts moved into ReWriter: the four personas (`reviewers.default.json`), the reviewer rules and
  severity meanings (`reviewer-prompt.md`), the independence rule, merge-don't-average and the author's
  shortlist (SKILL.md).

## Approaches considered

1. **Panel in `review.json`, CLI emits ready-to-dispatch subagent prompts** (picked). The prompt template
   lives in one file (`reviewer-prompt.md`, already written; placeholders `{{persona}} {{background}}
   {{focus}} {{article}} {{scope}}`); `reviewers <dir>` fills it per enabled reviewer, including the
   round context (round 1: whole article; later rounds: changed passages + existing open comments). Prompt
   construction is code, so it is testable and consistent between rounds.
2. Panel in `review.json`, Claude builds prompts from a template in SKILL.md. Less code, but the prompt drifts
   with each run and the "changed passages" part must be worked out by hand each round.
3. Separate per-article `panel.json`. A second state file for no gain; `review.json` already has atomic writes.

## Design

**State.** `review.json` gains `reviewers: [{ id, persona, background, focus: [..], enabled }]`. Round
statuses gain `setup` (author's turn, before round 1): `setup → preparing → open → submitted → (next)
preparing …`. `init` creates round 1 in `setup` with the default panel.

**Defaults.** Built-in panel: `reviewers.default.json` (shipped, already written). Saved panel: `reviewers.saved.json` in the
skill dir (written by "Save as default"; wins over the built-in when present). The UI also offers "Reset to
default".

**Validation.** Drafts are saved leniently while typing (≤5 reviewers, ≤4 focus areas, string length caps).
Strict check on **Start review** (setup submit) and on **Submit round**: 1–5 reviewers, each with a
non-empty persona (unique, case-insensitive), background and 1–4 non-empty focus areas; at least one enabled.

**Model / API.**
- `setReviewers(dir, list)` — author side, allowed in `setup` and `open`; lenient validation.
- `startReview(dir)` — `setup → preparing` (strict validation).
- `submit` also validates the panel strictly.
- `defaultReviewers()` / `saveDefaultReviewers(list)` (strict).
- `reviewerBriefs(dir)` — Claude side, `preparing` only: for each enabled reviewer `{ persona, prompt }`.
  Round 1 prompt: review the whole article. Round > 1: list the passages inserted since the last published
  snapshot (word diff) and the open comments' quotes, and ask for new problems in the changed text only.
- Server: `POST /api/reviewers`, `POST /api/start`, `GET /api/reviewers/default`, `POST /api/reviewers/default`.
- CLI: `reviewers <dir>` prints the briefs JSON.

**Subagent output.** Each reviewer returns a JSON array `[{severity, quote, body, suggestion?}]` with
ReWriter severities directly (no mapping). Shared rules sit in the template, not in the UI: stay in your
lens, "no findings" is valid, quote exactly, severity meanings.

**UI.**
- `setup`: the main pane shows the panel editor: one card per reviewer (persona, background, focus list with
  add/remove, enabled toggle, delete), "Add reviewer" (disabled at 5), "Reset to default", "Save as
  default", and a **Start review** button. Article title shown; sidebar hidden.
- `open` rounds: a header button "Reviewers (n)" opens the same editor in a drawer; edits autosave and apply
  to the next round's re-review.

**SKILL.md.** Start: `init` → `serve` → ask author to set up the panel and press Start review → on
"continue": `reviewers <dir>`, one subagent per brief in parallel, merge duplicates (persona names as
`reviewers`), `add`, `publish`. Next round: replies as today, then `reviewers <dir>` for the re-review of
changes, post only new findings. "Who reviews" section replaced: the panel is the source of truth.

## Portability (builder's call)

SKILL.md uses agent-neutral wording ("start in the background", "one independent sub-agent per brief") and
notes a fallback for agents without sub-agents: run briefs one at a time, each told to ignore earlier
findings. No per-reviewer prompt files (`--out`) for now.

## Non-goals

- Reviewer library/sharing across machines; per-reviewer model choice; strictness dials.

## Left to the builder

Exact copy, card layout, field length caps, how changed passages are summarised (bounded length).
