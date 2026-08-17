import type { Bindings } from '../types'
import { databaseForDataDomain, shadowDatabaseForDataDomain } from './dataDomainRegistry'
import {
  listStrategyEvidenceProfiles,
  type StrategyEvidenceMetric,
  type StrategyEvidenceProfile,
} from './strategyEvidenceProfile'
import { listStrategySpecsForLearning } from './strategyLearning'

export const STRATEGY_EVIDENCE_METRIC_DEFINITION_VERSION = 'strategy-evidence-metrics-v1'
export const STRATEGY_EVIDENCE_MIN_SAMPLES = 20
export const STRATEGY_EVIDENCE_MIN_MATURE_DATES = 5

export type StrategyEvidenceMetricStatus =
  | 'ready'
  | 'insufficient_samples'
  | 'dependency_pending'
  | 'not_available'

export type StrategyEvidenceObservation = {
  signal_date: string
  symbol: string
  producer_run_id: string
  strategy_id: string
  strategy_version: string
  strategy_status: string
  alpha_bucket: string
  affinity: number | string | null
  position_weight: number | string | null
  overlap: number | string | null
  horizon_days: number | string
  outcome_known_date: string
  absolute_return_net: number | string
  benchmark_return_net: number | string
  residual_return_net: number | string
  cross_section_rank: number | string
}

export type StrategyEvidenceMatrixRow = Pick<StrategyEvidenceObservation,
  'signal_date' | 'symbol' | 'producer_run_id' | 'strategy_id' | 'strategy_version'
  | 'strategy_status' | 'alpha_bucket' | 'affinity' | 'position_weight' | 'overlap'>

export type StrategyEvidenceOutcomeRow = Pick<StrategyEvidenceObservation,
  'signal_date' | 'symbol' | 'producer_run_id' | 'horizon_days' | 'outcome_known_date'
  | 'absolute_return_net' | 'benchmark_return_net' | 'residual_return_net' | 'cross_section_rank'>

function strategyEvidenceJoinKey(row: Pick<StrategyEvidenceObservation,
  'signal_date' | 'symbol' | 'producer_run_id'>): string {
  return `${row.signal_date}|${row.symbol}|${row.producer_run_id}`
}

export function joinStrategyEvidenceObservations(
  matrixRows: StrategyEvidenceMatrixRow[],
  outcomeRows: StrategyEvidenceOutcomeRow[],
): StrategyEvidenceObservation[] {
  const outcomesBySelection = new Map<string, StrategyEvidenceOutcomeRow[]>()
  for (const outcome of outcomeRows) {
    const key = strategyEvidenceJoinKey(outcome)
    outcomesBySelection.set(key, [...(outcomesBySelection.get(key) ?? []), outcome])
  }
  return matrixRows.flatMap((matrix) => (
    (outcomesBySelection.get(strategyEvidenceJoinKey(matrix)) ?? []).map((outcome) => ({ ...matrix, ...outcome }))
  ))
}

export type StrategyEvidenceMetricRow = {
  strategy_id: string
  strategy_version: string
  strategy_status: string
  alpha_bucket: string
  primary_horizon_days: number
  metric_name: StrategyEvidenceMetric
  metric_value: number | null
  metric_status: StrategyEvidenceMetricStatus
  sample_count: number
  mature_dates: number
  date_start: string | null
  date_end: string | null
  outcome_as_of_date: string
  definition_version: typeof STRATEGY_EVIDENCE_METRIC_DEFINITION_VERSION
  evidence_json: string
}

const DEPENDENCY_PENDING: Partial<Record<StrategyEvidenceMetric, string>> = {
  regime_consistency: 'pit_regime_partition_not_materialized',
  maximum_adverse_excursion: 'adjusted_intrahorizon_low_path_not_materialized',
  fundamental_revision_persistence: 'pit_fundamental_revision_sequence_not_materialized',
}

