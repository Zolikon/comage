// Footer link: while a ReWriter server this Claude Code session opened is running, its address is pinned
// under the prompt, e.g. `ReWriter · auth.md http://127.0.0.1:4870/`. No server, no line.
//
// The mod knows nothing about where servers are recorded: it asks the CLI (`rewriter running --json`,
// see lib/running.mjs), which answers for the calling session. Anything that goes wrong means "nothing
// to show": this never logs, toasts or throws. See docs/session-footer-design.md.
import type { EngineInterface, Register } from 'claude-code'

// How often the list is asked for again: how long a stopped server's link can outlive it.
const TICK_MS = 10000
// `serve` runs in the background, so its server registers a moment after the Bash call returns.
const AFTER_BASH_MS = [100, 2000]

// The line for what `rewriter running --json` printed, or undefined for no line.
function footerLine(stdout: string): string | undefined {
  let list: unknown
  try {
    list = JSON.parse(stdout)
  } catch {
    return undefined
  }
  if (!Array.isArray(list) || list.length === 0) return undefined
  const entries: string[] = []
  for (const s of list) {
    if (typeof s?.name !== 'string' || typeof s?.url !== 'string') return undefined
    entries.push(`${s.name} ${s.url}`)
  }

  return `ReWriter · ${entries.join(' · ')}`
}

// The line pinned now; NOTHING_YET until the first refresh, which therefore always states the line, a
// clear included: a line pinned by an earlier copy of the module must not outlive its server.
const NOTHING_YET = Symbol('nothing yet')
let shown: string | undefined | typeof NOTHING_YET = NOTHING_YET

// The status row this draws on is the terminal's; anywhere else (a `-p` run, the SDK, the apps) the mod
// does nothing at all.
let isOn = false

// Declared at the top of the file: the engine follows `$` only into such functions.
async function refresh($: EngineInterface): Promise<void> {
  let line: string | undefined
  try {
    // Read every time, never kept: the session id in it is the one the mod is in now.
    const env = await $.process.hookEnv()
    const root = env.CLAUDE_PLUGIN_ROOT
    const session = env.CLAUDE_CODE_SESSION_ID
    // The session is named outright: asked with none, the CLI lists every server on the machine, and
    // another session's link is the one thing this line must never show.
    if (root && session) {
      const ran = await $.process.run(
        ['node', `${root}/rewriter.mjs`, 'running', '--json', '--session', session],
        { env, timeoutMs: 5000 },
      )
      if (ran.exitCode === 0) line = footerLine(ran.stdout)
    }
  } catch {
    line = undefined
  }
  if (line === shown) return
  shown = line
  $.ui.status(line)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    isOn = e.surface === 'terminal' && e.isInteractive
    if (!isOn) return started
    void refresh($)
    $.clock.every(TICK_MS, () => void refresh($))

    return started
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    // Not awaited: the tool's result is never held back by a look at the servers.
    if (isOn && /\brewriter\b/.test(e.command)) {
      for (const ms of AFTER_BASH_MS) $.clock.after(ms, () => void refresh($))
    }

    return ran
    // This hook watches, it does not guard: if it ever fails, the call goes on as if it were not here.
  }).catch(($, e, next) => next(e))
}
