# ReWriter Reviewer Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The AI review dialog becomes a two-pane workbench over one reviewer library the author can save to from the UI, and the UI shows clearly when a round is in Claude's hands.

**Architecture:** `lib/reviewers.mjs` learns to write the user's reviewer file (upsert, remove), exposed by two new endpoints on the local server. The dialog in `ui/app.js` is rebuilt around a panel (who runs), a flat library and an editor pane. The lock that already exists for `submitted`/`preparing` rounds gets a visible indicator.

**Tech Stack:** Node 22, ESM, no dependencies, `node --test`. Vanilla JS UI.

**Spec:** `docs/reviewer-workbench-design.md`

## Global Constraints

- Node 22, nothing to `npm install`, no build step, no new dependencies.
- The user file is `process.env.REWRITER_REVIEWERS` or `~/.claude/rewriter/reviewers.json`. **Tests and the UI walkthrough must set `REWRITER_REVIEWERS` to a temp path. Never write the developer's real file.**
- A user file that exists but can't be parsed, or isn't an object/array of profiles, is never overwritten.
- Entries and fields of the user file that an operation doesn't touch are kept as they are.
- A reviewer stays `{ persona, background, focus[], model }`. Saving from the UI stores the whole description as `background` and `focus: []`.
- `GET /api/reviewers` keeps its response shape. `rewriter reviewers` keeps `suggested`.
- UI copy in this plan is exact. Use it verbatim.
- Continue on branch `review-flow`. Do not push. Version stays 1.1.0 (not released yet).
- End every commit message with: `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`
- Full suite before every commit: `npm test`, expected `# fail 0`.

## Review Focus

1. A hand-written user file with other profiles, other reviewers and extra fields (`enabled`): a save must change one entry and nothing else. (Task 1)
2. A user file that is broken JSON, or valid JSON of the wrong shape (`"text"`, `null`): error to the author, file byte-for-byte untouched. A legacy array file must keep its reviewers. (Task 1)
3. Reviewer names with spaces, `/`, `&`, `+` in the `DELETE` URL, and a malformed percent-escape: the first must work, the second must be a 400, not a 500. (Task 1)
4. A reviewer kept with this document shadows the library one of the same name. After **Update & use** / **Save & use** the saved definition must be the one in effect. (Task 1 server test, Task 2 walkthrough)
5. The round is handed to Claude while the dialog is open (Claude runs `request-review` from chat): the dialog must close and nothing can be submitted from it. (Task 3 walkthrough)

## File Structure

| File | Change |
|---|---|
| `lib/reviewers.mjs` | `saveLibraryReviewer`, `removeLibraryReviewer`, strict read for writes |
| `lib/model.mjs` | `forgetReviewer` |
| `lib/server.mjs` | `PUT /api/reviewers`, `DELETE /api/reviewers/<name>` |
| `ui/app.js`, `ui/styles.css`, `ui/index.html` | workbench dialog; working indicator and lock |
| `skills/rewriter/SKILL.md`, `README.md` | reviewer library and dialog description |
| `test/library.test.mjs` (new) | library and endpoint tests |

---

### Task 1: Writable reviewer library

**Files:**
- Modify: `lib/reviewers.mjs`, `lib/model.mjs`, `lib/server.mjs`
- Create: `test/library.test.mjs`

**Interfaces:**
- Produces:
  - `saveLibraryReviewer({ persona, background, model? }) → { persona, background, focus: [], model }` (`lib/reviewers.mjs`). Validates with `normalizeReviewer(r, true)`. Throws an error with `status: 400`.
  - `removeLibraryReviewer(persona) → { removed: persona }`. Throws with `status: 404` when the name is not in the user file.
  - `forgetReviewer(target, persona) → boolean` (`lib/model.mjs`): drops a same-named entry from `state.customReviewers`; `true` if one was dropped. No round-status requirement.
  - `PUT /api/reviewers` body `{ persona, background, model? }` → 200 with the saved reviewer.
  - `DELETE /api/reviewers/<encodeURIComponent(persona)>` → 200 `{ removed }`, 404 if absent, 400 on a malformed escape.