function finite(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function round6(value: number | null): number | null {
  return value == null || !Number.isFinite(value) ? null : Math.round(value * 1_000_000) / 1_000_000
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
}

function dateClusteredValues(rows: StrategyEvidenceObservation[], read: (row: StrategyEvidenceObservation) => number | null): number[] {
  const byDate = new Map<string, number[]>()
  for (const row of rows) {
    const value = read(row)
    if (value == null) continue
    byDate.set(row.signal_date, [...(byDate.get(row.signal_date) ?? []), value])
  }
  return [...byDate.keys()].sort().map((date) => mean(byDate.get(date) ?? [])!).filter(Number.isFinite)
}

function lcb90(values: number[]): number | null {
  if (values.length < 2) return null
  const average = mean(values)!
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1)
  return round6(average - 1.281551565545 * Math.sqrt(Math.max(0, variance) / values.length))
}

function maxDrawdown(values: number[]): number | null {
  if (!values.length) return null
  let equity = 1
  let peak = 1
  let drawdown = 0
  for (const value of values) {
    equity *= Math.max(0, 1 + value)
    peak = Math.max(peak, equity)
    drawdown = Math.min(drawdown, peak > 0 ? equity / peak - 1 : -1)
  }
  return round6(drawdown)
}

function ranks(values: number[]): number[] {
  const ordered = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value)
  const output = Array(values.length).fill(0)
  for (let start = 0; start < ordered.length;) {
    let end = start + 1
    while (end < ordered.length && ordered[end].value === ordered[start].value) end += 1
    const rank = (start + end - 1) / 2
    for (let index = start; index < end; index += 1) output[ordered[index].index] = rank
    start = end
  }
  return output
}

function pearson(left: number[], right: number[]): number | null {
  if (left.length !== right.length || left.length < 3) return null
  const leftMean = mean(left)!
  const rightMean = mean(right)!
  let numerator = 0
  let leftSq = 0
  let rightSq = 0
  for (let index = 0; index < left.length; index += 1) {
    const l = left[index] - leftMean
    const r = right[index] - rightMean
    numerator += l * r
    leftSq += l * l
    rightSq += r * r
  }
  return leftSq > 0 && rightSq > 0 ? numerator / Math.sqrt(leftSq * rightSq) : null
}

function rankIc(rows: StrategyEvidenceObservation[]): { value: number | null; dates: number } {
  const byDate = new Map<string, StrategyEvidenceObservation[]>()
  for (const row of rows) byDate.set(row.signal_date, [...(byDate.get(row.signal_date) ?? []), row])
  const values: number[] = []
  for (const dateRows of byDate.values()) {
    const pairs = dateRows.map((row) => ({ affinity: finite(row.affinity), reward: finite(row.residual_return_net) }))
      .filter((row): row is { affinity: number; reward: number } => row.affinity != null && row.reward != null)
    if (pairs.length < 3) continue
    const value = pearson(ranks(pairs.map((row) => row.affinity)), ranks(pairs.map((row) => row.reward)))
    if (value != null) values.push(value)
  }
  return { value: round6(mean(values)), dates: values.length }
}

function turnoverEfficiency(rows: StrategyEvidenceObservation[]): { value: number | null; turnover: number | null; dates: number } {
  const byDate = new Map<string, Map<string, number>>()
  for (const row of rows) {
    const weights = byDate.get(row.signal_date) ?? new Map<string, number>()
    weights.set(row.symbol, Math.max(0, finite(row.position_weight) ?? 1))
    byDate.set(row.signal_date, weights)
  }
  const dates = [...byDate.keys()].sort()
  const normalized = dates.map((date) => {
    const raw = byDate.get(date)!
    const total = [...raw.values()].reduce((sum, value) => sum + value, 0)
    return new Map([...raw.entries()].map(([symbol, value]) => [symbol, total > 0 ? value / total : 0]))
  })
  const turnovers: number[] = []
  for (let index = 1; index < normalized.length; index += 1) {
    const symbols = new Set([...normalized[index - 1].keys(), ...normalized[index].keys()])
    const oneWay = [...symbols].reduce((sum, symbol) => (
      sum + Math.abs((normalized[index].get(symbol) ?? 0) - (normalized[index - 1].get(symbol) ?? 0))
    ), 0) / 2
    turnovers.push(oneWay)
  }
  const turnover = mean(turnovers)
  const costNetMean = mean(rows.map((row) => finite(row.absolute_return_net)).filter((value): value is number => value != null))
  return {
    value: turnover != null && turnover > 0 && costNetMean != null ? round6(costNetMean / turnover) : null,
    turnover: round6(turnover),
    dates: dates.length,
  }
}

