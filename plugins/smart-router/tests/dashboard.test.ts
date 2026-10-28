import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  component: 'Pane',
  requestId: 'smart-router-dashboard',
  props: { title: 'Task dashboard', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 } },
} as const

test('the task list drives the dashboard progress on every surface', async ($, on) => {
  mock.clock(on, { now: 1000 })
  on('session.id', () => ({ value: 's1' }))
  mock.store(on)
  // Beneath the plugin: stand in for the engine's prompt entry and task tools.
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('tool.call', { tool: 'TaskCreate' }, (_$, e) => ({ result: { task: { id: e.subject, subject: e.subject } } }))
  on('tool.call', { tool: 'TaskUpdate' }, (_$, e) => ({ result: { success: true, taskId: e.taskId, updatedFields: ['status'] } }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'smart-router', surface, ...PANE })
    expect(await ui.find({ text: /Hali katta vazifa/ })).toBeDefined()
    await ui.unmount()
  }

  await $.prompt.submit({ text: 'Katta vazifa: hisobot tayyorla' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'A', description: 'a' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'B', description: 'b' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: 'A', status: 'completed' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'smart-router', surface, ...PANE })
    expect(await ui.find({ text: /Ishlayapti/ })).toBeDefined()
    expect(await ui.find({ text: /50%/ })).toBeDefined()
    expect(await ui.find({ text: /1\/2 vazifa/ })).toBeDefined()
    expect(await ui.find({ text: /✓ A/ })).toBeDefined()
    await ui.unmount()
  }
})
