import type {
  StrategyFeatureRefWeightedScoreCalibration,
  StrategySpec,
  StrategySpecThresholds,
} from './strategySpec'

export type StrategyThresholdCalibrationCadence = 'daily_drift' | 'weekly' | 'monthly' | 'regime_shift'
export type StrategyThresholdCalibrationStatus = 'approved' | 'rejected' | 'frozen' | 'rolled_back'

export interface StrategyThresholdCalibrationArtifactRow {
  artifact_id: string
  run_id: string
  strategy_id: string
  strategy_version: string
  target_key?: string | null
  status: StrategyThresholdCalibrationStatus
  cadence: StrategyThresholdCalibrationCadence
  base_min: number
  previous_min: number | null
  calibrated_min: number
  delta: number
  validation_start: string
  validation_end: string
  guardrails_json: string
  metrics_json: string
  source_refs_json: string
  created_at: string
  approved_at: string | null
  superseded_at: string | null
}

export interface StrategyThresholdCalibrationRunRow {
  run_id: string
  run_date: string
  cadence: StrategyThresholdCalibrationCadence
  status: 'success' | 'partial' | 'skipped' | 'failed'
  specs_seen: number
  artifacts_written: number
  guardrails_json: string
  summary_json: string
  created_at: string
}

export interface StrategyThresholdCalibrationEvidenceRow {
  date: string
  strategy_id: string
  strategy_version: string
  weighted_score: number | null
  raw_signals?: Record<string, unknown> | null
  reward_pct: number | null
}

export interface StrategyThresholdAutoCalibrationOptions {
  runDate: string
  cadence: StrategyThresholdCalibrationCadence
  startDate?: string
  endDate?: string
  minSamples?: number
  minCompleteScoreRows?: number
  minDailyMatches?: number
  maxDailyMatches?: number
  maxWeeklyDelta?: number
  maxMonthlyDelta?: number
  hitRateFloor?: number
  avgReturnFloor?: number
  maxDrawdownFloor?: number
  currentReturnTolerance?: number
  currentHitRateTolerance?: number
}

export interface StrategyThresholdGuardrails {
  minSamples: number
  minCompleteScoreRows: number
  minDailyMatches: number
  maxDailyMatches: number
  maxDelta: number
  hitRateFloor: number
  avgReturnFloor: number
  maxDrawdownFloor: number
  currentReturnTolerance: number
  currentHitRateTolerance: number
}

export interface StrategyThresholdCandidateMetrics {
  threshold: number
  completeScoreRows: number
  samples: number
  matchedRows: number
  avgDailyMatches: number
  hitRate: number | null
  avgReturnPct: number | null
  maxDrawdownPct: number | null
}

export interface StrategyThresholdAutoDecision {
  strategyId: string
  strategyVersion: string
  targetKey: string
  status: StrategyThresholdCalibrationStatus
  reason: string
  baseMin: number
  previousMin: number
  calibratedMin: number
  selected?: StrategyThresholdCandidateMetrics
  current?: StrategyThresholdCandidateMetrics
  candidates: StrategyThresholdCandidateMetrics[]
}

export interface StrategyThresholdAutoCalibrationResult {
  runId: string
  runDate: string
  cadence: StrategyThresholdCalibrationCadence
  mode: 'dry_run' | 'persisted'
  status: 'success' | 'partial' | 'skipped'
  specsSeen: number
  eligibleSpecs: number
  unsupportedSpecs: Array<{ strategyId: string; strategyVersion: string; reason: string }>
  artifactsWritten: number
  decisions: StrategyThresholdAutoDecision[]
  guardrails: StrategyThresholdGuardrails
  summary: string
}

const TABLE_DDL = [
  `CREATE TABLE IF NOT EXISTS strategy_threshold_calibration_runs (
    run_id TEXT PRIMARY KEY,
    run_date TEXT NOT NULL,
    cadence TEXT NOT NULL CHECK(cadence IN ('daily_drift','weekly','monthly','regime_shift')),
    status TEXT NOT NULL CHECK(status IN ('success','partial','skipped','failed')),
    specs_seen INTEGER NOT NULL DEFAULT 0,
    artifacts_written INTEGER NOT NULL DEFAULT 0,
    guardrails_json TEXT NOT NULL DEFAULT '{}',
    summary_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS strategy_threshold_calibration_artifacts (
    artifact_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    strategy_id TEXT NOT NULL,
    strategy_version TEXT NOT NULL,
    target_key TEXT NOT NULL DEFAULT 'featureRefs.weightedScore.min',
    status TEXT NOT NULL CHECK(status IN ('approved','rejected','frozen','rolled_back')),
    cadence TEXT NOT NULL CHECK(cadence IN ('daily_drift','weekly','monthly','regime_shift')),
    base_min REAL NOT NULL,
    previous_min REAL,
    calibrated_min REAL NOT NULL,
    delta REAL NOT NULL,
    validation_start TEXT NOT NULL,
    validation_end TEXT NOT NULL,
    guardrails_json TEXT NOT NULL DEFAULT '{}',
    metrics_json TEXT NOT NULL DEFAULT '{}',
    source_refs_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    approved_at TEXT,
    superseded_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_strategy_threshold_artifacts_latest
    ON strategy_threshold_calibration_artifacts(strategy_id, strategy_version, target_key, status, approved_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_strategy_threshold_artifacts_run
    ON strategy_threshold_calibration_artifacts(run_id, status)`,
] as const

