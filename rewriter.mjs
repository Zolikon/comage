#!/usr/bin/env node
// ReWriter CLI. Usage: rewriter <command> <document> [args] (bin/rewriter) — see skills/rewriter/SKILL.md.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as m from './lib/model.mjs';
import { listReviewers } from './lib/reviewers.mjs';

const USAGE = `ReWriter — local review rounds for markdown documents (articles, specs, plans, ...)

  rewriter <command> <document> [options]

  <document> is a markdown file, or a directory (meaning its index.md).

  init      [--type article|spec|plan|...]   start a review (round 1, preparing)
  add       --severity S --body B [--quote Q [--prefix P] [--suffix X]]
            [--reviewer R]... [--suggestion T]   |  --file comments.json
  reply     <id> --kind fixed|accepted|challenge|reply --body B [--quote Q [--prefix P]]
            |  --file replies.json   ([{id, kind, body, quote?, prefix?}], all-or-nothing)
  pending                              what needs Claude this round (JSON)
  next                                 open a new round (after the author submitted)
  publish                              snapshot the document, hand the round to the author
  status                               human-readable summary
  reviewers                            reviewers the author can pick (JSON)
  request-review [--file reviewers.json] [--reviewer R]... [--note N]
                                       ask for an AI review for the author (same as the UI's "AI review" button)
  wait      [--timeout seconds]        block until the author submits the round, then print pending
  serve     [--port 4870] [--no-open]  start the review UI

Severities: NITPICK, MINOR, MAJOR, BLOCKER. --file - reads JSON from stdin.`;

function parse(argv) {
  const pos = [];
  const flags = { reviewer: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const key = a.slice(2);
    if (key === 'no-open' || key === 'help') { flags[key] = true; continue; }
    const val = argv[++i];
    if (val === undefined) throw new m.RwError(`missing value for --${key}`);
    if (key === 'reviewer') flags.reviewer.push(val); else flags[key] = val;
  }
  return { pos, flags };
}

function readJsonFile(f) {
  const raw = f === '-' ? readFileSync(0, 'utf8') : readFileSync(f, 'utf8');
  const data = JSON.parse(raw);
  return Array.isArray(data) ? data : [data];
}

const out = (v) => process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);

function status(dir) {
  const s = m.load(dir);
  const r = s.rounds[s.rounds.length - 1];
  const by = (pred) => s.comments.filter(pred).length;
  const p = m.pending(dir);
  const sev = m.SEVERITIES.slice().reverse()
    .map((x) => `${x} ${by((c) => c.status !== 'resolved' && c.severity === x)}`).join(', ');
  const review = p.request?.mode === 'review';
  const asked = review
    ? `Author asked for an AI review by: ${p.request.reviewers.map((x) => x.persona + (x.model ? ` [${x.model}]` : '')).join(', ')}.`
    : 'Author asked for fixes.';
  const lines = [
    `Document: ${m.articlePath(dir, s)} (${m.docType(s)})`,
    `Round ${r.n} (${r.status})`,
    `Comments: ${by((c) => c.status === 'open')} open, ${by((c) => c.status === 'addressed')} addressed, ${by((c) => c.status === 'resolved')} resolved`,
    `Unresolved by severity: ${sev}`,
    `Needs Claude: ${p.needsAction.length}${p.needsAction.length ? ` (${p.needsAction.map((x) => `${x.id}:${x.why.join('+')}`).join(', ')})` : ''}`,
    ...(p.held ? [`Held for the author: ${p.held} (waits for their next "Submit round")`] : []),
    {
      preparing: !p.request ? 'Next: Claude runs `publish` to hand the document to the author.'
        : review ? `${asked} Next: Claude runs the reviewers, posts their findings with \`add\`, then \`publish\`.`
          : `${asked} Next: Claude acts on the items above, replies, then \`publish\`.`,
      open: 'Next: author reviews in the UI and presses "Submit round" or "AI review".',
      submitted: `${asked} Next: Claude runs \`next\`, then \`pending\`.`,
    }[r.status],
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

async function main() {
  const { pos, flags } = parse(process.argv.slice(2));
  const [cmd, dirArg, ...rest] = pos;
  if (!cmd || flags.help || cmd === 'help') { process.stdout.write(`${USAGE}\n`); return; }
  if (!dirArg) throw new m.RwError('document path required');
  const dir = m.target(resolve(dirArg));
  switch (cmd) {
    case 'init': {
      const s = m.init(dir, { article: flags.article, type: flags.type });
      process.stdout.write(`initialized ${dir.stateDir} (${s.docType}, round 1, preparing)\n`);
      break;
    }
    case 'reviewers': out(listReviewers(m.load(dir))); break;
    case 'request-review': {
      // An entry with a background whose name isn't listed yet is a new reviewer (saved with the review).
      // Everything else is looked up by name: a listed reviewer stays as listed even if the file repeats
      // its definition, which is what `reviewers` output pasted back in looks like.
      const fromFile = flags.file ? readJsonFile(flags.file) : [];
      const listed = new Set(listReviewers(m.load(dir)).map((r) => r.persona));
      const isNew = (x) => Boolean(x?.background) && !listed.has(String(x.persona || '').trim());
      m.submit(dir, {
        mode: 'review',
        reviewers: [...fromFile.filter((x) => !isNew(x)), ...flags.reviewer.map((persona) => ({ persona }))],
        custom: fromFile.filter(isNew),
        note: flags.note,
      });
      out(m.pending(dir));
      break;
    }
    case 'wait': {
      const deadline = flags.timeout ? Date.now() + Number(flags.timeout) * 1000 : Infinity;
      for (;;) {
        const s = m.load(dir);
        if (s.rounds[s.rounds.length - 1].status === 'submitted') break;
        if (Date.now() > deadline) throw new m.RwError('timed out waiting for the author to submit');
        await new Promise((r) => setTimeout(r, 1000));
      }
      out(m.pending(dir));
      break;
    }
    case 'add': {
      const items = flags.file ? readJsonFile(flags.file) : [{
        severity: flags.severity, body: flags.body, quote: flags.quote, prefix: flags.prefix,
        suffix: flags.suffix, suggestion: flags.suggestion, reviewers: flags.reviewer,
      }];
      out(m.addComments(dir, items));
      break;
    }
    case 'reply': {
      const items = flags.file ? readJsonFile(flags.file)
        : [{ id: rest[0], kind: flags.kind, body: flags.body, quote: flags.quote, prefix: flags.prefix, suffix: flags.suffix }];
      out(m.replies(dir, items));
      break;
    }
    case 'pending': out(m.pending(dir)); break;
    case 'next': out(m.nextRound(dir)); break;
    case 'publish': out(m.publish(dir)); break;
    case 'status': status(dir); break;
    case 'serve': {
      const { startServer } = await import('./lib/server.mjs');
      m.load(dir); // fail fast if not initialized
      await startServer(dir, { port: Number(flags.port || 4870), open: !flags['no-open'] });
      break;
    }
    default: throw new m.RwError(`unknown command: ${cmd}\n\n${USAGE}`);
  }
}

main().catch((e) => {
  process.stderr.write(`rewriter: ${e.message}\n`);
  process.exit(1);
});
