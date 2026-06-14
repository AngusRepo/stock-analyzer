import type { StrategyPortfolioMetrics } from './multiStrategyPleRouter'

export const STRATEGY_PORTFOLIO_METRICS_SOURCE_VERSION = 'strategy-portfolio-metrics-v1'

export type StrategyPortfolioMetricOverrides = Record<string, Partial<StrategyPortfolioMetrics>>

export interface StrategyRewardLedgerMetricRow {
  strategy_id: string
  strategy_version: string
  strategy_status: string
  alpha_bucket: string
  horizon_days: number
  samples: number
  hit_rate: number | null
  avg_return_pct: number | null
  reward_sum: number | null
  max_drawdown_pct: number | null
  coverage: number | null
  market_segment: string | null
  regime: string | null
  evidence_json: string | null
  updated_at: string | null
}

export interface StrategyDecisionLogMetricRow {
  date: string
  symbol: string
  strategy_id: string
  alpha_bucket: string
  match_score: number | null
}

export interface StrategyBacktestResultMetricRow {
  run_date: string
  strategy: string
  timerange: string | null
  total_trades: number | null
  win_rate: number | null
  sharpe: number | null
  sortino: number | null
  calmar: number | null
  max_drawdown: number | null
  cagr: number | null
  profit_factor: number | null
  expectancy: number | null
  raw_results: string | null
  created_at: string | null
}

export interface StrategyPortfolioMetricLoadResult {
  version: typeof STRATEGY_PORTFOLIO_METRICS_SOURCE_VERSION
  source: 'strategy_reward_ledger+strategy_decision_log+backtest_results'
  status: 'loaded' | 'empty' | 'unavailable'
  metrics: StrategyPortfolioMetricOverrides
  telemetry: {
    source: 'strategy_reward_ledger+strategy_decision_log+backtest_results'
    status: 'loaded' | 'empty' | 'unavailable'
    row_count: number
    reward_ledger_row_count: number
    decision_log_row_count: number
    backtest_result_row_count: number
    metric_count: number
    decision_overlap_metric_count: number
    backtest_metric_count: number
    regime: string | null
    market_segment: string
    error?: string
  }
}

export interface LoadStrategyPortfolioMetricOptions {
  regime?: string | null
  marketSegment?: string | null
  minSamples?: number
  limit?: number
  decisionLookbackDays?: number
  decisionLimit?: number
  backtestLimit?: number
  knownStrategyIds?: string[]
}

function cleanText(value: unknown): string {
  return String(value ?? '').trim()
}

function finiteNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000
}

function parseRecord(raw: unknown): Record<string, unknown> {
  if (!raw) return {}
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw !== 'string') return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function firstNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = finiteNumber(record[key])
    if (value != null) return value
  }
  return null
}

function collectStringValues(raw: unknown): string[] {
  if (raw == null) return []
  if (Array.isArray(raw)) return raw.flatMap(collectStringValues)
  const text = cleanText(raw)
  return text ? [text] : []
}

function nestedRecord(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const raw = record[key]
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {}
}

function standardDeviation(values: number[]): number {
  if (values.length < 2) return 0
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1)
  return Math.sqrt(Math.max(0, variance))
}

function pearsonCorrelation(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length)
  if (n < 3) return null
  const left = a.slice(0, n)
  const right = b.slice(0, n)
  const leftStd = standardDeviation(left)
  const rightStd = standardDeviation(right)
  if (leftStd <= 0 || rightStd <= 0) return null
  const leftMean = left.reduce((sum, value) => sum + value, 0) / n
  const rightMean = right.reduce((sum, value) => sum + value, 0) / n
  const covariance = left.reduce((sum, value, index) => sum + (value - leftMean) * (right[index] - rightMean), 0) / (n - 1)
  return covariance / (leftStd * rightStd)
}

function parseNumberArray(raw: unknown): number[] {
  if (!Array.isArray(raw)) return []
  return raw.map(finiteNumber).filter((value): value is number => value != null)
}

function extractStrategyPartitionReturns(raw: Record<string, unknown>): Record<string, number[]> {
  const candidates = raw.strategy_returns_by_partition ?? raw.candidate_partition_returns
  if (candidates && typeof candidates === 'object' && !Array.isArray(candidates)) {
    return Object.fromEntries(
      Object.entries(candidates as Record<string, unknown>)
        .map(([name, values]) => [cleanText(name), parseNumberArray(values)] as const)
        .filter(([name, values]) => Boolean(name) && values.length > 0),
    )
  }
  if (Array.isArray(candidates)) {
    const out: Record<string, number[]> = {}
    for (const item of candidates) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue
      const record = item as Record<string, unknown>
      const name = cleanText(record.name ?? record.strategy ?? record.strategy_id ?? record.trial_id)
      const values = parseNumberArray(record.partition_returns ?? record.returns)
      if (name && values.length) out[name] = values
    }
    return out
  }
  return {}
}

