# ReWriter Review Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ReWriter opens on its own when a document needs review, and every round ends in one of two visible actions: **Submit round** (fixes) or **AI review** (reviewers only).

**Architecture:** A round's request gets a `mode` (`fix` | `review`). The model enforces "review only" by holding the author's pending items out of `needsAction`. The UI gets two header buttons with one dialog each. A new CLI command, `request-review`, lets Claude press the AI review button on the author's behalf, so chat requests and UI requests take one path. The skill description and flow are rewritten around that.

**Tech Stack:** Node 22, ESM, no dependencies, `node --test`. Vanilla JS UI served by `lib/server.mjs`.

**Spec:** `docs/review-flow-design.md`

## Global Constraints

- Node 22, nothing to `npm install`, no build step. Do not add dependencies.
- State file stays `version: 1` and readable both ways: a request written by 1.0.0 (`{ aiReview, reviewers, note }`, no `mode`) must still load.
- `aiReview` stays in the stored request as a derived boolean (`mode === 'review'`).
- AI review means review only: the author's pending comments and decisions are never acted on in a `review` round.
- UI copy in this plan is exact. Use it verbatim.
- Work on branch `review-flow` (created in Task 1). Do not push.
- Never commit `.rewriter/` directories.
- End every commit message with: `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`
- Full suite before every commit: `npm test`, expected `# fail 0`.

## Review Focus

Conditions the spec implies that are easy to miss. Each has a test in the task named.

1. Author has decisions and comments, presses **AI review**, then presses **Submit round** a round later: the held items must reach Claude with their decisions intact, not be dropped or duplicated. (Task 1, round-trip test)
2. A review in flight when the plugin is upgraded: the stored request has `aiReview: true` and no `mode`. It must read as `review`, with the items held. (Task 1, legacy test)
3. Claude runs `request-review` when the round is not `open` (still `preparing`, or already `submitted`): exit 1, a message naming the state, nothing changed. (Task 2)
4. `request-review` with a reviewer file that mixes a valid new reviewer and an unknown name: exit 1, round still `open`, the new reviewer not saved. (Task 2)
5. A held comment the author no longer wants, one round later: deletable. One Claude has answered, or a reviewer's: not deletable. (Task 1, delete test)

## File Structure

| File | Change |
|---|---|
| `lib/model.mjs` | `requestMode()`, `mode` in `submit`, `held` in `pending`, delete rule |
| `rewriter.mjs` | `request-review` command, `status` wording, usage |
| `ui/index.html`, `ui/app.js`, `ui/styles.css` | second header button, two dialogs, banner, delete button |
| `skills/rewriter/SKILL.md` | description, start flow, chat flow, next-round flow |
| `README.md`, `.claude-plugin/plugin.json`, `package.json` | usage text, version 1.1.0 |
| `test/generic.test.mjs`, `test/model.test.mjs` | model, server and CLI tests |
| `test/skill.test.mjs` (new) | skill frontmatter and skill/CLI command sync |

---

### Task 1: Request mode in the model

**Files:**
- Modify: `lib/model.mjs` (`pending` ~227-259, `deleteComment` ~355-365, `submit` ~367-392)
- Test: `test/generic.test.mjs`, `test/model.test.mjs`

**Interfaces:**
- Produces:
  - `requestMode(request) → 'fix' | 'review'` (exported). `request.mode` if set, else `'review'` when `request.aiReview` is truthy, else `'fix'`. `null`/`undefined` request → `'fix'`.
  - `submit(target, { mode?, aiReview?, reviewers?, custom?, note? })`. Stores `round.request = { mode, aiReview, reviewers: [{ persona, model }], note }`. Input `mode` wins; without it, `aiReview: true` means `review`.
  - `pending(target)` returns `{ round, roundStatus, lastSubmittedRound, docType, request, needsAction, held, carriedOver }`. `request` is `null` or `{ mode, aiReview, reviewers (expanded), note }`. `held` is a number.