function tailCvar95(values: number[]): { value: number | null; tailSamples: number } {
  if (!values.length) return { value: null, tailSamples: 0 }
  const tailSamples = Math.max(1, Math.ceil(values.length * 0.05))
  return { value: round6(mean([...values].sort((a, b) => a - b).slice(0, tailSamples))), tailSamples }
}

function timeToReversion(rows: StrategyEvidenceObservation[], horizons: number[]): { value: number | null; samples: number; resolved: number } {
  const allowed = new Set(horizons)
  const bySignal = new Map<string, StrategyEvidenceObservation[]>()
  for (const row of rows) {
    if (!allowed.has(Number(row.horizon_days))) continue
    const key = `${row.signal_date}|${row.symbol}|${row.producer_run_id}`
    bySignal.set(key, [...(bySignal.get(key) ?? []), row])
  }
  const resolved: number[] = []
  for (const signalRows of bySignal.values()) {
    const first = signalRows
      .filter((row) => (finite(row.residual_return_net) ?? Number.NEGATIVE_INFINITY) > 0)
      .sort((left, right) => Number(left.horizon_days) - Number(right.horizon_days))[0]
    if (first) resolved.push(Number(first.horizon_days))
  }
  return { value: round6(mean(resolved)), samples: bySignal.size, resolved: resolved.length }
}

function downsideCapture(rows: StrategyEvidenceObservation[]): { value: number | null; samples: number } {
  const downside = rows.filter((row) => (finite(row.benchmark_return_net) ?? 0) < 0)
  const strategyMean = mean(downside.map((row) => finite(row.absolute_return_net)).filter((value): value is number => value != null))
  const benchmarkMean = mean(downside.map((row) => finite(row.benchmark_return_net)).filter((value): value is number => value != null))
  return {
    value: strategyMean != null && benchmarkMean != null && Math.abs(benchmarkMean) > 1e-9
      ? round6(strategyMean / benchmarkMean)
      : null,
    samples: downside.length,
  }
}

function crowdingDecay(rows: StrategyEvidenceObservation[]): { value: number | null; samples: number } {
  const values = rows.map((row) => ({ overlap: finite(row.overlap), reward: finite(row.residual_return_net) }))
    .filter((row): row is { overlap: number; reward: number } => row.overlap != null && row.reward != null)
    .sort((left, right) => left.overlap - right.overlap)
  const width = Math.floor(values.length / 4)
  if (width < 2) return { value: null, samples: values.length }
  const low = mean(values.slice(0, width).map((row) => row.reward))!
  const high = mean(values.slice(-width).map((row) => row.reward))!
  return { value: round6(high - low), samples: values.length }
}

function metricStatus(value: number | null, samples: number, matureDates: number): StrategyEvidenceMetricStatus {
  if (value == null) return 'not_available'
  return samples >= STRATEGY_EVIDENCE_MIN_SAMPLES && matureDates >= STRATEGY_EVIDENCE_MIN_MATURE_DATES
    ? 'ready'
    : 'insufficient_samples'
}