function globalBacktestStrategyName(value: string): boolean {
  const normalized = value.toLowerCase()
  return !normalized
    || normalized === 'backtest'
    || normalized === 'paper'
    || normalized === 'weekly'
    || normalized === 'weekly_backtest'
    || normalized.startsWith('replay_mode_')
    || normalized.startsWith('freqtrade')
}

function emptyResult(
  status: 'empty' | 'unavailable',
  options: LoadStrategyPortfolioMetricOptions,
  error?: string,
): StrategyPortfolioMetricLoadResult {
  const marketSegment = cleanText(options.marketSegment) || 'all'
  const regime = cleanText(options.regime) || null
  return {
    version: STRATEGY_PORTFOLIO_METRICS_SOURCE_VERSION,
    source: 'strategy_reward_ledger+strategy_decision_log+backtest_results',
    status,
    metrics: {},
    telemetry: {
      source: 'strategy_reward_ledger+strategy_decision_log+backtest_results',
      status,
      row_count: 0,
      reward_ledger_row_count: 0,
      decision_log_row_count: 0,
      backtest_result_row_count: 0,
      metric_count: 0,
      decision_overlap_metric_count: 0,
      backtest_metric_count: 0,
      regime,
      market_segment: marketSegment,
      ...(error ? { error: error.slice(0, 180) } : {}),
    },
  }
}

function scoreRowForPreference(row: StrategyRewardLedgerMetricRow, options: LoadStrategyPortfolioMetricOptions): number {
  const regime = cleanText(options.regime).toLowerCase()
  const marketSegment = cleanText(options.marketSegment).toLowerCase() || 'all'
  const rowRegime = cleanText(row.regime).toLowerCase() || 'all'
  const rowSegment = cleanText(row.market_segment).toLowerCase() || 'all'
  const regimeScore = !regime || rowRegime === regime ? 40 : rowRegime === 'all' ? 20 : 0
  const segmentScore = rowSegment === marketSegment ? 20 : rowSegment === 'all' ? 10 : 0
  const sampleScore = Math.min(20, Math.log10(Math.max(1, Number(row.samples ?? 0))) * 10)
  const horizonScore = Math.max(0, 10 - Math.abs(Number(row.horizon_days ?? 5) - 5))
  return regimeScore + segmentScore + sampleScore + horizonScore
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 0
  let intersection = 0
  for (const value of a) if (b.has(value)) intersection += 1
  return intersection / Math.max(1, a.size + b.size - intersection)
}

function setDistance(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 0
  return 1 - jaccard(a, b)
}