- [ ] **Step 1: Branch**

```bash
git switch -c review-flow
```

- [ ] **Step 2: Write the failing tests**

In `test/generic.test.mjs`, in the existing test `human-only first round…`, change the request assertion to:

```js
assert.deepEqual(sub.request, { mode: 'fix', aiReview: false, reviewers: [], note: '' });
```

and after `assert.equal(p.request.aiReview, false);` add `assert.equal(p.held, 0);`.

In the existing test `server: reviewers endpoint, submit with a request, bad request is a 400`, replace the two `post('/api/submit', { aiReview: true, … })` lines with:

```js
assert.equal((await post('/api/submit', { mode: 'both' })).status, 400);
assert.equal((await post('/api/submit', { mode: 'review', reviewers: [] })).status, 400);
assert.equal((await post('/api/submit', { mode: 'review', reviewers: [{ persona: 'Implementer', model: 'sonnet' }] })).status, 200);
```

Add three tests to `test/generic.test.mjs`:

```js
test('AI review is review only: pending items are held, then come back on Submit round', () => {
  const spec = join(tmpDocs(), 'spec.md');
  m.init(spec, { type: 'spec' });
  m.addComments(spec, [{ severity: 'MAJOR', body: 'which store?', quote: 'stores widgets' }, { severity: 'MINOR', body: 'say why' }]);
  m.publish(spec);
  m.setDecision(spec, 'c1', { type: 'approve' });
  m.userReply(spec, 'c2', 'why?');
  const u = m.userComment(spec, { anchor: { kind: 'article' }, body: 'name the store' });
  const r = m.submit(spec, { mode: 'review', reviewers: [{ persona: 'Architect' }], note: 'storage only' });
  assert.deepEqual(r.request, { mode: 'review', aiReview: true, reviewers: [{ persona: 'Architect', model: '' }], note: 'storage only' });
  let p = m.pending(spec); // submitted
  assert.equal(p.request.mode, 'review');
  assert.deepEqual([p.needsAction.length, p.held], [0, 3]);
  m.nextRound(spec);
  p = m.pending(spec); // preparing round 2
  assert.deepEqual([p.needsAction.length, p.held], [0, 3]);
  m.addComments(spec, [{ severity: 'MINOR', body: 'from the architect', reviewers: ['Architect'] }]);
  m.publish(spec);
  m.submit(spec, { mode: 'fix' });
  m.nextRound(spec);
  p = m.pending(spec);
  assert.deepEqual([p.request.mode, p.held, p.carriedOver], ['fix', 0, 1]);
  assert.deepEqual(Object.fromEntries(p.needsAction.map((x) => [x.id, x.why])),
    { c1: ['approved'], c2: ['user-reply'], [u.id]: ['user-comment'] });
  assert.equal(m.load(spec).comments[0].decision.type, 'approve');
});

test('submit mode: bad value rejected, requests saved by 1.0.0 read as review', () => {
  const spec = join(tmpDocs(), 'spec.md');
  m.init(spec, { type: 'spec' });
  m.publish(spec);
  assert.throws(() => m.submit(spec, { mode: 'both' }), /mode must be fix or review/);
  assert.throws(() => m.submit(spec, { mode: 'review' }), /at least one reviewer/);
  assert.equal(m.load(spec).rounds[0].status, 'open');
  assert.equal(m.requestMode({ aiReview: true, reviewers: [] }), 'review');
  assert.equal(m.requestMode({ aiReview: false }), 'fix');
  assert.equal(m.requestMode({ mode: 'fix', aiReview: true }), 'fix');
  assert.equal(m.requestMode(null), 'fix');
  m.userComment(spec, { anchor: { kind: 'article' }, body: 'mine' });
  m.submit(spec, { aiReview: true, reviewers: [{ persona: 'Architect' }] });
  const state = m.load(spec);
  delete state.rounds[0].request.mode; // what 1.0.0 wrote
  m.save(spec, state);
  const p = m.pending(spec);
  assert.deepEqual([p.request.mode, p.request.aiReview, p.held, p.needsAction.length], ['review', true, 1, 0]);
});

test('a held comment can be deleted in a later round, an answered one cannot', () => {
  const spec = join(tmpDocs(), 'spec.md');
  m.init(spec, { type: 'spec' });
  m.addComments(spec, [{ severity: 'MINOR', body: 'reviewer comment' }]);
  m.publish(spec);
  const held = m.userComment(spec, { anchor: { kind: 'article' }, body: 'held' });
  const answered = m.userComment(spec, { anchor: { kind: 'article' }, body: 'answered' });
  m.submit(spec, { mode: 'review', reviewers: [{ persona: 'Architect' }] });
  m.nextRound(spec);
  m.reply(spec, answered.id, { kind: 'reply', body: 'noted' });
  m.publish(spec);
  assert.deepEqual(m.deleteComment(spec, held.id), { deleted: held.id });
  assert.throws(() => m.deleteComment(spec, answered.id), (e) => e.status === 403);
  assert.throws(() => m.deleteComment(spec, 'c1'), (e) => e.status === 403);
});
```