export function computeStrategyEvidenceMetricRows(
  profile: StrategyEvidenceProfile,
  observations: StrategyEvidenceObservation[],
  outcomeAsOfDate: string,
): StrategyEvidenceMetricRow[] {
  const primary = observations.filter((row) => Number(row.horizon_days) === profile.primary_horizon_days)
  const dates = [...new Set(primary.map((row) => row.signal_date))].sort()
  const base = {
    strategy_id: profile.strategy_id,
    strategy_version: profile.strategy_version,
    strategy_status: profile.strategy_status,
    alpha_bucket: observations[0]?.alpha_bucket ?? 'unknown',
    primary_horizon_days: profile.primary_horizon_days,
    date_start: dates[0] ?? null,
    date_end: dates.at(-1) ?? null,
    outcome_as_of_date: outcomeAsOfDate,
    definition_version: STRATEGY_EVIDENCE_METRIC_DEFINITION_VERSION,
  } as const
  const absolute = primary.map((row) => finite(row.absolute_return_net)).filter((value): value is number => value != null)
  const residualByDate = dateClusteredValues(primary, (row) => finite(row.residual_return_net))
  const absoluteByDate = dateClusteredValues(primary, (row) => finite(row.absolute_return_net))

  return profile.required_metrics.map((metric): StrategyEvidenceMetricRow => {
    const dependency = DEPENDENCY_PENDING[metric]
    if (dependency) return {
      ...base, metric_name: metric, metric_value: null, metric_status: 'dependency_pending',
      sample_count: primary.length, mature_dates: dates.length,
      evidence_json: JSON.stringify({ dependency, production_effect: false }),
    }

    let value: number | null = null
    let samples = primary.length
    let matureDates = dates.length
    let evidence: Record<string, unknown> = {}
    if (metric === 'residual_return_lcb90') {
      value = lcb90(residualByDate)
      samples = primary.length
      matureDates = residualByDate.length
      evidence = { semantic: 'date_clustered_equal_weight_residual_return_lcb90', z90: 1.281551565545 }
    } else if (metric === 'rank_ic') {
      const result = rankIc(primary)
      value = result.value
      matureDates = result.dates
      evidence = { semantic: 'mean_daily_spearman_affinity_vs_residual_return' }
    } else if (metric === 'max_drawdown') {
      value = maxDrawdown(absoluteByDate)
      matureDates = absoluteByDate.length
      evidence = { semantic: 'date_clustered_equal_weight_compounded_cost_net_absolute_return' }
    } else if (metric === 'turnover_after_cost') {
      const result = turnoverEfficiency(primary)
      value = result.value
      matureDates = result.dates
      evidence = { semantic: 'cost_net_mean_return_per_one_way_turnover', average_one_way_turnover: result.turnover }
    } else if (metric === 'false_breakout_rate') {
      value = absolute.length ? round6(absolute.filter((item) => item <= 0).length / absolute.length) : null
      samples = absolute.length
      evidence = { semantic: 'primary_horizon_cost_net_return_non_positive_rate' }
    } else if (metric === 'tail_loss_cvar95') {
      const result = tailCvar95(absolute)
      value = result.value
      samples = absolute.length
      evidence = { semantic: 'mean_worst_five_percent_cost_net_absolute_return', tail_samples: result.tailSamples }
    } else if (metric === 'time_to_reversion') {
      const result = timeToReversion(observations, profile.evaluation_horizon_days)
      value = result.value
      samples = result.samples
      evidence = { semantic: 'earliest_discrete_evidence_horizon_with_positive_residual_return', resolved_samples: result.resolved, censored_samples: result.samples - result.resolved }
    } else if (metric === 'downside_capture') {
      const result = downsideCapture(primary)
      value = result.value
      samples = result.samples
      evidence = { semantic: 'cost_net_strategy_return_divided_by_benchmark_return_when_benchmark_negative' }
    } else if (metric === 'crowding_decay') {
      const result = crowdingDecay(primary)
      value = result.value
      samples = result.samples
      evidence = { semantic: 'high_overlap_quartile_minus_low_overlap_quartile_residual_return' }
    }
    return {
      ...base,
      metric_name: metric,
      metric_value: value,
      metric_status: metricStatus(value, samples, matureDates),
      sample_count: samples,
      mature_dates: matureDates,
      evidence_json: JSON.stringify({ ...evidence, production_effect: false }),
    }
  })
}

