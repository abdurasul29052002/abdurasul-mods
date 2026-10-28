import { expect, test } from 'claude-code/testing'

test('the rules are added as the last session section', async ($, on) => {
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'engine', scope: 'shared' }] }))

  const { sections } = await $.prompt.compose({
    model: 'claude-opus-5-5',
    promptModel: 'claude-opus-5-5',
    surfaces: ['terminal'],
    tools: [],
    outputStyle: null,
    traits: [],
  })

  expect(sections.map(s => s.id)).toEqual(['intro', 'token-saver:rules'])
  const rules = sections[1]
  expect(rules.scope).toBe('session')
  expect(rules.text).toContain('150K')
  expect(rules.text.split('\n').length).toBeLessThan(60)
})
