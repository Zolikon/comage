// The footer mod (footer.ts), run against the engine: `claude plugin test .` from the repo root.
// The hooks registered here stand for the engine and the host: what `rewriter running --json` prints is
// the `stdout` of `world`, and `seen` is every line the mod pinned under the prompt, in order.
import { expect, mock, test } from 'claude-code/testing'

const AUTH = { name: 'auth.md', url: 'http://127.0.0.1:4870/', document: '/d/auth.md' }
const PLAN = { name: 'plan.md', url: 'http://127.0.0.1:4871/', document: '/d/plan.md' }
const AUTH_LINE = 'ReWriter · auth.md http://127.0.0.1:4870/'


function world(on: any, servers: unknown) {
  const w = {
    stdout: JSON.stringify(servers),
    exitCode: 0,
    env: { CLAUDE_PLUGIN_ROOT: '/p', CLAUDE_CODE_SESSION_ID: 's' } as Record<string, string>,
    seen: [] as (string | undefined)[],
    runs: [] as (readonly string[])[],
    runFails: false,
    clock: mock.clock(on),
  }
  on('process.hookEnv', () => ({ value: w.env }))
  on('process.run', (_: unknown, e: { argv: readonly string[] }) => {
    w.runs.push(e.argv)
    if (w.runFails) throw new Error('cannot start node')
    return { value: { exitCode: w.exitCode, stdout: w.stdout, stderr: '' } }
  })
  on('ui.status', (_: unknown, e: { text: string | undefined }) => {
    w.seen.push(e.text)
    return { value: undefined }
  })
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  return w
}

const TERMINAL = { surface: 'terminal', isInteractive: true }

const start = async ($: any, w: ReturnType<typeof world>, where: object = TERMINAL) => {
  await $.session.start({ cwd: '/', ...where })
  await w.clock.settle()
}

test('one server: its name and URL are the status line', async ($, on) => {
  const w = world(on, [AUTH])
  await start($, w)

  expect(w.seen).toEqual([AUTH_LINE])
  expect(w.runs[0]).toEqual(['node', '/p/rewriter.mjs', 'running', '--json', '--session', 's'])
})

test('two servers are joined on one line', async ($, on) => {
  const w = world(on, [AUTH, PLAN])
  await start($, w)

  expect(w.seen).toEqual([`${AUTH_LINE} · plan.md http://127.0.0.1:4871/`])
})

test('no server: the line is cleared once at the start and never set', async ($, on) => {
  const w = world(on, [])
  await start($, w)
  await w.clock.advance(30000)

  // Cleared, not left alone: a line an earlier copy of the mod pinned must not outlive its server.
  expect(w.seen).toEqual([undefined])
  expect(w.runs.length).toBeGreaterThan(1)
})

test('a server that goes away clears the line on the next tick', async ($, on) => {
  const w = world(on, [AUTH])
  await start($, w)
  w.stdout = '[]'
  await w.clock.advance(10000)

  expect(w.seen).toEqual([AUTH_LINE, undefined])
})

test('unchanged output does not set the line again', async ($, on) => {
  const w = world(on, [AUTH])
  await start($, w)
  await w.clock.advance(30000)

  expect(w.seen).toEqual([AUTH_LINE])
  expect(w.runs.length).toBe(4)
})

test('a failing command clears the line, once', async ($, on) => {
  const w = world(on, [AUTH])
  await start($, w)
  w.exitCode = 1
  await w.clock.advance(10000)
  w.exitCode = 0
  w.stdout = 'oops'
  await w.clock.advance(10000)
  w.stdout = '{"name":"x"}'
  await w.clock.advance(10000)
  w.stdout = '[{"name":"x"}]'
  await w.clock.advance(10000)

  expect(w.seen).toEqual([AUTH_LINE, undefined])
})

test('no plugin root in the environment: the command is not run and no line is shown', async ($, on) => {
  const w = world(on, [AUTH])
  w.env = { CLAUDE_CODE_SESSION_ID: 's' }
  await start($, w)

  expect(w.seen).toEqual([undefined])
  expect(w.runs).toEqual([])
})

// Without a session id the CLI lists every server on the machine: other sessions' links.
test('no session id in the environment: the command is not run and no line is shown', async ($, on) => {
  const w = world(on, [AUTH])
  w.env = { CLAUDE_PLUGIN_ROOT: '/p' }
  await start($, w)

  expect(w.seen).toEqual([undefined])
  expect(w.runs).toEqual([])
})

test('a command that cannot be started clears the line', async ($, on) => {
  const w = world(on, [AUTH])
  await start($, w)
  w.runFails = true
  await w.clock.advance(10000)

  expect(w.seen).toEqual([AUTH_LINE, undefined])
})

for (const [name, where] of [
  ['a headless run', { surface: null, isInteractive: false }],
  ['the desktop app', { surface: 'desktop', isInteractive: true }],
] as const) {
  test(`${name}: the mod does nothing`, async ($, on) => {
    const w = world(on, [AUTH])
    await start($, w, where)
    await $.tool.call({ tool: 'Bash', command: 'rewriter serve docs/auth.md' })
    await w.clock.advance(30000)

    expect(w.seen).toEqual([])
    expect(w.runs).toEqual([])
  })
}

test('a Bash call that mentions rewriter refreshes soon after it returns', async ($, on) => {
  const w = world(on, [])
  await start($, w)
  w.stdout = JSON.stringify([AUTH])
  await $.tool.call({ tool: 'Bash', command: 'rewriter serve docs/auth.md' })
  await w.clock.advance(100)

  expect(w.seen).toEqual([undefined, AUTH_LINE])
})

test('a server that registers a moment later is caught by the second look', async ($, on) => {
  const w = world(on, [])
  await start($, w)
  await $.tool.call({ tool: 'Bash', command: 'rewriter serve docs/auth.md' })
  await w.clock.advance(100)
  w.stdout = JSON.stringify([AUTH])
  await w.clock.advance(1900)

  expect(w.seen).toEqual([undefined, AUTH_LINE])
})

test('another Bash call does not run the command', async ($, on) => {
  const w = world(on, [])
  await start($, w)
  const before = w.runs.length
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await w.clock.advance(5000)

  expect(w.runs.length).toBe(before)
})
