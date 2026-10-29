// Pure drawing helpers for the band, the stats pane and board.html: no `$`, so the tests call them directly.

import type { Tok } from '../types'

export const ZERO: Tok = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
export const plus = (a: Tok, b: Tok): Tok => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
})
// Total = input + cache write + output; cache reads are shown apart.
export const sumOf = (t: Tok) => t.input + t.cacheWrite + t.output

// 950, 1.3K, 525.1K, 1.9M, 2.4B: one decimal, a trailing .0 dropped.
export const num = (n: number) => {
  for (const [v, u] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']] as const) {
    if (n >= v) return (n / v).toFixed(1).replace(/\.0$/, '') + u
  }
  return String(n)
}
export const usd = (n: number | null) => (n === null ? '—' : `$${n.toFixed(2)}`)
export const fmtTime = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}
export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export const dayOf = (ms: number) => new Date(ms - new Date(ms).getTimezoneOffset() * 60000).toISOString().slice(0, 10)
export const shiftDay = (day: string, n: number) => new Date(Date.parse(day + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10)
export const weekStartOf = (day: string) => shiftDay(day, -((new Date(day + 'T00:00:00Z').getUTCDay() + 6) % 7))
export const folderName = (cwd: string) => cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd

export const ENV_COLORS = ['#7F77DD', '#1D9E75', '#D85A30', '#378ADD', '#BA7517']
export const OTHER_COLOR = '#888780'
export const TIER_COLORS: Record<string, string> = { haiku: '#1D9E75', sonnet: '#7F77DD', opus: '#D85A30' }
export const TIER_LABEL: Record<string, string> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus', other: 'boshqa' }

export type UseRow = { day: string; cwd: string; tok: Tok }
type Legend = { name: string; color: string; tok: number }

const totalsBy = <R>(rows: R[], keyOf: (r: R) => string, tokOf: (r: R) => Tok) => {
  const m = new Map<string, Tok>()
  for (const r of rows) m.set(keyOf(r), plus(m.get(keyOf(r)) ?? ZERO, tokOf(r)))
  return [...m].sort((a, b) => sumOf(b[1]) - sumOf(a[1]))
}

// The last `n` days up to today, one stacked part per folder: the `top` biggest in colour, the rest as one.
export function dailyStack(rows: UseRow[], today: string, n: number, top: number) {
  const from = shiftDay(today, -(n - 1))
  const inRange = rows.filter(r => r.day >= from)
  const envs = totalsBy(inRange, r => r.cwd, r => r.tok)
  const topCwd = envs.slice(0, top).map(([cwd]) => cwd)
  const legend: Legend[] = envs.slice(0, top).map(([cwd, t], i) => ({ name: folderName(cwd), color: ENV_COLORS[i] ?? OTHER_COLOR, tok: sumOf(t) }))
  if (envs.length > top) legend.push({ name: 'boshqalar', color: OTHER_COLOR, tok: envs.slice(top).reduce((s, [, t]) => s + sumOf(t), 0) })
  const slotOf = (cwd: string) => (topCwd.includes(cwd) ? topCwd.indexOf(cwd) : topCwd.length)
  const days = Array.from({ length: n }, (_, i) => shiftDay(from, i))
  const perDay = days.map(d => {
    const parts = legend.map(() => 0)
    for (const r of inRange) if (r.day === d) parts[slotOf(r.cwd)] = (parts[slotOf(r.cwd)] ?? 0) + sumOf(r.tok)
    return parts
  })
  return { from, days, perDay, legend }
}

// One stacked bar per day, a part per legend entry; hovering a bar shows its numbers.
export const chartSvg = (days: string[], perDay: number[][], legend: { name: string; color: string }[], W = 352, H = 110, fmt = num) => {
  const w = W / days.length
  const max = Math.max(1e-9, ...perDay.map(p => p.reduce((a, b) => a + b, 0)))
  const bars = perDay.map((day, i) => {
    let y = H
    const parts = day.map((v, j) => {
      const h = (v / max) * (H - 4)
      y -= h
      return h > 0 ? `<rect x="${i * w + 2}" y="${y}" width="${Math.max(w - 4, 1)}" height="${Math.max(h - 1, 1)}" rx="1.5" fill="${legend[j]?.color}"/>` : ''
    })
    const tip = [`${days[i]}: ${fmt(day.reduce((a, b) => a + b, 0))}`, ...day.flatMap((v, j) => (v > 0 ? [`${legend[j]?.name}: ${fmt(v)}`] : []))]
    return `<g><title>${esc(tip.join('\n'))}</title>${parts.join('')}<rect x="${i * w}" y="0" width="${w}" height="${H}" fill="transparent"/></g>`
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${bars.join('')}</svg>`
}

// The band: one SVG row of columns for surfaces that draw it (the desktop's proportional font breaks text glyphs).
export type Col = { key: string; label: string; value: string; sub: string; pct?: number }
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
// shortcut: the image follows the system theme, not the app's; pass the theme in if they differ for someone
const STYLE = `.l,.s{fill:#87867f;font:12px ${FONT}}.v{fill:#1f1e1d;font:600 16px ${FONT}}.d{stroke:#1f1e1d;stroke-opacity:.12}.b{fill:#87867f}.t{fill:#1f1e1d;fill-opacity:.1}.p{fill:#7F77DD}@media (prefers-color-scheme:dark){.v{fill:#ecebe6}.d{stroke:#fff;stroke-opacity:.14}.t{fill:#fff;fill-opacity:.14}}`
const fit = (s: string, max: number) => (s.length > max ? `${s.slice(0, Math.max(1, max - 1))}…` : s)

export function bandSvg(cols: Col[], turnCosts: number[], width = 720): string {
  const height = 64
  const colW = width / Math.max(1, cols.length)
  const max = Math.max(...turnCosts, 0)
  let body = `<line class="d" x1="0" y1="0.5" x2="${width}" y2="0.5"/>`
  cols.forEach((c, i) => {
    const x = i * colW + (i === 0 ? 0 : 12)
    const right = (i + 1) * colW - 12
    if (i > 0) body += `<line class="d" x1="${i * colW}" y1="14" x2="${i * colW}" y2="${height - 2}"/>`
    body += `<text class="l" x="${x}" y="24">${esc(c.label)}</text>`
    body += `<text class="v" x="${x}" y="44">${esc(fit(c.value, Math.floor((colW - 16) / 9)))}</text>`
    if (c.sub) body += `<text class="s" x="${x}" y="61">${esc(fit(c.sub, Math.floor((colW - 16) / 6.2)))}</text>`
    if (c.pct !== undefined) {
      const x0 = x + 9 * c.value.length + 10
      const w = Math.max(0, right - x0)
      body += `<rect class="t" x="${x0}" y="35" width="${w}" height="6" rx="3"/>`
      body += `<rect class="p" x="${x0}" y="35" width="${(w * Math.min(100, Math.max(0, c.pct))) / 100}" height="6" rx="3"/>`
    }
    if (c.key === 'cost' && turnCosts.length > 1 && max > 0) {
      const bars = turnCosts.slice(-10)
      const x0 = right - bars.length * 5
      bars.forEach((v, j) => {
        const h = Math.max(1, Math.round((v / max) * 16))
        body += `<rect class="b" x="${x0 + j * 5}" y="${44 - h}" width="3" height="${h}" rx="1"/>`
      })
    }
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><style>${STYLE}</style>${body}</svg>`
}

// board.html: everything the store holds across sessions and folders, as one self-contained page.
export type Board = {
  now: number
  use: UseRow[]
  costs: { day: string; cwd: string; usd: number }[]
  models: { day: string; tier: string; tok: Tok }[]
  sessions: { cwd: string; startedAt: number; ms: number; tok: Tok; usd: number | null }[]
}

const CSS = `:root{--bg:#faf9f5;--card:#fff;--text:#1f1e1d;--muted:#87867f;--line:rgba(31,30,29,.1);--track:rgba(31,30,29,.07);--accent:#7F77DD;--up:#a86400;--down:#2e7d32}
@media (prefers-color-scheme:dark){:root{--bg:#1f1e1d;--card:#262624;--text:#ecebe6;--muted:#9c9a92;--line:rgba(255,255,255,.1);--track:rgba(255,255,255,.08);--up:#e3a03d;--down:#6abf69}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif}
main{max-width:1080px;margin:0 auto;padding:32px 16px 48px}
header{display:flex;align-items:baseline;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:24px}
h1{font-size:22px;margin:0;font-weight:650;letter-spacing:-.01em}h1 span{color:var(--accent)}h2{font-size:15px;margin:0 0 14px;font-weight:600}
.muted{color:var(--muted)}.num{font-variant-numeric:tabular-nums}
.grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));margin-bottom:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px 20px;margin-bottom:16px}.grid .card{margin:0}
.kpi .label{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.06em}.kpi .value{font-size:28px;font-weight:650;margin:4px 0 2px}
.kpi .sub{color:var(--muted);font-size:13px}.up{color:var(--up)}.down{color:var(--down)}
.chart svg{width:100%;height:auto;display:block}.axis{display:flex;justify-content:space-between;color:var(--muted);font-size:12px;margin-top:6px}
.legend{display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:12px;font-size:13px}.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px}
.two{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(320px,1fr))}.two .card{margin:0 0 16px}
.row{display:grid;grid-template-columns:110px 1fr 70px 44px;gap:10px;align-items:center;margin:8px 0}.row .bar{height:8px;border-radius:4px;background:var(--track);overflow:hidden}.row .bar i{display:block;height:100%;border-radius:4px}
.row b{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.row .num{text-align:right}
.scroll{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:13px}th{color:var(--muted);font-weight:500;text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:8px 10px;border-bottom:1px solid var(--line);white-space:nowrap}td.r,th.r{text-align:right}tr:last-child td{border-bottom:0}
.empty{color:var(--muted);padding:40px 0;text-align:center}`

const share = (rows: { name: string; color: string; value: number; label: string }[]) => {
  const max = Math.max(1e-9, ...rows.map(r => r.value))
  const total = Math.max(1e-9, rows.reduce((s, r) => s + r.value, 0))
  return rows
    .map(
      r =>
        `<div class="row"><b title="${esc(r.name)}"><span class="dot" style="background:${r.color}"></span>${esc(r.name)}</b><div class="bar"><i style="width:${((100 * r.value) / max).toFixed(1)}%;background:${r.color}"></i></div><span class="num">${r.label}</span><span class="num muted">${Math.round((100 * r.value) / total)}%</span></div>`,
    )
    .join('')
}

export function boardHtml(b: Board): string {
  const today = dayOf(b.now)
  const weekStart = weekStartOf(today)
  const monthStart = today.slice(0, 8) + '01'
  const tokWhere = (keep: (d: string) => boolean) => b.use.filter(r => keep(r.day)).reduce((s: Tok, r) => plus(s, r.tok), ZERO)
  const usdWhere = (keep: (d: string) => boolean) => b.costs.filter(r => keep(r.day)).reduce((s, r) => s + r.usd, 0)
  const prevWeek = sumOf(tokWhere(d => d >= shiftDay(weekStart, -7) && d <= shiftDay(today, -7)))
  const week = tokWhere(d => d >= weekStart)
  const change = prevWeek > 0 ? Math.round((100 * (sumOf(week) - prevWeek)) / prevWeek) : null

  const kpi = (label: string, t: Tok, cost: number, extra = '') =>
    `<div class="card kpi"><div class="label">${label}</div><div class="value num">${num(sumOf(t))}</div><div class="sub num">${usd(cost)} · ⚡ ${num(t.cacheRead)} kesh${extra}</div></div>`
  const changeNote = change === null ? '' : ` · <span class="${change > 0 ? 'up' : 'down'}">${change > 0 ? '+' : ''}${change}%</span>`

  const DAYS = 30
  const stack = dailyStack(b.use, today, DAYS, 5)
  const costPerDay = stack.days.map(d => [b.costs.filter(r => r.day === d).reduce((s, r) => s + r.usd, 0)])
  const axis = `<div class="axis"><span>${stack.from.slice(5)}</span><span>${today.slice(5)}</span></div>`

  const from = stack.from
  const models = totalsBy(b.models.filter(r => r.day >= from), r => r.tier, r => r.tok)
  const folders = totalsBy(b.use.filter(r => r.day >= from), r => r.cwd, r => r.tok)
  const folderUsd = (cwd: string) => b.costs.filter(r => r.day >= from && r.cwd === cwd).reduce((s, r) => s + r.usd, 0)
  const sessions = [...b.sessions].sort((x, y) => y.startedAt - x.startedAt).slice(0, 30)

  const body =
    b.use.length === 0 && b.costs.length === 0
      ? '<div class="card empty">Hali token yozilmadi. Bir nechta so‘rovdan keyin board to‘ladi.</div>'
      : `<div class="grid">${kpi('Bugun', tokWhere(d => d === today), usdWhere(d => d === today))}${kpi('Shu hafta', week, usdWhere(d => d >= weekStart), changeNote)}${kpi('Shu oy', tokWhere(d => d >= monthStart), usdWhere(d => d >= monthStart))}</div>
<div class="card chart"><h2>Tokenlar, so‘nggi ${DAYS} kun</h2>${chartSvg(stack.days, stack.perDay, stack.legend, 960, 180)}${axis}
<div class="legend">${stack.legend.map(l => `<span><span class="dot" style="background:${l.color}"></span>${esc(l.name)} <span class="muted num">${num(l.tok)}</span></span>`).join('')}</div></div>
<div class="card chart"><h2>Narx, so‘nggi ${DAYS} kun <span class="muted num">${usd(costPerDay.reduce((s, [v]) => s + (v ?? 0), 0))}</span></h2>${chartSvg(stack.days, costPerDay, [{ name: 'narx', color: '#7F77DD' }], 960, 120, v => usd(v))}${axis}</div>
<div class="two"><div class="card"><h2>Modellar bo‘yicha</h2>${models.length === 0 ? '<div class="muted">Model bo‘yicha yozuv hali yo‘q.</div>' : share(models.map(([tier, t]) => ({ name: TIER_LABEL[tier] ?? tier, color: TIER_COLORS[tier] ?? OTHER_COLOR, value: sumOf(t), label: num(sumOf(t)) })))}</div>
<div class="card"><h2>Papkalar bo‘yicha</h2>${share(folders.slice(0, 8).map(([cwd, t], i) => ({ name: folderName(cwd), color: ENV_COLORS[i] ?? OTHER_COLOR, value: sumOf(t), label: num(sumOf(t)) })))}</div></div>
<div class="card"><h2>Papkalar</h2><div class="scroll"><table><tr><th>Papka</th><th class="r">Tokenlar</th><th class="r">Chiqish</th><th class="r">Kesh</th><th class="r">Narx</th></tr>${folders.map(([cwd, t]) => `<tr><td title="${esc(cwd)}">${esc(folderName(cwd))}</td><td class="r num">${num(sumOf(t))}</td><td class="r num">${num(t.output)}</td><td class="r num">${num(t.cacheRead)}</td><td class="r num">${usd(folderUsd(cwd))}</td></tr>`).join('')}</table></div></div>
${sessions.length === 0 ? '' : `<div class="card"><h2>So‘nggi sessiyalar</h2><div class="scroll"><table><tr><th>Boshlangan</th><th>Papka</th><th class="r">Vaqt</th><th class="r">Tokenlar</th><th class="r">Kesh</th><th class="r">Narx</th></tr>${sessions.map(s => `<tr><td class="num">${dayOf(s.startedAt)} ${new Date(s.startedAt).toTimeString().slice(0, 5)}</td><td title="${esc(s.cwd)}">${esc(folderName(s.cwd))}</td><td class="r num">${fmtTime(s.ms)}</td><td class="r num">${num(sumOf(s.tok))}</td><td class="r num">${num(s.tok.cacheRead)}</td><td class="r num">${usd(s.usd)}</td></tr>`).join('')}</table></div></div>`}`

  return `<!doctype html><html lang="uz"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Smart router board</title><style>${CSS}</style></head>
<body><main><header><h1><span>●</span> Smart router</h1><span class="muted num">Yangilandi: ${today} ${new Date(b.now).toTimeString().slice(0, 5)} · Tokenlar = kirish + kesh yozish + chiqish</span></header>
${body}</main></body></html>`
}
