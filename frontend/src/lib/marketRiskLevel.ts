import type { StatusTone } from './colorTokens'

// Market risk levels are decided server-side (KV trading:risk_config cuts); the UI only maps a level to style.
export type MarketRiskLevel = 'green' | 'yellow' | 'orange' | 'red' | 'black'

// A risk level is a status, not a price move: it uses the ok/warn/fail tokens plus a shape (tone → StatusIcon),
// never the red/green up/down palette. Level names stay the KV level ids.
export const MARKET_RISK_LEVEL_STYLE: Record<MarketRiskLevel, { label: string; color: string; border: string; bg: string; tone: StatusTone }> = {
  green: { label: '貪婪', color: 'text-ok', border: 'border-ok/30', bg: 'bg-ok/10', tone: 'ok' },
  yellow: { label: '中性', color: 'text-warn', border: 'border-warn/25', bg: 'bg-warn/[0.06]', tone: 'warn' },
  orange: { label: '偏熱', color: 'text-warn', border: 'border-warn/45', bg: 'bg-warn/15', tone: 'warn' },
  red: { label: '恐慌', color: 'text-fail', border: 'border-fail/35', bg: 'bg-fail/10', tone: 'fail' },
  black: { label: '極度恐慌', color: 'text-fail', border: 'border-fail/60', bg: 'bg-fail/20', tone: 'fail' },
}

export const UNKNOWN_MARKET_RISK_STYLE: { label: string; color: string; border: string; bg: string; tone: StatusTone } = {
  label: '待接資料', color: 'text-muted-foreground', border: 'border-slate-500/30', bg: 'bg-slate-500/[0.06]', tone: 'na',
}

// Stored history may still carry the retired low/medium/high/extreme vocabulary; regime words are not levels here.
const LEGACY_LEVELS: Record<string, MarketRiskLevel> = {
  low: 'green', medium: 'yellow', high: 'orange', very_high: 'red', extreme: 'black', halt: 'black', closed: 'black',
}

export function normalizeMarketRiskLevel(value: unknown): MarketRiskLevel | null {
  const raw = String(value ?? '').trim().toLowerCase()
  if (raw in MARKET_RISK_LEVEL_STYLE) return raw as MarketRiskLevel
  return LEGACY_LEVELS[raw] ?? null
}

export function marketRiskLevelStyle(value: unknown) {
  const level = normalizeMarketRiskLevel(value)
  return level ? MARKET_RISK_LEVEL_STYLE[level] : UNKNOWN_MARKET_RISK_STYLE
}

export interface TradingMarketRisk {
  status: 'ready' | 'blocked' | 'awaiting_next_session' | 'missing'
  level: MarketRiskLevel | null
  score: number | null
  date: string | null
  label: string
  style: typeof UNKNOWN_MARKET_RISK_STYLE
  haltNewBuys: boolean
  blockers: string[]
}

function finiteOrNull(value: unknown): number | null {
  if (value == null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** The level Paper buys/halts use, from GET /market/risk `runtimeRisk` (never the factor packet level). */
export function tradingMarketRisk(payload: any): TradingMarketRisk {
  const runtime = payload?.runtimeRisk
  const status = runtime?.status
  const blockers = Array.isArray(runtime?.blockers) ? runtime.blockers.map(String) : []
  const date = typeof runtime?.date === 'string' ? runtime.date : null
  if (status === 'awaiting_next_session') {
    return { status, level: null, score: null, date, label: '待下一交易日計算', style: UNKNOWN_MARKET_RISK_STYLE, haltNewBuys: false, blockers }
  }
  const level = normalizeMarketRiskLevel(runtime?.level)
  if ((status !== 'ready' && status !== 'blocked') || !level) {
    return { status: 'missing', level: null, score: null, date, label: UNKNOWN_MARKET_RISK_STYLE.label, style: UNKNOWN_MARKET_RISK_STYLE, haltNewBuys: false, blockers }
  }
  const style = MARKET_RISK_LEVEL_STYLE[level]
  return {
    status,
    level,
    score: finiteOrNull(runtime.score),
    date,
    label: status === 'blocked' ? '資料阻擋 · 停止新買' : style.label,
    style,
    haltNewBuys: runtime.haltNewBuys === true,
    blockers,
  }
}

/** Shield icon for a trading level: unknown or awaiting is neutral, never the "safe" check. */
export function marketRiskShield(view: TradingMarketRisk): 'alert' | 'check' | 'neutral' {
  if (view.level == null) return 'neutral'
  if (view.haltNewBuys || view.status === 'blocked' || view.level === 'red' || view.level === 'black') return 'alert'
  return 'check'
}
