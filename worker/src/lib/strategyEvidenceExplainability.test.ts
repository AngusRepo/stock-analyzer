import assert from 'node:assert/strict'

import { computeStrategyEvidenceMetricRows, type StrategyEvidenceObservation } from './strategyEvidenceMetrics'
import { buildStrategyEvidenceProfile } from './strategyEvidenceProfile'
import { DEFAULT_STRATEGY_SPECS } from './strategySpec'

const spec = DEFAULT_STRATEGY_SPECS.find((row) => row.id === 'trend_following_seed_v1')!
const profile = buildStrategyEvidenceProfile(spec, { availableOutcomeHorizonDays: [3, 5, 10] })
const rows: StrategyEvidenceObservation[] = []
for (let day = 1; day <= 10; day += 1) {
  const signalDate = `2026-07-${String(day).padStart(2, '0')}`
  for (let symbol = 1; symbol <= 4; symbol += 1) {
    rows.push({
      signal_date: signalDate,
      symbol: `S${symbol}`,
      producer_run_id: `run-${signalDate}`,
      strategy_id: spec.id,
      strategy_version: spec.version,
      strategy_status: spec.status,
      alpha_bucket: spec.alphaBucket,
      affinity: 1,
      position_weight: 1,
      overlap: 0,
      horizon_days: profile.primary_horizon_days,
      outcome_known_date: '2026-08-22',
      absolute_return_net: symbol * 0.001,
      benchmark_return_net: 0,
      residual_return_net: symbol * 0.001,
      cross_section_rank: symbol / 4,
    })
  }
}

const rankIc = computeStrategyEvidenceMetricRows(profile, rows, '2026-08-22')
  .find((row) => row.metric_name === 'rank_ic')!
const evidence = JSON.parse(rankIc.evidence_json) as Record<string, unknown>

assert.equal(rankIc.metric_status, 'not_available')
assert.equal(rankIc.mature_dates, 0, 'mature_dates is estimator-valid dates, not raw observation dates')
assert.equal(evidence.observation_dates, 10)
assert.equal(evidence.constant_affinity_dates, 0)
assert.equal(evidence.excluded_legacy_binary_pairs, 40)
assert.equal(evidence.missing_reason, 'formal_continuous_affinity_unavailable')


const continuousRows = rows.map((row, index) => ({
  ...row,
  affinity_evidence_count: 3,
  challenger_affinity: (index % 4) + 1,
  challenger_affinity_version: 'strategy-threshold-margin-affinity-v2',
}))
const continuousRankIc = computeStrategyEvidenceMetricRows(profile, continuousRows, '2026-08-22')
  .find((row) => row.metric_name === 'rank_ic')!
const continuousEvidence = JSON.parse(continuousRankIc.evidence_json) as Record<string, unknown>

assert.equal(continuousRankIc.metric_value, 1)
assert.equal(continuousRankIc.mature_dates, 10)
assert.equal(continuousRankIc.metric_status, 'ready')
assert.equal(continuousEvidence.affinity_owner, 'strategy-threshold-margin-affinity-v2')
assert.equal(continuousEvidence.formal_continuous_pairs, 40)
assert.equal(continuousEvidence.excluded_legacy_binary_pairs, 0)
assert.equal(continuousEvidence.constant_affinity_dates, 0)

const regimeProfile = {
  ...profile,
  supported_regimes: ['bull', 'sideways'],
  required_metrics: ['regime_consistency'] as typeof profile.required_metrics,
}
const regimeRows = rows
  .filter((row) => ['2026-07-01', '2026-07-02', '2026-07-03'].includes(row.signal_date))
  .map((row) => ({
    ...row,
    market_regime: row.signal_date === '2026-07-03' ? 'sideways' : 'bull',
  }))
const regimeMetric = computeStrategyEvidenceMetricRows(regimeProfile, regimeRows, '2026-08-22')[0]
const regimeEvidence = JSON.parse(regimeMetric.evidence_json) as {
  observed_partitions: Array<{ regime: string; dates: number }>
  eligible_partitions: Array<{ regime: string; dates: number }>
  observed_regime_count: number
  eligible_regime_count: number
}

assert.equal(regimeMetric.metric_value, null)
assert.equal(regimeEvidence.observed_regime_count, 2)
assert.equal(regimeEvidence.eligible_regime_count, 1)
assert.deepEqual(
  regimeEvidence.observed_partitions.map((item) => [item.regime, item.dates]),
  [['bull', 2], ['sideways', 1]],
)
assert.deepEqual(
  regimeEvidence.eligible_partitions.map((item) => [item.regime, item.dates]),
  [['bull', 2]],
)

console.log('strategy evidence explainability tests passed')