export function rewardLedgerRowToStrategyPortfolioMetrics(
  row: StrategyRewardLedgerMetricRow,
): Partial<StrategyPortfolioMetrics> {
  const evidence = parseRecord(row.evidence_json)
  const samples = Math.max(0, Math.floor(Number(row.samples ?? 0)))
  const coverage = clamp(finiteNumber(row.coverage) ?? 1, 0, 1)
  const hitRate = clamp(finiteNumber(row.hit_rate) ?? 0.5, 0, 1)
  const avgReturn = finiteNumber(row.avg_return_pct) ?? 0
  const rewardSum = finiteNumber(row.reward_sum) ?? avgReturn * samples
  const drawdown = Math.abs(finiteNumber(row.max_drawdown_pct) ?? 0)
  const sampleConfidence = clamp((samples / 30) * coverage, 0, 1)

  const rollingSharpe = firstNumber(evidence, ['rolling_sharpe', 'sharpe', 'strategy_sharpe'])
    ?? clamp((hitRate - 0.5) * 3 + avgReturn * 35, -1.5, 2.5)
  const recentAlpha = firstNumber(evidence, ['recent_alpha', 'alpha', 'avg_alpha'])
    ?? clamp(avgReturn, -0.2, 0.2)
  const ic = firstNumber(evidence, ['ic', 'information_coefficient'])
    ?? clamp((hitRate - 0.5) * 0.35 + avgReturn * 2.5, -0.3, 0.35)
  const rankIc = firstNumber(evidence, ['rank_ic', 'rankIC'])
    ?? clamp((hitRate - 0.5) * 0.42 + avgReturn * 2, -0.3, 0.35)
  const regimePerformance = firstNumber(evidence, ['regime_performance', 'regime_alpha'])
    ?? clamp((hitRate - 0.5) * 0.28 + avgReturn * 2.2, -0.25, 0.3)
  const baseReliability = clamp(
    0.5
    + (hitRate - 0.5) * 0.42
    + avgReturn * 4
    + Math.max(0, ic) * 0.35
    - drawdown * 0.6,
    0,
    1,
  )
  const reliability = clamp(0.5 * (1 - sampleConfidence) + baseReliability * sampleConfidence, 0, 1)

  return {
    rolling_sharpe: round4(rollingSharpe),
    max_drawdown: round4(drawdown),
    recent_alpha: round4(recentAlpha),
    return_correlation: firstNumber(evidence, ['return_correlation', 'correlation']) ?? undefined,
    holding_overlap: firstNumber(evidence, ['holding_overlap', 'overlap']) ?? undefined,
    turnover: firstNumber(evidence, ['turnover', 'strategy_turnover']) ?? undefined,
    factor_crowding: firstNumber(evidence, ['factor_crowding', 'crowding']) ?? undefined,
    ic: round4(ic),
    rank_ic: round4(rankIc),
    shapley_contribution: round4(firstNumber(evidence, ['shapley_contribution', 'shapley']) ?? clamp(rewardSum / Math.max(1, samples), -0.2, 0.4)),
    regime_performance: round4(regimePerformance),
    live_backtest_divergence: firstNumber(evidence, ['live_backtest_divergence', 'live_vs_backtest_divergence']) ?? undefined,
    reliability: round4(reliability),
  }
}

export function buildStrategyPortfolioMetricOverridesFromLedgerRows(
  rows: StrategyRewardLedgerMetricRow[],
  options: LoadStrategyPortfolioMetricOptions = {},
): StrategyPortfolioMetricOverrides {
  const minSamples = Math.max(0, Math.floor(options.minSamples ?? 5))
  const best = new Map<string, { row: StrategyRewardLedgerMetricRow; score: number }>()
  for (const row of rows) {
    if (!cleanText(row.strategy_id)) continue
    if (Number(row.samples ?? 0) < minSamples) continue
    const score = scoreRowForPreference(row, options)
    const existing = best.get(row.strategy_id)
    if (!existing || score > existing.score) best.set(row.strategy_id, { row, score })
  }
  return Object.fromEntries([...best.entries()].map(([strategyId, item]) => [
    strategyId,
    rewardLedgerRowToStrategyPortfolioMetrics(item.row),
  ]))
}

export function buildStrategyPortfolioDecisionLogMetricOverrides(
  rows: StrategyDecisionLogMetricRow[],
): StrategyPortfolioMetricOverrides {
  const symbolsByStrategy = new Map<string, Set<string>>()
  const symbolsByStrategyDate = new Map<string, Map<string, Set<string>>>()
  const bucketByStrategy = new Map<string, string>()
  const symbolsByBucket = new Map<string, Set<string>>()

  for (const row of rows) {
    const strategyId = cleanText(row.strategy_id)
    const symbol = cleanText(row.symbol).toUpperCase()
    const date = cleanText(row.date)
    if (!strategyId || !symbol || !date) continue
    const bucket = cleanText(row.alpha_bucket) || 'unknown'
    bucketByStrategy.set(strategyId, bucket)

    if (!symbolsByStrategy.has(strategyId)) symbolsByStrategy.set(strategyId, new Set())
    symbolsByStrategy.get(strategyId)!.add(symbol)

    if (!symbolsByBucket.has(bucket)) symbolsByBucket.set(bucket, new Set())
    symbolsByBucket.get(bucket)!.add(symbol)

    if (!symbolsByStrategyDate.has(strategyId)) symbolsByStrategyDate.set(strategyId, new Map())
    const byDate = symbolsByStrategyDate.get(strategyId)!
    if (!byDate.has(date)) byDate.set(date, new Set())
    byDate.get(date)!.add(symbol)
  }

  const out: StrategyPortfolioMetricOverrides = {}
  const strategyEntries = [...symbolsByStrategy.entries()]
  for (const [strategyId, symbols] of strategyEntries) {
    let maxOverlap = 0
    let sameBucketOverlapSum = 0
    let sameBucketCount = 0
    const bucket = bucketByStrategy.get(strategyId) ?? 'unknown'

    for (const [otherId, otherSymbols] of strategyEntries) {
      if (otherId === strategyId) continue
      const overlap = jaccard(symbols, otherSymbols)
      maxOverlap = Math.max(maxOverlap, overlap)
      if ((bucketByStrategy.get(otherId) ?? 'unknown') === bucket) {
        sameBucketOverlapSum += overlap
        sameBucketCount += 1
      }
    }

    const byDate = symbolsByStrategyDate.get(strategyId) ?? new Map()
    const dates = [...byDate.keys()].sort()
    const turnoverValues: number[] = []
    for (let index = 1; index < dates.length; index += 1) {
      turnoverValues.push(setDistance(byDate.get(dates[index - 1]) ?? new Set(), byDate.get(dates[index]) ?? new Set()))
    }
    const turnover = turnoverValues.length
      ? turnoverValues.reduce((sum, value) => sum + value, 0) / turnoverValues.length
      : 0
    const bucketSymbols = symbolsByBucket.get(bucket) ?? symbols
    const bucketShare = symbols.size / Math.max(1, bucketSymbols.size)
    const sameBucketOverlap = sameBucketCount ? sameBucketOverlapSum / sameBucketCount : 0
    const factorCrowding = clamp(bucketShare * 0.45 + sameBucketOverlap * 0.55, 0, 1)

    out[strategyId] = {
      holding_overlap: round4(maxOverlap),
      turnover: round4(turnover),
      factor_crowding: round4(factorCrowding),
    }
  }
  return out
}

