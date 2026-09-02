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
  layer?: PitFactorGroupLayer
  parentLayer?: 'industry'
  parent?: string
}

export type PitFactorGroupLayer = 'industry' | 'industry_theme'

export interface PitFactorTaxonomyMembership {
  date: string
  symbol: string
  tag: string
}

interface PitFactorGroupedPoint extends PitFactorFunnelPoint {
  group: string
  attributionWeight: number
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

function weightedAverage(
  rows: PitFactorGroupedPoint[],
  value: (row: PitFactorGroupedPoint) => number | null,
): number | null {
  let numerator = 0
  let denominator = 0
  for (const row of rows) {
    const candidate = value(row)
    if (candidate == null || !Number.isFinite(candidate)) continue
    const weight = Math.max(0, finite(row.attributionWeight) ?? 0)
    if (weight <= 0) continue
    numerator += candidate * weight
    denominator += weight
  }
  return denominator > 0 ? numerator / denominator : null
}

function percentilePosition(value: number, sortedAsc: number[]): number {
  if (sortedAsc.length <= 1) return 50
  let lower = 0
  while (lower < sortedAsc.length && sortedAsc[lower] < value) lower += 1
  let upper = lower
  while (upper < sortedAsc.length && sortedAsc[upper] <= value) upper += 1
  const midpoint = (lower + Math.max(lower, upper - 1)) / 2
  return ((midpoint + 0.5) / sortedAsc.length) * 100
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

function buildPitFactorSeries(points: PitFactorGroupedPoint[]) {
  const buckets = new Map<string, PitFactorGroupedPoint[]>()
  for (const point of points) {
    const key = `${point.date}\u0000${point.group}`
    const bucket = buckets.get(key) ?? []
    bucket.push(point)
    buckets.set(key, bucket)
  }

  const aggregates: Array<{
    date: string
    industry: string
    tilt: number
    confirmation: number | null
    flow: number | null
    breadth: number
    memberCount: number
    meanRankDelta: number
  }> = []
  for (const [key, bucket] of buckets) {
    const [date, industry] = key.split('\u0000')
    const tilt = weightedAverage(
      bucket,
      (point) => point.rankDelta / Math.max(1, point.candidateCount - 1),
    ) ?? 0
    const confirmation = weightedAverage(bucket, (point) => point.confirmationRank)
    const flow = weightedAverage(bucket, (point) => point.flowRank)
    aggregates.push({
      date,
      industry,
      tilt,
      confirmation,
      flow,
      breadth: weightedAverage(bucket, (point) => point.breadthRank) ?? 0,
      memberCount: new Set(bucket.map((point) => point.symbol)).size,
      meanRankDelta: weightedAverage(bucket, (point) => point.rankDelta) ?? 0,
    })
  }

  const tiltsByDate = new Map<string, number[]>()
  for (const row of aggregates) {
    const values = tiltsByDate.get(row.date) ?? []
    values.push(row.tilt)
    tiltsByDate.set(row.date, values)
  }
  for (const values of tiltsByDate.values()) values.sort((left, right) => left - right)

  const byIndustry = new Map<string, Array<Record<string, unknown>>>()
  for (const row of aggregates) {
    const series = byIndustry.get(row.industry) ?? []
    series.push({
      date: row.date,
      x: percentilePosition(row.tilt, tiltsByDate.get(row.date) ?? []),
      raw_tilt: row.tilt,
      y: row.confirmation == null ? null : row.confirmation * 100,
      flow: row.flow == null ? null : row.flow * 100,
      breadth: row.breadth * 100,
      member_count: row.memberCount,
      mean_rank_delta: row.meanRankDelta,
    })
    byIndustry.set(row.industry, series)
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

export function buildPitFactorGroupSeries(points: PitFactorFunnelPoint[]) {
  return buildPitFactorSeries(points.map((point) => ({
    ...point,
    group: point.industry,
    attributionWeight: 1,
  })))
}

export function buildPitFactorIndustryThemeSeries(
  points: PitFactorFunnelPoint[],
  memberships: PitFactorTaxonomyMembership[],
  parentIndustry?: string | null,
) {
  const tagsByPoint = new Map<string, Set<string>>()
  for (const membership of memberships) {
    const date = String(membership.date || '').trim()
    const symbol = String(membership.symbol || '').trim()
    const tag = String(membership.tag || '').trim()
    if (!date || !symbol || !tag) continue
    const key = `${date}\u0000${symbol}`
    const tags = tagsByPoint.get(key) ?? new Set<string>()
    tags.add(tag)
    tagsByPoint.set(key, tags)
  }
  const grouped: PitFactorGroupedPoint[] = []
  for (const point of points) {
    if (parentIndustry && point.industry !== parentIndustry) continue
    const tags = [...(tagsByPoint.get(`${point.date}\u0000${point.symbol}`) ?? [])].sort()
    if (!tags.length) continue
    const attributionWeight = 1 / tags.length
    for (const tag of tags) grouped.push({ ...point, group: tag, attributionWeight })
  }
  return buildPitFactorSeries(grouped)
}

async function loadPitFactorTaxonomyMemberships(
  env: Bindings,
  dates: string[],
  symbols: string[],
  tagType: 'industry_theme',
): Promise<PitFactorTaxonomyMembership[]> {
  const uniqueDates = [...new Set(dates.filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)))].sort()
  const uniqueSymbols = [...new Set(symbols.map((symbol) => symbol.trim()).filter(Boolean))]
  if (!uniqueDates.length || !uniqueSymbols.length) return []
  const marketDb = databaseForDataDomain(env, 'market')
  const dateValues = uniqueDates.map(() => '(?)').join(',')
  const memberships: PitFactorTaxonomyMembership[] = []
  for (let index = 0; index < uniqueSymbols.length; index += 80) {
    const chunk = uniqueSymbols.slice(index, index + 80)
    const symbolPlaceholders = chunk.map(() => '?').join(',')
    const { results } = await marketDb.prepare(`
      WITH requested_dates(signal_date) AS (VALUES ${dateValues}),
      resolved_snapshots AS (
        SELECT requested_dates.signal_date,
               MAX(snapshot_runs.snapshot_date) AS snapshot_date
          FROM requested_dates
          JOIN sector_taxonomy_snapshot_runs_v1 snapshot_runs
            ON snapshot_runs.tag_type=?
           AND snapshot_runs.status='ready'
           AND snapshot_runs.snapshot_date<=requested_dates.signal_date
         GROUP BY requested_dates.signal_date
      )
      SELECT resolved.signal_date AS date, membership.symbol, membership.tag
        FROM resolved_snapshots resolved
        JOIN sector_taxonomy_membership_snapshots_v1 membership
          ON membership.snapshot_date=resolved.snapshot_date
         AND membership.tag_type=?
       WHERE membership.symbol IN (${symbolPlaceholders})
       ORDER BY resolved.signal_date, membership.symbol, membership.tag
    `).bind(...uniqueDates, tagType, tagType, ...chunk).all<PitFactorTaxonomyMembership>()
    memberships.push(...(results ?? []))
  }
  return memberships
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
  const layer = query.layer ?? 'industry'
  const parent = String(query.parent ?? '').trim()
  if (
    layer === 'industry_theme'
    && ((parent && query.parentLayer !== 'industry') || (!parent && query.parentLayer))
  ) {
    throw new Error('pit_factor_industry_theme_parent_invalid')
  }
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
  const groupSeries = layer === 'industry'
    ? buildPitFactorGroupSeries(funnelPoints)
    : buildPitFactorIndustryThemeSeries(
        funnelPoints,
        await loadPitFactorTaxonomyMemberships(
          env,
          dates,
          funnelPoints
            .filter((point) => !parent || point.industry === parent)
            .map((point) => point.symbol),
          'industry_theme',
        ),
        parent || null,
      )
  return {
    requested_date: query.requestedDate,
    date: dates[dates.length - 1] ?? null,
    session_count: dates.length,
    requested_sessions: days,
    group_series: groupSeries,
    stock_series: stockSeries,
    governance: {
      candidate: 'pit_residual_momentum_w10',
      phase: 'prospective_shadow',
      taxonomy_layer: layer,
      parent_layer: layer === 'industry_theme' && parent ? 'industry' : null,
      parent: layer === 'industry_theme' && parent ? parent : null,
      available_taxonomy_layers: ['industry', 'industry_theme', 'subindustry', 'theme'],
      supported_visual_layers: ['industry', 'industry_theme'],
      theme_relationship: 'cross_cutting_overlay_not_strict_child',
      weight: 0.10,
      primary_horizon_sessions: 10,
      x_axis: 'same_date_group_residual_counterfactual_tilt_percentile',
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
