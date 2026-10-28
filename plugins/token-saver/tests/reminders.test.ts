import { expect, mock, test } from 'claude-code/testing'

const MIN = 60_000
const typed = { text: 'fix it', wait: false, origin: { kind: 'composer' } } as const
const usage = (tokens?: number) => ({ value: { startedAt: 0, context: { window: 1_000_000, tokens }, rateLimits: [] } })
// The engine's bottom: the prompt enters as it arrived, with the context hooks attached.
const enter = ($: unknown, e: { text: string; context?: readonly string[] }) => ({ text: e.text, context: e.context })

test('context reminder only above 150K tokens', async ($, on) => {
  mock.clock(on, { now: 0 })
  on('prompt.submit', enter)
  let tokens: number | undefined = 149_000
  on('session.usage', () => usage(tokens))

  expect((await $.prompt.submit(typed)).context ?? []).toEqual([])
  tokens = 151_000
  expect((await $.prompt.submit(typed)).context).toEqual(['[token-saver: kontekst 151K token, chegara 150K]'])
  tokens = undefined
  expect((await $.prompt.submit(typed)).context ?? []).toEqual([])
})

test('a failing usage read does not stop the prompt', async ($, on) => {
  mock.clock(on, { now: 0 })
  on('prompt.submit', enter)
  on('session.usage', () => {
    throw new Error('no usage')
  })

  expect((await $.prompt.submit(typed)).text).toBe('fix it')
})

test('cache reminder needs 3 earlier prompts and more than 60 minutes', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  on('prompt.submit', enter)
  on('session.usage', () => usage(1000))
  const ask = async () => (await $.prompt.submit(typed)).context ?? []

  // 2 earlier prompts: a long pause is not enough.
  await ask()
  await ask()
  await clock.advance(90 * MIN)
  expect(await ask()).toEqual([])

  // 3 earlier prompts: 59 minutes stays quiet, 61 reminds.
  await clock.advance(59 * MIN)
  expect(await ask()).toEqual([])
  await clock.advance(61 * MIN)
  expect(await ask()).toEqual(['[token-saver: kesh 61 daqiqa]'])
})

test('a finished turn keeps the cache warm', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  on('prompt.submit', enter)
  on('session.usage', () => usage(1000))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  const ask = async () => (await $.prompt.submit(typed)).context ?? []
  for (let i = 0; i < 3; i++) await ask()

  await clock.advance(50 * MIN)
  await $.turn.complete({ answer: '', durationMs: 0, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(50 * MIN)
  expect(await ask()).toEqual([])
})

test('commands and plugin prompts neither count nor remind, /clear starts over', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  on('prompt.submit', enter)
  on('session.usage', () => usage(1000))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  const ask = async (e: object = typed) => (await $.prompt.submit({ ...typed, ...e })).context ?? []

  await ask()
  await ask()
  await ask({ command: { name: 'compact', args: '' } })
  await ask({ origin: { kind: 'plugin', name: 'other' } })
  await clock.advance(61 * MIN)
  // Still only 2 typed prompts before this one.
  expect(await ask({ command: { name: 'compact', args: '' } })).toEqual([])
  await clock.advance(61 * MIN)
  expect(await ask({ origin: { kind: 'plugin', name: 'other' } })).toEqual([])

  await ask()
  await ask()
  await clock.advance(61 * MIN)
  expect(await ask()).toEqual(['[token-saver: kesh 61 daqiqa]'])

  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  await clock.advance(61 * MIN)
  expect(await ask()).toEqual([])
})
