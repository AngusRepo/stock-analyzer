import type { RiskConfig } from './riskConfig'
import type { MarketRegimeState } from './marketRegimeState'
import { readMarketRegimeState } from './marketRegimeState'
import type { MarketRegimeFactorPacket } from './marketRegimeFactorPacket'
import { loadMarketRegimeFactorPacket } from './marketRegimeFactorPacket'

export type CanonicalMarketRiskLevel = 'green' | 'yellow' | 'orange' | 'red' | 'black'

export interface CanonicalMarketRiskContext {
  status: 'ready' | 'blocked'
  date: string | null
  level: CanonicalMarketRiskLevel
  score: number | null
  targetExposureCap: number | null
  deRiskExistingPositions: boolean
  haltNewBuys: boolean
  dailyChangePct: number | null
  advanceRatio: number | null
  bullAlignmentRatio: number | null
  regimeFamily: string | null
  factorPacketLevel: CanonicalMarketRiskLevel | null
  storedRiskLevel: CanonicalMarketRiskLevel | null
  breadthLevel: CanonicalMarketRiskLevel | null
  shockLevel: CanonicalMarketRiskLevel | null
  reasons: string[]
  blockers: string[]
  lineage: {
    owner: 'canonical_market_risk_runtime_v1'
    factorPacketDate: string | null
    marketRiskDate: string | null
    breadthDate: string | null
    regimeDate: string | null
  }
}

interface MarketRiskRow {
  date?: unknown
  twii_close?: unknown
  risk_score?: unknown
  risk_level?: unknown
}

interface MarketBreadthRow {
  date?: unknown
  advance_ratio?: unknown
  bull_alignment_pct?: unknown
}

export interface CanonicalMarketRiskInputs {
  marketRiskRows: MarketRiskRow[]
  factorPacket: MarketRegimeFactorPacket | null
  breadth: MarketBreadthRow | null
  regimeState: MarketRegimeState | null
  policy: RiskConfig['portfolio']
}

export interface CanonicalMarketRiskDatabases {
  core: D1Database
  market: D1Database
}

const LEVEL_RANK: Record<CanonicalMarketRiskLevel, number> = {
  green: 0,
  yellow: 1,
  orange: 2,
  red: 3,
  black: 4,
}

