#!/usr/bin/env node
// Component installer for this repo. No dependencies, Node 22.
//
//   node install.mjs                 pick components interactively
//   node install.mjs rewriter        install one component
//   node install.mjs --list          show components
//   node install.mjs --uninstall rewriter
//
// Options: --app-dir DIR (default ~/.local/share/comage), --bin-dir DIR (~/.local/bin),
//          --skills-dir DIR (~/.claude/skills), --yes (no prompts)

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync, lstatSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

const REPO = dirname(fileURLToPath(import.meta.url));

// Each component: the app files (copied to <app-dir>/<name>), the commands put on PATH, and the Claude
// skill that is always installed with it. The skill's ${CLAUDE_PLUGIN_ROOT} / ${CLAUDE_SKILL_DIR}
// placeholders are rewritten to the installed locations.
export const COMPONENTS = {
  rewriter: {
    description: 'ReWriter: PR-style review rounds for markdown documents (CLI, local UI, and its Claude skill)',
    files: ['rewriter.mjs', 'lib', 'ui', 'vendor', 'bin', 'reviewers.default.json', 'package.json'],
    bins: { rewriter: 'bin/rewriter' },
    skill: { name: 'rewriter', from: 'skills/rewriter' },
  },
};

function parseArgs(argv) {
  const o = { names: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (['--app-dir', '--bin-dir', '--skills-dir'].includes(a)) o.flags[a.slice(2)] = resolve(argv[++i] ?? '');
    else if (a.startsWith('--')) o.flags[a.slice(2)] = true;
    else o.names.push(a);
  }
  return o;
}

function dirs(flags) {
  return {
    app: flags['app-dir'] ?? join(homedir(), '.local', 'share', 'comage'),
    bin: flags['bin-dir'] ?? join(homedir(), '.local', 'bin'),
    skills: flags['skills-dir'] ?? join(homedir(), '.claude', 'skills'),
  };
}

function rmLink(p) {
  try { lstatSync(p); unlinkSync(p); } catch { /* absent */ }
}

export function install(name, d, log = console.log) {
  const c = COMPONENTS[name];
  const appDir = join(d.app, name);
  rmSync(appDir, { recursive: true, force: true });
  mkdirSync(appDir, { recursive: true });
  for (const f of c.files) cpSync(join(REPO, f), join(appDir, f), { recursive: true });
  log(`  app    ${appDir}`);

  mkdirSync(d.bin, { recursive: true });
  for (const [cmd, rel] of Object.entries(c.bins)) {
    const target = join(appDir, rel);
    chmodSync(target, 0o755);
    const link = join(d.bin, cmd);
    rmLink(link);
    symlinkSync(target, link);
    log(`  bin    ${link}`);
  }

  const skillDir = join(d.skills, c.skill.name);
  rmSync(skillDir, { recursive: true, force: true });
  mkdirSync(skillDir, { recursive: true });
  for (const f of readdirSync(join(REPO, c.skill.from))) {
    let text = readFileSync(join(REPO, c.skill.from, f), 'utf8');
    text = text.replaceAll('${CLAUDE_PLUGIN_ROOT}', appDir).replaceAll('${CLAUDE_SKILL_DIR}', skillDir);
    writeFileSync(join(skillDir, f), text);
  }
  log(`  skill  ${skillDir}`);
  if (!(process.env.PATH ?? '').split(':').includes(d.bin)) log(`  note   ${d.bin} is not on your PATH`);
}

export function uninstall(name, d, log = console.log) {
  const c = COMPONENTS[name];
  for (const cmd of Object.keys(c.bins)) rmLink(join(d.bin, cmd));
  rmSync(join(d.app, name), { recursive: true, force: true });
  rmSync(join(d.skills, c.skill.name), { recursive: true, force: true });
  log(`  removed ${name}`);
}

async function pick() {
  const names = Object.keys(COMPONENTS);
  names.forEach((n, i) => console.log(`  ${i + 1}) ${n}: ${COMPONENTS[n].description}`));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ans = (await rl.question('Install which? (numbers or names, comma separated, "all"): ')).trim();
  rl.close();
  if (ans === 'all') return names;
  return ans.split(/[\s,]+/).filter(Boolean).map((s) => names[Number(s) - 1] ?? s);
}

async function main() {
  const { names: given, flags } = parseArgs(process.argv.slice(2));
  if (flags.list) {
    for (const [n, c] of Object.entries(COMPONENTS)) console.log(`${n}\t${c.description}`);
    return;
  }
  let names = flags.all ? Object.keys(COMPONENTS) : given;
  if (!names.length) {
    if (!process.stdin.isTTY || flags.yes) throw new Error('no component given (see --list)');
    names = await pick();
  }
  const bad = names.filter((n) => !COMPONENTS[n]);
  if (bad.length || !names.length) throw new Error(`unknown component: ${bad.join(', ') || '(none selected)'}; see --list`);
  const d = dirs(flags);
  for (const n of names) {
    console.log(`${flags.uninstall ? 'Uninstalling' : 'Installing'} ${n}`);
    (flags.uninstall ? uninstall : install)(n, d);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`install: ${e.message}`); process.exit(1); });
}
