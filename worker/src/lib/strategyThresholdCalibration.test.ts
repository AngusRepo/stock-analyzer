import * as fs from 'node:fs'
import {
  applyStrategyThresholdCalibrationArtifacts,
  buildStrategyThresholdAutoDecisions,
  classifyStrategyThresholdCalibrationCoverage,
  summarizeStrategyThresholdCalibrationResult,
  type StrategyThresholdCalibrationArtifactRow,
  type StrategyThresholdCalibrationEvidenceRow,
} from './strategyThresholdCalibration'
import type { StrategySpec } from './strategySpec'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const spec: StrategySpec = {
  id: 'test_auto_threshold_v1',
  version: 'strategy-spec-v1',
  name: 'Test Auto Threshold',
  status: 'active',
  owner: 'strategy',
  alphaBucket: 'breakout_vol_expansion',
  supportedRegimes: ['bull', 'sideways'],
  thesis: 'Fixture spec for adaptive threshold calibration.',
  thresholds: {
    minPrice: 10,
    featureRefs: {
      weightedScore: {
        min: 0.58,
        terms: [
          { featureRef: 'l1_smcBullishScore', signal: 'factorSignals.smc_bullish_score', weight: 1 },
        ],
      },
    },
  },
  candidatePolicy: { poolQuota: 16, costBudget: 18, evidenceRequirements: ['raw_smc'], maxMlShare: 0.2 },
  riskNotes: [],
  createdBy: 'p5_strategy_governance',
}

const rawOnlySpec: StrategySpec = {
  ...spec,
  id: 'test_raw_threshold_only_v1',
  thresholds: { minPrice: 10, minVolumeExpansion20: 1.2 },
}

function evidenceRows(): StrategyThresholdCalibrationEvidenceRow[] {
  const rows: StrategyThresholdCalibrationEvidenceRow[] = []
  for (let day = 1; day <= 40; day += 1) {
    const date = `2026-05-${String(day <= 31 ? day : day - 31).padStart(2, '0')}`
    const month = day <= 31 ? '05' : '06'
    const resolvedDate = `2026-${month}-${String(day <= 31 ? day : day - 31).padStart(2, '0')}`
    for (const [score, reward] of [
      [0.66, 0.014],
      [0.64, 0.011],
      [0.60, -0.012],
      [0.59, -0.009],
      [0.58, -0.008],
      [0.40, 0.004],
    ] as const) {
      rows.push({
        date: resolvedDate || date,
        strategy_id: spec.id,
        strategy_version: spec.version,
        weighted_score: score,
        raw_signals: {},
        reward_pct: reward,
      })
    }
  }
  return rows
}

function rawScalarEvidenceRows(): StrategyThresholdCalibrationEvidenceRow[] {
  const rows: StrategyThresholdCalibrationEvidenceRow[] = []
  for (let day = 1; day <= 40; day += 1) {
    const month = day <= 31 ? '05' : '06'
    const resolvedDate = `2026-${month}-${String(day <= 31 ? day : day - 31).padStart(2, '0')}`
    for (const [volumeExpansion20, reward] of [
      [1.55, 0.018],
      [1.42, 0.014],
      [1.28, 0.011],
      [1.20, -0.012],
      [1.12, -0.008],
      [0.95, 0.002],
    ] as const) {
      rows.push({
        date: resolvedDate,
        strategy_id: rawOnlySpec.id,
        strategy_version: rawOnlySpec.version,
        weighted_score: null,
        raw_signals: { volumeExpansion20 },
        reward_pct: reward,
      })
    }
  }
  return rows
}

{
  const coverage = classifyStrategyThresholdCalibrationCoverage([spec, rawOnlySpec])
  assert(coverage.eligible.length === 2, 'weighted-score and supported raw scalar specs should both be eligible')
  assert(coverage.unsupported.length === 0, 'supported raw scalar-only specs must not be reported as unsupported')
}