In `test/model.test.mjs`, rename `user can delete own comment from current round only` to `user can delete own comment, not a reviewer comment` (body unchanged).

- [ ] **Step 3: Run to verify they fail**

Run: `npm test 2>&1 | grep -E "^not ok|^# (pass|fail)"`
Expected: 5 failures (the two edited tests and the three new ones).

- [ ] **Step 4: Implement in `lib/model.mjs`**

- `export function requestMode(request)` as in Interfaces.
- `submit`: resolve `mode` from `req.mode ?? (req.aiReview ? 'review' : 'fix')`; anything other than `fix`/`review` throws `RwError('mode must be fix or review (got "<value>")')`. Everything that today keys off `aiReview` keys off `mode === 'review'`. Store the request in the shape given in Interfaces.
- `pending`: when a request is in effect (`req` non-null) and `requestMode(req) === 'review'`, return `needsAction: []` and `held` = the number of items that would have been in it. Otherwise `held: 0`. The returned `request` always carries `mode` and `aiReview` derived through `requestMode`, so a legacy request reports `mode: 'review'`.
- `deleteComment`: drop the `c.round !== round.n` condition. New message: `only your own comments that Claude has not answered can be deleted`.
- Update the comment above `submit` to describe `mode`.

- [ ] **Step 5: Run to verify they pass**

Run: `npm test 2>&1 | grep -E "^not ok|^# (pass|fail)"`
Expected: `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add lib/model.mjs test/generic.test.mjs test/model.test.mjs
git commit -m "Add request mode: AI review holds the author's pending items"
```

---

### Task 2: `request-review` command and status wording

**Files:**
- Modify: `rewriter.mjs` (usage ~8-27, `status` ~53-75, `main` switch)
- Test: `test/generic.test.mjs`

**Interfaces:**
- Consumes: `m.submit(target, { mode: 'review', reviewers, custom, note })`, `m.pending(target)` with `request.mode` and `held` (Task 1).
- Produces: `rewriter request-review <doc> [--file reviewers.json] [--reviewer NAME]… [--note TEXT]`. Prints `pending` JSON on success. Task 4's skill text documents exactly this.

- [ ] **Step 1: Write the failing test**

Add to `test/generic.test.mjs`:

```js
test('cli: request-review does what the AI review button does', () => {
  const dir = tmpDocs();
  const spec = join(dir, 'spec.md');
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  const dba = { persona: 'DBA', background: 'Owns the production database.', focus: ['Migrations'], model: 'sonnet' };
  const file = join(dir, 'reviewers.json');
  run('init', spec, '--type', 'spec');

  const early = run('request-review', spec, '--reviewer', 'Architect');
  assert.equal(early.status, 1);
  assert.match(early.stderr, /needs round 1 to be 'open', but it is 'preparing'/);
  run('publish', spec);
  assert.match(run('status', spec).stdout, /presses "Submit round" or "AI review"/);

  writeFileSync(file, JSON.stringify([dba, { persona: 'Nobody' }]));
  const bad = run('request-review', spec, '--file', file);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /unknown reviewer: Nobody/);
  assert.equal(m.load(spec).rounds[0].status, 'open');
  assert.equal(m.load(spec).customReviewers, undefined);
  const none = run('request-review', spec);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /at least one reviewer/);

  m.userComment(spec, { anchor: { kind: 'article' }, body: 'name the store' });
  writeFileSync(file, JSON.stringify([dba]));
  const ok = run('request-review', spec, '--file', file, '--reviewer', 'Architect', '--note', 'storage only');
  assert.equal(ok.status, 0, ok.stderr);
  const p = JSON.parse(ok.stdout);
  assert.deepEqual([p.roundStatus, p.request.mode, p.request.note, p.held], ['submitted', 'review', 'storage only', 1]);
  assert.deepEqual(p.request.reviewers.map((r) => [r.persona, r.profile]), [['Architect', 'spec'], ['DBA', 'custom']]);
  assert.equal(p.request.reviewers[1].background, dba.background);
  assert.equal(run('request-review', spec, '--reviewer', 'Architect').status, 1); // already submitted

  let st = run('status', spec).stdout;
  assert.match(st, /Author asked for an AI review by: Architect, DBA \[sonnet\]\. Next: Claude runs `next`/);
  assert.match(st, /Held for the author: 1/);
  run('next', spec);
  assert.match(run('status', spec).stdout, /AI review by: Architect, DBA \[sonnet\]\. Next: Claude runs the reviewers/);
  run('publish', spec);
  m.submit(spec);
  st = run('status', spec).stdout;
  assert.match(st, /Author asked for fixes\. Next: Claude runs `next`/);
  assert.doesNotMatch(st, /Held for the author/);
  assert.match(run('help').stdout, /request-review/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test 2>&1 | grep -E "^not ok|^# (pass|fail)"`
Expected: 1 failure, `cli: request-review…` (`unknown command: request-review`).

- [ ] **Step 3: Implement in `rewriter.mjs`**

- `case 'request-review'`: entries from `--file` (via `readJsonFile`) that have a `background` go to `custom`; the rest, plus every `--reviewer NAME` as `{ persona: NAME }`, go to `reviewers`. Call `m.submit(dir, { mode: 'review', reviewers, custom, note: flags.note })`, then `out(m.pending(dir))`. No extra validation: `submit` already rejects an empty panel, unknown names and a round that is not `open`.
- Usage: add after the `reviewers` line

  ```
    request-review [--file reviewers.json] [--reviewer R]... [--note N]
                                         ask for an AI review for the author (same as the UI's "AI review" button)
  ```

- `status`: after the `Needs Claude:` line add `Held for the author: N (waits for their next "Submit round")`, only when `p.held > 0`. Last line, with `asked` = `Author asked for an AI review by: A [model], B.` (model in brackets only when set) or `Author asked for fixes.`:

  | Round status | Last line |
  |---|---|
  | `open` | `Next: author reviews in the UI and presses "Submit round" or "AI review".` |
  | `submitted` | ``<asked> Next: Claude runs `next`, then `pending`.`` |
  | `preparing`, no request | ``Next: Claude runs `publish` to hand the document to the author.`` |
  | `preparing`, `fix` | ``<asked> Next: Claude acts on the items above, replies, then `publish`.`` |
  | `preparing`, `review` | ``<asked> Next: Claude runs the reviewers, posts their findings with `add`, then `publish`.`` |

- [ ] **Step 4: Run to verify it passes**

Run: `npm test 2>&1 | grep -E "^not ok|^# (pass|fail)"`
Expected: `# fail 0`. (The existing `cli: init --type…` test still matches `AI review by: Sequencer [haiku]`.)