function safeJson(value: unknown): string {
  return JSON.stringify(value ?? null)
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function finiteNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

function stableIdPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 96)
}

function thresholdKey(strategyId: string, version: string): string {
  return `${strategyId}|${version}`
}

function thresholdTargetKey(strategyId: string, version: string, targetKey: string): string {
  return `${strategyId}|${version}|${targetKey}`
}

type RawScalarThresholdKey = keyof Pick<
  StrategySpecThresholds,
  | 'minCloseAboveMa20Pct'
  | 'maxCloseAboveMa20Pct'
  | 'minCloseAboveMa60Pct'
  | 'maxCloseAboveMa60Pct'
  | 'minVolumeExpansion20'
  | 'minReturn20d'
  | 'maxReturn20d'
  | 'minBrokerCount'
  | 'maxBrokerConcentration'
  | 'minRevenueGrowthYoY'
  | 'minMonthlyRevenueYoY'
  | 'minMonthlyRevenueMoM'
  | 'minGrossMargin'
  | 'minOperatingMargin'
  | 'minRoe'
  | 'minEps'
  | 'maxPe'
  | 'maxPb'
>

interface RawScalarThresholdTarget {
  targetKey: RawScalarThresholdKey
  signalKey: string
  direction: 'min' | 'max'
  weeklyDelta: number
  monthlyDelta: number
  minValue?: number
  maxValue?: number
}

const WEIGHTED_SCORE_TARGET_KEY = 'featureRefs.weightedScore.min'

const RAW_SCALAR_THRESHOLD_TARGETS: RawScalarThresholdTarget[] = [
  { targetKey: 'minCloseAboveMa20Pct', signalKey: 'closeAboveMa20Pct', direction: 'min', weeklyDelta: 0.02, monthlyDelta: 0.05, minValue: -0.25, maxValue: 0.25 },
  { targetKey: 'maxCloseAboveMa20Pct', signalKey: 'closeAboveMa20Pct', direction: 'max', weeklyDelta: 0.02, monthlyDelta: 0.05, minValue: -0.25, maxValue: 0.35 },
  { targetKey: 'minCloseAboveMa60Pct', signalKey: 'closeAboveMa60Pct', direction: 'min', weeklyDelta: 0.03, monthlyDelta: 0.08, minValue: -0.35, maxValue: 0.45 },
  { targetKey: 'maxCloseAboveMa60Pct', signalKey: 'closeAboveMa60Pct', direction: 'max', weeklyDelta: 0.03, monthlyDelta: 0.08, minValue: -0.35, maxValue: 0.55 },
  { targetKey: 'minVolumeExpansion20', signalKey: 'volumeExpansion20', direction: 'min', weeklyDelta: 0.2, monthlyDelta: 0.5, minValue: 0, maxValue: 6 },
  { targetKey: 'minReturn20d', signalKey: 'return20d', direction: 'min', weeklyDelta: 0.04, monthlyDelta: 0.1, minValue: -0.5, maxValue: 1 },
  { targetKey: 'maxReturn20d', signalKey: 'return20d', direction: 'max', weeklyDelta: 0.04, monthlyDelta: 0.1, minValue: -0.5, maxValue: 1.2 },
  { targetKey: 'minBrokerCount', signalKey: 'brokerCount', direction: 'min', weeklyDelta: 1, monthlyDelta: 2, minValue: 0, maxValue: 30 },
  { targetKey: 'maxBrokerConcentration', signalKey: 'brokerConcentration', direction: 'max', weeklyDelta: 0.05, monthlyDelta: 0.12, minValue: 0, maxValue: 1 },
  { targetKey: 'minRevenueGrowthYoY', signalKey: 'revenueGrowthYoY', direction: 'min', weeklyDelta: 2, monthlyDelta: 5, minValue: -80, maxValue: 200 },
  { targetKey: 'minMonthlyRevenueYoY', signalKey: 'monthlyRevenueYoY', direction: 'min', weeklyDelta: 2, monthlyDelta: 5, minValue: -80, maxValue: 250 },
  { targetKey: 'minMonthlyRevenueMoM', signalKey: 'monthlyRevenueMoM', direction: 'min', weeklyDelta: 2, monthlyDelta: 5, minValue: -80, maxValue: 160 },
  { targetKey: 'minGrossMargin', signalKey: 'grossMargin', direction: 'min', weeklyDelta: 2, monthlyDelta: 5, minValue: -80, maxValue: 100 },
  { targetKey: 'minOperatingMargin', signalKey: 'operatingMargin', direction: 'min', weeklyDelta: 2, monthlyDelta: 5, minValue: -100, maxValue: 100 },
  { targetKey: 'minRoe', signalKey: 'roe', direction: 'min', weeklyDelta: 2, monthlyDelta: 5, minValue: -100, maxValue: 150 },
  { targetKey: 'minEps', signalKey: 'eps', direction: 'min', weeklyDelta: 1, monthlyDelta: 3, minValue: -30, maxValue: 100 },
  { targetKey: 'maxPe', signalKey: 'pe', direction: 'max', weeklyDelta: 5, monthlyDelta: 12, minValue: 0, maxValue: 300 },
  { targetKey: 'maxPb', signalKey: 'pb', direction: 'max', weeklyDelta: 1, monthlyDelta: 3, minValue: 0, maxValue: 80 },
]