- [ ] **Step 1: Write the failing tests**

Create `test/library.test.mjs`:

```js
// The author's reviewer library: the user file, written from the UI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as m from '../lib/model.mjs';
import { listReviewers, removeLibraryReviewer, saveLibraryReviewer } from '../lib/reviewers.mjs';
import { createHandler } from '../lib/server.mjs';

// Every test gets its own user file; the developer's real one is never touched.
function userFile(content) {
  const f = join(mkdtempSync(join(tmpdir(), 'rw-lib-')), 'sub', 'reviewers.json');
  process.env.REWRITER_REVIEWERS = f;
  if (content !== undefined) { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, content); }
  return f;
}
const read = (f) => JSON.parse(readFileSync(f, 'utf8'));
const find = (name) => listReviewers({ docType: 'spec' }).find((r) => r.persona === name);

test('save adds a new reviewer under "library", creating the file and its directory', () => {
  const f = userFile();
  const saved = saveLibraryReviewer({ persona: ' DBA ', background: 'Owns the database.\n- Migrations', model: 'Sonnet' });
  assert.deepEqual(saved, { persona: 'DBA', background: 'Owns the database.\n- Migrations', focus: [], model: 'sonnet' });
  assert.deepEqual(read(f), { library: [saved] });
  assert.deepEqual([find('DBA').source, find('DBA').profile], ['user', 'library']);
});

test('save changes one hand-written entry and nothing else', () => {
  const before = {
    spec: [{ persona: 'DBA', background: 'old', focus: ['Migrations'], model: 'haiku', enabled: true }, { persona: 'Other', background: 'x' }],
    article: [{ persona: 'DBA', background: 'old copy' }],
  };
  const f = userFile(JSON.stringify(before));
  saveLibraryReviewer({ persona: 'DBA', background: 'new' });
  const after = read(f);
  assert.deepEqual(after.spec[0], { persona: 'DBA', background: 'new', focus: [], model: '', enabled: true });
  assert.deepEqual(after.spec[1], before.spec[1]);
  assert.deepEqual(after.article[0], { persona: 'DBA', background: 'new', focus: [], model: '' });
  assert.equal(after.library, undefined);
});

test('a legacy array file keeps its reviewers', () => {
  const f = userFile(JSON.stringify([{ persona: 'Old Hand', background: 'From before profiles.' }]));
  saveLibraryReviewer({ persona: 'DBA', background: 'new' });
  assert.deepEqual(read(f), { article: [{ persona: 'Old Hand', background: 'From before profiles.' }], library: [{ persona: 'DBA', background: 'new', focus: [], model: '' }] });
});

test('a broken or wrong-shaped user file is an error and stays untouched', () => {
  for (const content of ['{ not json', '"just text"', 'null', '42']) {
    const f = userFile(content);
    assert.throws(() => saveLibraryReviewer({ persona: 'DBA', background: 'x' }), (e) => e.status === 400 && e.message.includes(f), content);
    assert.throws(() => removeLibraryReviewer('DBA'), (e) => e.status === 400, content);
    assert.equal(readFileSync(f, 'utf8'), content);
  }
});

test('save validates before writing anything', () => {
  const f = userFile();
  assert.throws(() => saveLibraryReviewer({ persona: 'DBA' }), /needs a description/);
  assert.throws(() => saveLibraryReviewer({ background: 'x' }), /needs a name/);
  assert.throws(() => saveLibraryReviewer({ persona: 'DBA', background: 'x', model: 'bad model!' }), /bad model/);
  assert.equal(existsSync(f), false);
});

test("the author's copy of a starter wins; removing it brings the starter back", () => {
  userFile();
  assert.equal(find('Architect').source, 'built-in');
  saveLibraryReviewer({ persona: 'Architect', background: 'Mine.' });
  assert.deepEqual([find('Architect').source, find('Architect').background], ['user', 'Mine.']);
  assert.deepEqual(removeLibraryReviewer('Architect'), { removed: 'Architect' });
  assert.equal(find('Architect').source, 'built-in');
  assert.throws(() => removeLibraryReviewer('Architect'), (e) => e.status === 404); // a starter is not in the library
  assert.throws(() => removeLibraryReviewer('Nobody'), (e) => e.status === 404);
});

test('server: save, shadowing, remove, odd names, guards', async () => {
  userFile();
  const dir = mkdtempSync(join(tmpdir(), 'rw-'));
  const spec = join(dir, 'spec.md');
  writeFileSync(spec, '# Spec\n\nThe service stores widgets.\n');
  m.init(spec, { type: 'spec' });
  m.publish(spec);
  m.submit(spec, { mode: 'review', custom: [{ persona: 'DBA', background: 'kept with this document' }] });
  const server = createServer(createHandler(spec));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, p, body, type = 'application/json') => fetch(base + p, { method, headers: { 'content-type': type }, body: body === undefined ? undefined : JSON.stringify(body) });
  const listed = async (name) => (await (await fetch(`${base}/api/reviewers`)).json()).reviewers.find((r) => r.persona === name);
  try {
    assert.equal((await listed('DBA')).source, 'review');
    const put = await call('PUT', '/api/reviewers', { persona: 'DBA', background: 'saved', model: 'opus' });
    assert.equal(put.status, 200);
    assert.deepEqual(await put.json(), { persona: 'DBA', background: 'saved', focus: [], model: 'opus' });
    assert.deepEqual([(await listed('DBA')).source, (await listed('DBA')).background], ['user', 'saved']);
    assert.deepEqual(m.load(spec).customReviewers, []);

    assert.equal((await call('PUT', '/api/reviewers', { persona: 'DBA' })).status, 400);
    assert.equal((await call('PUT', '/api/reviewers', { persona: 'DBA', background: 'x' }, 'text/plain')).status, 415);

    const odd = 'QA/Perf & C++ Reviewer';
    assert.equal((await call('PUT', '/api/reviewers', { persona: odd, background: 'x' })).status, 200);
    const del = await call('DELETE', `/api/reviewers/${encodeURIComponent(odd)}`);
    assert.equal(del.status, 200);
    assert.deepEqual(await del.json(), { removed: odd });
    assert.equal(await listed(odd), undefined);
    assert.equal((await call('DELETE', `/api/reviewers/${encodeURIComponent(odd)}`)).status, 404);
    assert.equal((await call('DELETE', '/api/reviewers/%E0%A4%A')).status, 400);
    assert.equal((await call('DELETE', '/api/reviewers/DBA')).status, 200);
    assert.equal(await listed('DBA'), undefined);
  } finally { server.close(); }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/library.test.mjs 2>&1 | grep -E "^not ok|^# (pass|fail)|SyntaxError"`