- [ ] **Step 5: Commit**

```bash
git add rewriter.mjs test/generic.test.mjs
git commit -m "Add request-review command; status says which outcome was asked for"
```

---

### Task 3: Two buttons in the UI

**Files:**
- Modify: `ui/index.html` (header ~23-27, help text ~73), `ui/app.js` (`render` ~214-227, delete button ~413, submit dialog ~706-795), `ui/styles.css` (only if the new button needs it)

**Interfaces:**
- Consumes: `POST /api/submit` with `{ mode: 'fix', note }` or `{ mode: 'review', reviewers, custom, note }`; `round.request.mode` in `/api/state` (Task 1). `GET /api/reviewers` is unchanged.
- Produces: nothing other tasks use.

There are no automated UI tests in this repo. Verification is the walkthrough in Step 3.

- [ ] **Step 1: Markup**

`ui/index.html`: add `<button id="review-btn">AI review</button>` directly before `#submit-btn`. Replace the help card's last paragraph with:

```html
<p class="muted">Every action autosaves. A round ends in one of two ways:<br><b>Submit round</b> hands your comments and decisions to Claude to fix.<br><b>AI review</b> has the reviewers you pick read the document; your pending items wait.</p>
```

No keyboard shortcut for either button (decided: nothing that ends a round on a single keypress).

- [ ] **Step 2: Behaviour in `ui/app.js`**

- Add `const reqMode = (rq) => rq?.mode || (rq?.aiReview ? 'review' : 'fix');` and `const names = (rq) => rq.reviewers.map((r) => r.persona).join(', ');`.
- `render`: `#review-btn` is disabled under the same condition as `#submit-btn`.
- Banner, replacing the `preparing` and `submitted` branches (`prev` = the round before the latest one):

  | State | Text |
  |---|---|
  | `submitted`, `review` | `AI review requested: <names>. Claude picks it up if it is waiting; otherwise tell it to continue.` |
  | `submitted`, `fix` | `Round <n> submitted. Asked for fixes only. Claude picks it up if it is waiting; otherwise tell it to continue.` |
  | `preparing`, `prev.request` is `review` | `AI review running: <names>. Findings appear here when they are done.` |
  | `preparing`, otherwise | `Claude is preparing round <n>. Read-only until it publishes.` |

  The `info` banner class applies to both `submitted` rows and to the "AI review running" row.
- Delete button: show it for the author's own comment with no AI entry in its thread, in any round (drop `c.round === latest().n`).
- Split `openSubmit` into two functions sharing the existing `dlg` container and `closeSubmit`. Both start with the same guards as today (`readOnly()`, close popover and form). Factor the `toFix` / `undecided` counts into one helper used by both.

  **`openSubmitDialog()`**, bound to `#submit-btn`:
  - Title `Submit round <n>`.
  - Line: `<toFix> item(s) for Claude to act on.` plus, when `undecided > 0`, ` <undecided> reviewer comment(s) have no decision and carry over.`
  - When `toFix === 0`, a second line: `Nothing for Claude to act on yet: comment, decide on a reviewer comment, or write a note below.`
  - Note textarea, placeholder `Note for Claude about this round (optional)…`
  - `Cancel` and primary `Submit round`. The primary button is disabled while `toFix === 0` and the note is empty; re-evaluate on every `input` event of the note.
  - Sends `{ mode: 'fix', note }`. Toast `Round submitted`.

  **`openReviewDialog()`**, bound to `#review-btn`:
  - Fetches `/api/reviewers` first, as `openSubmit` does today.
  - Title `AI review`.
  - Line: `The reviewers you pick read the document as it is now. Their findings arrive as comments in the next round.`
  - When `toFix > 0`: `Your <toFix> pending item(s) stay as they are until you press Submit round.`
  - The reviewer panel exactly as today (groups, checkboxes, model selects, `+ New reviewer` form, last panel or suggested preselected), always visible. The two radio buttons and the `st.ai` flag are gone.
  - Note textarea, placeholder `Note for the reviewers (optional), e.g. what to focus on…`
  - `Cancel` and primary `Start AI review`. With no reviewer ticked: toast `Pick at least one reviewer`, no request.
  - Sends `{ mode: 'review', reviewers, custom, note }` with `reviewers` / `custom` built as today. Toast `AI review requested`.