const RAW_SCALAR_THRESHOLD_TARGET_BY_KEY = new Map<string, RawScalarThresholdTarget>(
  RAW_SCALAR_THRESHOLD_TARGETS.map((target) => [target.targetKey, target]),
)

function currentWeightedMin(spec: StrategySpec): number | null {
  const weighted = spec.thresholds.featureRefs?.weightedScore
  if (!weighted) return null
  const embedded = weighted.calibration?.status === 'active'
    ? finiteNumber(weighted.calibration.calibratedMin)
    : null
  return embedded ?? finiteNumber(weighted.min)
}

function baseWeightedMin(spec: StrategySpec): number | null {
  return finiteNumber(spec.thresholds.featureRefs?.weightedScore?.min)
}

function rawScalarThresholdValue(spec: StrategySpec, target: RawScalarThresholdTarget): number | null {
  return finiteNumber(spec.thresholds[target.targetKey])
}

export function classifyStrategyThresholdCalibrationCoverage(specs: StrategySpec[]): {
  eligible: StrategySpec[]
  unsupported: Array<{ strategyId: string; strategyVersion: string; reason: string }>
} {
  const runtimeSpecs = specs.filter((spec) => spec.status === 'active' || spec.status === 'candidate')
  const eligible: StrategySpec[] = []
  const unsupported: Array<{ strategyId: string; strategyVersion: string; reason: string }> = []
  for (const spec of runtimeSpecs) {
    const hasWeightedScore = baseWeightedMin(spec) != null && spec.thresholds.featureRefs?.weightedScore
    const hasRawScalarThreshold = RAW_SCALAR_THRESHOLD_TARGETS.some((target) => rawScalarThresholdValue(spec, target) != null)
    if (hasWeightedScore || hasRawScalarThreshold) {
      eligible.push(spec)
      continue
    }
    unsupported.push({
      strategyId: spec.id,
      strategyVersion: spec.version,
      reason: 'unsupported_threshold_shape_no_weighted_score_or_raw_scalar_threshold',
    })
  }
  return { eligible, unsupported }
}

function defaultGuardrails(options: StrategyThresholdAutoCalibrationOptions): StrategyThresholdGuardrails {
  return {
    minSamples: options.minSamples ?? 30,
    minCompleteScoreRows: options.minCompleteScoreRows ?? 120,
    minDailyMatches: options.minDailyMatches ?? 20,
    maxDailyMatches: options.maxDailyMatches ?? 320,
    maxDelta: options.cadence === 'monthly'
      ? options.maxMonthlyDelta ?? 0.10
      : options.maxWeeklyDelta ?? 0.05,
    hitRateFloor: options.hitRateFloor ?? 0.50,
    avgReturnFloor: options.avgReturnFloor ?? 0,
    maxDrawdownFloor: options.maxDrawdownFloor ?? -0.08,
    currentReturnTolerance: options.currentReturnTolerance ?? 0.0025,
    currentHitRateTolerance: options.currentHitRateTolerance ?? 0.03,
  }
}

