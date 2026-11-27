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
  next                                 open a new round (after the author submitted); it is this session's
  claim                                take over a round another Claude session left unfinished
  publish                              snapshot the document, hand the round to the author
  status                               human-readable summary
  reviewers                            reviewers the author can pick (JSON)
  request-review [--file reviewers.json] [--reviewer R]... [--note N]
                                       ask for an AI review for the author (same as the UI's "AI review" button)
  approve   [--note N]                 approve the document as it stands: the review is closed, its UI stops
                                       and its state is removed
  wait      [--timeout seconds]        block until the author ends the round (submits or approves), then print pending
  serve     [--port 4870] [--no-open] [--idle-minutes 120]
                                       start the review UI, or print the URL of the one already running for
                                       this document; it stops after --idle-minutes with no browser tab (0 = never)
  running   [--session ID] [--json]    the review UIs running for this Claude session (no <document>);
                                       without a session id, every one running on this machine

Severities: NITPICK, MINOR, MAJOR, BLOCKER. --file - reads JSON from stdin.
A round being prepared belongs to the Claude session that opened it ($CLAUDE_CODE_SESSION_ID, or
--session ID): add, reply and publish from another session are refused.`;

function parse(argv) {
  const pos = [];
  const flags = { reviewer: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const key = a.slice(2);
    if (key === 'no-open' || key === 'help' || key === 'json') { flags[key] = true; continue; }
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// How long an approved review stays before `approve` removes it: the same pause the UI server takes.
const APPROVED_REMOVE_MS = 1000;

function status(dir, session) {
  const s = m.load(dir);
  const r = s.rounds[s.rounds.length - 1];
  const by = (pred) => s.comments.filter(pred).length;
  const p = m.pending(dir, { session });
  const sev = m.SEVERITIES.slice().reverse()
    .map((x) => `${x} ${by((c) => c.status !== 'resolved' && c.severity === x)}`).join(', ');
  const review = p.request?.mode === 'review';
  const asked = review
    ? `Author asked for an AI review by: ${p.request.reviewers.map((x) => x.persona + (x.model ? ` [${x.model}]` : '')).join(', ')}.`
    : 'Author asked for fixes.';
  const lines = [
    `Document: ${m.articlePath(dir, s)} (${m.docType(s)})`,
    `Round ${r.n} (${r.status}${p.otherSession ? ', held by another Claude session' : ''})`,
    `Comments: ${by((c) => c.status === 'open')} open, ${by((c) => c.status === 'addressed')} addressed, ${by((c) => c.status === 'resolved')} resolved`,
    `Unresolved by severity: ${sev}`,
    `Needs Claude: ${p.needsAction.length}${p.needsAction.length ? ` (${p.needsAction.map((x) => `${x.id}:${x.why.join('+')}`).join(', ')})` : ''}`,
    ...(p.held ? [`Held for the author: ${p.held} (waits for their next "Submit round")`] : []),
    ...(p.notActedOn ? [`Left as they were: ${p.notActedOn} item(s) not acted on.`] : []),
    p.otherSession ? `Another Claude session (${p.otherSession}) is working on this round. Next: nothing here, leave the round and the document to it. Only if that session is gone: \`claim\`, then carry on.` : {
      preparing: !p.request ? 'Next: Claude runs `publish` to hand the document to the author.'
        : review ? `${asked} Next: Claude runs the reviewers, posts their findings with \`add\`, then \`publish\`.`
          : `${asked} Next: Claude acts on the items above, replies, then \`publish\`.`,
      open: 'Next: author reviews in the UI and presses "Submit round", "AI review" or "Approve".',
      submitted: `${asked} Next: Claude runs \`next\`, then \`pending\`.`,
      approved: 'Next: nothing. The author approved this version; the review is closed and its state is being removed. A document that has to change after all gets a new review (`init`).',
    }[r.status],
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

async function main() {
  const { pos, flags } = parse(process.argv.slice(2));
  const [cmd, dirArg, ...rest] = pos;
  if (!cmd || flags.help || cmd === 'help') { process.stdout.write(`${USAGE}\n`); return; }
  // Which Claude session is calling: decides who may work on a round that is being prepared.
  const session = flags.session || process.env.REWRITER_SESSION || process.env.CLAUDE_CODE_SESSION_ID || null;
  if (cmd === 'running') { // the one command about no document in particular
    const { listRunning } = await import('./lib/running.mjs');
    const list = await listRunning({ session });
    if (flags.json) out(list); else process.stdout.write(list.map((x) => `${x.name}  ${x.url}\n`).join(''));
    return;
  }
  if (!dirArg) throw new m.RwError('document path required');
  const dir = m.locate(resolve(dirArg)); // a review from an older version is moved to the project root here
  switch (cmd) {
    case 'init': {
      const s = m.init(dir, { article: flags.article, type: flags.type, session });
      process.stdout.write(`initialized ${dir.stateDir} (${s.docType}, round 1, preparing)\n`);
      break;
    }
    case 'reviewers': out(listReviewers(m.load(dir), m.target(dir).root)); break;
    case 'request-review': {
      // An entry with a background whose name isn't listed yet is a new reviewer (saved with the review).
      // Everything else is looked up by name: a listed reviewer stays as listed even if the file repeats
      // its definition, which is what `reviewers` output pasted back in looks like.
      const fromFile = flags.file ? readJsonFile(flags.file) : [];
      const listed = new Set(listReviewers(m.load(dir), m.target(dir).root).map((r) => r.persona));
      const isNew = (x) => Boolean(x?.background) && !listed.has(String(x.persona || '').trim());
      m.submit(dir, {
        mode: 'review',
        reviewers: [...fromFile.filter((x) => !isNew(x)), ...flags.reviewer.map((persona) => ({ persona }))],
        custom: fromFile.filter(isNew),
        note: flags.note,
      });
      out(m.pending(dir, { session }));
      break;
    }
    case 'wait': {
      // An approved review is removed about a second after the approval, so this looks four times a second:
      // it must read "approved" while that is still there to read. A review that is not there (approved and
      // cleaned up before this started or between two looks, or removed elsewhere) is reported as "gone",
      // not as an error telling the caller to start one: for a document that was under review, no review
      // means the review is over.
      const deadline = flags.timeout ? Date.now() + Number(flags.timeout) * 1000 : Infinity;
      for (;;) {
        try {
          const s = m.load(dir);
          if (['submitted', 'approved'].includes(s.rounds[s.rounds.length - 1].status)) { out(m.pending(dir, { session })); break; }
        } catch (e) {
          if (e.status !== 404) throw e;
          out({ roundStatus: 'gone' });
          break;
        }
        if (Date.now() > deadline) throw new m.RwError('timed out waiting for the author to end the round');
        await sleep(250);
      }
      break;
    }
    case 'add': {
      const items = flags.file ? readJsonFile(flags.file) : [{
        severity: flags.severity, body: flags.body, quote: flags.quote, prefix: flags.prefix,
        suffix: flags.suffix, suggestion: flags.suggestion, reviewers: flags.reviewer,
      }];
      out(m.addComments(dir, items, { session }));
      break;
    }
    case 'reply': {
      const items = flags.file ? readJsonFile(flags.file)
        : [{ id: rest[0], kind: flags.kind, body: flags.body, quote: flags.quote, prefix: flags.prefix, suffix: flags.suffix }];
      out(m.replies(dir, items, { session }));
      break;
    }
    case 'pending': out(m.pending(dir, { session })); break;
    case 'next': out(m.nextRound(dir, { session })); break;
    case 'claim': out(m.claim(dir, { session })); break;
    // The author's approval, given in chat: same as the UI's "Approve" button.
    // The review is then over and its state goes. A running UI server does that itself, once it has told
    // its tabs; with none running it is done here, after the same pause, so that a `wait` in another
    // session reads the approval first.
    case 'approve': {
      const { approvedAt } = m.approve(dir, { note: flags.note });
      out(m.pending(dir, { session }));
      const { servedBy } = await import('./lib/server.mjs');
      // Only this approval is removed: a review started on the document in the meantime is left alone.
      if (!(await servedBy(dir))) { await sleep(APPROVED_REMOVE_MS); m.removeApproved(dir, approvedAt); }
      break;
    }
    case 'publish': out(m.publish(dir, { session })); break;
    case 'status': status(dir, session); break;
    case 'serve': {
      const { startServer } = await import('./lib/server.mjs');
      m.load(dir); // fail fast if not initialized
      const num = (v, name) => {
        if (v === undefined) return undefined;
        if (!Number.isFinite(Number(v)) || Number(v) < 0) throw new m.RwError(`--${name} must be a number (got "${v}")`);
        return Number(v);
      };
      await startServer(dir, { port: num(flags.port, 'port'), open: !flags['no-open'], idleMinutes: num(flags['idle-minutes'], 'idle-minutes'), session });
      break;
    }
    default: throw new m.RwError(`unknown command: ${cmd}\n\n${USAGE}`);
  }
}

main().catch((e) => {
  process.stderr.write(`rewriter: ${e.message}\n`);
  process.exit(1);
});