- Update the section comment above the dialogs. Remove the now-unused `radio` helper, and the `.mode` rule in `ui/styles.css` if nothing else uses it.

- [ ] **Step 3: Verify**

Run: `node --check ui/app.js && npm test 2>&1 | grep -E "^# (pass|fail)"`
Expected: no syntax error, `# fail 0`.

Then drive the real UI on a scratch document:

```bash
D=$(mktemp -d) && printf '# Spec\n\nThe service stores widgets.\n' > "$D/spec.md"
node rewriter.mjs init "$D/spec.md" --type spec && node rewriter.mjs publish "$D/spec.md"
node rewriter.mjs serve "$D/spec.md"   # background; open the printed URL
```

Check each of these in the browser, using `node rewriter.mjs status|next|add|publish "$D/spec.md"` in a second shell to play Claude:

1. Header shows `AI review` and `Submit round`. **Submit round** with nothing done: the "Nothing for Claude…" line shows and the button is disabled; typing a note enables it. Cancel.
2. Add a general comment. **AI review**: the spec reviewers are preselected, the "Your 1 pending item(s)…" line shows. Untick all → `Start AI review` → toast "Pick at least one reviewer". Tick Architect → start.
3. Banner: "AI review requested: Architect. …"; both buttons disabled.
4. `next` → banner "AI review running: Architect. …". `add --severity MAJOR --body "which store?" --quote "stores widgets" --reviewer Architect`, `publish` → the finding appears without a reload; the author's comment from step 2 is still there with a **Delete** button.
5. Approve the finding, **Submit round**: "2 item(s) for Claude to act on." Submit → banner "Round 2 submitted. Asked for fixes only. …". `status` prints `Needs Claude: 2`.

If no browser is available in the session, say so in the report and hand this list to the user instead of claiming it passed.

- [ ] **Step 4: Commit**

```bash
git add ui/
git commit -m "UI: separate Submit round and AI review actions"
```

---

### Task 4: Skill, README, version

**Files:**
- Modify: `skills/rewriter/SKILL.md`, `README.md` (Use section ~40-50), `.claude-plugin/plugin.json`, `package.json`
- Create: `test/skill.test.mjs`

**Interfaces:**
- Consumes: the `request-review` syntax from Task 2; `request.mode` and `held` from Task 1; the button names and dialog behaviour from Task 3.

- [ ] **Step 1: Write the failing test**

Create `test/skill.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const skill = readFileSync(join(ROOT, 'skills', 'rewriter', 'SKILL.md'), 'utf8');
const description = /^description: (.*)$/m.exec(skill)[1];

test('skill description leads with the triggers and stays valid frontmatter', () => {
  assert.ok(description.length <= 1024, `description is ${description.length} chars`);
  assert.ok(!description.includes(': '), 'a ": " would break the unquoted YAML value');
  assert.match(description, /^Use whenever a markdown document needs the user's review/);
  for (const phrase of ['right after you write', 'role-based reviewers', 'review it with a DBA and a security reviewer', '/rewriter', 'Not for READMEs']) {
    assert.ok(description.includes(phrase), `missing: ${phrase}`);
  }
});

test('every command in the skill table exists in the CLI, and the flow uses request.mode', () => {
  const help = spawnSync(process.execPath, [join(ROOT, 'rewriter.mjs'), 'help'], { encoding: 'utf8' }).stdout;
  const commands = [...skill.matchAll(/^\| `([a-z-]+) <doc>/gm)].map((x) => x[1]); // rows of the command table only
  assert.ok(commands.includes('request-review'));
  for (const c of commands) assert.match(help, new RegExp(`^  ${c}\\b`, 'm'), `skill documents "${c}", CLI help does not`);
  assert.match(skill, /request\.mode/);
  assert.doesNotMatch(skill, /Fix, then AI review|request\.aiReview/);
});