Expected: fails to load, `saveLibraryReviewer` is not exported.

- [ ] **Step 3: Implement**

`lib/reviewers.mjs`:
- `ReviewerError` takes an optional status (default 400).
- A strict reader used only by the two writers: missing file → `{}`; unparsable → `ReviewerError("<file>: <parse message>")`; an array → `{ article: array }`; anything that is not a plain object → `ReviewerError("<file>: expected an object of reviewer lists")`. `listReviewers` keeps using the existing lenient `readProfiles`.
- `saveLibraryReviewer`: normalize first, then read. Update every entry with that `persona` in any profile list as `{ ...existing, persona, background, focus: [], model }`. If none exists, push to `library` (created when missing). Write with a temp file and `renameSync`, after `mkdirSync(dirname(file), { recursive: true })`, as 2-space JSON plus a newline.
- `removeLibraryReviewer`: filter the name out of every profile list (non-array values are left alone). Nothing removed → `ReviewerError('"<persona>" is not in your library', 404)`.

`lib/model.mjs`: `forgetReviewer` as in Interfaces, through `update`.

`lib/server.mjs`, next to the other non-GET routes:
- `PUT /api/reviewers` → `saveLibraryReviewer(body)`, then `m.forgetReviewer(dir, saved.persona)`, respond with the saved reviewer.
- `DELETE /api/reviewers/<name>`: path pattern `^/api/reviewers/([^/]+)$`; decode with `decodeURIComponent`, a `URIError` becomes `RwError('bad reviewer name in URL', 400)`.

