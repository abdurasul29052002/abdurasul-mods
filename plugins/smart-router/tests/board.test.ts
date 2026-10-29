import { expect, mock, test } from 'claude-code/testing'

import { boardHtml } from '../hooks/board'

const PANE = {
  component: 'Pane',
  requestId: 'smart-router-dashboard',
  props: { title: 'Task dashboard', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 } },
} as const

const tok = (input: number, output: number) => ({ input, output, cacheRead: 0, cacheWrite: 0 })

test("the app's plan list drives the progress: items, advance, done/start, wrap-up", async ($, on) => {
  mock.clock(on, { now: 1000 })
  mock.store(on)
  on('session.id', () => ({ value: 's1' }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('tool.call', { tool: 'mcp__ccd_turn__update_plan' }, () => ({ result: 'ok' }) as any)
  on('tool.call', { tool: 'mcp__ccd_turn__wrap_up' }, () => ({ result: 'ok' }) as any)
  const plan = (input: object) => $.tool.call({ tool: 'mcp__ccd_turn__update_plan', ...input } as any)
  const progress = async (re: RegExp) => {
    const ui = await $.ui.mount({ plugin: 'smart-router', surface: 'terminal', ...PANE })
    const found = await ui.find({ text: re })
    await ui.unmount()
    return found
  }

  await $.prompt.submit({ text: 'Katta vazifa' })
  await plan({ items: [{ content: 'A', status: 'in_progress' }, { content: 'B', status: 'pending' }, { content: 'C', status: 'pending' }, { content: 'D', status: 'pending' }] })
  expect(await progress(/0\/4 vazifa/)).toBeDefined()
  await plan({ advance: true })
  expect(await progress(/1\/4 vazifa/)).toBeDefined()
  expect(await progress(/▶ B/)).toBeDefined()
  await plan({ done: [2], start: 4 })
  expect(await progress(/2\/4 vazifa/)).toBeDefined()
  expect(await progress(/▶ D/)).toBeDefined()
  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'ok' } as any)
  expect(await progress(/4\/4 vazifa/)).toBeDefined()
})

test('a main turn books its own cost by day and folder; the board shows cost, models and sessions', async ($, on) => {
  mock.clock(on, { now: Date.UTC(2026, 9, 24, 12) })
  mock.store(on)
  const written: Record<string, string> = {}
  on('fs.write', (_$, e: any) => {
    written[e.path] = e.text
    return { value: undefined } as any
  })
  on('env.get', (_$, e: any) => ({ value: ({ HOME: 'C:/me', OS: 'Windows_NT' } as Record<string, string>)[e.name] }) as any)
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }) as any)
  let cost = 1.5
  on('session.id', () => ({ value: 's1' }))
  on('session.cwd', () => ({ value: 'C:\\work\\shop' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [], cost: { usd: cost } } }) as any)
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('session.start', (_$, e) => e as any)
  on('command.register', () => ({ value: undefined }) as any)

  await $.session.start({ source: 'startup', cwd: 'C:\\work\\shop' } as any)
  await $.prompt.submit({ text: 'ish' })
  await $.turn.start({ text: 'ish', turnId: 't1' })
  cost = 2.25
  await $.turn.complete({ answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' } as any)

  // Today's cost is only this turn's 0.75, not the 1.50 the session had before the mod started.
  await $.command.run({ command: 'router-board', args: '' } as any)
  const page = Object.entries(written).find(([path]) => /smart-router[\\/]board\.html$/.test(path))?.[1] ?? ''
  expect(page).toContain('<div class="label">Bugun</div><div class="value num">0</div><div class="sub num">$0.75')
  // The session list shows the session's whole cost.
  expect(page).toContain('<td class="r num">$2.25</td>')

  const html = boardHtml({
    now: Date.UTC(2026, 9, 24, 12),
    use: [{ day: '2026-10-24', cwd: 'C:\\work\\shop', tok: tok(1000, 500) }],
    costs: [{ day: '2026-10-24', cwd: 'C:\\work\\shop', usd: 0.75 }],
    models: [
      { day: '2026-10-24', tier: 'haiku', tok: tok(300, 0) },
      { day: '2026-10-24', tier: 'opus', tok: tok(700, 500) },
    ],
    sessions: [{ cwd: 'C:\\work\\<shop>', startedAt: Date.UTC(2026, 9, 24, 10), ms: 65_000, tok: tok(1000, 500), usd: 0.75 }],
  })
  expect(html).toContain('<title>Smart router board</title>')
  expect(html).toContain('$0.75')
  expect(html).toContain('Haiku')
  expect(html).toContain('Opus')
  expect(html).toContain('01:05')
  // Folder names are escaped.
  expect(html).toContain('&lt;shop&gt;')
  expect(html).not.toContain('<shop>')
  expect(boardHtml({ now: 0, use: [], costs: [], models: [], sessions: [] })).toContain('Hali token yozilmadi')
})
