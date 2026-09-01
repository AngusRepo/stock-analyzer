import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  calibrationMetricSnapshotChecksum,
  evaluateStrategyEvidenceOwnerCalibration,
  type StrategyEvidenceCalibrationMetricRow,
  type StrategyEvidenceCalibrationProfile,
  type StrategyEvidenceDateReturn,
} from './strategyEvidenceOwnerCalibration'
import { buildStrategyEvidenceOwnerSnapshot } from './strategyEvidenceOwnerFusion'
import { listStrategyEvidenceProfiles } from './strategyEvidenceProfile'
import { DEFAULT_STRATEGY_SPECS } from './strategySpec'

const calibrationSource = fs.readFileSync('src/lib/strategyEvidenceOwnerCalibration.ts', 'utf8')
assert.match(
  calibrationSource,
  /ROW_NUMBER\(\) OVER \([\s\S]*PARTITION BY knowledge_cutoff_date[\s\S]*WHERE ordinal=1/,
  'hysteresis history must count distinct knowledge cutoffs, not same-day reruns',
)

const profiles: StrategyEvidenceCalibrationProfile[] = ['a', 'b', 'c'].map((strategyId) => ({
  strategy_id: strategyId,
  strategy_version: 'v1',
  strategy_status: 'active',
  primary_horizon_days: 5,
  required_metrics: ['residual_return_lcb90'],
}))

const dates = Array.from({ length: 10 }, (_, index) => `2026-01-${String(index + 1).padStart(2, '0')}`)
const metricRows: StrategyEvidenceCalibrationMetricRow[] = dates.flatMap((date) => [
  { strategy_id: 'a', value: 0.02 },
  { strategy_id: 'b', value: 0 },
  { strategy_id: 'c', value: -0.02 },
].map(({ strategy_id, value }) => ({
  strategy_id,
  strategy_version: 'v1',
  primary_horizon_days: 5,
  metric_name: 'residual_return_lcb90',
  metric_value: value,
  metric_status: 'ready',
  outcome_as_of_date: date,
  definition_version: 'strategy-evidence-metrics-v4',
})))
const dateReturns: StrategyEvidenceDateReturn[] = dates.slice(1).flatMap((date) => [
  { strategy_id: 'a', value: 0.03 },
  { strategy_id: 'b', value: 0.01 },
  { strategy_id: 'c', value: -0.01 },
].map(({ strategy_id, value }) => ({
  signal_date: date,
  strategy_id,
  strategy_version: 'v1',
  residual_return_net: value,
  sample_count: 100,
})))

async function main(): Promise<void> {
const promoted = await evaluateStrategyEvidenceOwnerCalibration({
  profiles,
  metricRows,
  dateReturns,
  allowPromotion: true,
})
assert.equal(promoted.status, 'promoted')
assert.equal(promoted.trainDates.length >= 3, true)
assert.equal(promoted.purgeDates.length, 2)
assert.equal(promoted.oosDates.length, 3)
assert.equal(promoted.challengerDeltaLcb90! > 0, true)
assert.equal(promoted.artifacts.length, 3)
assert.equal(promoted.artifacts.find((row) => row.strategy_id === 'a')!.weight_multiplier > 1, true)
assert.equal(promoted.artifacts.find((row) => row.strategy_id === 'c')!.weight_multiplier < 1, true)

const rejected = await evaluateStrategyEvidenceOwnerCalibration({
  profiles,
  metricRows,
  dateReturns: dateReturns.map((row) => ({
    ...row,
    residual_return_net: row.strategy_id === 'a' ? -0.03 : row.strategy_id === 'c' ? 0.03 : 0,
  })),
  allowPromotion: true,
})
assert.equal(rejected.status, 'rejected')
assert.equal(rejected.gates.oos_delta_lcb90_positive, false)

const activeSpec = DEFAULT_STRATEGY_SPECS.find((strategy) => strategy.status === 'active')!
const activeProfile = listStrategyEvidenceProfiles([activeSpec])[0]!
const ownerMetricRows = activeProfile.required_metrics.map((metric_name) => ({
  strategy_id: activeSpec.id,
  strategy_version: activeSpec.version,
  primary_horizon_days: activeProfile.primary_horizon_days,
  metric_name,
  metric_value: 0.01,
  metric_status: 'ready',
  sample_count: 100,
  mature_dates: 10,
  outcome_as_of_date: dates.at(-1)!,
  definition_version: 'strategy-evidence-metrics-v4',
}))
const sourceMetricChecksum = await calibrationMetricSnapshotChecksum(ownerMetricRows)
const ownerArtifacts = [{
  strategy_id: activeSpec.id,
  strategy_version: activeSpec.version,
  metric_outcome_as_of_date: dates.at(-1)!,
  multi_horizon_score: 0.25,
  weight_multiplier: 1.0625,
  source_metric_checksum: sourceMetricChecksum,
  payload_checksum: 'd'.repeat(64),
}]
const calibratedOwner = await buildStrategyEvidenceOwnerSnapshot({
  strategies: [activeSpec],
  rows: ownerMetricRows,
  knowledgeCutoffDate: '2026-01-11',
  calibration: {
    runId: 'calibration-run',
    artifactChecksum: 'a'.repeat(64),
    sourceMetricChecksum,
    knowledgeCutoffDate: '2026-01-11',
    artifacts: ownerArtifacts,
  },
})
assert.equal(calibratedOwner.weight_effect, 'immutable_oos_calibrated_bounded_bidirectional')
assert.equal(calibratedOwner.calibration_run_id, 'calibration-run')
assert.equal(calibratedOwner.profiles.every((row) => row.weight_effect === 'immutable_oos_calibrated'), true)
assert.equal(calibratedOwner.profiles[0].performance_state, 'full', 'one promoted score cannot trigger cooldown')

const negativeHistory = [-0.2, -0.1].map((score, index) => ({
  runId: `negative-${index}`,
  artifactChecksum: String(index + 1).repeat(64),
  sourceMetricChecksum: index === 0 ? sourceMetricChecksum : 'e'.repeat(64),
  knowledgeCutoffDate: `2026-01-${String(10 - index).padStart(2, '0')}`,
  artifacts: [{
    ...ownerArtifacts[0],
    multi_horizon_score: score,
    weight_multiplier: 0.75 + index * 0.01,
    source_metric_checksum: index === 0 ? sourceMetricChecksum : 'e'.repeat(64),
  }],
}))
const cooldownOwner = await buildStrategyEvidenceOwnerSnapshot({
  strategies: [activeSpec],
  rows: ownerMetricRows,
  knowledgeCutoffDate: '2026-01-11',
  calibration: negativeHistory[0],
  calibrationHistory: negativeHistory,
})
assert.equal(cooldownOwner.profiles[0].performance_state, 'cooldown')
assert.equal(cooldownOwner.profiles[0].negative_calibration_streak, 2)

const recoveryHistory = [0.2, 0.1].map((score, index) => ({
  runId: `recovery-${index}`,
  artifactChecksum: String(index + 3).repeat(64),
  sourceMetricChecksum: index === 0 ? sourceMetricChecksum : 'f'.repeat(64),
  knowledgeCutoffDate: `2026-01-${String(10 - index).padStart(2, '0')}`,
  artifacts: [{
    ...ownerArtifacts[0],
    multi_horizon_score: score,
    weight_multiplier: 1.05,
    source_metric_checksum: index === 0 ? sourceMetricChecksum : 'f'.repeat(64),
  }],
}))
const recoveredOwner = await buildStrategyEvidenceOwnerSnapshot({
  strategies: [activeSpec],
  rows: ownerMetricRows,
  knowledgeCutoffDate: '2026-01-11',
  calibration: recoveryHistory[0],
  calibrationHistory: [...recoveryHistory, ...negativeHistory],
})
assert.equal(recoveredOwner.profiles[0].performance_state, 'full')
assert.equal(recoveredOwner.profiles[0].positive_calibration_streak, 2)

const staleOwner = await buildStrategyEvidenceOwnerSnapshot({
  strategies: [activeSpec],
  rows: ownerMetricRows,
  knowledgeCutoffDate: '2026-01-11',
  calibration: {
    runId: 'stale',
    artifactChecksum: 'b'.repeat(64),
    sourceMetricChecksum: 'c'.repeat(64),
    knowledgeCutoffDate: '2026-01-11',
    artifacts: ownerArtifacts,
  },
})
assert.equal(staleOwner.weight_effect, 'neutral_until_immutable_calibration')
assert.equal(staleOwner.calibration_run_id, null)

console.log('strategy evidence owner calibration tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