function resolveBacktestStrategyIds(
  row: StrategyBacktestResultMetricRow,
  raw: Record<string, unknown>,
  knownStrategyIds: Set<string>,
): string[] {
  const labRecord = nestedRecord(raw, 'strategy_lab_record')
  const ids = new Set<string>()
  for (const value of [
    ...collectStringValues(raw.strategy_id),
    ...collectStringValues(raw.strategy_ids),
    ...collectStringValues(raw.strategy_spec_id),
    ...collectStringValues(raw.strategy_spec_ids),
    ...collectStringValues(labRecord.strategy_id),
    ...collectStringValues(labRecord.strategy_ids),
    ...collectStringValues(labRecord.strategy_spec_id),
    ...collectStringValues(labRecord.strategy_spec_ids),
  ]) {
    const id = cleanText(value)
    if (id) ids.add(id)
  }
  const rowStrategy = cleanText(row.strategy)
  if (rowStrategy && !globalBacktestStrategyName(rowStrategy)) ids.add(rowStrategy)

  for (const key of Object.keys(extractStrategyPartitionReturns(raw))) {
    if (key && !globalBacktestStrategyName(key)) ids.add(key)
  }

  const resolved = [...ids]
    .map(cleanText)
    .filter(Boolean)
    .filter((id) => !knownStrategyIds.size || knownStrategyIds.has(id))
  return [...new Set(resolved)]
}

function regimePerformanceFromRaw(raw: Record<string, unknown>, regime?: string | null): number | null {
  const perRegime = nestedRecord(raw, 'per_regime')
  const regimeKey = cleanText(regime).toLowerCase()
  const entries = Object.entries(perRegime)
  if (!entries.length) return null
  const candidate = entries.find(([key]) => key.toLowerCase() === regimeKey)?.[1]
    ?? entries.find(([key]) => key.toLowerCase() === 'all')?.[1]
    ?? entries[0]?.[1]
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null
  const record = candidate as Record<string, unknown>
  const ret = firstNumber(record, ['return', 'total_return', 'avg_return', 'mean_return'])
  if (ret != null) return clamp(ret, -0.35, 0.45)
  const sharpe = firstNumber(record, ['sharpe', 'rolling_sharpe'])
  if (sharpe != null) return clamp(sharpe * 0.08, -0.35, 0.45)
  return null
}

function walkForwardScore(raw: Record<string, unknown>): number {
  const walkForward = nestedRecord(raw, 'walk_forward')
  if (!Object.keys(walkForward).length) return 0.5
  const passed = Boolean(walkForward.passed || walkForward.gate_pass || cleanText(walkForward.decision).toUpperCase() === 'PASS')
  const windows = Math.max(0, Math.floor(finiteNumber(walkForward.windows) ?? 0))
  const oosSharpe = finiteNumber(walkForward.oos_sharpe)
  return clamp((passed ? 0.58 : 0.36) + Math.min(0.18, windows * 0.025) + clamp(oosSharpe ?? 0, -1, 2) * 0.08, 0, 1)
}

