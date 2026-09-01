import type { Bindings } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'

const RESIDUAL_STAGE = 'pit_residual_momentum_shadow'
const MAX_SYMBOLS = 30

export interface PitFactorFunnelPoint {
  date: string
  symbol: string
  name: string
  industry: string
  rankDelta: number
  candidateCount: number
  residualRank: number | null
  breadthRank: number | null
  flowRank: number | null
  confirmationRank: number | null
}

export interface PitFactorFlowMapQuery {
  requestedDate: string
  days: number
  symbols: string[]
  includeMovers: number
}

function finite(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function unit(value: unknown): number | null {
  const parsed = finite(value)
  return parsed == null ? null : Math.max(0, Math.min(1, parsed))
}

function safeJson(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object') return value as Record<string, unknown>
  if (typeof value !== 'string' || !value.trim()) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function average(values: Array<number | null>): number | null {
  const valid = values.filter((value): value is number => value != null && Number.isFinite(value))
  return valid.length ? valid.reduce((total, value) => total + value, 0) / valid.length : null
}

function parseFunnelRows(rows: Array<Record<string, unknown>>): PitFactorFunnelPoint[] {
  const points: PitFactorFunnelPoint[] = []
  for (const row of rows) {
    const evidence = safeJson(row.evidence)
    const symbol = String(row.symbol || '').trim()
    const date = String(row.date || '').trim()
    const industry = String(evidence.industry || '').trim()
    const rankDelta = finite(evidence.rankDelta)
    const candidateCount = Math.max(1, Math.floor(finite(row.candidate_count) ?? 1))
    if (!symbol || !date || !industry || rankDelta == null) continue
    points.push({
      date,
      symbol,
      name: String(row.name || symbol),
      industry,
      rankDelta,
      candidateCount,
      residualRank: unit(evidence.residualMomentumRank),
      breadthRank: unit(evidence.breadthRank),
      flowRank: unit(evidence.flowDiffusionRank),
      confirmationRank: unit(evidence.diagnosticConfirmationRank),
    })
  }
  return points
}

async function loadFunnelPoints(env: Bindings, requestedDate: string, days: number): Promise<PitFactorFunnelPoint[]> {
  const opsDb = databaseForDataDomain(env, 'ops')
  const { results } = await opsDb.prepare(
    `WITH canonical_runs AS (
       SELECT r.run_id, r.date, r.candidate_count
         FROM screener_funnel_runs r
         JOIN canonical_run_heads h
           ON h.run_id=r.run_id
          AND h.logical_run_key='screener:' || r.date || ':TW:production:market_screener'
        WHERE r.date <= ?
          AND r.status = 'success'
          AND EXISTS (
            SELECT 1 FROM screener_funnel_items x
             WHERE x.run_id = r.run_id AND x.stage = ?
          )
        ORDER BY date DESC
        LIMIT ?
     )
     SELECT i.date, i.symbol, i.name, i.evidence, r.candidate_count
       FROM canonical_runs r
       JOIN screener_funnel_items i ON i.run_id = r.run_id
      WHERE i.stage = ?
      ORDER BY i.date ASC, i.id ASC`,
  ).bind(requestedDate, RESIDUAL_STAGE, days, RESIDUAL_STAGE).all<Record<string, unknown>>()
  return parseFunnelRows(results ?? [])
}

export function buildPitFactorGroupSeries(points: PitFactorFunnelPoint[]) {
  const buckets = new Map<string, PitFactorFunnelPoint[]>()
  for (const point of points) {
    const key = `${point.date}\u0000${point.industry}`
    const bucket = buckets.get(key) ?? []
    bucket.push(point)
    buckets.set(key, bucket)
  }

  const byIndustry = new Map<string, Array<Record<string, unknown>>>()
  for (const [key, bucket] of buckets) {
    const [date, industry] = key.split('\u0000')
    const normalizedDeltas = bucket.map((point) =>
      point.rankDelta / Math.max(1, point.candidateCount - 1),
    )
    const tilt = average(normalizedDeltas) ?? 0
    const confirmation = average(bucket.map((point) => point.confirmationRank))
    const flow = average(bucket.map((point) => point.flowRank))
    const series = byIndustry.get(industry) ?? []
    series.push({
      date,
      x: 50 + (50 * Math.max(-1, Math.min(1, tilt))),
      y: confirmation == null ? null : confirmation * 100,
      flow: flow == null ? null : flow * 100,
      breadth: (average(bucket.map((point) => point.breadthRank)) ?? 0) * 100,
      member_count: bucket.length,
      mean_rank_delta: average(bucket.map((point) => point.rankDelta)) ?? 0,
    })
    byIndustry.set(industry, series)
  }

  const sortedDates = [...new Set(points.map((point) => point.date))].sort()
  const latestDate = sortedDates[sortedDates.length - 1] ?? null
  return [...byIndustry.entries()]
    .map(([industry, series]) => ({
      key: industry,
      label: industry,
      points: series.sort((left, right) => String(left.date).localeCompare(String(right.date))),
    }))
    .filter((series) => series.points.some((point) => point.y != null))
    .sort((left, right) => {
      const leftLatest = left.points.find((point) => point.date === latestDate) ?? left.points[left.points.length - 1]
      const rightLatest = right.points.find((point) => point.date === latestDate) ?? right.points[right.points.length - 1]
      const leftSignal = Math.abs(Number(leftLatest?.x ?? 50) - 50) + Math.abs(Number(leftLatest?.y ?? 50) - 50)
      const rightSignal = Math.abs(Number(rightLatest?.x ?? 50) - 50) + Math.abs(Number(rightLatest?.y ?? 50) - 50)
      return rightSignal - leftSignal || left.label.localeCompare(right.label)
    })
}

export function selectPitFactorStockSymbols(points: PitFactorFunnelPoint[], requested: string[], includeMovers: number): string[] {
  const sortedDates = [...new Set(points.map((point) => point.date))].sort()
  const latestDate = sortedDates[sortedDates.length - 1]
  const movers = points
    .filter((point) => point.date === latestDate)
    .sort((left, right) => Math.abs(right.rankDelta) - Math.abs(left.rankDelta) || left.symbol.localeCompare(right.symbol))
    .slice(0, includeMovers)
    .map((point) => point.symbol)
  return [...new Set([...requested, ...movers])].slice(0, MAX_SYMBOLS)
}

async function loadStockSeries(
  env: Bindings,
  requestedDate: string,
  days: number,
  symbols: string[],
  requestedSymbols: string[],
  funnelPoints: PitFactorFunnelPoint[],
) {
  if (!symbols.length) return []
  if (!env.LEARNING_DB) throw new Error('pit_residual_learning_db_binding_required')
  const placeholders = symbols.map(() => '?').join(',')
  const { results } = await env.LEARNING_DB.prepare(
    `WITH recent_dates AS (
       SELECT DISTINCT signal_date
         FROM pit_factor_shadow_daily_v1
        WHERE signal_date <= ?
          AND decision_effect = 'none'
        ORDER BY signal_date DESC
        LIMIT ?
     )
     SELECT signal_date, symbol, industry, residual_momentum_rank,
            breadth_rank, flow_diffusion_rank, research_base_score,
            research_shadow_score, factor_contract_version
       FROM pit_factor_shadow_daily_v1
      WHERE signal_date IN (SELECT signal_date FROM recent_dates)
        AND symbol IN (${placeholders})
        AND residual_weight = 0.10
        AND primary_horizon_sessions = 10
        AND decision_effect = 'none'
      ORDER BY signal_date ASC, symbol ASC`,
  ).bind(requestedDate, days, ...symbols).all<Record<string, unknown>>()

  const coreDb = env.CORE_DB ?? env.DB
  const { results: stockRows } = await coreDb.prepare(
    `SELECT symbol, name FROM stocks WHERE symbol IN (${placeholders})`,
  ).bind(...symbols).all<{ symbol: string; name: string | null }>()
  const names = new Map((stockRows ?? []).map((row) => [String(row.symbol), String(row.name || row.symbol)]))
  const requested = new Set(requestedSymbols)
  const rankDelta = new Map(funnelPoints.map((point) => [`${point.date}\u0000${point.symbol}`, point.rankDelta]))
  const bySymbol = new Map<string, Array<Record<string, unknown>>>()
  for (const row of results ?? []) {
    const symbol = String(row.symbol || '').trim()
    const residual = unit(row.residual_momentum_rank)
    const breadth = unit(row.breadth_rank)
    const flow = unit(row.flow_diffusion_rank)
    if (!symbol || residual == null) continue
    const date = String(row.signal_date || '')
    const confirmation = average([breadth, flow])
    const series = bySymbol.get(symbol) ?? []
    series.push({
      date,
      x: residual * 100,
      y: confirmation == null ? null : confirmation * 100,
      breadth: breadth == null ? null : breadth * 100,
      flow: flow == null ? null : flow * 100,
      rank_delta: rankDelta.get(`${date}\u0000${symbol}`) ?? null,
      research_delta: (finite(row.research_shadow_score) ?? 0) - (finite(row.research_base_score) ?? 0),
    })
    bySymbol.set(symbol, series)
  }
  return [...bySymbol.entries()].map(([symbol, series]) => ({
    key: symbol,
    symbol,
    label: names.get(symbol) ?? symbol,
    industry: String((results ?? []).find((row) => String(row.symbol) === symbol)?.industry || '未分類'),
    requested: requested.has(symbol),
    points: series,
  }))
}

export async function loadPitFactorFlowMap(env: Bindings, query: PitFactorFlowMapQuery) {
  const days = Math.max(2, Math.min(60, Math.floor(query.days)))
  const requestedSymbols = [...new Set(query.symbols.map((symbol) => symbol.trim()).filter(Boolean))].slice(0, MAX_SYMBOLS)
  const funnelPoints = await loadFunnelPoints(env, query.requestedDate, days)
  const stockSymbols = selectPitFactorStockSymbols(funnelPoints, requestedSymbols, Math.max(0, Math.min(12, query.includeMovers)))
  const stockSeries = await loadStockSeries(
    env,
    query.requestedDate,
    days,
    stockSymbols,
    requestedSymbols,
    funnelPoints,
  )
  const dates = [...new Set(funnelPoints.map((point) => point.date))].sort()
  return {
    requested_date: query.requestedDate,
    date: dates[dates.length - 1] ?? null,
    session_count: dates.length,
    requested_sessions: days,
    group_series: buildPitFactorGroupSeries(funnelPoints),
    stock_series: stockSeries,
    governance: {
      candidate: 'pit_residual_momentum_w10',
      phase: 'prospective_shadow',
      taxonomy_layer: 'industry',
      available_taxonomy_layers: ['industry', 'industry_theme', 'subindustry', 'theme'],
      weight: 0.10,
      primary_horizon_sessions: 10,
      x_axis: 'residual_counterfactual_rank_tilt',
      y_axis: 'breadth_flow_confirmation',
      auxiliary_authority: 'diagnostic_only',
      decision_effect: 'none',
      candidate_set_mutation_allowed: false,
      debate_visibility: false,
      sizing_authority: false,
      order_authority: false,
    },
  }
}
