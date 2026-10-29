import type { Register } from 'claude-code'

import type { Effort, Route, RouterState, SubAgent, TaskRun, Tier, Tok, Todo } from '../types'
import { bandSvg, boardHtml, chartSvg, dailyStack, dayOf, fmtTime, num, plus, shiftDay, sumOf, usd, weekStartOf, ZERO } from './board'
import type { Board, Col, UseRow } from './board'

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

const toTok = (u: Usage): Tok => ({
  input: u.input_tokens,
  output: u.output_tokens,
  cacheRead: u.cache_read_input_tokens,
  cacheWrite: u.cache_creation_input_tokens,
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
let state: S = { isEnabled: true, run: null, todos: [], agents: [], agentUse: {}, now: 0, isPaneOpened: false, usd: null, turnCosts: [] }
const read = async <K extends keyof S>($: any, key: K): Promise<S[K]> => state[key]
const update = async <K extends keyof S>($: any, key: K, fn: (v: S[K]) => S[K]) => {
  state = { ...state, [key]: fn(state[key]) }
  $.ui.invalidate('ui.render')
}

// Drawing helpers.
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
// Also per model tier (mdl|day|session|tier) and the cost per folder (usd|day|session|cwd), for board.html.
const USE = 'use|'
const MDL = 'mdl|'
const USD = 'usd|'
const tierOf = (model: string) => TIERS.find(t => model.includes(t)) ?? 'other'
// The session's own keys, so two requests at once (parallel subagents) add up instead of overwriting each other.
const useCache = new Map<string, unknown>()
const addStored = async <T,>($: any, key: string, zero: T, add: (a: T) => T) => {
  if (!useCache.has(key)) {
    const saved = (await $.store.get(key)) as T | undefined
    if (!useCache.has(key)) useCache.set(key, saved ?? zero)
  }
  const v = add(useCache.get(key) as T)
  useCache.set(key, v)
  await $.store.set(key, v)
}

const recordUse = async ($: any, usage: Usage, model: string) => {
  const head = `${dayOf(await $.clock.now())}|${await $.session.id()}|`
  await addStored($, `${USE}${head}${await $.session.cwd()}`, ZERO, t => plus(t, toTok(usage)))
  await addStored($, `${MDL}${head}${tierOf(model)}`, ZERO, t => plus(t, toTok(usage)))
  $.ui.invalidate('ui.render')
}

// The cost of the main turn that just ended: the engine's session total minus the one seen before.
let usdSeen = 0
const recordCost = async ($: any) => {
  const total = (await $.session.usage().catch(() => undefined))?.cost?.usd as number | undefined
  if (total === undefined) return
  // A total below the last one means the engine started its count over (a /clear).
  const turn = total >= usdSeen ? total - usdSeen : total
  usdSeen = total
  await update($, 'usd', () => total)
  await update($, 'turnCosts', (list: number[]) => [...list, turn].slice(-20))
  const key = `${USD}${dayOf(await $.clock.now())}|${await $.session.id()}|${await $.session.cwd()}`
  await addStored($, key, 0, (v: number) => v + turn)
}

// Rows of one prefix: [day, the key's middle part, the key's last part (a cwd may hold '|'), value].
const loadRows = async ($: any, prefix: string) => {
  const rows: { day: string; rest: string; value: unknown }[] = []
  for (const key of await $.store.keys()) {
    if (!key.startsWith(prefix)) continue
    const [, day, , ...rest] = key.split('|')
    rows.push({ day, rest: rest.join('|'), value: await $.store.get(key) })
  }
  return rows
}
const loadUse = async ($: any): Promise<UseRow[]> =>
  (await loadRows($, USE)).map(r => ({ day: r.day, cwd: envOf(r.rest), tok: r.value as Tok }))

const loadBoard = async ($: any): Promise<Board> => {
  const sessions: Board['sessions'] = []
  for (const key of await $.store.keys()) {
    if (!key.startsWith('total:')) continue
    const t = (await $.store.get(key)) as { tok: Tok; ms: number; cwd?: string; startedAt?: number; usd?: number }
    // Totals saved before this version have no folder or start time.
    if (t.cwd !== undefined && t.startedAt !== undefined) {
      sessions.push({ cwd: envOf(t.cwd), startedAt: t.startedAt, ms: t.ms, tok: t.tok, usd: t.usd ?? null })
    }
  }
  return {
    now: await $.clock.now(),
    use: await loadUse($),
    costs: (await loadRows($, USD)).map(r => ({ day: r.day, cwd: envOf(r.rest), usd: r.value as number })),
    models: (await loadRows($, MDL)).map(r => ({ day: r.day, tier: r.rest, tok: r.value as Tok })),
    sessions,
  }
}

// Writes board.html fresh and opens it in the default browser.
const openBoard = async ($: any) => {
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  const file = `${(await $.env.get('XDG_CONFIG_HOME')) ?? `${home}/.config`}/smart-router/board.html`
  // $.fs.write creates the directory.
  await $.fs.write(file, boardHtml(await loadBoard($)))
  const windows = (await $.env.get('OS')) === 'Windows_NT'
  const mac = !windows && (await $.process.run(['uname'])).stdout.trim() === 'Darwin'
  await $.process.run(windows ? ['cmd', '/c', 'start', '', file] : [mac ? 'open' : 'xdg-open', file])
  return file
}

// Stats pane: a Desktop environment is its workspace folder; a worktree session counts toward the folder it was cut from.
const envOf = (cwd: string) => cwd.replace(/[\\/]\.claude[\\/]worktrees[\\/].*$/, '')
const PERIODS = [7, 14, 30]
// ponytail: module variable, a hot reload resets the period to 14 days
let statsDays = 14

// The app's own plan (the list under the latest message): the same progress as TaskCreate or TodoWrite.
type PlanInput = { items?: { content: string; status: Todo['status'] }[]; advance?: boolean; done?: number[]; start?: number }
const applyPlan = (list: Todo[], e: PlanInput): Todo[] => {
  if (e.items) return e.items.map((t, i) => ({ id: `plan-${i}`, title: t.content, status: t.status }))
  let next = list
  if (e.advance) {
    const at = next.findIndex(t => t.status === 'in_progress')
    next = next.map((t, i) => (i === at ? { ...t, status: 'completed' } : t))
    const pending = next.findIndex((t, i) => i > at && t.status === 'pending')
    if (pending >= 0) next = next.map((t, i) => (i === pending ? { ...t, status: 'in_progress' } : t))
  }
  // done and start are 1-based.
  if (e.done) next = next.map((t, i) => (e.done?.includes(i + 1) ? { ...t, status: 'completed' } : t))
  if (e.start !== undefined) next = next.map((t, i) => (i + 1 === e.start ? { ...t, status: 'in_progress' } : t.status === 'in_progress' ? { ...t, status: 'pending' } : t))
  return next
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
    await recordUse($, r.usage, HAIKU)
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

// The session's finished prompts in $.store, so a reload of the mod keeps the totals.
const totalKey = (id: string) => 'total:' + id
const loadTotal = async ($: any) =>
  (await $.store.get(totalKey(await $.session.id()))) as { tok: Tok; ms: number; startedAt?: number } | undefined

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
  const use = await read($, agentUse)
  const saved = await loadTotal($)
  await $.store.set(totalKey(await $.session.id()), {
    tok: plus(ended.prior, plus(plus(ended.main, ended.router), agentTotal(use))),
    ms: ended.priorMs + elapsedOf(ended, ended.endedAt as number),
    // For board.html's session list.
    cwd: await $.session.cwd(),
    startedAt: saved?.startedAt ?? (await $.session.usage().catch(() => undefined))?.startedAt ?? r.startedAt,
    usd: (await read($, 'usd')) ?? undefined,
  })
  const text = historyLine(ended, await read($, todos), subs, use)
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
    await $.command.register({ name: 'router-board', description: 'Open the usage board (all sessions and folders) in the browser' })
    // The cost so far is the baseline for the next turn's own cost.
    const usd = (await $.session.usage().catch(() => undefined))?.cost?.usd as number | undefined
    usdSeen = usd ?? 0
    await update($, 'usd', () => usd ?? null)
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

  on('command.run', { command: 'router-board' }, async $ => {
    const file = await openBoard($)
    return { text: `Board ochildi: ${file}` }
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
      // The finished prompt folds into the session totals instead of starting from zero.
      const saved = r === null ? await loadTotal($) : null
      const prior = r === null ? saved?.tok ?? ZERO : plus(r.prior, plus(plus(r.main, r.router), agentTotal(await read($, agentUse))))
      const priorMs = r === null ? saved?.ms ?? 0 : r.priorMs + elapsedOf(r, r.endedAt ?? t)
      await update($, run, () => ({ startedAt: t, endedAt: null, main: ZERO, router: ZERO, prior, priorMs }))
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
      await recordUse($, out.usage, (out.usage as { model?: string }).model ?? '')
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
    await recordCost($)
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

  on('tool.call', { tool: 'mcp__ccd_turn__update_plan' }, async ($, e, next) => {
    const ran = await next(e)
    if (!ran.isError && ran.deny === undefined) {
      await update($, todos, (list: Todo[]) => applyPlan(list, e as PlanInput))
      await maybeOpenPane($)
    }
    return ran
  })

  // Wrapping up checks off the whole plan.
  on('tool.call', { tool: 'mcp__ccd_turn__wrap_up' }, async ($, e, next) => {
    const ran = await next(e)
    if (!ran.isError && ran.deny === undefined) await update($, todos, (list: Todo[]) => list.map(t => ({ ...t, status: 'completed' })))
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
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const pct = progressOf(list, subs)
    const total = plus(cur.prior, plus(plus(cur.main, cur.router), agentTotal(use)))
    const running = subs.filter(a => !a.isDone)
    const usdNow = await read($, 'usd')
    const costs = await read($, 'turnCosts')
    const last = costs[costs.length - 1]
    const turns = costs.length
    const elapsed = fmtTime(cur.priorMs + elapsedOf(cur, tick))
    const context = total.input + total.cacheWrite + total.cacheRead
    const cachePct = context > 0 ? Math.round((100 * total.cacheRead) / context) : 0

    const cols: Col[] = [
      { key: 'cost', label: 'narx', value: usd(usdNow), sub: last === undefined ? '' : `oxirgi ${usd(last)} · ⌀ ${usd(costs.reduce((a, b) => a + b, 0) / turns)}` },
      { key: 'tokens', label: 'tokenlar', value: num(sumOf(total)), sub: io(total) },
      { key: 'cache', label: 'kesh', value: num(total.cacheRead), sub: `${cachePct}% keshdan o‘qildi` },
      { key: 'time', label: 'vaqt', value: elapsed, sub: cur.endedAt === null ? 'ishlayapti' : '✓ tugadi' },
    ]
    if (pct !== null) {
      const done = list.length > 0 ? `${list.filter(t => t.status === 'completed').length}/${list.length} vazifa` : `${subs.filter(a => a.isDone).length}/${subs.length} subagent`
      cols.push({ key: 'progress', label: 'progress', value: `${pct}%`, sub: done, pct })
    }

    const buttons = (
      <Box flexDirection="row" alignItems="center" gap={1}>
        <Text>
          <Text color="suggestion">●</Text> <Text bold>smart-router</Text>
        </Text>
        <Box flexGrow={1} />
        <Button key="dashboard" plain label="Dashboard" onPress={() => update($, isPaneOpened, () => true).then(() => $.ui.open({ id: PANE, title: 'Task dashboard' }))} />
        <Button key="stats" plain label="Statistika" onPress={() => $.ui.open({ id: STATS, title: 'Token statistikasi' })} />
        <Button key="board" plain label="Board" onPress={() => openBoard($).catch(() => $.ui.toast('smart-router: board ochilmadi'))} />
      </Box>
    )
    const metrics =
      e.surface !== 'terminal' && 'Svg' in els ? (
        <els.Svg source={bandSvg(cols, costs)} alt={cols.map(c => `${c.label} ${c.value}`).join(', ')} />
      ) : (
        <Text>
          <Text bold>⏱ {elapsed}</Text>
          {usdNow !== null && <Text>{`  ·  ${usd(usdNow)}`}</Text>}
          {pct !== null && <Text>{`  ·  ${bar(pct, 10)} ${pct}%`}</Text>}
          <Text>{`  ·  ${io(total)}`}</Text>
          {total.cacheRead > 0 && <Text dimColor>{`  ⚡ ${num(total.cacheRead)} kesh`}</Text>}
          {cur.endedAt !== null && <Text dimColor>  ✓ tugadi</Text>}
        </Text>
      )

    return (
      <Box flexDirection="column" gap={1} width={e.props.bodyColumns}>
        {buttons}
        {metrics}
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
    const weekStart = weekStartOf(today)
    const sumWhere = (keep: (day: string) => boolean) => rows.filter(r => keep(r.day)).reduce((s: Tok, r) => plus(s, r.tok), ZERO)
    const todayTok = sumWhere(d => d === today)
    const weekTok = sumWhere(d => d >= weekStart)
    const monthTok = sumWhere(d => d >= today.slice(0, 8) + '01')
    const prevWeek = sumOf(sumWhere(d => d >= shiftDay(weekStart, -7) && d <= shiftDay(today, -7)))
    const change = prevWeek > 0 ? Math.round((100 * (sumOf(weekTok) - prevWeek)) / prevWeek) : null

    // The chart and the list: the chosen period, the three biggest environments in colour, the rest as one.
    const { from, days, perDay, legend } = dailyStack(rows, today, statsDays, 3)
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
    const total = plus(cur.prior, plus(plus(cur.main, cur.router), agentsTok))

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
        <Text>⏱ Vaqt (sessiya): {fmtTime(cur.priorMs + elapsedOf(cur, tick))}</Text>
        <Text> </Text>
        <Text bold>Tokenlar (sessiya jami)</Text>
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
