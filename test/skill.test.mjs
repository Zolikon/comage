// The skill is the plugin's interface to Claude: keep its frontmatter loadable and its commands real.
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
  assert.ok(commands.includes('approve'));
  assert.ok(!commands.includes('reopen'), 'an approved review is removed: there is nothing to reopen');
  for (const c of commands) assert.match(help, new RegExp(`^  ${c}\\b`, 'm'), `skill documents "${c}", CLI help does not`);
  assert.match(skill, /request\.mode/);
  assert.doesNotMatch(skill, /Fix, then AI review|request\.aiReview/);
  // request-review ends the round, so a `wait` started earlier fires: the skill must say that is not a second request
  assert.match(skill, /`wait` you started earlier exits/);
});

test('plugin and package versions match', () => {
  const v = (f) => JSON.parse(readFileSync(join(ROOT, f), 'utf8')).version;
  assert.equal(v('.claude-plugin/plugin.json'), '1.7.0');
  assert.equal(v('package.json'), '1.7.0');
});

test('the skill is safe for parallel sessions: JSON goes over stdin, and a round held elsewhere is left alone', () => {
  // Fixed temp file names are shared by every session reviewing a document in the same folder.
  assert.doesNotMatch(skill, /tmp-[a-z*]/);
  const fileArgs = [...skill.matchAll(/--file (\S+)/g)].map((x) => x[1].replace(/[`.,)]+$/, ''));
  assert.ok(fileArgs.length >= 3);
  assert.deepEqual([...new Set(fileArgs)], ['-']);
  const commands = [...skill.matchAll(/^\| `([a-z-]+) <doc>/gm)].map((x) => x[1]);
  assert.ok(commands.includes('claim'));
  // the words the CLI uses when it refuses, so Claude can match the error to the instruction
  assert.match(skill, /another Claude session/);
  const refused = spawnSync(process.execPath, [join(ROOT, 'rewriter.mjs'), 'help'], { encoding: 'utf8' }).stdout;
  assert.match(refused, /another session/);
});

test('the skill treats approval as the end: nothing runs after it', () => {
  assert.match(skill, /roundStatus.{0,40}approved/);
  assert.match(skill, /do not run `next`, `publish`, `serve` or another `wait`/i);
  assert.match(skill, /`approve <doc>`/);
});

test('the skill does not let an approval start work nobody asked for', () => {
  assert.doesNotMatch(skill, /without asking/);
  assert.match(skill, /only asked to review/);
  assert.match(skill, /`held`/); // still how an AI review round reports the author's pending items
});

test('the skill knows where state lives and that approval removes it', () => {
  assert.match(skill, /<project root>\/\.rewriter\//);
  assert.doesNotMatch(skill, /`reopen/);
  assert.match(skill, /read what `wait` printed first/i);
  assert.match(skill, /roundStatus.{0,20}gone/);
  assert.match(skill, /no ReWriter review.{0,120}expected/is);
  assert.match(skill, /between `init` or `next` and `publish`/);
  // A session that missed the `wait` (resumed, or the approval came first) must not start the review over.
  assert.match(skill, /a review you had open[\s\S]{0,400}do not run\s+`init`/i); // the sentence wraps
  assert.doesNotMatch(skill, /next to the document/);
});

test('reviewers run as the plugin\'s own read-only agent, and the skill fills every placeholder of its prompt', () => {
  const agent = readFileSync(join(ROOT, 'agents', 'reviewer.md'), 'utf8');
  const front = /^---\n([\s\S]*?)\n---\n/.exec(agent)[1];
  assert.match(front, /^name: reviewer$/m);
  // the agent is addressed as <plugin name>:<agent name>
  const plugin = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).name;
  assert.ok(skill.includes(`subagent_type: "${plugin}:reviewer"`));
  const tools = /^tools: (.*)$/m.exec(front)[1].split(',').map((x) => x.trim());
  assert.deepEqual(tools, ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch']); // nothing that edits or runs
  assert.doesNotMatch(front, /^model:/m); // the reviewer's model is set per call; without one, the session's
  const agentDescription = /^description: (.*)$/m.exec(front)[1];
  assert.ok(!agentDescription.includes(': '), 'a ": " would break the unquoted YAML value');
  assert.match(agent, /Reply with \*\*only\*\* a JSON array/);
  for (const s of ['BLOCKER', 'MAJOR', 'MINOR', 'NITPICK']) assert.ok(agent.includes(`\`${s}\``));
  const prompt = readFileSync(join(ROOT, 'skills', 'rewriter', 'reviewer-prompt.md'), 'utf8');
  const placeholders = [...new Set([...prompt.matchAll(/\{\{[a-zA-Z]+\}\}/g)].map((x) => x[0]))];
  assert.ok(placeholders.length >= 7);
  for (const p of placeholders) assert.ok(skill.includes(p), `the skill does not say how to fill ${p}`);
});
