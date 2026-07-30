import * as fs from 'node:fs'
import {
  applyStrategyThresholdCalibrationArtifacts,
  buildStrategyThresholdAutoDecisions,
  classifyStrategyThresholdCalibrationCoverage,
  listStrategyThresholdCalibrationEvidenceRows,
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
    source_refs_json: JSON.stringify(['strategy_candidate_contexts.raw_signals_json', 'predictions:ensemble']),
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
  const source = fs.readFileSync('src/lib/strategyThresholdCalibration.ts', 'utf8')
  const loader = source.slice(
    source.indexOf('export async function listStrategyThresholdCalibrationEvidenceRows'),
    source.indexOf('export function buildStrategyThresholdAutoDecisions'),
  )
  assert(loader.includes('const pageSize = Math.min(5_000, limit)'), 'threshold evidence reads must stay within bounded D1 pages')
  assert(loader.includes('while (rows.length < limit)'), 'threshold evidence loader must exhaust the requested evidence budget')
  assert(loader.includes('m.strategy_version > ?'), 'keyset cursor must include strategy version to avoid dropped duplicate symbols')
  assert(loader.includes('ORDER BY m.signal_date DESC, m.strategy_id ASC, m.symbol ASC, m.strategy_version ASC'), 'keyset order must match the complete cursor identity')
  assert(loader.includes('WITH evidence_page AS MATERIALIZED'), 'page limit must be materialized before joining large JSON evidence')
  assert(loader.includes('FROM evidence_page p'), 'large evidence joins must consume only the bounded key page')
  assert(!loader.includes('LEFT JOIN strategy_candidate_contexts c'), 'evidence pages must not repeat raw context JSON per strategy row')
  assert(loader.includes('rawSignalsByContext'), 'raw signals must load once per unique context')
  assert(!loader.includes('bind(options.startDate, options.endDate, limit)'), 'threshold evidence must not issue the legacy unbounded 50k join')
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

async function verifyThresholdEvidenceKeysetPagination(): Promise<void> {
  const makeRow = (symbol: string) => ({
    date: '2026-07-15',
    strategy_id: 'test_strategy',
    strategy_version: 'strategy-spec-v1',
    symbol,
    weighted_score: 0.61,
    context_id: 'context-1',
    reward_pct: 0.01,
  })
  const pages = [
    Array.from({ length: 5_000 }, (_, index) => makeRow(String(index).padStart(4, '0'))),
    [makeRow('5000'), makeRow('5001')],
  ]
  const bindCalls: unknown[][] = []
  const sqlCalls: string[] = []
  const db = {
    prepare(sql: string) {
      sqlCalls.push(sql)
      return {
        bind(...values: unknown[]) {
          bindCalls.push(values)
          return {
            async all() {
              if (sql.includes('FROM strategy_candidate_contexts')) {
                return { results: [{ context_id: 'context-1', raw_signals_json: '{"volumeExpansion20":1.4}' }] }
              }
              return { results: pages.shift() ?? [] }
            },
          }
        },
      }
    },
  } as unknown as D1Database

  const rows = await listStrategyThresholdCalibrationEvidenceRows(db, {
    startDate: '2026-04-01',
    endDate: '2026-07-15',
    limit: 5_002,
  })
  assert(rows.length === 5_002, 'keyset pagination must preserve the complete requested evidence budget')
  assert(bindCalls.length === 3, '5,002 evidence rows must use two evidence pages and one deduplicated context query')
  assert(bindCalls[0][12] === 5_000, 'the first scalar D1 query must be capped at 5,000 rows')
  assert(bindCalls[1][2] === '2026-07-15', 'the next page must continue from the last signal date')
  assert(bindCalls[1][4] === 'test_strategy', 'the next page must continue from the last strategy')
  assert(bindCalls[1][7] === '4999', 'the next page must continue from the last symbol')
  assert(bindCalls[1][11] === 'strategy-spec-v1', 'the next page must continue from the last strategy version')
  assert(bindCalls[1][12] === 2, 'the final D1 query must request only the remaining rows')
  assert(sqlCalls.slice(0, 2).every((sql) => sql.includes('m.strategy_version > ?')), 'every evidence page must use the full unique cursor')
  assert(bindCalls[2].length === 1 && bindCalls[2][0] === 'context-1', 'raw signals must load once for the shared context')
  assert(rows[0].raw_signals?.volumeExpansion20 === 1.4, 'paged evidence must preserve parsed raw signals')
}

void verifyThresholdEvidenceKeysetPagination().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
