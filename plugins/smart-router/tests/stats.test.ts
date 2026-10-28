import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  component: 'Pane',
  requestId: 'smart-router-stats',
  props: { title: 'Token statistikasi', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 } },
} as const

const tok = (input: number, output: number) => ({ input, output, cacheRead: 0, cacheWrite: 0 })

test('stats sum tokens by day and by environment across sessions', async ($, on) => {
  // Saturday 2026-10-24 12:00 UTC: the same day in any timezone from UTC-11 to UTC+11.
  mock.clock(on, { now: Date.UTC(2026, 9, 24, 12) })
  mock.store(on, {
    'use|2026-10-24|s1|C:\\work\\shop': tok(1000, 500),
    'use|2026-10-24|s2|C:\\work\\shop': tok(2000, 0),
    'use|2026-10-24|s5|C:\\work\\shop\\.claude\\worktrees\\fix-1': tok(500, 0),
    'use|2026-10-24|s3|C:\\Users\\me\\Other stuff': tok(300, 0),
    'use|2026-10-23|s4|C:\\work\\shop': tok(10000, 0),
    'use|2026-09-30|s6|C:\\work\\old': tok(7000, 0),
    'history:s1': [],
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'smart-router', surface, ...PANE })
    expect(await ui.find({ text: /^4\.3K$/ })).toBeDefined()
    expect(await ui.find({ text: /^14\.3K$/ })).toBeDefined()
    // The worktree session counts toward shop; September is outside both the month and the 14 days.
    expect(await ui.find({ text: /shop.*14K.*98%/ })).toBeDefined()
    expect(await ui.find({ text: /Other stuff.*300/ })).toBeDefined()
    expect(await ui.find({ text: /fix-1/ })).toBeUndefined()
    expect(await ui.find({ text: /old/ })).toBeUndefined()
    await ui.unmount()
  }
})