function daysBefore(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime())) return date
  parsed.setUTCDate(parsed.getUTCDate() - days)
  return parsed.toISOString().slice(0, 10)
}

function maxDrawdownPct(rewards: number[]): number | null {
  if (!rewards.length) return null
  let equity = 0
  let peak = 0
  let mdd = 0
  for (const reward of rewards) {
    equity += reward
    peak = Math.max(peak, equity)
    mdd = Math.min(mdd, equity - peak)
  }
  return round6(mdd)
}

function buildWeightedThresholdGrid(baseMin: number, currentMin: number, maxDelta: number): number[] {
  const values = new Set<number>()
  for (let raw = baseMin - 0.12; raw <= baseMin + 0.22; raw += 0.02) {
    const clampedToDelta = Math.max(currentMin - maxDelta, Math.min(currentMin + maxDelta, raw))
    values.add(round6(Math.max(0, Math.min(1, clampedToDelta))))
  }
  values.add(round6(Math.max(0, Math.min(1, baseMin))))
  values.add(round6(Math.max(0, Math.min(1, currentMin))))
  return [...values].sort((a, b) => a - b)
}

function clampThresholdValue(value: number, target?: RawScalarThresholdTarget): number {
  if (!target) return Math.max(0, Math.min(1, value))
  return Math.max(target.minValue ?? -Infinity, Math.min(target.maxValue ?? Infinity, value))
}

function rawSignalValue(row: StrategyThresholdCalibrationEvidenceRow, target: RawScalarThresholdTarget): number | null {
  return finiteNumber(row.raw_signals?.[target.signalKey])
}

function thresholdObservedValue(row: StrategyThresholdCalibrationEvidenceRow, target?: RawScalarThresholdTarget): number | null {
  return target ? rawSignalValue(row, target) : finiteNumber(row.weighted_score)
}

function rowPassesThreshold(row: StrategyThresholdCalibrationEvidenceRow, threshold: number, target?: RawScalarThresholdTarget): boolean {
  const value = thresholdObservedValue(row, target)
  if (value == null) return false
  if (!target || target.direction === 'min') return value >= threshold
  return value <= threshold
}

function quantile(values: number[], q: number): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.round((sorted.length - 1) * q)))
  return sorted[idx]
}

function buildRawScalarThresholdGrid(
  rows: StrategyThresholdCalibrationEvidenceRow[],
  currentValue: number,
  target: RawScalarThresholdTarget,
  cadence: StrategyThresholdCalibrationCadence,
): number[] {
  const maxDelta = cadence === 'monthly' ? target.monthlyDelta : target.weeklyDelta
  const values = new Set<number>()
  const observed = rows
    .map((row) => rawSignalValue(row, target))
    .filter((value): value is number => value != null)
  for (const q of [0.15, 0.25, 0.35, 0.5, 0.65, 0.75, 0.85]) {
    const candidate = quantile(observed, q)
    if (candidate == null) continue
    const clampedToDelta = Math.max(currentValue - maxDelta, Math.min(currentValue + maxDelta, candidate))
    values.add(round6(clampThresholdValue(clampedToDelta, target)))
  }
  values.add(round6(clampThresholdValue(currentValue, target)))
  values.add(round6(clampThresholdValue(currentValue - maxDelta, target)))
  values.add(round6(clampThresholdValue(currentValue + maxDelta, target)))
  return [...values].sort((a, b) => a - b)
}

function evaluateThreshold(
  rows: StrategyThresholdCalibrationEvidenceRow[],
  threshold: number,
  target?: RawScalarThresholdTarget,
): StrategyThresholdCandidateMetrics {
  const complete = rows.filter((row) => thresholdObservedValue(row, target) != null)
  const matched = complete.filter((row) => rowPassesThreshold(row, threshold, target))
  const rewardRows = matched.filter((row) => row.reward_pct != null)
  const rewards = rewardRows.map((row) => row.reward_pct as number)
  const dates = new Set(matched.map((row) => row.date))
  const avgDailyMatches = dates.size > 0 ? matched.length / dates.size : 0
  const rewardSum = rewards.reduce((sum, value) => sum + value, 0)
  return {
    threshold: round6(threshold),
    completeScoreRows: complete.length,
    samples: rewards.length,
    matchedRows: matched.length,
    avgDailyMatches: round6(avgDailyMatches),
    hitRate: rewards.length ? round6(rewards.filter((reward) => reward > 0).length / rewards.length) : null,
    avgReturnPct: rewards.length ? round6(rewardSum / rewards.length) : null,
    maxDrawdownPct: maxDrawdownPct(rewards),
  }
}

