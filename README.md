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

Each round ends with one of two buttons:

- **Submit round**: Claude acts on your comments and on your decisions about reviewer comments.
- **AI review**: the reviewers you pick, each on the model you pick, read the document and post their
  findings. Nothing is fixed in that round; your own pending items wait for your next **Submit round**.

Review state is stored next to the document in `.rewriter/`.

## Reviewers

Built-in panels per document type are in `reviewers.default.json` (`article`, `spec`, `plan`, `generic`).
Add your own in `~/.claude/rewriter/reviewers.json`, same shape:

```json
{ "spec": [{ "persona": "DBA", "background": "Owns the production database.", "focus": ["Migrations", "Query cost"], "model": "sonnet" }] }
```

Reviewers created in the AI review dialog are saved with that review and can be reused in later rounds.

## Layout

| Path | What |
|---|---|
| `.claude-plugin/` | plugin and marketplace manifests |
| `skills/rewriter/` | the skill (`SKILL.md`) and the reviewer prompt template |
| `bin/rewriter` | CLI launcher, on Claude's `PATH` while the plugin is enabled |
| `rewriter.mjs`, `lib/` | CLI, review model, local server, reviewer registry |
| `ui/` | browser UI |
| `vendor/` | bundled `marked` (MIT), so no install step |
| `docs/` | design notes and implementation plan |
| `install.mjs` | component installer (app + skill, no plugin needed) |
| `test/` | `npm test` |

## License

MIT. Bundled `marked` keeps its own license in `vendor/marked.LICENSE`.

## Development

```bash
npm test
claude plugin validate .
```
