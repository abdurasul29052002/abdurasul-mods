import type { Register } from 'claude-code'

import type { Effort, Route, RouterState, SubAgent, TaskRun, Tier, Tok, Todo } from '../types'

const isEnabled = 'isEnabled' as const
const run = 'run' as const
const todos = 'todos' as const
const agents = 'agents' as const
const agentUse = 'agentUse' as const
const now = 'now' as const
const isPaneOpened = 'isPaneOpened' as const

const PANE = 'smart-router-dashboard'
const STATS = 'smart-router-stats'
const TIERS: readonly Tier[] = ['haiku', 'sonnet', 'opus']
const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const HAIKU = 'claude-haiku-5-5'
const TIER_NAME: Record<string, string> = { haiku: 'Haiku 5.5', sonnet: 'Sonnet 5.5', opus: 'Opus 5.5' }

const CLASSIFIER = `You route a delegated subtask to a Claude model. Pick a tier and, separately, an effort.
Tiers: haiku = narrow or mechanical work (lookups, reading files, formatting, simple edits, short answers); sonnet = most coding, writing and routine multi-step work; opus = architecture, hard debugging, deep analysis, long planning, high-stakes correctness.
Effort is judged on its own, not from the tier: low = trivial, medium = normal, high = needs care, xhigh = tricky reasoning inside a narrow scope, max = the hardest. A small tier with high or xhigh effort is often right for a narrow but fiddly task.
Reply with JSON only: {"tier":"haiku|sonnet|opus","effort":"low|medium|high|xhigh|max","reason":"at most 8 words, in Uzbek"}`

const AGENT_TYPES: Record<string, { tier: Tier; effort: Effort }> = {
  'smart-router:router-easy': { tier: 'haiku', effort: 'low' },
  'smart-router:router-careful': { tier: 'haiku', effort: 'xhigh' },
  'smart-router:router-normal': { tier: 'sonnet', effort: 'medium' },
  'smart-router:router-strong': { tier: 'sonnet', effort: 'high' },
  'smart-router:router-hard': { tier: 'opus', effort: 'high' },
}

const POLICY = `The smart-router plugin is active (the user installed it and asks for this).
- For a large task, first split it into subtasks with TaskCreate (or TodoWrite) and keep each status current while working: the user watches a progress dashboard built from that list.
- Delegate independent subtasks with the Agent tool, choosing the subagent_type by how hard the subtask is. Each type has its model and effort fixed:
  smart-router:router-easy = Haiku, low (mechanical: reading, searching, renames, formatting, simple edits)
  smart-router:router-careful = Haiku, xhigh (narrow but fiddly: regexes, edge cases, exact formatting)
  smart-router:router-normal = Sonnet, medium (routine coding, writing, translation inside a clear spec)
  smart-router:router-strong = Sonnet, high (trickier coding across a few files, subtle bugs with a clear repro)
  smart-router:router-hard = Opus, high (design, hard debugging, deep analysis, high-stakes correctness)
  Start with the cheapest type likely to succeed; if its result fails your check, retry one step up.
- Keep work that needs the whole conversation's context in the main thread.`

type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

const ZERO: Tok = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
const toTok = (u: Usage): Tok => ({
  input: u.input_tokens,
  output: u.output_tokens,
  cacheRead: u.cache_read_input_tokens,
  cacheWrite: u.cache_creation_input_tokens,
})
const plus = (a: Tok, b: Tok): Tok => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
})

const parseRoute = (text: string): Route | null => {
  const json = text.match(/\{[\s\S]*\}/)
  if (!json) return null
  try {
    const v = JSON.parse(json[0])
    if (!TIERS.includes(v.tier) || !EFFORTS.includes(v.effort)) return null
    return { tier: v.tier, effort: v.effort, reason: String(v.reason ?? '').slice(0, 80) }
  } catch {
    return null
  }
}

// State lives in this module and every change redraws the band and the pane.
// ponytail: $.state is not available on this build yet, so a hot reload of the mod resets the dashboard
type S = RouterState
let state: S = { isEnabled: true, run: null, todos: [], agents: [], agentUse: {}, now: 0, isPaneOpened: false }
const read = async <K extends keyof S>($: any, key: K): Promise<S[K]> => state[key]
const update = async <K extends keyof S>($: any, key: K, fn: (v: S[K]) => S[K]) => {
  state = { ...state, [key]: fn(state[key]) }
  $.ui.invalidate('ui.render')
}