test('plugin and package versions match', () => {
  const v = (f) => JSON.parse(readFileSync(join(ROOT, f), 'utf8')).version;
  assert.equal(v('.claude-plugin/plugin.json'), '1.1.0');
  assert.equal(v('package.json'), '1.1.0');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/skill.test.mjs 2>&1 | grep -E "^not ok|^# (pass|fail)"`
Expected: 3 failures.

- [ ] **Step 3: Rewrite the skill**

`skills/rewriter/SKILL.md`. Keep `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_SKILL_DIR}` placeholders as they are (the installer rewrites them). Sections not listed stay untouched.

**Frontmatter description** (one line, verbatim):

```
description: Use whenever a markdown document needs the user's review - right after you write or substantially rewrite a design spec, implementation plan, design doc or article draft for the user (open it in ReWriter straight away instead of asking them to read the file), when the user asks to review a markdown document, asks for AI or role-based reviewers on one ("review it with a DBA and a security reviewer", "run the default panel"), says they submitted or finished a ReWriter round, or types /rewriter (e.g. "/rewriter docs/specs/auth.md", "/rewriter next"). Not for READMEs, notes, changelogs or small edits. Opens a local browser UI for PR-style review rounds where the author comments and decides, Claude fixes, and reviewer subagents post their findings.
```

**Intro paragraph:** replace "On any round the author may also ask for an AI review" with: every round ends in one of two ways, **Submit round** (you act on the author's comments and decisions) or **AI review** (reviewers run as subagents and post findings; nothing is fixed).

**Command table:** add the row

```
| `request-review <doc> --file reviewers.json` | ask for an AI review for the author, as the UI's **AI review** button does (also `--reviewer NAME`…, `--note`) |
```

**"Start a review (round 1)"**, replace the steps with:

```markdown
Do this without being asked whenever the description applies, including for a document you wrote yourself
in this turn. Don't ask "shall I open it in ReWriter?": open it.

1. `status <doc>`. If a review exists, continue from its state rather than starting over. Otherwise
   `init <doc> --type T`: pick `T` from what the document is (`article`, `spec`, `plan`; anything else gets
   the generic reviewers).
2. `publish <doc>`. Round 1 is always the untouched document: post no comments of your own.
3. Start `serve <doc>` with `run_in_background` if it isn't already running for this document, and give
   the user the URL it prints.
4. If the user asked for reviewers in chat, go to "Reviewers asked for in chat" now.
5. Start `wait <doc>` with `run_in_background`. When it exits, the author has ended the round: go to "Next
   round" without waiting to be told. If you can't run it in the background, ask the user to tell you when
   they have pressed a button.
6. Tell the user in one or two lines: the document is open in the browser; comment and press **Submit
   round** to have you fix things, or press **AI review** to have reviewers read it first.
```

**New section "Reviewers asked for in chat"**, after "Start a review":

```markdown
"Review it with a DBA and a security reviewer", "run the default panel": the findings belong in the UI,
never in chat. Do what the **AI review** button does:

1. Make sure the review exists and the UI is running ("Start a review", steps 1-3). If the round is
   `submitted` or `preparing`, finish it first ("Next round") so that a round is `open`.
2. Build the panel. `reviewers <doc>` lists who exists. "Default panel" = the `suggested` entries. A role
   that isn't listed is a new reviewer: write its `persona`, a `background` (who they are, what they look
   for) and `focus` bullets from what the user said.
