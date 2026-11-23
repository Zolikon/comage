import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const INSTALL = join(dirname(fileURLToPath(import.meta.url)), '..', 'install.mjs');
const run = (...args) => spawnSync(process.execPath, [INSTALL, ...args], { encoding: 'utf8' });

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'inst-'));
  return { app: join(root, 'app'), bin: join(root, 'bin'), skills: join(root, 'skills'),
    args: ['--app-dir', join(root, 'app'), '--bin-dir', join(root, 'bin'), '--skills-dir', join(root, 'skills')] };
}

test('install rewriter puts app, bin link and skill together', () => {
  const s = sandbox();
  const r = run('rewriter', ...s.args);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(s.app, 'rewriter', 'rewriter.mjs')));
  assert.ok(lstatSync(join(s.bin, 'rewriter')).isSymbolicLink());
  const skill = readFileSync(join(s.skills, 'rewriter', 'SKILL.md'), 'utf8');
  assert.ok(!skill.includes('${CLAUDE_PLUGIN_ROOT}') && !skill.includes('${CLAUDE_SKILL_DIR}'));
  assert.ok(skill.includes(join(s.app, 'rewriter', 'rewriter.mjs')));
  assert.ok(existsSync(join(s.skills, 'rewriter', 'reviewer-prompt.md')));
  const help = spawnSync(join(s.bin, 'rewriter'), ['help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
});

test('reinstall is idempotent, uninstall removes everything', () => {
  const s = sandbox();
  assert.equal(run('rewriter', ...s.args).status, 0);
  assert.equal(run('rewriter', ...s.args).status, 0);
  assert.equal(run('--uninstall', 'rewriter', ...s.args).status, 0);
  assert.ok(!existsSync(join(s.app, 'rewriter')));
  assert.ok(!existsSync(join(s.skills, 'rewriter')));
  assert.throws(() => lstatSync(join(s.bin, 'rewriter')));
});

test('unknown component and --list', () => {
  const r = run('nope', ...sandbox().args);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown component: nope/);
  assert.match(run('--list').stdout, /^rewriter\t/);
});