function finiteNumber(value: unknown): number | null {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function normalizeRatio(value: unknown): number | null {
  const parsed = finiteNumber(value)
  if (parsed == null || parsed < 0) return null
  return parsed > 1 ? parsed / 100 : parsed
}

export function normalizeCanonicalMarketRiskLevel(value: unknown): CanonicalMarketRiskLevel | null {
  const level = String(value ?? '').trim().toLowerCase()
  if (['black', 'halt', 'closed', 'extreme'].includes(level)) return 'black'
  if (['red', 'very_high', 'bear', 'bear_market'].includes(level)) return 'red'
  if (['orange', 'high', 'volatile'].includes(level)) return 'orange'
  if (['yellow', 'medium', 'sideways', 'neutral', 'normal'].includes(level)) return 'yellow'
  if (['green', 'low', 'bull', 'bull_market', 'constructive'].includes(level)) return 'green'
  return null
}

function maxLevel(levels: Array<CanonicalMarketRiskLevel | null>): CanonicalMarketRiskLevel {
  return levels.reduce<CanonicalMarketRiskLevel>((highest, current) => (
    current && LEVEL_RANK[current] > LEVEL_RANK[highest] ? current : highest
  ), 'green')
}

function targetExposureCap(level: CanonicalMarketRiskLevel, policy: RiskConfig['portfolio']): number {
  if (level === 'black') return policy.blackTargetExposure
  if (level === 'red') return policy.redTargetExposure
  if (level === 'orange') return policy.orangeTargetExposure
  if (level === 'yellow') return policy.yellowTargetExposure
  return policy.greenTargetExposure
}

function marketShockLevel(changePct: number | null, policy: RiskConfig['portfolio']): CanonicalMarketRiskLevel | null {
  if (changePct == null) return null
  const change = changePct / 100
  if (change <= policy.marketShockBlackPct) return 'black'
  if (change <= policy.marketShockRedPct) return 'red'
  if (change <= policy.marketShockOrangePct) return 'orange'
  return null
}

function marketBreadthLevel(advanceRatio: number | null, policy: RiskConfig['portfolio']): CanonicalMarketRiskLevel | null {
  if (advanceRatio == null) return null
  if (advanceRatio <= policy.breadthBlackAdvanceRatio) return 'black'
  if (advanceRatio <= policy.breadthRedAdvanceRatio) return 'red'
  if (advanceRatio <= policy.breadthOrangeAdvanceRatio) return 'orange'
  return null
}

function regimeRiskLevel(regimeState: MarketRegimeState | null): CanonicalMarketRiskLevel | null {
  if (regimeState?.family === 'bear') return 'red'
  if (regimeState?.family === 'volatile') return 'orange'
  if (regimeState?.family === 'sideways') return 'yellow'
  if (regimeState?.family === 'bull') return 'green'
  return null
}

export function buildCanonicalMarketRiskContext(input: CanonicalMarketRiskInputs): CanonicalMarketRiskContext {
  const rows = [...input.marketRiskRows]
    .filter((row) => String(row.date ?? '').trim())
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
  const latest = rows[0] ?? null
  const previous = rows[1] ?? null
  const marketRiskDate = latest ? String(latest.date) : null
  const factorPacketDate = input.factorPacket?.date ?? null
  const breadthDate = input.breadth?.date ? String(input.breadth.date) : null
  const regimeDate = input.regimeState?.run_date ?? null
  const blockers: string[] = []

  if (!latest) blockers.push('market_risk_missing')
  if (!previous) blockers.push('market_risk_previous_close_missing')
  if (!input.factorPacket) blockers.push('market_regime_factor_packet_missing')
  if (!input.breadth) blockers.push('market_breadth_missing')
  if (!input.regimeState) blockers.push('market_regime_state_missing')
  if (marketRiskDate && factorPacketDate !== marketRiskDate) blockers.push('factor_packet_date_mismatch')
  if (marketRiskDate && breadthDate !== marketRiskDate) blockers.push('market_breadth_date_mismatch')
  if (marketRiskDate && regimeDate !== marketRiskDate) blockers.push('market_regime_date_mismatch')

  const currentClose = finiteNumber(latest?.twii_close)
  const previousClose = finiteNumber(previous?.twii_close)
  if (currentClose == null || currentClose <= 0) blockers.push('market_risk_twii_close_missing')
  if (previousClose == null || previousClose <= 0) blockers.push('market_risk_previous_twii_close_missing')
  const advanceRatio = normalizeRatio(input.breadth?.advance_ratio)
  const bullAlignmentRatio = normalizeRatio(input.breadth?.bull_alignment_pct)
  if (advanceRatio == null) blockers.push('market_breadth_advance_ratio_missing')

  const dailyChangePct = currentClose != null && previousClose != null && previousClose > 0
    ? ((currentClose / previousClose) - 1) * 100
    : null
  const factorPacketLevel = normalizeCanonicalMarketRiskLevel(input.factorPacket?.level)
  const storedRiskLevel = normalizeCanonicalMarketRiskLevel(latest?.risk_level)
  const shockLevel = marketShockLevel(dailyChangePct, input.policy)
  const breadthLevel = marketBreadthLevel(advanceRatio, input.policy)
  const regimeLevel = regimeRiskLevel(input.regimeState)
  const level = maxLevel([factorPacketLevel, storedRiskLevel, shockLevel, breadthLevel, regimeLevel])
  const packetScore = finiteNumber(input.factorPacket?.score)
  const storedScore = finiteNumber(latest?.risk_score)
  const score = packetScore == null ? storedScore : storedScore == null ? packetScore : Math.max(packetScore, storedScore)
  const reasons = [
    factorPacketLevel ? `factor_packet=${factorPacketLevel}:${packetScore ?? 'na'}` : null,
    storedRiskLevel ? `stored_risk=${storedRiskLevel}:${storedScore ?? 'na'}` : null,
    shockLevel ? `market_shock=${shockLevel}:return_1d=${dailyChangePct?.toFixed(2)}%` : null,
    breadthLevel ? `market_breadth=${breadthLevel}:advance_ratio=${advanceRatio?.toFixed(4)}` : null,
    regimeLevel ? `regime=${regimeLevel}:${input.regimeState?.family ?? 'unknown'}` : null,
  ].filter((reason): reason is string => Boolean(reason))
  const status = blockers.length === 0 ? 'ready' : 'blocked'

  return {
    status,
    date: marketRiskDate,
    level: status === 'ready' ? level : 'black',
    score: status === 'ready' ? score : null,
    targetExposureCap: status === 'ready' ? targetExposureCap(level, input.policy) : null,
    deRiskExistingPositions: status === 'ready' && LEVEL_RANK[level] >= LEVEL_RANK.orange,
    haltNewBuys: status === 'blocked' || level === 'black',
    dailyChangePct,
    advanceRatio,
    bullAlignmentRatio,
    regimeFamily: input.regimeState?.family ?? null,
    factorPacketLevel,
    storedRiskLevel,
    breadthLevel,
    shockLevel,
    reasons,
    blockers: [...new Set(blockers)],
    lineage: {
      owner: 'canonical_market_risk_runtime_v1',
      factorPacketDate,
      marketRiskDate,
      breadthDate,
      regimeDate,
    },
  }
}

export async function resolveCanonicalMarketRisk(
  databases: CanonicalMarketRiskDatabases,
  kv: KVNamespace | undefined,
  riskConfig: RiskConfig,
): Promise<CanonicalMarketRiskContext> {
  if (!kv) {
    return buildCanonicalMarketRiskContext({
      marketRiskRows: [],
      factorPacket: null,
      breadth: null,
      regimeState: null,
      policy: riskConfig.portfolio,
    })
  }
  try {
    const [{ results: marketRiskRows }, factorPacket, breadth, regimeState] = await Promise.all([
      databases.core.prepare(
        'SELECT date, twii_close, risk_score, risk_level FROM market_risk ORDER BY date DESC LIMIT 2',
      ).all<MarketRiskRow>(),
      loadMarketRegimeFactorPacket(databases.market).catch(() => null),
      databases.market.prepare(
        'SELECT date, advance_ratio, bull_alignment_pct FROM market_breadth ORDER BY date DESC LIMIT 1',
      ).first<MarketBreadthRow>().catch(() => null),
      readMarketRegimeState(kv).catch(() => null),
    ])
    return buildCanonicalMarketRiskContext({
      marketRiskRows: marketRiskRows ?? [],
      factorPacket,
      breadth,
      regimeState,
      policy: riskConfig.portfolio,
    })
  } catch (error) {
    const blocked = buildCanonicalMarketRiskContext({
      marketRiskRows: [],
      factorPacket: null,
      breadth: null,
      regimeState: null,
      policy: riskConfig.portfolio,
    })
    blocked.blockers.push(`canonical_market_risk_read_error:${error instanceof Error ? error.message : String(error)}`)
    return blocked
  }
}