3. Write `.rewriter/tmp-reviewers.json`, an array of `{ persona, model?, background?, focus? }` (only new
   reviewers need `background`), run `request-review <doc> --file .rewriter/tmp-reviewers.json`, delete
   the file. For listed reviewers alone, `request-review <doc> --reviewer "Architect" --reviewer "DBA"`
   is enough.
4. Continue with "Next round".
```

**"Next round (author submitted)"**, replace steps 2 and 3 with:

```markdown
2. `next <doc>`, then `pending <doc>`. `request.mode` says which of the two the author chose.
3. **`fix`** (Submit round): read `request.note` first, it is the author's instruction for this round.
   Then act on each `needsAction` item; its `why` says what it needs:
   <the four existing bullets: approved, declined, user-comment, user-reply, unchanged>
   Comments that are open with no decision are carried over: leave them alone and don't re-post them.
   Post no new comments of your own.
4. **`review`** (AI review): don't edit the document and don't reply to anything. `held` counts the
   author's pending items; they wait for the author's next **Submit round**. Run the AI review (below)
   with exactly `request.reviewers`. `request.note` is addressed to the reviewers.
```

and renumber the remaining steps (publish, wait, report). The report line becomes: after `fix`, "fixed N, accepted N, challenged N (with ids)"; after `review`, "N new comments, by which reviewers", plus the author's shortlist.

**"AI review" → "Who reviews"**, replace the three-item precedence list with: always exactly `request.reviewers` from `pending`, no more, no fewer. Both the UI button and `request-review` put them there.

**"AI review" → `{{scope}}` bullet**, append: if `request.note` is not empty, add "The author asks: <note>" to `{{scope}}`.

**"Reviewers"** section: "Reviewers the author defines in the Submit dialog" → "in the AI review dialog".

**"UI" reference paragraph**, replace the sentence that starts `**Submit round** opens a dialog` with: the header has two buttons. **Submit round** opens a dialog with the count of items for Claude and a note. **AI review** opens a dialog with a checklist of reviewers (grouped by profile, last panel preselected), a model per reviewer, "+ New reviewer", and a note for the reviewers. The author can delete an own comment until Claude has answered it.

- [ ] **Step 4: README and versions**

`README.md`, "Use" section. Replace the two sentences from "or just ask" to "Fix, then AI review" with:

```markdown
You rarely need to type that. Claude opens ReWriter on its own after it writes a spec, plan or article
draft for you, or when you ask for a review ("review docs/specs/auth.md", "review it with a DBA and a
security reviewer").

Each round ends with one of two buttons:

- **Submit round**: Claude acts on your comments and on your decisions about reviewer comments.
- **AI review**: the reviewers you pick, each on the model you pick, read the document and post their
  findings. Nothing is fixed in that round; your own pending items wait for your next **Submit round**.
```

Also change "Reviewers created in the Submit dialog" to "in the AI review dialog", and in the intro paragraph "On any round the author can also ask for an AI review" stays true, leave it.

Set `"version": "1.1.0"` in `.claude-plugin/plugin.json` and `package.json`. The bump is what lets an installed copy pick up the new skill description.

- [ ] **Step 5: Verify**

Run: `npm test 2>&1 | grep -E "^not ok|^# (pass|fail)"`
Expected: `# fail 0`.

Run: `claude plugin validate .`
Expected: validation passes. If the `claude` CLI is not available in the session, report that it was not run.

- [ ] **Step 6: Commit**

```bash
git add skills/rewriter/SKILL.md README.md .claude-plugin/plugin.json package.json test/skill.test.mjs
git commit -m "Skill: open ReWriter unprompted, two outcomes per round; 1.1.0"
```

---

## After the last task

Not part of the plan's tasks, and the author's call: merge `review-flow` into `master` and push, then update the installed copy in the test project (marketplace update, then plugin update) and try the two cases that started this: ask Claude for a spec and see whether ReWriter opens unprompted, and ask "review it with a DBA and a security reviewer". Triggering depends on the model reading the description, so that check can only be done in a live session.
