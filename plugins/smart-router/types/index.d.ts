export type Tier = 'haiku' | 'sonnet' | 'opus'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** What the classifier picks for a subagent that came without a model or effort. */
export type Route = { tier: Tier; effort: Effort; reason: string }

/** Exact token counts as the API reports them, summed. */
export type Tok = { input: number; output: number; cacheRead: number; cacheWrite: number }

/** One big task: from the typed prompt until the work and its subagents end. */
export type TaskRun = {
  startedAt: number
  endedAt: number | null
  /** The main conversation's own requests. */
  main: Tok
  /** The small classifier calls the mod makes for subagents that came without a model. */
  router: Tok
  /** Tokens of the session's earlier finished prompts, main, router and subagents together. */
  prior: Tok
  /** Working time of the session's earlier finished prompts, in ms. */
  priorMs: number
}

export type Todo = { id: string; title: string; status: 'pending' | 'in_progress' | 'completed' }

export type SubAgent = {
  id: string
  agentId?: string
  description: string
  tier: string
  effort: string
  isDone: boolean
}

/** Everything the mod tracks for one session. */
export type RouterState = {
  isEnabled: boolean
  run: TaskRun | null
  todos: Todo[]
  agents: SubAgent[]
  /** Tokens each subagent's requests used, by agent id. */
  agentUse: Record<string, Tok & { model: string }>
  now: number
  isPaneOpened: boolean
  /** The session's cost as the engine totals it; null until it reports one. */
  usd: number | null
  /** The cost of each of the last main turns, oldest first. */
  turnCosts: number[]
}