// Drawing helpers.
// 950, 1.3K, 525.1K, 1.9M, 2.4B: one decimal, a trailing .0 dropped.
const num = (n: number) => {
  for (const [v, u] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']] as const) {
    if (n >= v) return (n / v).toFixed(1).replace(/\.0$/, '') + u
  }
  return String(n)
}
const fmtTime = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}
const bar = (pct: number, width: number) => {
  const filled = Math.round((pct / 100) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}
// No task list and no subagents means there is no progress to show, so no percentage.
const progressOf = (list: Todo[], subs: SubAgent[]): number | null => {
  if (list.length > 0) return Math.round((100 * list.filter(t => t.status === 'completed').length) / list.length)
  if (subs.length > 0) return Math.round((100 * subs.filter(a => a.isDone).length) / subs.length)
  return null
}
const elapsedOf = (r: TaskRun, tick: number) => (r.endedAt ?? Math.max(tick, r.startedAt)) - r.startedAt
const agentTotal = (m: S['agentUse']): Tok => Object.values(m).reduce((sum: Tok, t) => plus(sum, t), ZERO)
const io = (t: Tok) => `↓ ${num(t.input + t.cacheWrite)}  ↑ ${num(t.output)}`
// Input counts what the model read fresh (uncached plus newly cached); cache reads are shown apart.


// Exact counts, summed as the API reports them: uncached input, output, and the cache read and written.
const addMain = async ($: any, usage: Usage) => {
  await update($, run, (r: TaskRun | null) => (r === null ? r : { ...r, main: plus(r.main, toTok(usage)) }))
}
const addRouter = async ($: any, usage: Usage) => {
  await update($, run, (r: TaskRun | null) => (r === null ? r : { ...r, router: plus(r.router, toTok(usage)) }))
}
const addAgent = async ($: any, agentId: string, usage: Usage & { model: string }) => {
  await update($, agentUse, (m: S['agentUse']) => ({
    ...m,
    [agentId]: { ...plus(m[agentId] ?? ZERO, toTok(usage)), model: usage.model },
  }))
}

// Daily usage across sessions: one $.store key per day, session and folder, so parallel sessions never write the same key.
// ponytail: keys are never pruned; the 4 MiB store holds years of these, prune when it nears that
const USE = 'use|'
const dayOf = (ms: number) => new Date(ms - new Date(ms).getTimezoneOffset() * 60000).toISOString().slice(0, 10)
const sumOf = (t: Tok) => t.input + t.cacheWrite + t.output
const folderName = (cwd: string) => cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd
// The session's own keys, so two requests at once (parallel subagents) add up instead of overwriting each other.
const useCache = new Map<string, Tok>()

const recordUse = async ($: any, usage: Usage) => {
  const key = `${USE}${dayOf(await $.clock.now())}|${await $.session.id()}|${await $.session.cwd()}`
  if (!useCache.has(key)) {
    const saved = (await $.store.get(key)) as Tok | undefined
    if (!useCache.has(key)) useCache.set(key, saved ?? ZERO)
  }
  const tok = plus(useCache.get(key) as Tok, toTok(usage))
  useCache.set(key, tok)
  await $.store.set(key, tok)
  $.ui.invalidate('ui.render')
}

type UseRow = { day: string; cwd: string; tok: Tok }
const loadUse = async ($: any): Promise<UseRow[]> => {
  const rows: UseRow[] = []
  for (const key of await $.store.keys()) {
    if (!key.startsWith(USE)) continue
    const [, day, , ...cwd] = key.split('|')
    rows.push({ day, cwd: envOf(cwd.join('|')), tok: (await $.store.get(key)) as Tok })
  }
  return rows
}
const totalsBy = (rows: UseRow[], keyOf: (r: UseRow) => string) => {
  const m = new Map<string, Tok>()
  for (const r of rows) m.set(keyOf(r), plus(m.get(keyOf(r)) ?? ZERO, r.tok))
  return [...m]
}

// Stats pane: a Desktop environment is its workspace folder; a worktree session counts toward the folder it was cut from.
const envOf = (cwd: string) => cwd.replace(/[\\/]\.claude[\\/]worktrees[\\/].*$/, '')
const shiftDay = (day: string, n: number) => new Date(Date.parse(day + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10)
const ENV_COLORS = ['#7F77DD', '#1D9E75', '#D85A30']
const OTHER_COLOR = '#888780'
const PERIODS = [7, 14, 30]
// ponytail: module variable, a hot reload resets the period to 14 days
let statsDays = 14
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// One stacked bar per day, a part per environment; hovering a bar shows its numbers.
const chartSvg = (days: string[], perDay: number[][], legend: { name: string; color: string }[]) => {
  const W = 352
  const H = 110
  const w = W / days.length
  const max = Math.max(1, ...perDay.map(p => p.reduce((a, b) => a + b, 0)))
  const bars = perDay.map((day, i) => {
    let y = H
    const parts = day.map((v, j) => {
      const h = (v / max) * (H - 4)
      y -= h
      return h > 0 ? `<rect x="${i * w + 2}" y="${y}" width="${w - 4}" height="${Math.max(h - 1, 1)}" fill="${legend[j]?.color}"/>` : ''
    })
    const tip = [`${days[i]}: ${num(day.reduce((a, b) => a + b, 0))}`, ...day.flatMap((v, j) => (v > 0 ? [`${legend[j]?.name}: ${num(v)}`] : []))]
    return `<g><title>${esc(tip.join('\n'))}</title>${parts.join('')}<rect x="${i * w}" y="0" width="${w}" height="${H}" fill="transparent"/></g>`
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${bars.join('')}</svg>`
}

// Only for a subagent that came with no type, model or effort: Haiku judges the subtask.
const classify = async ($: any, text: string): Promise<Route | null> => {
  const r = await $.model.complete({
    model: HAIKU,
    system: CLASSIFIER,
    prompt: `Subtask:\n${text.slice(0, 8000)}`,
    maxTokens: 150,
    effort: 'low',
    timeoutMs: 20000,
  })
  if (r.usage) {
    await addRouter($, r.usage)
    await recordUse($, r.usage)
  }
  return r.isAnswered ? parseRoute(r.text) : null
}

const maybeOpenPane = async ($: any) => {
  if (await read($, isPaneOpened)) return
  const list = await read($, todos)
  const subs = await read($, agents)
  if (list.length < 2 && subs.length === 0) return
  await update($, isPaneOpened, () => true)
  await $.ui.open({ id: PANE, title: 'Task dashboard' })
}

// Ends the run once the main conversation is idle and every subagent has finished.
const historyLine = (r: TaskRun, list: Todo[], subs: SubAgent[], use: S['agentUse']) => {
  const agentsTok = agentTotal(use)
  const total = plus(plus(r.main, r.router), agentsTok)
  const parts = [`⏱ ${fmtTime(elapsedOf(r, r.endedAt ?? r.startedAt))}`]
  if (list.length > 0) parts.push(`✓ ${list.filter(t => t.status === 'completed').length}/${list.length} vazifa`)
  parts.push(io(total))
  if (total.cacheRead > 0) parts.push(`⚡ ${num(total.cacheRead)} kesh`)
  if (subs.length > 0) parts.push(`${subs.length} subagent: ${io(agentsTok)}`)
  return parts.join('  ·  ')
}

// What happened to the last history line, for /router to report.
let historyStatus = 'hali urinilmadi'
// The history line of each finished run, by the answer it closes; drawn under that answer.
// Kept in $.store per session, so it survives a restart of the app and a reload of the mod.
const historyByAnswer = new Map<string, string>()
let historyKey: string | null = null
// The answer's last 1000 characters name it: enough to tell answers apart, small enough to store.
const answerKey = (text: string) => text.trim().slice(-1000)

const loadHistory = async ($: any) => {
  historyKey = 'history:' + (await $.session.id())
  const saved = await $.store.get(historyKey)
  historyByAnswer.clear()
  if (Array.isArray(saved)) for (const [k, v] of saved) historyByAnswer.set(String(k), String(v))
  $.ui.invalidate('ui.render')
}

const saveHistory = async ($: any) => {
  if (historyKey === null) historyKey = 'history:' + (await $.session.id())
  await $.store.set(historyKey, [...historyByAnswer].slice(-300))
}

const maybeEndRun = async ($: any, isMainBusy: boolean, isInMainTurn = false): Promise<string | null> => {
  if (isMainBusy) {
    historyStatus = 'kutilmoqda: asosiy chat hali band'
    return null
  }
  const subs = await read($, agents)
  if (subs.some(a => !a.isDone)) {
    historyStatus = 'kutilmoqda: ' + subs.filter(a => !a.isDone).length + ' subagent hali ishlayapti'
    return null
  }
  const r = await read($, run)
  if (r === null) {
    historyStatus = 'yozilmadi: vazifa boshlanmagan (mod qayta yuklangandan keyin prompt kelmagan)'
    return null
  }
  if (r.endedAt !== null) return null
  const ended = { ...r, endedAt: await $.clock.now() }
  await update($, run, () => ended)
  const text = historyLine(ended, await read($, todos), subs, await read($, agentUse))
  if (isInMainTurn) {
    historyStatus = 'javob ichiga chizildi'
    return text
  }
  try {
    const res = await $.session.append({ message: { type: 'system', content: [{ type: 'text', text }] } })
    historyStatus = res && res.deny ? 'rad etildi: ' + res.deny : 'eslatma sifatida yozildi (desktop ko‘rsatmasligi mumkin)'
  } catch (err) {
    historyStatus = 'xato: ' + String(err).slice(0, 300)
  }
  return null
}

export const register: Register = on => {
  // ponytail: module variable, lost on a hot reload; the next main turn sets it again
  let isMainBusy = false

  on('session.start', async ($, e, next) => {
    await loadHistory($)
    await $.command.register({ name: 'router', description: 'Smart router: on, off, or show its state', argumentHint: 'on | off' })
    await $.command.register({ name: 'dashboard', description: 'Open the task progress dashboard' })
    await $.command.register({ name: 'token-stats', description: 'Open token usage stats by day and folder' })
    // Ticks the elapsed time while a task runs; writes only then, so an idle session redraws nothing.
    $.clock.every(1000, async () => {
      const r = await read($, run)
      if (r !== null && r.endedAt === null) {
        const t = await $.clock.now()
        await update($, now, () => t)
      }
    })
    return next(e)
  })

  on('command.run', { command: 'router' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'on' || arg === 'off') {
      await update($, isEnabled, () => arg === 'on')
      return { text: arg === 'on' ? 'Smart router yoqildi.' : 'Smart router o‘chirildi: subagent turlari qoladi, ko‘rsatma va panel to‘xtadi.' }
    }
    return { text: `Smart router ${(await read($, isEnabled)) ? 'yoqiq' : 'o‘chiq'}: asosiy chatga tegmaydi, subagentlarga model va effort beradi, vazifa progressi, vaqt va tokenlarni ko‘rsatadi.\nTarix qatori: ${historyStatus}` }
  })

  on('command.run', { command: 'dashboard' }, async $ => {
    await update($, isPaneOpened, () => true)
    await $.ui.open({ id: PANE, title: 'Task dashboard' })
    return { text: 'Dashboard ochildi.' }
  })

  on('command.run', { command: 'token-stats' }, async $ => {
    await $.ui.open({ id: STATS, title: 'Token statistikasi' })
    return { text: 'Token statistikasi ochildi.' }
  })

  // ponytail: sent once per conversation; /router off does not take it back (it only asks for good delegation)
  on('prompt.context', async ($, e, next) => {
    const ctx = await next(e)
    return { ...ctx, blocks: [...ctx.blocks, { name: 'smartRouter', text: POLICY }] }
  })

  // A typed prompt while nothing runs starts a new task run.
  on('prompt.submit', async ($, e, next) => {
    const r = await read($, run)
    if (!e.isMeta && !e.command && (r === null || r.endedAt !== null)) {
      const t = await $.clock.now()
      await update($, run, () => ({ startedAt: t, endedAt: null, main: ZERO, router: ZERO }))
      await update($, now, () => t)
      await update($, todos, () => [])
      await update($, agents, () => [])
      await update($, agentUse, () => ({}))
      await update($, isPaneOpened, () => false)
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) isMainBusy = true
    return next(e)
  })

  // Counts every request once, the main conversation's and each subagent's; it changes nothing.
  on('turn.step', async function* ($, e, next) {
    const out = yield* next(e)
    if (out.usage) {
      if (e.agentId === undefined) await addMain($, out.usage)
      else await addAgent($, e.agentId, out.usage)
      await recordUse($, out.usage)
    }
    return out
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      const agentId = e.agentId
      await update($, agents, (list: SubAgent[]) => list.map(a => (a.agentId === agentId ? { ...a, isDone: true } : a)))
      await maybeEndRun($, isMainBusy)
      return next(e)
    }
    isMainBusy = false
    const line = await maybeEndRun($, isMainBusy, true)
    if (line && e.answer.trim()) {
      historyByAnswer.set(answerKey(e.answer), line)
      $.ui.invalidate('ui.render')
      await saveHistory($)
    }
    return next(e)
  })

  // Subagents: a typed router agent fixes its model and effort; a bare call gets them from Haiku's judgement.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    let model = e.model
    let effort = e.effort
    const fixed = e.subagent_type ? AGENT_TYPES[e.subagent_type] : undefined
    if (fixed) {
      model = model ?? fixed.tier
      effort = effort ?? fixed.effort
    }
    if ((await read($, isEnabled)) && !fixed && e.subagent_type !== 'fork' && (!model || !effort)) {
      const picked = await classify($, `${e.description}\n${e.prompt}`)
      if (picked) {
        model = model ?? picked.tier
        effort = effort ?? picked.effort
      }
    }
    const sub: SubAgent = { id: e.tool_use_id, description: e.description, tier: model ?? 'default', effort: effort ?? 'default', isDone: false }
    await update($, agents, (list: SubAgent[]) => [...list, sub])
    await maybeOpenPane($)
    const ran = await next({ ...e, ...(model ? { model } : {}), ...(effort ? { effort } : {}) })
    if (ran.deny !== undefined || ran.isError || e.run_in_background === false) {
      await update($, agents, (list: SubAgent[]) => list.map(a => (a.id === sub.id ? { ...a, isDone: true } : a)))
      await maybeEndRun($, isMainBusy)
    }
    return ran
  })

  on('agent.spawn', async ($, e, next) => {
    const res = await next(e)
    if (res.agentId !== undefined) {
      const agentId = res.agentId
      await update($, agents, (list: SubAgent[]) => list.map(a => (a.id === e.tool_use_id ? { ...a, agentId } : a)))
    }
    return res
  })

  // The task list feeds the progress bar.
  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.result) {
      const id = (ran.result as { task?: { id: string } }).task?.id
      if (id === undefined) return ran
      const todo: Todo = { id, title: e.subject, status: 'pending' }
      await update($, todos, (list: Todo[]) => [...list, todo])
      await maybeOpenPane($)
    }
    return ran
  })

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)
    if ((ran.result as { success?: boolean } | undefined)?.success) {
      const status = e.status
      await update($, todos, (list: Todo[]) =>
        status === 'deleted'
          ? list.filter(t => t.id !== e.taskId)
          : list.map(t =>
              t.id === e.taskId
                ? { ...t, ...(e.subject ? { title: e.subject } : {}), ...(status ? { status } : {}) }
                : t,
            ),
      )
    }
    return ran
  })

  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.result) {
      await update($, todos, () => e.todos.map((t, i) => ({ id: String(i), title: t.content, status: t.status })))
      await maybeOpenPane($)
    }
    return ran
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const text = e.props.text.trim()
    if (!text) return next(e)
    let line = historyByAnswer.get(answerKey(text))
    if (line === undefined) {
      // The answer may span several text blocks: the last block is the one that ends it.
      for (const [answer, l] of historyByAnswer) if (text.length > 20 && answer.endsWith(text)) line = l
    }
    if (line === undefined) return next(e)
    return next({ ...e, props: { ...e.props, text: e.props.text + '\n\n---\n*' + line + '*' } })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, isEnabled))) return next(e)
    const cur = await read($, run)
    if (cur === null) return next(e)
    const tick = await read($, now)
    const list = await read($, todos)
    const subs = await read($, agents)
    const use = await read($, agentUse)
    const { Box, Text } = $.ui.resolve(e)
    const pct = progressOf(list, subs)
    const total = plus(plus(cur.main, cur.router), agentTotal(use))
    const running = subs.filter(a => !a.isDone)

    return (
      <Box flexDirection="column">
        <Text>
          <Text bold>⏱ {fmtTime(elapsedOf(cur, tick))}</Text>
          {pct !== null && <Text>{`  ·  ${bar(pct, 10)} ${pct}%`}</Text>}
          <Text>{`  ·  ${io(total)}`}</Text>
          {total.cacheRead > 0 && <Text dimColor>{`  ⚡ ${num(total.cacheRead)} kesh`}</Text>}
          {cur.endedAt !== null && <Text dimColor>  ✓ tugadi</Text>}
        </Text>
        {running.slice(0, 3).map(a => (
          <Text dimColor>
            ↳ {TIER_NAME[a.tier] ?? a.tier} · {a.effort}: {a.description}
            {a.agentId !== undefined && use[a.agentId] !== undefined ? `   ${io(use[a.agentId] as Tok)}` : ''}
          </Text>
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: STATS }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Svg = e.surface !== 'terminal' && 'Svg' in els ? els.Svg : undefined
    const rows = await loadUse($)
    if (rows.length === 0) {
      return (
        <Box flexDirection="column">
          <Text dimColor>Hali token yozilmadi.</Text>
        </Box>
      )
    }
    const width = Math.max(5, Math.min(20, (e.props.bodyColumns ?? 40) - 24))
    const today = dayOf(await $.clock.now())
    // Cards: today, this week from Monday, this month; the week is compared with the same days of the last one.
    const weekStart = shiftDay(today, -((new Date(today + 'T00:00:00Z').getUTCDay() + 6) % 7))
    const sumWhere = (keep: (day: string) => boolean) => rows.filter(r => keep(r.day)).reduce((s: Tok, r) => plus(s, r.tok), ZERO)
    const todayTok = sumWhere(d => d === today)
    const weekTok = sumWhere(d => d >= weekStart)
    const monthTok = sumWhere(d => d >= today.slice(0, 8) + '01')
    const prevWeek = sumOf(sumWhere(d => d >= shiftDay(weekStart, -7) && d <= shiftDay(today, -7)))
    const change = prevWeek > 0 ? Math.round((100 * (sumOf(weekTok) - prevWeek)) / prevWeek) : null

    // The chart and the list: the chosen period, the three biggest environments in colour, the rest as one.
    const from = shiftDay(today, -(statsDays - 1))
    const inRange = rows.filter(r => r.day >= from)
    const envs = totalsBy(inRange, r => r.cwd).sort((a, b) => sumOf(b[1]) - sumOf(a[1]))
    const top = envs.slice(0, 3).map(([cwd]) => cwd)
    const legend = envs.slice(0, 3).map(([cwd, t], i) => ({ name: folderName(cwd), color: ENV_COLORS[i] ?? OTHER_COLOR, tok: sumOf(t) }))
    if (envs.length > 3) legend.push({ name: 'boshqalar', color: OTHER_COLOR, tok: envs.slice(3).reduce((s, [, t]) => s + sumOf(t), 0) })
    const slotOf = (cwd: string) => (top.includes(cwd) ? top.indexOf(cwd) : top.length)
    const days = Array.from({ length: statsDays }, (_, i) => shiftDay(from, i))
    const perDay = days.map(d => {
      const parts = legend.map(() => 0)
      for (const r of inRange) if (r.day === d) parts[slotOf(r.cwd)] = (parts[slotOf(r.cwd)] ?? 0) + sumOf(r.tok)
      return parts
    })
    const periodTotal = Math.max(1, legend.reduce((s, l) => s + l.tok, 0))
    const maxDay = Math.max(1, ...perDay.map(p => p.reduce((a, b) => a + b, 0)))

    const card = (label: string, t: Tok, note: string, noteColor?: string) => (
      <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor="subtle" paddingX={1}>
        <Text dimColor>{label}</Text>
        <Text bold>{num(sumOf(t))}</Text>
        <Text color={noteColor} dimColor={noteColor === undefined}>
          {note}
        </Text>
      </Box>
    )

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1}>
          {PERIODS.map(n => (
            <Button
              key={`period-${n}`}
              label={`${n} kun`}
              variant={n === statsDays ? 'primary' : 'secondary'}
              onPress={() => {
                statsDays = n
                $.ui.invalidate('ui.render')
              }}
            />
          ))}
        </Box>
        <Box flexDirection="row" gap={1}>
          {card('Bugun', todayTok, `↑ ${num(todayTok.output)} chiqish`)}
          {card(
            'Shu hafta',
            weekTok,
            change === null ? `⚡ ${num(weekTok.cacheRead)} kesh` : `${change > 0 ? '+' : ''}${change}% o‘tgan haftaga`,
            change === null ? undefined : change > 0 ? 'warning' : 'success',
          )}
          {card('Shu oy', monthTok, `⚡ ${num(monthTok.cacheRead)} kesh`)}
        </Box>
        <Text bold>Kunlar bo‘yicha</Text>
        {Svg !== undefined ? (
          <Box flexDirection="column">
            <Svg
              source={chartSvg(days, perDay, legend)}
              alt={`So‘nggi ${statsDays} kunlik tokenlar, environment bo‘yicha`}
              isInteractive
            />
            <Box flexDirection="row" justifyContent="space-between">
              <Text dimColor>{from.slice(5)}</Text>
              <Text dimColor>{today.slice(5)}</Text>
            </Box>
          </Box>
        ) : (
          perDay.map((day, i) => {
            const t = day.reduce((a, b) => a + b, 0)
            return (
              <Text>
                {days[i]?.slice(5)} {bar(Math.round((100 * t) / maxDay), width)} {num(t)}
              </Text>
            )
          })
        )}
        <Text bold>Environment'lar bo‘yicha</Text>
        {legend.map(l => (
          <Text>
            <Text color={l.color}>●</Text> {l.name}  <Text color={l.color}>{bar(Math.round((100 * l.tok) / (legend[0]?.tok ?? 1)), width)}</Text>{' '}
            <Text>{num(l.tok)}</Text> <Text dimColor>{Math.round((100 * l.tok) / periodTotal)}%</Text>
          </Text>
        ))}
        <Text dimColor>
          Jami = kirish + kesh yozish + chiqish; kesh o‘qish alohida.
        </Text>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const cur = await read($, run)
    const tick = await read($, now)
    const list = await read($, todos)
    const subs = await read($, agents)
    const use = await read($, agentUse)
    const width = Math.max(10, Math.min(40, (e.props.bodyColumns ?? 40) - 8))

    if (cur === null) {
      return (
        <Box flexDirection="column">
          <Text dimColor>Hali katta vazifa boshlanmadi.</Text>
        </Box>
      )
    }

    const pct = progressOf(list, subs)
    const done = list.filter(t => t.status === 'completed').length
    const status = cur.endedAt === null ? 'Ishlayapti' : 'Tugadi'
    const agentsTok = agentTotal(use)
    const total = plus(plus(cur.main, cur.router), agentsTok)

    return (
      <Box flexDirection="column">
        <Text bold>{status}</Text>
        <Text>
          {pct === null ? bar(0, width) : bar(pct, width)} {pct === null ? '—' : `${pct}%`}
        </Text>
        {list.length > 0 && (
          <Text dimColor>
            {done}/{list.length} vazifa bajarildi
          </Text>
        )}
        <Text> </Text>
        <Text>⏱ Vaqt: {fmtTime(elapsedOf(cur, tick))}</Text>
        <Text> </Text>
        <Text bold>Tokenlar (jami)</Text>
        <Text>↓ kirish: {num(total.input + total.cacheWrite)}</Text>
        <Text>↑ chiqish: {num(total.output)}</Text>
        <Text dimColor>⚡ kesh o‘qildi: {num(total.cacheRead)}</Text>
        <Text> </Text>
        <Text dimColor>Asosiy chat: {io(cur.main)}</Text>
        <Text dimColor>Subagentlar: {io(agentsTok)}</Text>
        {(cur.router.input > 0 || cur.router.output > 0) && <Text dimColor>Router (baholash): {io(cur.router)}</Text>}
        {list.length > 0 && <Text> </Text>}
        {list.length > 0 && <Text bold>Vazifalar</Text>}
        {list.map(t => (
          <Text dimColor={t.status === 'completed'}>
            {t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▶' : '○'} {t.title}
          </Text>
        ))}
        {subs.length > 0 && <Text> </Text>}
        {subs.length > 0 && <Text bold>Subagentlar</Text>}
        {subs.map(a => (
          <Text dimColor={a.isDone}>
            {a.isDone ? '✓' : '▶'} {TIER_NAME[a.tier] ?? a.tier} · {a.effort}: {a.description}
            {a.agentId !== undefined && use[a.agentId] !== undefined ? `   ${io(use[a.agentId] as Tok)}` : ''}
          </Text>
        ))}
      </Box>
    )
  })
}