- [ ] **Step 4: Run to verify it passes**

Run: `npm test 2>&1 | grep -E "^not ok|^# (pass|fail)"`
Expected: `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add lib/reviewers.mjs lib/model.mjs lib/server.mjs test/library.test.mjs
git commit -m "Reviewer library can be saved to and removed from over the local API"
```

---

### Task 2: The workbench dialog

**Files:**
- Modify: `ui/app.js` (`openReviewDialog`, Escape handling in the keyboard section), `ui/styles.css` (replace the `.rv-*` rules), `skills/rewriter/SKILL.md` (Reviewers section, UI paragraph), `README.md` (Reviewers section)

**Interfaces:**
- Consumes: `GET /api/reviewers` → `{ reviewers: [{ persona, background, focus, model, profile, source, suggested }], models, last }`; `PUT /api/reviewers`; `DELETE /api/reviewers/<name>` (Task 1); `POST /api/submit` with `{ mode: 'review', reviewers: [{ persona, model }], custom: [{ persona, background, focus: [], model }], note }`.

No automated UI tests exist. Verification is the walkthrough in Step 3.

- [ ] **Step 1: Rebuild `openReviewDialog()`**

State kept while the dialog is open:
- `reg`: the last `GET /api/reviewers` response.
- `panel`: array of `{ persona, model, def }`. `def` is `null` for a reviewer used as stored, or `{ background }` for one used with an unsaved description.
- `sel`: `null`, or `{ persona, isNew, desc, model }` for the editor pane.

Helpers:
- Stored description of a reviewer: `[background, ...focus.map((f) => '- ' + f)].join('\n')`.
- Tag by `source`: `review` → `this document`, `user` → `yours`, `built-in` → `starter`.
- Dirty: `sel.desc.trim()` differs from the stored description, or `sel.model` differs from the stored model.