{
  const { guardrails, decisions } = buildStrategyThresholdAutoDecisions([spec], evidenceRows(), {
    runDate: '2026-07-07',
    cadence: 'weekly',
    minSamples: 30,
    minCompleteScoreRows: 120,
    minDailyMatches: 1,
    maxDailyMatches: 3,
  })
  assert(guardrails.maxDelta === 0.05, 'weekly auto threshold calibration must clamp single-run changes to 0.05')
  assert(decisions.length === 1, 'weighted active spec should produce one auto-threshold decision')
  assert(decisions[0].status === 'approved', 'machine guardrails should auto-approve a passing threshold without Wei review')
  assert(decisions[0].targetKey === 'featureRefs.weightedScore.min', 'weighted score decision must carry target_key')
  assert(decisions[0].calibratedMin > decisions[0].previousMin, 'auto calibration should tighten when lower score bucket is loss-making')
  assert(decisions[0].calibratedMin <= decisions[0].previousMin + guardrails.maxDelta, 'auto calibration must respect delta clamp')
  assert(decisions[0].selected?.avgDailyMatches! <= 3, 'selected threshold should respect target breadth guardrail')
}

{
  const { decisions } = buildStrategyThresholdAutoDecisions([rawOnlySpec], rawScalarEvidenceRows(), {
    runDate: '2026-07-07',
    cadence: 'weekly',
    minSamples: 30,
    minCompleteScoreRows: 120,
    minDailyMatches: 1,
    maxDailyMatches: 3,
  })
  const rawDecision = decisions.find((decision) => decision.targetKey === 'minVolumeExpansion20')
  assert(rawDecision != null, 'raw scalar minVolumeExpansion20 should produce an auto-threshold decision')
  assert(rawDecision!.status === 'approved', 'raw scalar threshold should be machine-approved when guardrails pass')
  assert(rawDecision!.calibratedMin > rawDecision!.previousMin, 'raw scalar calibration should tighten when lower volume bucket is loss-making')
}

{
  const artifact: StrategyThresholdCalibrationArtifactRow = {
    artifact_id: 'strategy-threshold-test_auto_threshold_v1-strategy-spec-v1-weekly-2026-07-07',
    run_id: 'strategy-threshold-weekly-2026-07-07-test',
    strategy_id: spec.id,
    strategy_version: spec.version,
    status: 'approved',
    cadence: 'weekly',
    base_min: 0.58,
    previous_min: 0.58,
    calibrated_min: 0.63,
    delta: 0.05,
    validation_start: '2026-04-08',
    validation_end: '2026-07-07',
    guardrails_json: '{}',
    metrics_json: JSON.stringify({ completeScoreRows: 240, matchedRows: 80, currentMatchedRows: 200, avgDailyMatches: 2 }),
    source_refs_json: JSON.stringify(['strategy_decision_log', 'predictions:ensemble']),
    created_at: '2026-07-07T00:00:00.000Z',
    approved_at: '2026-07-07T00:00:00.000Z',
    superseded_at: null,
  }
  const calibrated = applyStrategyThresholdCalibrationArtifacts([spec], [artifact])[0]
  const weighted = calibrated.thresholds.featureRefs?.weightedScore
  assert(weighted?.calibration?.status === 'active', 'latest approved artifact must be applied as active weighted-score calibration')
  assert(weighted?.calibration?.method === 'auto_threshold_guardrail', 'artifact-applied calibration must expose machine guardrail lineage')
  assert(weighted?.calibration?.calibratedMin === 0.63, 'runtime effective threshold should come from latest approved artifact')
  assert(weighted?.min === 0.58, 'StrategySpec base threshold must remain unchanged as fallback')
}