function passesCandidateGuardrails(
  candidate: StrategyThresholdCandidateMetrics,
  current: StrategyThresholdCandidateMetrics,
  guardrails: StrategyThresholdGuardrails,
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = []
  if (candidate.completeScoreRows < guardrails.minCompleteScoreRows) reasons.push(`complete_score_rows_lt_${guardrails.minCompleteScoreRows}`)
  if (candidate.samples < guardrails.minSamples) reasons.push(`samples_lt_${guardrails.minSamples}`)
  if (candidate.avgDailyMatches < guardrails.minDailyMatches) reasons.push(`avg_daily_matches_lt_${guardrails.minDailyMatches}`)
  if (candidate.avgDailyMatches > guardrails.maxDailyMatches) reasons.push(`avg_daily_matches_gt_${guardrails.maxDailyMatches}`)
  if (candidate.hitRate == null || candidate.hitRate < guardrails.hitRateFloor) reasons.push(`hit_rate_lt_${guardrails.hitRateFloor}`)
  if (candidate.avgReturnPct == null || candidate.avgReturnPct < guardrails.avgReturnFloor) reasons.push('avg_return_not_positive')
  if (candidate.maxDrawdownPct != null && candidate.maxDrawdownPct < guardrails.maxDrawdownFloor) reasons.push(`max_drawdown_lt_${guardrails.maxDrawdownFloor}`)
  if (
    current.avgReturnPct != null &&
    candidate.avgReturnPct != null &&
    candidate.avgReturnPct < current.avgReturnPct - guardrails.currentReturnTolerance
  ) {
    reasons.push('avg_return_worse_than_current_tolerance')
  }
  if (
    current.hitRate != null &&
    candidate.hitRate != null &&
    candidate.hitRate < current.hitRate - guardrails.currentHitRateTolerance
  ) {
    reasons.push('hit_rate_worse_than_current_tolerance')
  }
  return { ok: reasons.length === 0, reasons }
}

function selectThresholdCandidate(
  candidates: StrategyThresholdCandidateMetrics[],
  current: StrategyThresholdCandidateMetrics,
  guardrails: StrategyThresholdGuardrails,
): { selected: StrategyThresholdCandidateMetrics | null; reason: string } {
  const passing = candidates.filter((candidate) => passesCandidateGuardrails(candidate, current, guardrails).ok)
  if (!passing.length) {
    const bestReason = candidates
      .map((candidate) => passesCandidateGuardrails(candidate, current, guardrails).reasons.join('|'))
      .find(Boolean)
    return { selected: null, reason: bestReason || 'no_candidate_passed_guardrails' }
  }
  const currentPasses = passesCandidateGuardrails(current, current, guardrails).ok
  const sorted = passing.sort((a, b) => {
    const aBreadthPenalty = Math.abs(a.avgDailyMatches - Math.min(Math.max(a.avgDailyMatches, guardrails.minDailyMatches), guardrails.maxDailyMatches))
    const bBreadthPenalty = Math.abs(b.avgDailyMatches - Math.min(Math.max(b.avgDailyMatches, guardrails.minDailyMatches), guardrails.maxDailyMatches))
    if (aBreadthPenalty !== bBreadthPenalty) return aBreadthPenalty - bBreadthPenalty
    const aReturn = a.avgReturnPct ?? -Infinity
    const bReturn = b.avgReturnPct ?? -Infinity
    if (aReturn !== bReturn) return bReturn - aReturn
    const aHit = a.hitRate ?? -Infinity
    const bHit = b.hitRate ?? -Infinity
    if (aHit !== bHit) return bHit - aHit
    return b.threshold - a.threshold
  })
  const selected = sorted[0]
  if (currentPasses && Math.abs(selected.threshold - current.threshold) < 0.000001) {
    return { selected, reason: 'current_threshold_still_best' }
  }
  return { selected, reason: 'auto_approved_by_machine_guardrails' }
}

export async function ensureStrategyThresholdCalibrationTables(db: D1Database): Promise<void> {
  for (const sql of TABLE_DDL) {
    await db.prepare(sql).run()
  }
}

