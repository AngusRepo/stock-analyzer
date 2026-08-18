export const STRATEGY_ROUTE_CALIBRATION_ARTIFACT_VERSION = 'strategy-route-calibration-v1'
export const STRATEGY_ROUTE_CHALLENGER_VERSION = 'strategy-threshold-margin-affinity-v2'

const MIN_TRAIN_DATES = 3
const MIN_OOS_DATES = 3
const PURGE_DATES = 5
const MIN_TOTAL_DATES = MIN_TRAIN_DATES + PURGE_DATES + MIN_OOS_DATES
export const STRATEGY_ROUTE_MIN_TRAIN_DATES = MIN_TRAIN_DATES
export const STRATEGY_ROUTE_MIN_OOS_DATES = MIN_OOS_DATES
export const STRATEGY_ROUTE_PURGE_DATES = PURGE_DATES
export const STRATEGY_ROUTE_MIN_TOTAL_DATES = MIN_TOTAL_DATES
const LOOKBACK_CALENDAR_DAYS = 540
const PAGE_SIZE = 1000

export interface StrategyRouteObservation {
  signal_date: string
  symbol: string
  route_score: number | string
  absolute_return_net: number | string
  residual_return_net: number | string
}

interface DateSummary {
  date: string
  absolute: number
  spread: number
  selected: number
  total: number
}

export interface StrategyRouteCalibrationResult {
  status: 'pass' | 'fail' | 'pending_maturity'
  routeFloor: number | null
  sampleCount: number
  dateCount: number
  trainDates: string[]
  purgeDates: string[]
  oosDates: string[]
  topBucketNetReturn: number | null
  topBucketNetReturnLcb90: number | null
  residualSpread: number | null
  residualSpreadLcb90: number | null
  brierScore: number | null
  climatologyBrierScore: number | null
  logLoss: number | null
  gates: Record<string, boolean>
}

export interface StrategyRouteCurrentCoverage {
  referenceRows: number
  thresholdAffinityRows: number
  challengerRouteRows: number
  thresholdAffinityComplete: boolean
  challengerRouteComplete: boolean
}

function finite(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
}

function lcb90(values: number[]): number | null {
  const average = mean(values)
  if (average == null || values.length < 2) return null
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1)
  const criticalByDf = [
    0, 3.077684, 1.885618, 1.637744, 1.533206, 1.475884,
    1.439756, 1.414924, 1.396815, 1.383029, 1.372184,
  ]
  const df = values.length - 1
  const critical = df < criticalByDf.length ? criticalByDf[df] : 1.281552
  return average - critical * Math.sqrt(variance) / Math.sqrt(values.length)
}

function quantile(values: number[], q: number): number | null {
  const sorted = [...values].sort((left, right) => left - right)
  if (!sorted.length) return null
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)))
  return sorted[index]
}

function summarizeDates(rows: StrategyRouteObservation[], dates: Set<string>, floor: number): DateSummary[] {
  const byDate = new Map<string, StrategyRouteObservation[]>()
  for (const row of rows) {
    if (!dates.has(row.signal_date)) continue
    const bucket = byDate.get(row.signal_date) ?? []
    bucket.push(row)
    byDate.set(row.signal_date, bucket)
  }
  const output: DateSummary[] = []
  for (const [date, dateRows] of byDate.entries()) {
    const valid = dateRows
      .map((row) => ({
        score: finite(row.route_score),
        absolute: finite(row.absolute_return_net),
        residual: finite(row.residual_return_net),
      }))
      .filter((row): row is { score: number; absolute: number; residual: number } => (
        row.score != null && row.absolute != null && row.residual != null
      ))
    const selected = valid.filter((row) => row.score >= floor)
    const rejected = valid.filter((row) => row.score < floor)
    if (!selected.length || !rejected.length) continue
    output.push({
      date,
      absolute: mean(selected.map((row) => row.absolute))!,
      spread: mean(selected.map((row) => row.residual))! - mean(rejected.map((row) => row.residual))!,
      selected: selected.length,
      total: valid.length,
    })
  }
  return output.sort((left, right) => left.date.localeCompare(right.date))
}

