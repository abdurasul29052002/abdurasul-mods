import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  component: 'Pane',
  requestId: 'smart-router-dashboard',
  props: { title: 'Task dashboard', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 } },
} as const

const usage = (input: number, output: number) => ({
  model: 'x',
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
})

test('a second prompt adds to the session totals instead of starting from zero', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  mock.store(on)
  on('session.id', () => ({ value: 's1' }))
  on('session.cwd', () => ({ value: 'C:\w' }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: usage(1000, 500) } as any
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))

  const prompt = async (text: string, turnId: string) => {
    await $.prompt.submit({ text })
    await $.turn.start({ text, turnId })
    const s = $.turn.step({ turnId, index: 0, model: 'x', messageCount: 1 })
    for await (const _ of s) void _
    await clock.advance(60_000)
    await $.turn.complete({ answer: 'ok ' + turnId, durationMs: 60_000, isAborted: false, turnId, reason: 'answer' } as any)
  }

  await prompt('birinchi', 't1')
  await prompt('ikkinchi', 't2')

  const ui = await $.ui.mount({ plugin: 'smart-router', surface: 'terminal', ...PANE })
  expect(await ui.find({ text: /↓ kirish: 2K/ })).toBeDefined()
  expect(await ui.find({ text: /↑ chiqish: 1K/ })).toBeDefined()
  expect(await ui.find({ text: /Vaqt \(sessiya\): 02:00/ })).toBeDefined()
  await ui.unmount()
})