export async function listLatestApprovedStrategyThresholdCalibrations(
  db: D1Database,
): Promise<StrategyThresholdCalibrationArtifactRow[]> {
  await ensureStrategyThresholdCalibrationTables(db)
  const { results } = await db.prepare(`
    SELECT artifact_id, run_id, strategy_id, strategy_version, target_key, status, cadence,
           base_min, previous_min, calibrated_min, delta, validation_start, validation_end,
           guardrails_json, metrics_json, source_refs_json, created_at, approved_at, superseded_at
      FROM strategy_threshold_calibration_artifacts
     WHERE status = 'approved'
       AND superseded_at IS NULL
     ORDER BY approved_at DESC, created_at DESC
     LIMIT 500
  `).all<StrategyThresholdCalibrationArtifactRow>()
  const latest = new Map<string, StrategyThresholdCalibrationArtifactRow>()
  for (const row of results ?? []) {
    const key = thresholdTargetKey(row.strategy_id, row.strategy_version, row.target_key || WEIGHTED_SCORE_TARGET_KEY)
    if (!latest.has(key)) latest.set(key, row)
  }
  return [...latest.values()]
}

export function applyStrategyThresholdCalibrationArtifacts(
  specs: StrategySpec[],
  artifacts: StrategyThresholdCalibrationArtifactRow[],
): StrategySpec[] {
  const latest = new Map(artifacts.map((artifact) => [
    thresholdTargetKey(artifact.strategy_id, artifact.strategy_version, artifact.target_key || WEIGHTED_SCORE_TARGET_KEY),
    artifact,
  ]))
  return specs.map((spec) => {
    const weightedArtifact = latest.get(thresholdTargetKey(spec.id, spec.version, WEIGHTED_SCORE_TARGET_KEY))
    const weighted = spec.thresholds.featureRefs?.weightedScore
    let next: StrategySpec = spec
    if (weightedArtifact && weighted) {
      const calibratedMin = finiteNumber(weightedArtifact.calibrated_min)
      if (calibratedMin != null && calibratedMin >= 0 && calibratedMin <= 1) {
        const sourceRefs = parseJson<string[]>(weightedArtifact.source_refs_json, [])
        const metrics = parseJson<Record<string, unknown>>(weightedArtifact.metrics_json, {})
        const calibration: StrategyFeatureRefWeightedScoreCalibration = {
          schemaVersion: 'strategy-feature-ref-weighted-score-calibration-v1',
          calibrationId: weightedArtifact.artifact_id,
          status: 'active',
          method: 'auto_threshold_guardrail',
          originalMin: weightedArtifact.base_min,
          calibratedMin,
          validationFold: {
            startDate: weightedArtifact.validation_start,
            endDate: weightedArtifact.validation_end,
          },
          targetDailyMatches: Math.round(Number(metrics.avgDailyMatches ?? 0)),
          observed: {
            validationRows: Number(metrics.completeScoreRows ?? 0),
            validationCompleteFeatureRows: Number(metrics.completeScoreRows ?? 0),
            validationMatchesAtOriginalMin: Number(metrics.currentMatchedRows ?? 0),
            validationMatchesAtCalibratedMin: Number(metrics.matchedRows ?? 0),
          },
          sourceRefs,
          frozenAt: weightedArtifact.approved_at ?? weightedArtifact.created_at,
        }
        next = {
          ...next,
          thresholds: {
            ...next.thresholds,
            featureRefs: {
              ...next.thresholds.featureRefs,
              weightedScore: {
                ...weighted,
                calibration,
              },
            },
          },
        }
      }
    }
    for (const target of RAW_SCALAR_THRESHOLD_TARGETS) {
      const artifact = latest.get(thresholdTargetKey(spec.id, spec.version, target.targetKey))
      if (!artifact) continue
      const calibrated = finiteNumber(artifact.calibrated_min)
      if (calibrated == null) continue
      next = {
        ...next,
        thresholds: {
          ...next.thresholds,
          [target.targetKey]: clampThresholdValue(calibrated, target),
        },
      }
    }
    return next
  })
}

export async function listStrategyThresholdCalibrationEvidenceRows(
  db: D1Database,
  options: { startDate: string; endDate: string; limit?: number },
): Promise<StrategyThresholdCalibrationEvidenceRow[]> {
  const limit = Math.max(1, Math.min(Math.floor(options.limit ?? 50_000), 100_000))
  const { results } = await db.prepare(`
    SELECT l.date,
           l.strategy_id,
           l.strategy_version,
           CASE
             WHEN json_valid(l.evidence_json)
             THEN CAST(json_extract(l.evidence_json, '$.feature_ref_diagnostics.weighted_score') AS REAL)
             ELSE NULL
           END AS weighted_score,
           CASE
             WHEN json_valid(l.context_json)
             THEN json_extract(l.context_json, '$.candidate.raw_signals')
             ELSE NULL
           END AS raw_signals_json,
           COALESCE(p.trade_pnl_pct, p.actual_return_pct) AS reward_pct
      FROM strategy_decision_log l
      LEFT JOIN stocks s
        ON s.symbol = l.symbol
      LEFT JOIN predictions p
        ON p.stock_id = s.id
       AND p.prediction_date = l.date
       AND p.model_name = 'ensemble'
     WHERE l.date >= ?
       AND l.date <= ?
     ORDER BY l.date DESC, l.strategy_id ASC
     LIMIT ?
  `).bind(options.startDate, options.endDate, limit).all<StrategyThresholdCalibrationEvidenceRow & { raw_signals_json?: string | null }>()
  return (results ?? []).map((row) => ({
    ...row,
    raw_signals: parseJson<Record<string, unknown> | null>(row.raw_signals_json, null),
    weighted_score: finiteNumber(row.weighted_score),
    reward_pct: finiteNumber(row.reward_pct),
  }))
}