function calibrationMetrics(
  rows: StrategyRouteObservation[],
  trainDates: Set<string>,
  oosDates: Set<string>,
): { brier: number | null; climatologyBrier: number | null; logLoss: number | null } {
  const bins = Array.from({ length: 5 }, () => ({ positive: 1, total: 2 }))
  const trainOutcomes: number[] = []
  for (const row of rows) {
    if (!trainDates.has(row.signal_date)) continue
    const score = finite(row.route_score)
    const absolute = finite(row.absolute_return_net)
    if (score == null || absolute == null) continue
    const outcome = absolute > 0 ? 1 : 0
    const index = Math.min(4, Math.max(0, Math.floor(score / 20)))
    bins[index].positive += outcome
    bins[index].total += 1
    trainOutcomes.push(outcome)
  }
  if (!trainOutcomes.length) return { brier: null, climatologyBrier: null, logLoss: null }
  const baseRate = mean(trainOutcomes)!
  const squared: number[] = []
  const baselineSquared: number[] = []
  const losses: number[] = []
  for (const row of rows) {
    if (!oosDates.has(row.signal_date)) continue
    const score = finite(row.route_score)
    const absolute = finite(row.absolute_return_net)
    if (score == null || absolute == null) continue
    const outcome = absolute > 0 ? 1 : 0
    const index = Math.min(4, Math.max(0, Math.floor(score / 20)))
    const probability = Math.min(1 - 1e-6, Math.max(1e-6, bins[index].positive / bins[index].total))
    squared.push((probability - outcome) ** 2)
    baselineSquared.push((baseRate - outcome) ** 2)
    losses.push(-(outcome * Math.log(probability) + (1 - outcome) * Math.log(1 - probability)))
  }
  return {
    brier: mean(squared),
    climatologyBrier: mean(baselineSquared),
    logLoss: mean(losses),
  }
}

export function evaluateStrategyRouteCalibration(
  observations: StrategyRouteObservation[],
): StrategyRouteCalibrationResult {
  const valid = observations.filter((row) => (
    finite(row.route_score) != null
    && finite(row.absolute_return_net) != null
    && finite(row.residual_return_net) != null
  ))
  const dates = [...new Set(valid.map((row) => row.signal_date))].sort()
  const oosCount = Math.max(STRATEGY_ROUTE_MIN_OOS_DATES, Math.floor(dates.length * 0.3))
  const trainEnd = Math.max(0, dates.length - oosCount - STRATEGY_ROUTE_PURGE_DATES)
  const trainDates = dates.slice(0, trainEnd)
  const purgeDates = dates.slice(trainEnd, Math.max(trainEnd, dates.length - oosCount))
  const oosDates = dates.slice(Math.max(trainEnd, dates.length - oosCount))
  const trainSet = new Set(trainDates)
  const oosSet = new Set(oosDates)
  const trainScores = valid.filter((row) => trainSet.has(row.signal_date)).map((row) => Number(row.route_score))
  const thresholds = [...new Set([0.2, 0.35, 0.5, 0.65, 0.8]
    .map((q) => quantile(trainScores, q))
    .filter((value): value is number => value != null))]
  let routeFloor: number | null = null
  let bestObjective = Number.NEGATIVE_INFINITY
  for (const threshold of thresholds) {
    const summary = summarizeDates(valid, trainSet, threshold)
    const selected = summary.reduce((sum, row) => sum + row.selected, 0)
    const total = summary.reduce((sum, row) => sum + row.total, 0)
    const coverage = total > 0 ? selected / total : 0
    if (summary.length < 3 || coverage < 0.05 || coverage > 0.60) continue
    const objective = (mean(summary.map((row) => row.spread)) ?? -1)
      + (mean(summary.map((row) => row.absolute)) ?? -1) * 0.25
    if (objective > bestObjective) {
      bestObjective = objective
      routeFloor = threshold
    }
  }
  const oos = routeFloor == null ? [] : summarizeDates(valid, oosSet, routeFloor)
  const topBucket = oos.map((row) => row.absolute)
  const spreads = oos.map((row) => row.spread)
  const calibration = calibrationMetrics(valid, trainSet, oosSet)
  const gates = {
    enough_total_dates: dates.length >= STRATEGY_ROUTE_MIN_TOTAL_DATES,
    enough_train_dates: trainDates.length >= STRATEGY_ROUTE_MIN_TRAIN_DATES,
    enough_oos_dates: oos.length >= STRATEGY_ROUTE_MIN_OOS_DATES,
    route_floor_selected_on_train_only: routeFloor != null,
    top_bucket_cost_net_return_lcb90_positive: (lcb90(topBucket) ?? Number.NEGATIVE_INFINITY) > 0,
    residual_spread_lcb90_positive: (lcb90(spreads) ?? Number.NEGATIVE_INFINITY) > 0,
    calibrated_probability_beats_climatology: calibration.brier != null
      && calibration.climatologyBrier != null
      && calibration.brier < calibration.climatologyBrier,
  }
  return {
    status: !gates.enough_total_dates
      ? 'pending_maturity'
      : Object.values(gates).every(Boolean) ? 'pass' : 'fail',
    routeFloor,
    sampleCount: valid.length,
    dateCount: dates.length,
    trainDates,
    purgeDates,
    oosDates,
    topBucketNetReturn: mean(topBucket),
    topBucketNetReturnLcb90: lcb90(topBucket),
    residualSpread: mean(spreads),
    residualSpreadLcb90: lcb90(spreads),
    brierScore: calibration.brier,
    climatologyBrierScore: calibration.climatologyBrier,
    logLoss: calibration.logLoss,
    gates,
  }
}