async function loadObservationsAcrossDatabases(
  matrixDb: D1Database,
  outcomeDb: D1Database,
  outcomeAsOfDate: string,
): Promise<StrategyEvidenceObservation[]> {
  const outcomeRows: StrategyEvidenceOutcomeRow[] = []
  let outcomeRowId = 0
  for (;;) {
    const page = await outcomeDb.prepare(`
      SELECT rowid source_row_id, signal_date, symbol, producer_run_id,
             horizon_days, outcome_known_date, absolute_return_net,
             benchmark_return_net, residual_return_net, cross_section_rank
        FROM canonical_selection_outcomes_v1
       WHERE outcome_known_date<=? AND rowid>?
       ORDER BY rowid
       LIMIT 2000
    `).bind(outcomeAsOfDate, outcomeRowId).all<StrategyEvidenceOutcomeRow & { source_row_id: number }>()
    const rows = page.results ?? []
    outcomeRows.push(...rows)
    if (rows.length < 2000) break
    outcomeRowId = Number(rows.at(-1)!.source_row_id)
  }

  const observations: StrategyEvidenceObservation[] = []
  let matrixRowId = 0
  for (;;) {
    const page = await matrixDb.prepare(`
      SELECT rowid source_row_id, signal_date, symbol, producer_run_id,
             strategy_id, strategy_version, strategy_status, alpha_bucket,
             affinity, position_weight, overlap
        FROM strategy_label_matrix_v4
       WHERE strategy_hit=1 AND evaluable=1 AND rowid>?
       ORDER BY rowid
       LIMIT 2000
    `).bind(matrixRowId).all<StrategyEvidenceMatrixRow & { source_row_id: number }>()
    const rows = page.results ?? []
    observations.push(...joinStrategyEvidenceObservations(rows, outcomeRows))
    if (rows.length < 2000) break
    matrixRowId = Number(rows.at(-1)!.source_row_id)
  }
  return observations
}

async function loadObservations(db: D1Database, outcomeAsOfDate: string): Promise<StrategyEvidenceObservation[]> {
  const output: StrategyEvidenceObservation[] = []
  let matrixRowId = 0
  let horizonDays = 0
  for (;;) {
    const page = await db.prepare(`
      SELECT m.rowid matrix_row_id, m.signal_date, m.symbol, m.producer_run_id,
             m.strategy_id, m.strategy_version, m.strategy_status, m.alpha_bucket,
             m.affinity, m.position_weight, m.overlap,
             o.horizon_days, o.outcome_known_date, o.absolute_return_net,
             o.benchmark_return_net, o.residual_return_net, o.cross_section_rank
        FROM strategy_label_matrix_v4 m
        JOIN canonical_selection_outcomes_v1 o
          ON o.signal_date=m.signal_date AND o.symbol=m.symbol
         AND o.producer_run_id=m.producer_run_id
       WHERE m.strategy_hit=1 AND m.evaluable=1
         AND o.outcome_known_date<=?
         AND (m.rowid>? OR (m.rowid=? AND o.horizon_days>?))
       ORDER BY m.rowid, o.horizon_days
       LIMIT 5000
    `).bind(outcomeAsOfDate, matrixRowId, matrixRowId, horizonDays).all<StrategyEvidenceObservation & { matrix_row_id: number }>()
    const rows = page.results ?? []
    output.push(...rows)
    if (rows.length < 5000) break
    matrixRowId = Number(rows.at(-1)!.matrix_row_id)
    horizonDays = Number(rows.at(-1)!.horizon_days)
  }
  return output
}

