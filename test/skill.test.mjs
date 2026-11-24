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
  for (const c of commands) assert.match(help, new RegExp(`^  ${c}\\b`, 'm'), `skill documents "${c}", CLI help does not`);
  assert.match(skill, /request\.mode/);
  assert.doesNotMatch(skill, /Fix, then AI review|request\.aiReview/);
  // request-review ends the round, so a `wait` started earlier fires: the skill must say that is not a second request
  assert.match(skill, /`wait` you started earlier exits/);
});

test('plugin and package versions match', () => {
  const v = (f) => JSON.parse(readFileSync(join(ROOT, f), 'utf8')).version;
  assert.equal(v('.claude-plugin/plugin.json'), '1.2.0');
  assert.equal(v('package.json'), '1.2.0');
});