async function fingerprint(rows: StrategyRouteObservation[]): Promise<string> {
  const payload = JSON.stringify(rows.map((row) => [
    row.signal_date, row.symbol, Number(row.route_score),
    Number(row.absolute_return_net), Number(row.residual_return_net),
  ]))
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload))
  return [...new Uint8Array(digest)].slice(0, 10).map((value) => value.toString(16).padStart(2, '0')).join('')
}

export async function inspectStrategyRouteCurrentCoverage(
  db: D1Database,
  asOfDate: string,
  canonicalRunIds?: Record<string, string>,
): Promise<StrategyRouteCurrentCoverage> {
  const canonicalOwnerClause = 'EXISTS (SELECT 1 FROM json_each(?) h WHERE h.key=r.signal_date AND h.value=r.producer_run_id)'
  const row = await db.prepare(`
    SELECT COUNT(*) reference_rows,
           SUM(CASE WHEN r.strategy_challenger_affinity_version=? THEN 1 ELSE 0 END) threshold_affinity_rows,
           SUM(CASE WHEN r.strategy_challenger_route_version=?
                     AND r.strategy_challenger_route_score IS NOT NULL THEN 1 ELSE 0 END) challenger_route_rows
      FROM selection_reference_snapshots_v1 r
     WHERE r.signal_date=?
       AND r.hard_gate_passed=1
       AND ${canonicalOwnerClause}
  `).bind(
    STRATEGY_ROUTE_CHALLENGER_VERSION,
    STRATEGY_ROUTE_CHALLENGER_VERSION,
    asOfDate,
    JSON.stringify(canonicalRunIds ?? {}),
  ).first<{
    reference_rows?: number | string
    threshold_affinity_rows?: number | string
    challenger_route_rows?: number | string
  }>()
  const referenceRows = Math.max(0, Number(row?.reference_rows ?? 0))
  const thresholdAffinityRows = Math.max(0, Number(row?.threshold_affinity_rows ?? 0))
  const challengerRouteRows = Math.max(0, Number(row?.challenger_route_rows ?? 0))
  return {
    referenceRows,
    thresholdAffinityRows,
    challengerRouteRows,
    thresholdAffinityComplete: referenceRows > 0 && thresholdAffinityRows === referenceRows,
    challengerRouteComplete: referenceRows > 0 && challengerRouteRows === referenceRows,
  }
}