Layout (class names are the builder's choice except `rv-edit` on the right pane, which the Escape rule below uses). The card gets a wider variant, about 860px.

- Title `AI review`.
- Line: `The reviewers in the panel read the document as it is now. Their findings arrive as comments in the next round.`
- When the author has pending items: `Your <n> pending item(s) stay as they are until you press Submit round.` (unchanged)
- **Left pane**
  - Label `Panel (<n>)`. Empty: `No reviewers yet. Pick one from the library or create a new one.`
  - One row per panel entry: name, model (`session` when empty), and a `✕` button titled `Remove from the panel`. Clicking the row opens it in the editor with the panel's model and, if `def` is set, its description.
  - Label `Library`. One row per `reg.reviewers` entry, sorted by source (`review`, `user`, `built-in`) and then by name. Each shows the name, its tag, and `✓` when it is in the panel. Clicking opens it in the editor with its stored description and model.
  - Button `+ New reviewer`: opens an empty editor (`isNew`).
- **Right pane** (`rv-edit`)
  - Nothing selected: `Select a reviewer to see or edit it, or create a new one.`
  - Existing: the name as a heading with its tag. New: a text input, placeholder `Name, e.g. Security Reviewer`, `maxlength` 60.
  - Textarea, placeholder `Who they are and what they look for…`.
  - Label `Model`, then one pill button per entry of `reg.models`; the empty model is labelled `session`. The chosen pill is marked.
  - Buttons, re-evaluated on every edit:

    | Selected reviewer | Buttons |
    |---|---|
    | `user` or `built-in`, not dirty | `Use` |
    | `user` or `built-in`, dirty | `Update & use` · `Use without updating` |
    | `review` (kept with this document) | `Save & use` · `Use` |
    | new | `Save & use` · `Use once` |

  - For a `user` reviewer also a quiet button `Remove from library`.
- Below the panes: note textarea, placeholder `Note for the reviewers (optional), e.g. what to focus on…`, then `Cancel` and primary `Start AI review`.

Behaviour:
- Initial panel: `reg.last` entries whose persona is still in `reg.reviewers`, as `{ persona, model, def: null }`; otherwise empty.
- A new reviewer needs a name and a description: toast `Give the reviewer a name and a description`. If the trimmed name equals an existing persona, open that reviewer instead and toast `"<name>" already exists. Opened it.`
- `Use`, `Use without updating`, `Use once`: put the reviewer in the panel (replace an entry with the same persona). `def` is `{ background: sel.desc.trim() }` when the description differs from the stored one or the reviewer is new, else `null`. Nothing is sent to the server.
- `Update & use`, `Save & use`: `PUT /api/reviewers` with `{ persona, background: sel.desc.trim(), model: sel.model }`. On success refetch `reg`, put `{ persona, model, def: null }` in the panel, keep the reviewer selected, toast `Saved to your library`. On failure toast the server's message and change nothing.
- `Remove from library`: `confirm('Remove "<name>" from your library?')`, then `DELETE`, refetch `reg`. If the persona no longer exists in `reg.reviewers`, drop it from the panel and clear the editor; if a starter of that name came back, select that. Toast `Removed from your library`.
- `Start AI review`:
  - Empty panel: toast `Add at least one reviewer to the panel`, no request.
  - Editor dirty or holding a new reviewer that is not in the panel: `confirm('"<name>" has changes you have not applied. Start without them?')`.
  - Sends `reviewers` = panel entries with `def === null` as `{ persona, model }`, `custom` = the others as `{ persona, background: def.background, focus: [], model }`. Toast `AI review requested`.
- Escape while the focus is inside `.rv-edit` must not close the dialog: in the keyboard section replace the `.rv-add` test with `.rv-edit`.
- Remove the old checklist code and the `.rv-add`, `.rv-row`, `.rv-group` rules that nothing uses any more.

- [ ] **Step 2: Docs**

`README.md`, "Reviewers" section, replace its text with:

````markdown
The **AI review** dialog shows one library: your saved reviewers first, then the built-in starters. Select
one to read or edit its description and pick its model, then add it to the panel. A new reviewer, or a
change to an existing one, can be saved to your library (**Save & use**, **Update & use**) or kept with
this document only (**Use once**, **Use without updating**).

Your library is `~/.claude/rewriter/reviewers.json`, shared by every document and project. You can also
edit it by hand:

```json
{ "library": [{ "persona": "DBA", "background": "Owns the production database. Looks at migrations and query cost.", "model": "sonnet" }] }
```

The starters are in `reviewers.default.json`, grouped by document type. That grouping only matters when you
ask Claude in chat for "the default panel".
````


`skills/rewriter/SKILL.md`:
- "Reviewers" section: the user file may have any profile keys; the UI saves under `library`. Replace the sentence about reviewers defined in the dialog with: the author can save a reviewer to their library from the dialog, or use one with this document only; those stay with the review. Keep the sentence about adding a reviewer to the user's file when they ask for it to be available everywhere.
- "UI" paragraph: replace the description of the AI review dialog with: a panel of the reviewers that will run, a library (the author's saved reviewers, then the built-in starters), and an editor for the selected reviewer with its description, model and buttons to use it as is, or to save the change to the library.

- [ ] **Step 3: Verify**

Run: `node --check ui/app.js && npm test 2>&1 | grep -E "^# (pass|fail)"`
Expected: no syntax error, `# fail 0`.

Drive the real UI on a scratch spec with `REWRITER_REVIEWERS` pointing at a temp file (server started with that variable). Check:

1. First AI review: panel is empty with its empty-state text, the editor shows its empty-state text, the library lists 14 starters, nothing is ticked. `Start AI review` → toast "Add at least one reviewer to the panel".
2. Select `Architect`: description shows the background and `- ` focus lines, the `session` pill is marked, one button `Use`. Press it: panel shows `Architect session`, the library row is ticked.
3. Select `Implementer`, click the `opus` pill: buttons become `Update & use` and `Use without updating`. Press the second: panel shows `Implementer opus`; the temp user file does not exist.
4. Select `Test Engineer`, change the description, `Update & use`: toast "Saved to your library"; its tag is now `yours`; the user file has it under `library`; `Remove from library` is shown.
5. `+ New reviewer`, name `DBA`, description, `haiku`, `Use once`: in the panel; the user file has no DBA.
6. `+ New reviewer`, name `Architect`, any description, `Save & use`: toast `"Architect" already exists. Opened it.`; the user file has no Architect.
7. `Start AI review`: the round's request has `reviewers` Architect (`''`), Implementer (`opus`), Test Engineer and `custom` DBA (`haiku`); `rewriter pending` shows all four with a background.
8. Next round (`next`, `publish`), open the dialog: the panel is the four from last time; DBA is tagged `this document` and offers `Save & use` · `Use`. `Save & use`: tag becomes `yours`, the review's own list no longer has DBA.
9. Select `Test Engineer`, `Remove from library`, confirm: tag back to `starter`, still in the panel.

If no browser can be driven in the session, say so and hand the list to the user instead of claiming it passed.

- [ ] **Step 4: Commit**

```bash
git add ui/ README.md skills/rewriter/SKILL.md
git commit -m "AI review dialog: panel, library and reviewer editor"
```

---

### Task 3: Show when Claude has the round

**Files:**
- Modify: `ui/app.js` (`render`), `ui/styles.css`, `skills/rewriter/SKILL.md` (UI paragraph, one sentence)

**Interfaces:**
- Consumes: round `status` and `request` from `/api/state`; `readOnly()`, `isPast()`, `closeSubmit()` in `ui/app.js`.

- [ ] **Step 1: Implement**

- `#round-status` pill (next to the round label), when not viewing an earlier round: `submitted` → text `Waiting for Claude`, `preparing` → text `Claude is working`, both with a class that pulses (CSS animation; respect `prefers-reduced-motion`). `open` stays hidden, an earlier round stays `snapshot`.
- `#banner` gets a spinner (CSS, before the text) whenever the latest round is `submitted` or `preparing` and the author is not viewing an earlier round. Banner texts are unchanged.
- `#new-general` is disabled whenever `readOnly()`.
- When a render finds `readOnly()` true, close what could still change state: the AI review / Submit dialog (`closeSubmit()`), an open comment or reply form, and the selection "Comment" button.
- Card actions, the `+` beside blocks and both header buttons are already hidden or disabled when read-only: confirm in the walkthrough, change nothing if so.
- `skills/rewriter/SKILL.md`, UI paragraph, add: while a round is with you the UI is locked and shows "Waiting for Claude" (`submitted`) or "Claude is working" (`preparing`); it unlocks when you `publish`.

- [ ] **Step 2: Verify**

Run: `node --check ui/app.js && npm test 2>&1 | grep -E "^# (pass|fail)"`
Expected: no syntax error, `# fail 0`.

Drive the UI:

1. Round open: no pill, no banner, `+ General comment` enabled.
2. Open the AI review dialog, then run `rewriter request-review <doc> --reviewer Architect` in a shell: the dialog closes by itself; pill `Waiting for Claude`; banner "AI review requested: Architect. …" with the spinner; `+ General comment` and both header buttons disabled; a comment card shows no action buttons.
3. `rewriter next <doc>`: pill `Claude is working`; banner "AI review running: Architect. …".
4. `rewriter publish <doc>`: pill and banner gone, controls enabled, without a reload.
5. Select round 1 in the round selector: pill reads `snapshot`, no spinner.

- [ ] **Step 3: Commit**

```bash
git add ui/ skills/rewriter/SKILL.md
git commit -m "UI: show when a round is waiting for Claude or being worked on"
```
