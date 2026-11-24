# ReWriter

A Claude Code plugin for PR-style review rounds on markdown documents: articles, design specs,
implementation plans, or anything else.

The author reads the document in a local browser UI, comments on it, and approves or declines reviewer
comments. Claude applies the fixes and answers. On any round the author can also ask for an AI review,
choosing the reviewers and the model each one runs on. Reviewers always run as subagents.

## Install

```bash
claude plugin marketplace add Zolikon/comage
claude plugin install comage@comage
```

Or, from a local checkout, try it for one session without installing:

```bash
claude --plugin-dir path/to/comage
```

Requires Node 22. There is nothing to `npm install`.

### Without the plugin: installer

`install.mjs` installs components from this repo. The app and its Claude skill always go in together.

```bash
node install.mjs              # pick components interactively
node install.mjs rewriter     # or name them (--all for everything, --list to see them)
node install.mjs --uninstall rewriter
```

`rewriter` installs the app to `~/.local/share/comage/rewriter`, links `rewriter` into `~/.local/bin`, and
puts the skill in `~/.claude/skills/rewriter` with its paths pointing at that app. Override with
`--app-dir`, `--bin-dir`, `--skills-dir`. Don't use it together with the plugin: both would provide
`/rewriter`.

## Use

```
/comage:rewriter docs/specs/auth.md
```

You rarely need to type that. Claude opens ReWriter on its own after it writes a spec, plan or article
draft for you, or when you ask for a review ("review docs/specs/auth.md", "review it with a DBA and a
security reviewer").

Each round ends with one of three buttons:

- **Submit round**: Claude acts on your comments and on your decisions about reviewer comments.
- **AI review**: the reviewers you pick, each on the model you pick, read the document and post their
  findings. Nothing is fixed in that round; your own pending items wait for your next **Submit round**.
- **Approve**: the document is final as it stands. The review is closed, its server stops, its browser tab
  closes (where the browser lets a page close its own tab; otherwise the page says it can be closed), and
  Claude goes on with what the document was for. Anything still open is left as it is (the dialog tells you how much).
  Ask Claude to reopen the review if the document has to change after all.

Review state is stored next to the document in `.rewriter/`.

## Several sessions at once

The plugin is safe to use from any number of Claude sessions in parallel.

- Each document has its own review state, so sessions working on different documents share nothing.
- Each document has one UI server. A second session asking for it gets the running server's URL instead
  of a new one. A server stops by itself after two hours without a browser tab (`serve --idle-minutes N`,
  `0` = never), or as soon as its review is approved, and comes back on the same URL when it is started
  again.
- While Claude works on a round, that round belongs to the session that picked it up. If two sessions
  watch the same document, one gets the round and the other is told to leave it. `rewriter claim <doc>`
  hands a round to a new session when the one that held it is gone.
- Writes to a review are locked, so parallel commands never overwrite each other.
- The browser tab is named after the Claude session working on the review (`<session title> · <document>`),
  and follows the session when it is retitled or renamed.

### Footer link

While a review UI that a session opened is running, the plugin shows its address under that session's
prompt (`ReWriter · auth.md http://127.0.0.1:4870/`), one entry per document. It goes away when the server
stops, and a session with no review UI shows nothing. `rewriter running` prints the same list. Terminal
only for now.

## Reviewers

The **AI review** dialog shows one library: your saved reviewers first, then the built-in starters. Select
one to read or edit its description and pick its model, then add it to the panel. A new reviewer, or a
change to an existing one, can be saved to your library (**Save & use**, **Update & use**) or kept with
this document only (**Use once**, **Use without updating**).

Your library is `~/.claude/rewriter/reviewers.json`, shared by every document and project. You can also
edit it by hand:

```json
{ "library": [{ "persona": "DBA", "background": "Owns the production database. Looks at migrations and query cost.", "model": "sonnet" }] }
```

To share your reviewers, press **Export** above the library: it downloads `reviewers.json`. The other
person saves it as their own `~/.claude/rewriter/reviewers.json`, or copies the entries they want into
theirs. There is no import button yet.

The panel has no upper limit, but every reviewer is a separate subagent run; 2–5 usually cover a document.
The **?** in the dialog explains how a review runs.

The starters are in `reviewers.default.json`, grouped by document type. That grouping only matters when you
ask Claude in chat for "the default panel".

## Layout

| Path | What |
|---|---|
| `.claude-plugin/` | plugin and marketplace manifests |
| `skills/rewriter/` | the skill (`SKILL.md`) and the reviewer prompt template |
| `bin/rewriter` | CLI launcher, on Claude's `PATH` while the plugin is enabled |
| `rewriter.mjs`, `lib/` | CLI, review model, local server, reviewer registry |
| `ui/` | browser UI |
| `vendor/` | bundled `marked` (MIT), so no install step |
| `install.mjs` | component installer (app + skill, no plugin needed) |
| `test/` | `npm test` |

## License

MIT. Bundled `marked` keeps its own license in `vendor/marked.LICENSE`.

## Development

```bash
npm test
claude plugin validate .
```