export function buildStrategyPortfolioBacktestMetricOverrides(
  rows: StrategyBacktestResultMetricRow[],
  options: LoadStrategyPortfolioMetricOptions = {},
): StrategyPortfolioMetricOverrides {
  const knownStrategyIds = new Set((options.knownStrategyIds ?? []).map(cleanText).filter(Boolean))
  const best = new Map<string, { metrics: Partial<StrategyPortfolioMetrics>; score: number }>()

  for (const row of rows) {
    const raw = parseRecord(row.raw_results)
    const strategyIds = resolveBacktestStrategyIds(row, raw, knownStrategyIds)
    if (!strategyIds.length) continue

    const totalTrades = Math.max(0, Math.floor(finiteNumber(row.total_trades) ?? firstNumber(nestedRecord(raw, 'summary'), ['total_trades']) ?? 0))
    const sharpe = finiteNumber(row.sharpe) ?? firstNumber(nestedRecord(raw, 'summary'), ['sharpe'])
    const maxDrawdown = Math.abs(finiteNumber(row.max_drawdown) ?? firstNumber(nestedRecord(raw, 'summary'), ['max_drawdown']) ?? 0)
    const cagr = finiteNumber(row.cagr) ?? firstNumber(nestedRecord(raw, 'summary'), ['cagr'])
    const expectancy = finiteNumber(row.expectancy) ?? firstNumber(nestedRecord(raw, 'summary'), ['expectancy'])
    const winRate = finiteNumber(row.win_rate) ?? firstNumber(nestedRecord(raw, 'summary'), ['win_rate'])
    const partitionReturns = extractStrategyPartitionReturns(raw)
    const score = totalTrades + Math.max(0, sharpe ?? 0) * 20 + (row.run_date ? Date.parse(row.run_date) / 8.64e7 / 100000 : 0)

    for (const strategyId of strategyIds) {
      const ownReturns = partitionReturns[strategyId] ?? []
      const otherCorrelations = Object.entries(partitionReturns)
        .filter(([otherId]) => otherId !== strategyId)
        .map(([, returns]) => pearsonCorrelation(ownReturns, returns))
        .filter((value): value is number => value != null)
      const returnCorrelation = otherCorrelations.length
        ? round4(clamp(Math.max(...otherCorrelations), 0, 1))
        : undefined
      const strategyMeanReturn = ownReturns.length
        ? ownReturns.reduce((sum, value) => sum + value, 0) / ownReturns.length
        : null
      const tradeConfidence = clamp(totalTrades / 60, 0, 1)
      const wfScore = walkForwardScore(raw)
      const reliability = clamp(
        0.5 * (1 - tradeConfidence)
        + (
          0.5
          + clamp(sharpe ?? 0, -1.5, 2.5) * 0.16
          + (winRate != null ? (winRate - 0.5) * 0.28 : 0)
          + wfScore * 0.18
          - maxDrawdown * 0.45
        ) * tradeConfidence,
        0,
        1,
      )
      const metrics: Partial<StrategyPortfolioMetrics> = {
        rolling_sharpe: sharpe == null ? undefined : round4(sharpe),
        max_drawdown: round4(maxDrawdown),
        return_correlation: returnCorrelation,
        shapley_contribution: strategyMeanReturn == null
          ? (expectancy == null ? undefined : round4(clamp(expectancy, -0.2, 0.4)))
          : round4(clamp(strategyMeanReturn, -0.2, 0.4)),
        regime_performance: round4(regimePerformanceFromRaw(raw, options.regime) ?? clamp(cagr ?? strategyMeanReturn ?? 0, -0.35, 0.45)),
        reliability: round4(reliability),
      }
      const existing = best.get(strategyId)
      if (!existing || score > existing.score) best.set(strategyId, { metrics, score })
    }
  }

  return Object.fromEntries([...best.entries()].map(([strategyId, item]) => [strategyId, item.metrics]))
}

function mergeDefinedMetrics(
  base: StrategyPortfolioMetricOverrides,
  supplement: StrategyPortfolioMetricOverrides,
): StrategyPortfolioMetricOverrides {
  const out: StrategyPortfolioMetricOverrides = {}
  for (const strategyId of new Set([...Object.keys(base), ...Object.keys(supplement)])) {
    const merged: Partial<StrategyPortfolioMetrics> = { ...(base[strategyId] ?? {}) }
    for (const [key, value] of Object.entries(supplement[strategyId] ?? {}) as Array<[keyof StrategyPortfolioMetrics, unknown]>) {
      if (merged[key] == null && value != null) {
        ;(merged as Record<string, unknown>)[key] = value
      }
    }
    out[strategyId] = merged
  }
  return out
}