export function buildStrategyThresholdAutoDecisions(
  specs: StrategySpec[],
  evidenceRows: StrategyThresholdCalibrationEvidenceRow[],
  options: StrategyThresholdAutoCalibrationOptions,
): { guardrails: StrategyThresholdGuardrails; decisions: StrategyThresholdAutoDecision[] } {
  const guardrails = defaultGuardrails(options)
  const rowsByStrategy = new Map<string, StrategyThresholdCalibrationEvidenceRow[]>()
  for (const row of evidenceRows) {
    const key = thresholdKey(row.strategy_id, row.strategy_version)
    const bucket = rowsByStrategy.get(key) ?? []
    bucket.push(row)
    rowsByStrategy.set(key, bucket)
  }
  const decisions: StrategyThresholdAutoDecision[] = []
  for (const spec of classifyStrategyThresholdCalibrationCoverage(specs).eligible) {
    const rows = rowsByStrategy.get(thresholdKey(spec.id, spec.version)) ?? []

    const appendDecision = (
      targetKey: string,
      baseMin: number,
      previousMin: number,
      candidates: StrategyThresholdCandidateMetrics[],
      current: StrategyThresholdCandidateMetrics,
    ) => {
      if (!rows.length) {
        decisions.push({
          strategyId: spec.id,
          strategyVersion: spec.version,
          targetKey,
          status: 'frozen',
          reason: 'no_calibration_evidence_rows',
          baseMin,
          previousMin,
          calibratedMin: previousMin,
          current,
          candidates,
        })
        return
      }
      const selected = selectThresholdCandidate(candidates, current, guardrails)
      if (!selected.selected) {
        decisions.push({
          strategyId: spec.id,
          strategyVersion: spec.version,
          targetKey,
          status: 'frozen',
          reason: selected.reason,
          baseMin,
          previousMin,
          calibratedMin: previousMin,
          current,
          candidates,
        })
        return
      }
      decisions.push({
        strategyId: spec.id,
        strategyVersion: spec.version,
        targetKey,
        status: 'approved',
        reason: selected.reason,
        baseMin,
        previousMin,
        calibratedMin: selected.selected.threshold,
        selected: selected.selected,
        current,
        candidates,
      })
    }

    const baseMin = baseWeightedMin(spec)
    const previousMin = currentWeightedMin(spec)
    if (baseMin != null && previousMin != null && spec.thresholds.featureRefs?.weightedScore) {
      const grid = buildWeightedThresholdGrid(baseMin, previousMin, guardrails.maxDelta)
      const candidates = grid.map((threshold) => evaluateThreshold(rows, threshold))
      const current = evaluateThreshold(rows, previousMin)
      appendDecision(WEIGHTED_SCORE_TARGET_KEY, baseMin, previousMin, candidates, current)
    }

    for (const target of RAW_SCALAR_THRESHOLD_TARGETS) {
      const value = rawScalarThresholdValue(spec, target)
      if (value == null) continue
      const grid = buildRawScalarThresholdGrid(rows, value, target, options.cadence)
      const candidates = grid.map((threshold) => evaluateThreshold(rows, threshold, target))
      const current = evaluateThreshold(rows, value, target)
      appendDecision(target.targetKey, value, value, candidates, current)
    }
  }
  return { guardrails, decisions }
}