export async function refreshStrategyRouteCalibration(
  db: D1Database,
  asOfDate: string,
  options: { allowPromotion?: boolean; canonicalRunIds?: Record<string, string> } = {},
): Promise<{ runId: string; status: 'pass' | 'fail' | 'pending_maturity' | 'promoted'; result: StrategyRouteCalibrationResult }> {
  const endMs = Date.parse(asOfDate + 'T00:00:00Z')
  if (!Number.isFinite(endMs)) throw new Error('invalid_strategy_route_calibration_date:' + asOfDate)
  const startDate = new Date(endMs - LOOKBACK_CALENDAR_DAYS * 86_400_000).toISOString().slice(0, 10)
  const rows: StrategyRouteObservation[] = []
  const canonicalOwnerClause = 'EXISTS (SELECT 1 FROM json_each(?) h WHERE h.key=r.signal_date AND h.value=r.producer_run_id)'
  let cursorDate = ''
  let cursorSymbol = ''
  for (;;) {
    const page = await db.prepare(`
      SELECT r.signal_date, r.symbol, r.strategy_challenger_route_score route_score,
             l.absolute_return_net, l.residual_return_net
        FROM selection_reference_snapshots_v1 r
        JOIN canonical_selection_labels_v4 l
          ON l.signal_date=r.signal_date AND l.symbol=r.symbol AND l.producer_run_id=r.producer_run_id
       WHERE r.signal_date BETWEEN ? AND ?
         AND r.strategy_challenger_route_version=?
         AND r.strategy_challenger_route_score IS NOT NULL
         AND l.label_schema_version='canonical-strategy-selection-label-v4'
         AND l.outcome_known_date <= ?
         AND ${canonicalOwnerClause}
         AND (r.signal_date > ? OR (r.signal_date=? AND r.symbol > ?))
       ORDER BY r.signal_date, r.symbol
       LIMIT ?
    `).bind(
      startDate, asOfDate, STRATEGY_ROUTE_CHALLENGER_VERSION, asOfDate,
      JSON.stringify(options.canonicalRunIds ?? {}),
      cursorDate, cursorDate, cursorSymbol, PAGE_SIZE,
    ).all<StrategyRouteObservation>()
    const pageRows = page.results ?? []
    rows.push(...pageRows)
    if (pageRows.length < PAGE_SIZE) break
    cursorDate = pageRows.at(-1)!.signal_date
    cursorSymbol = pageRows.at(-1)!.symbol
  }
  const evaluated = evaluateStrategyRouteCalibration(rows)
  const currentCoverage = await inspectStrategyRouteCurrentCoverage(db, asOfDate, options.canonicalRunIds)
  const currentCoverageReady = currentCoverage.thresholdAffinityComplete
    && currentCoverage.challengerRouteComplete
  const result: StrategyRouteCalibrationResult = {
    ...evaluated,
    gates: {
      ...evaluated.gates,
      current_day_threshold_affinity_complete: currentCoverage.thresholdAffinityComplete,
      current_day_challenger_route_complete: currentCoverage.challengerRouteComplete,
    },
  }
  const runId = `${STRATEGY_ROUTE_CALIBRATION_ARTIFACT_VERSION}-${asOfDate}-${await fingerprint(rows)}`
  const promoted = result.status === 'pass' && currentCoverageReady && options.allowPromotion === true && result.routeFloor != null
  const status: 'pass' | 'fail' | 'pending_maturity' | 'promoted' = promoted ? 'promoted' : result.status
  await db.prepare(`
    INSERT INTO strategy_route_calibration_runs_v1 (
      run_id, artifact_version, as_of_date, status, candidate_route_version, route_floor,
      sample_count, date_count, train_start_date, train_end_date, oos_start_date, oos_end_date,
      top_bucket_net_return, top_bucket_net_return_lcb90, residual_spread, residual_spread_lcb90,
      brier_score, climatology_brier_score, log_loss, gate_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      status=excluded.status, route_floor=excluded.route_floor, sample_count=excluded.sample_count,
      date_count=excluded.date_count, top_bucket_net_return=excluded.top_bucket_net_return,
      top_bucket_net_return_lcb90=excluded.top_bucket_net_return_lcb90,
      residual_spread=excluded.residual_spread, residual_spread_lcb90=excluded.residual_spread_lcb90,
      brier_score=excluded.brier_score, climatology_brier_score=excluded.climatology_brier_score,
      log_loss=excluded.log_loss, gate_json=excluded.gate_json
  `).bind(
    runId, STRATEGY_ROUTE_CALIBRATION_ARTIFACT_VERSION, asOfDate, status,
    STRATEGY_ROUTE_CHALLENGER_VERSION, result.routeFloor, result.sampleCount, result.dateCount,
    result.trainDates[0] ?? null, result.trainDates.at(-1) ?? null,
    result.oosDates[0] ?? null, result.oosDates.at(-1) ?? null,
    result.topBucketNetReturn, result.topBucketNetReturnLcb90,
    result.residualSpread, result.residualSpreadLcb90,
    result.brierScore, result.climatologyBrierScore, result.logLoss,
    JSON.stringify({
      ...result.gates,
      _metadata: {
        purge_dates: result.purgeDates,
        no_top_k: true,
        point_in_time: true,
        current_day_reference_rows: currentCoverage.referenceRows,
        current_day_threshold_affinity_rows: currentCoverage.thresholdAffinityRows,
        current_day_challenger_route_rows: currentCoverage.challengerRouteRows,
      },
    }),
  ).run()
  if (promoted) {
    await db.prepare(`
      INSERT INTO strategy_route_calibration_head_v1 (
        singleton_id, run_id, artifact_version, candidate_route_version, route_floor
      ) VALUES (1, ?, ?, ?, ?)
      ON CONFLICT(singleton_id) DO UPDATE SET
        run_id=excluded.run_id, artifact_version=excluded.artifact_version,
        candidate_route_version=excluded.candidate_route_version,
        route_floor=excluded.route_floor, promoted_at=CURRENT_TIMESTAMP
    `).bind(
      runId, STRATEGY_ROUTE_CALIBRATION_ARTIFACT_VERSION,
      STRATEGY_ROUTE_CHALLENGER_VERSION, result.routeFloor,
    ).run()
  }
  return { runId, status, result }
}

export async function loadPromotedStrategyRouteCalibration(
  db: D1Database,
): Promise<{ runId: string; routeVersion: string; routeFloor: number } | null> {
  const row = await db.prepare(`
    SELECT h.run_id, h.candidate_route_version, h.route_floor
      FROM strategy_route_calibration_head_v1 h
      JOIN strategy_route_calibration_runs_v1 r ON r.run_id=h.run_id
     WHERE h.singleton_id=1 AND r.status='promoted'
  `).first<{ run_id?: string; candidate_route_version?: string; route_floor?: number | string }>()
  const floor = finite(row?.route_floor)
  if (!row?.run_id || row.candidate_route_version !== STRATEGY_ROUTE_CHALLENGER_VERSION || floor == null) return null
  return { runId: row.run_id, routeVersion: row.candidate_route_version, routeFloor: floor }
}
