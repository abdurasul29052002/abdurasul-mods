import { expect, mock, test } from 'claude-code/testing'

const MIN = 60_000
const typed = { text: 'fix it', wait: false, origin: { kind: 'composer' } } as const
const usage = (tokens?: number) => ({ value: { startedAt: 0, context: { window: 1_000_000, tokens }, rateLimits: [] } })
// The engine's bottom: the prompt enters as it arrived, with the context hooks attached.
const enter = ($: unknown, e: { text: string; context?: readonly string[] }) => ({ text: e.text, context: e.context })

test('big context asks only above the limit, "Davom etish" lets the prompt through and snoozes', async ($, on) => {
  mock.clock(on, { now: 0 })
  on('prompt.submit', enter)
  let tokens: number | undefined = 249_000
  on('session.usage', () => usage(tokens))
  const asked: string[] = []
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    const [q] = e.questions
    asked.push(q.question)
    return { result: { questions: e.questions, answers: { [q.question]: 'Baribir davom etish' } } }
  })

  expect((await $.prompt.submit(typed)).text).toBe('fix it')
  expect(asked).toEqual([])
  tokens = 251_000
  expect((await $.prompt.submit(typed)).text).toBe('fix it')
  expect(asked.length).toBe(1)
  expect(asked[0]).toContain('Kontekst 251K token (chegara 250K)')
  // Snoozed: no second question until the context grows another 50K.
  tokens = 280_000
  await $.prompt.submit(typed)
  expect(asked.length).toBe(1)
  tokens = 305_000
  await $.prompt.submit(typed)
  expect(asked.length).toBe(2)
  tokens = undefined
  expect((await $.prompt.submit(typed)).text).toBe('fix it')
})

test('the limit comes from the contextLimitK option', { options: { contextLimitK: 100 } }, async ($, on) => {
  mock.clock(on, { now: 0 })
  on('prompt.submit', enter)
  on('session.usage', () => usage(120_000))
  let asked = ''
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    asked = e.questions[0].question
    return { result: { questions: e.questions, answers: { [asked]: 'Baribir davom etish' } } }
  })

  await $.prompt.submit(typed)
  expect(asked).toContain('chegara 100K')
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
  // Cold cache: the prompt is refused once, before the model is called; the resend goes through.
  expect((await $.prompt.submit(typed)).drop).toContain('Model chaqirilmadi')
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
  expect((await $.prompt.submit(typed)).drop).toContain('Model chaqirilmadi')

  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  await clock.advance(61 * MIN)
  expect(await ask()).toEqual([])
})

test('cold cache asks, and "Baribir davom etish" lets the prompt through', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  on('prompt.submit', enter)
  on('session.usage', () => usage(1000))
  let asked = ''
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    const [q] = e.questions
    asked = q.question
    return { result: { questions: e.questions, answers: { [q.question]: 'Baribir davom etish' } } }
  })
  for (let i = 0; i < 3; i++) await $.prompt.submit(typed)

  await clock.advance(61 * MIN)
  expect((await $.prompt.submit(typed)).text).toBe('fix it')
  expect(asked).toContain('Kesh o\'lgan (61 daqiqa)')
})

const stepOf = (model: string, effort: string, agentId?: string) =>
  ({ turnId: 't1', index: 0, model, effort, messageCount: 1, agentId }) as never

test('old model or costly effort asks before the request; "Tushunarli" sends nothing, "Baribir davom etish" sends', async ($, on) => {
  const step = async (model: string, effort: string, agentId?: string) => {
    const stream = $.turn.step(stepOf(model, effort, agentId))
    // The kit hands the result over as the done step; `.result` stays empty.
    let r = await stream.next()
    while (!r.done) r = await stream.next()
    return r.value
  }
  let answer = 'Tushunarli'
  const asked: string[] = []
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    const [q] = e.questions
    asked.push(q.question)
    return { result: { questions: e.questions, answers: { [q.question]: answer } } }
  })
  let sent = 0
  on('turn.step', async function* (_$, e) {
    sent++
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: null }
  })

  expect((await step('claude-opus-5-5', 'medium')).answer).toBe('ok')
  expect(asked).toEqual([])
  expect((await step('claude-opus-5', 'max', 'sub1')).answer).toBe('ok')
  expect(asked).toEqual([])

  expect((await step('claude-opus-5', 'max')).answer).toBe('')
  expect(asked[0]).toContain('Taklif etilgan model: Opus 5.5')
  expect(asked[0]).toContain('Taklif etilgan effort: medium')
  expect(sent).toBe(2)

  answer = 'Baribir davom etish'
  expect((await step('claude-opus-5', 'max')).answer).toBe('ok')
  // Asked once per session: now it passes without a question.
  await step('claude-opus-5', 'max')
  expect(asked.length).toBe(2)
})