export async function persistStrategyThresholdAutoCalibrationResult(
  db: D1Database,
  result: Omit<StrategyThresholdAutoCalibrationResult, 'mode' | 'artifactsWritten'> & { mode?: 'dry_run' | 'persisted' },
  options: { dryRun?: boolean; validationStart: string; validationEnd: string; nowIso?: string },
): Promise<number> {
  await ensureStrategyThresholdCalibrationTables(db)
  const dryRun = options.dryRun !== false
  if (dryRun) return 0
  const nowIso = options.nowIso ?? new Date().toISOString()
  const approved = result.decisions.filter((decision) => decision.status === 'approved')
  const runSummary = result.summary || [
    `threshold_calibration cadence=${result.cadence}`,
    `status=${result.status}`,
    `approved=${approved.length}`,
    `decisions=${result.decisions.length}`,
    `eligible=${result.eligibleSpecs}`,
    `unsupported=${result.unsupportedSpecs.length}`,
  ].join(' ')
  await db.prepare(`
    INSERT INTO strategy_threshold_calibration_runs (
      run_id, run_date, cadence, status, specs_seen, artifacts_written,
      guardrails_json, summary_json, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    result.runId,
    result.runDate,
    result.cadence,
    result.status,
    result.specsSeen,
    approved.length,
    safeJson(result.guardrails),
    safeJson({
      summary: runSummary,
      coverage: {
        eligible_specs: result.eligibleSpecs,
        unsupported_specs: result.unsupportedSpecs,
      },
      decisions: result.decisions.map((row) => ({ strategyId: row.strategyId, targetKey: row.targetKey, status: row.status, reason: row.reason })),
    }),
    nowIso,
  ).run()

  for (const decision of approved) {
    await db.prepare(`
      UPDATE strategy_threshold_calibration_artifacts
         SET superseded_at = ?
       WHERE strategy_id = ?
         AND strategy_version = ?
         AND target_key = ?
         AND status = 'approved'
         AND superseded_at IS NULL
    `).bind(nowIso, decision.strategyId, decision.strategyVersion, decision.targetKey).run()
  }

  const statements = approved.map((decision) => {
    const selected = decision.selected
    const metrics = selected
      ? {
        ...selected,
        currentThreshold: decision.current?.threshold ?? decision.previousMin,
        currentMatchedRows: decision.current?.matchedRows ?? 0,
        currentAvgDailyMatches: decision.current?.avgDailyMatches ?? null,
      }
      : {}
    const artifactId = `strategy-threshold-${stableIdPart(decision.strategyId)}-${stableIdPart(decision.strategyVersion)}-${stableIdPart(decision.targetKey)}-${stableIdPart(result.cadence)}-${stableIdPart(result.runDate)}`
    return db.prepare(`
      INSERT INTO strategy_threshold_calibration_artifacts (
        artifact_id, run_id, strategy_id, strategy_version, target_key, status, cadence,
        base_min, previous_min, calibrated_min, delta, validation_start, validation_end,
        guardrails_json, metrics_json, source_refs_json, created_at, approved_at, superseded_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).bind(
      artifactId,
      result.runId,
      decision.strategyId,
      decision.strategyVersion,
      decision.targetKey,
      decision.status,
      result.cadence,
      decision.baseMin,
      decision.previousMin,
      decision.calibratedMin,
      round6(decision.calibratedMin - decision.previousMin),
      options.validationStart,
      options.validationEnd,
      safeJson(result.guardrails),
      safeJson(metrics),
      safeJson([
        'strategy_decision_log',
        'strategy_decision_log.context_json.candidate.raw_signals',
        'predictions:ensemble',
        'strategy_threshold_auto_calibration',
      ]),
      nowIso,
      nowIso,
    )
  })
  if (statements.length) await db.batch(statements)
  return approved.length
}

export function summarizeStrategyThresholdCalibrationResult(result: StrategyThresholdAutoCalibrationResult): string {
  const approved = result.decisions.filter((decision) => decision.status === 'approved').length
  const frozen = result.decisions.filter((decision) => decision.status === 'frozen').length
  const rejected = result.decisions.filter((decision) => decision.status === 'rejected').length
  const preview = result.decisions
    .slice(0, 5)
    .map((decision) => `${decision.strategyId}:${decision.targetKey}:${decision.status}:${decision.previousMin.toFixed(2)}->${decision.calibratedMin.toFixed(2)}`)
    .join(' ')
  return [
    `threshold_calibration cadence=${result.cadence}`,
    `mode=${result.mode}`,
    `status=${result.status}`,
    `eligible=${result.eligibleSpecs}`,
    `unsupported=${result.unsupportedSpecs.length}`,
    `approved=${approved}`,
    `frozen=${frozen}`,
    `rejected=${rejected}`,
    `written=${result.artifactsWritten}`,
    preview,
  ].filter(Boolean).join(' ')
}

export function defaultStrategyThresholdCalibrationWindow(options: StrategyThresholdAutoCalibrationOptions): {
  startDate: string
  endDate: string
} {
  const endDate = options.endDate ?? options.runDate
  const lookback = options.cadence === 'monthly' ? 180 : 90
  return {
    startDate: options.startDate ?? daysBefore(endDate, lookback),
    endDate,
  }
}