export async function loadStrategyPortfolioMetricOverrides(
  db: D1Database,
  options: LoadStrategyPortfolioMetricOptions = {},
): Promise<StrategyPortfolioMetricLoadResult> {
  const marketSegment = cleanText(options.marketSegment) || 'all'
  const regime = cleanText(options.regime) || null
  const limit = Math.max(1, Math.min(Math.floor(options.limit ?? 500), 2000))
  const decisionLookbackDays = Math.max(1, Math.min(Math.floor(options.decisionLookbackDays ?? 20), 120))
  const decisionLimit = Math.max(1, Math.min(Math.floor(options.decisionLimit ?? 2000), 5000))
  const backtestLimit = Math.max(1, Math.min(Math.floor(options.backtestLimit ?? 200), 1000))
  let ledgerRows: StrategyRewardLedgerMetricRow[] = []
  let decisionRows: StrategyDecisionLogMetricRow[] = []
  let backtestRows: StrategyBacktestResultMetricRow[] = []
  const errors: string[] = []

  try {
    const { results } = await db.prepare(`
      SELECT strategy_id, strategy_version, strategy_status, alpha_bucket,
             horizon_days, samples, hit_rate, avg_return_pct, reward_sum,
             max_drawdown_pct, coverage, market_segment, regime, evidence_json,
             updated_at
        FROM strategy_reward_ledger
       WHERE samples > 0
         AND (market_segment = ? OR market_segment = 'all' OR market_segment IS NULL)
         AND (? IS NULL OR regime = ? OR regime = 'all' OR regime IS NULL)
       ORDER BY updated_at DESC, samples DESC
       LIMIT ?
    `).bind(marketSegment, regime, regime, limit).all<StrategyRewardLedgerMetricRow>()
    ledgerRows = results ?? []
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }

  try {
    const { results } = await db.prepare(`
      SELECT date, symbol, strategy_id, alpha_bucket, match_score
        FROM strategy_decision_log
       WHERE matched = 1
         AND date >= date('now', '-' || ? || ' days')
       ORDER BY date DESC
       LIMIT ?
    `).bind(decisionLookbackDays, decisionLimit).all<StrategyDecisionLogMetricRow>()
    decisionRows = results ?? []
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }

  try {
    const { results } = await db.prepare(`
      SELECT run_date, strategy, timerange, total_trades, win_rate,
             sharpe, sortino, calmar, max_drawdown, cagr,
             profit_factor, expectancy, raw_results, created_at
        FROM backtest_results
       WHERE total_trades > 0
       ORDER BY run_date DESC, created_at DESC
       LIMIT ?
    `).bind(backtestLimit).all<StrategyBacktestResultMetricRow>()
    backtestRows = results ?? []
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }

  if (!ledgerRows.length && !decisionRows.length && !backtestRows.length && errors.length) {
    return emptyResult('unavailable', options, errors.join(' | '))
  }

  const ledgerMetrics = buildStrategyPortfolioMetricOverridesFromLedgerRows(ledgerRows, options)
  const decisionMetrics = buildStrategyPortfolioDecisionLogMetricOverrides(decisionRows)
  const backtestMetrics = buildStrategyPortfolioBacktestMetricOverrides(backtestRows, options)
  const metrics = mergeDefinedMetrics(mergeDefinedMetrics(ledgerMetrics, decisionMetrics), backtestMetrics)
  const metricCount = Object.keys(metrics).length
  const status = metricCount > 0 ? 'loaded' : 'empty'
  return {
    version: STRATEGY_PORTFOLIO_METRICS_SOURCE_VERSION,
    source: 'strategy_reward_ledger+strategy_decision_log+backtest_results',
    status,
    metrics,
    telemetry: {
      source: 'strategy_reward_ledger+strategy_decision_log+backtest_results',
      status,
      row_count: ledgerRows.length + decisionRows.length + backtestRows.length,
      reward_ledger_row_count: ledgerRows.length,
      decision_log_row_count: decisionRows.length,
      backtest_result_row_count: backtestRows.length,
      metric_count: metricCount,
      decision_overlap_metric_count: Object.keys(decisionMetrics).length,
      backtest_metric_count: Object.keys(backtestMetrics).length,
      regime,
      market_segment: marketSegment,
      ...(errors.length ? { error: errors.join(' | ').slice(0, 180) } : {}),
    },
  }
}