async function persistMetricRows(db: D1Database, rows: StrategyEvidenceMetricRow[]): Promise<number> {
  const statements = rows.map((row) => db.prepare(`
    INSERT INTO strategy_evidence_metrics_v1 (
      strategy_id, strategy_version, strategy_status, alpha_bucket,
      primary_horizon_days, metric_name, metric_value, metric_status,
      sample_count, mature_dates, date_start, date_end, outcome_as_of_date,
      definition_version, evidence_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(strategy_id, strategy_version, primary_horizon_days, metric_name) DO UPDATE SET
      strategy_status=excluded.strategy_status, alpha_bucket=excluded.alpha_bucket,
      metric_value=excluded.metric_value, metric_status=excluded.metric_status,
      sample_count=excluded.sample_count, mature_dates=excluded.mature_dates,
      date_start=excluded.date_start, date_end=excluded.date_end,
      outcome_as_of_date=excluded.outcome_as_of_date,
      definition_version=excluded.definition_version, evidence_json=excluded.evidence_json,
      updated_at=CURRENT_TIMESTAMP
  `).bind(
    row.strategy_id, row.strategy_version, row.strategy_status, row.alpha_bucket,
    row.primary_horizon_days, row.metric_name, row.metric_value, row.metric_status,
    row.sample_count, row.mature_dates, row.date_start, row.date_end,
    row.outcome_as_of_date, row.definition_version, row.evidence_json,
  ))
  for (let offset = 0; offset < statements.length; offset += 100) {
    await db.batch(statements.slice(offset, offset + 100))
  }
  return statements.length
}

export async function materializeStrategyEvidenceMetrics(
  env: Bindings,
  options: { outcomeAsOfDate: string },
): Promise<{ profiles: number; observations: number; metric_rows: number; ready_rows: number; source: string; summary: string }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.outcomeAsOfDate)) throw new Error('invalid_strategy_metric_outcome_as_of_date')
  const authorityDb = databaseForDataDomain(env, 'learning')
  const db = shadowDatabaseForDataDomain(env, 'learning') ?? authorityDb
  const source = authorityDb === db ? 'learning_target_join' : 'authoritative_cross_d1_bridge'
  const [{ specs }, observations] = await Promise.all([
    listStrategySpecsForLearning(authorityDb, { asOfDate: options.outcomeAsOfDate }),
    authorityDb === db
      ? loadObservations(db, options.outcomeAsOfDate)
      : loadObservationsAcrossDatabases(authorityDb, db, options.outcomeAsOfDate),
  ])
  const profiles = listStrategyEvidenceProfiles(specs.filter((spec) => spec.status !== 'retired'), {
    availableOutcomeHorizonDays: [3, 5, 10],
  })
  const byStrategy = new Map<string, StrategyEvidenceObservation[]>()
  for (const row of observations) {
    const key = `${row.strategy_id}|${row.strategy_version}`
    byStrategy.set(key, [...(byStrategy.get(key) ?? []), row])
  }
  const metricRows = profiles.flatMap((profile) => computeStrategyEvidenceMetricRows(
    profile,
    byStrategy.get(`${profile.strategy_id}|${profile.strategy_version}`) ?? [],
    options.outcomeAsOfDate,
  )).map((row) => ({
    ...row,
    evidence_json: JSON.stringify({
      ...JSON.parse(row.evidence_json) as Record<string, unknown>,
      materialization_source: source,
    }),
  }))
  await persistMetricRows(db, metricRows)
  const readyRows = metricRows.filter((row) => row.metric_status === 'ready').length
  return {
    profiles: profiles.length,
    observations: observations.length,
    metric_rows: metricRows.length,
    ready_rows: readyRows,
    source,
    summary: `strategy_evidence_metrics source=${source} profiles=${profiles.length} observations=${observations.length} rows=${metricRows.length} ready=${readyRows}`,
  }
}