{
  const artifact: StrategyThresholdCalibrationArtifactRow = {
    artifact_id: 'strategy-threshold-test_raw_threshold_only_v1-strategy-spec-v1-minVolumeExpansion20-weekly-2026-07-07',
    run_id: 'strategy-threshold-weekly-2026-07-07-test',
    strategy_id: rawOnlySpec.id,
    strategy_version: rawOnlySpec.version,
    target_key: 'minVolumeExpansion20',
    status: 'approved',
    cadence: 'weekly',
    base_min: 1.2,
    previous_min: 1.2,
    calibrated_min: 1.35,
    delta: 0.15,
    validation_start: '2026-04-08',
    validation_end: '2026-07-07',
    guardrails_json: '{}',
    metrics_json: JSON.stringify({ completeScoreRows: 240, matchedRows: 120, currentMatchedRows: 160, avgDailyMatches: 3 }),
    source_refs_json: JSON.stringify(['strategy_decision_log.context_json.candidate.raw_signals', 'predictions:ensemble']),
    created_at: '2026-07-07T00:00:00.000Z',
    approved_at: '2026-07-07T00:00:00.000Z',
    superseded_at: null,
  }
  const calibrated = applyStrategyThresholdCalibrationArtifacts([rawOnlySpec], [artifact])[0]
  assert(calibrated.thresholds.minVolumeExpansion20 === 1.35, 'latest approved raw scalar artifact must update runtime scalar threshold')
  assert(rawOnlySpec.thresholds.minVolumeExpansion20 === 1.2, 'raw scalar resolver must not mutate the source StrategySpec object')
}

{
  const adminWorker = fs.readFileSync('src/lib/adminTriggerWorkerDomainTasks.ts', 'utf8')
  const routes = fs.readFileSync('src/routes/adminTriggerRoutes.ts', 'utf8')
  const gcpCron = fs.readFileSync('src/lib/cronGcpDomainTasks.ts', 'utf8')
  const schedulerStatus = fs.readFileSync('src/lib/schedulerStatus.ts', 'utf8')
  assert(adminWorker.includes("'strategy-threshold-calibration'"), 'manual admin task must expose strategy-threshold-calibration')
  assert(routes.includes("'strategy-threshold-calibration'"), 'strategy-threshold-calibration must require sync=1 for scheduler observability')
  assert(gcpCron.includes("runWithLog('strategy-threshold-calibration'"), 'weekly scheduler must run auto threshold calibration')
  assert(schedulerStatus.includes('Strategy Threshold Calibration'), 'scheduler dashboard must show threshold calibration')
  assert(!adminWorker.includes('X-Confirm-Threshold') && !adminWorker.includes('requires_wei_approval'), 'threshold calibration must not require manual approval headers')
}

{
  const summary = summarizeStrategyThresholdCalibrationResult({
    runId: 'strategy-threshold-weekly-2026-07-07-test',
    runDate: '2026-07-07',
    cadence: 'weekly',
    mode: 'persisted',
    status: 'success',
    specsSeen: 1,
    eligibleSpecs: 1,
    unsupportedSpecs: [],
    artifactsWritten: 1,
    guardrails: {
      minSamples: 30,
      minCompleteScoreRows: 120,
      minDailyMatches: 1,
      maxDailyMatches: 3,
      maxDelta: 0.05,
      hitRateFloor: 0.5,
      avgReturnFloor: 0,
      maxDrawdownFloor: -0.08,
      currentReturnTolerance: 0.0025,
      currentHitRateTolerance: 0.03,
    },
    decisions: [{
      strategyId: spec.id,
      strategyVersion: spec.version,
      targetKey: 'featureRefs.weightedScore.min',
      status: 'approved',
      reason: 'auto_approved_by_machine_guardrails',
      baseMin: 0.58,
      previousMin: 0.58,
      calibratedMin: 0.63,
      candidates: [],
    }],
    summary: '',
  })
  assert(summary.includes('approved=1'), 'summary must surface approved artifact count')
  assert(summary.includes('written=1'), 'summary must surface persisted artifact count')
}
