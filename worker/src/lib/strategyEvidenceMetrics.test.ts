import assert from 'node:assert/strict'
import fs from 'node:fs'
import { buildStrategyEvidenceProfile } from './strategyEvidenceProfile'
import {
  computeStrategyEvidenceMetricRows,
  joinStrategyEvidenceObservations,
  fundamentalRevisionPersistenceAsOf,
  maximumAdverseExcursionFromPricePath,
  STRATEGY_EVIDENCE_MIN_MATURE_DATES,
  STRATEGY_EVIDENCE_MIN_SAMPLES,
  type StrategyEvidenceObservation,
} from './strategyEvidenceMetrics'
import { DEFAULT_STRATEGY_SPECS } from './strategySpec'

const joined = joinStrategyEvidenceObservations([{
  signal_date: '2026-08-01', symbol: '2330', producer_run_id: 'run-1',
  strategy_id: 'trend', strategy_version: 'v1', strategy_status: 'active',
  alpha_bucket: 'trend', affinity: 0.8, position_weight: 1, overlap: 0.2,
}], [{
  signal_date: '2026-08-01', symbol: '2330', producer_run_id: 'run-1',
  horizon_days: 5, outcome_known_date: '2026-08-08', absolute_return_net: 0.03,
  benchmark_return_net: 0.01, residual_return_net: 0.02, cross_section_rank: 0.9,
}, {
  signal_date: '2026-08-01', symbol: '2330', producer_run_id: 'other-run',
  horizon_days: 5, outcome_known_date: '2026-08-08', absolute_return_net: -0.03,
  benchmark_return_net: 0.01, residual_return_net: -0.04, cross_section_rank: 0.1,
}])
assert.equal(joined.length, 1)
assert.equal(joined[0].strategy_id, 'trend')
assert.equal(joined[0].horizon_days, 5)
assert.equal(joined[0].residual_return_net, 0.02)

const metricSource = fs.readFileSync('src/lib/strategyEvidenceMetrics.ts', 'utf8')
assert(metricSource.includes("sourceMode?: 'authority_bridge' | 'learning_target'"))
assert(metricSource.includes("throw new Error('strategy_evidence_metric_learning_target_missing')"))
assert(metricSource.includes("const observationDb = targetJoinRequested ? learningTargetDb! : authorityDb"))
assert(metricSource.includes('const outcomesBySelection = indexStrategyEvidenceOutcomes(outcomeRows)'))
assert(!metricSource.includes('joinStrategyEvidenceObservations(rows, outcomeRows)'))
assert(metricSource.includes("profile?: Pick<StrategyEvidenceProfile, 'strategy_id' | 'strategy_version'>"))
assert(metricSource.includes('for (const profile of profiles)'))
assert(metricSource.includes('loadObservations(db, options.outcomeAsOfDate, profile)'))

function observations(strategyId: string, strategyVersion: string, strategyStatus: string, alphaBucket: string): StrategyEvidenceObservation[] {
  const rows: StrategyEvidenceObservation[] = []
  for (let day = 0; day < 10; day += 1) {
    const date = `2026-07-${String(day + 1).padStart(2, '0')}`
    for (let symbolIndex = 0; symbolIndex < 4; symbolIndex += 1) {
      for (const horizon of [3, 5, 10]) {
        const residual = 0.002 + symbolIndex * 0.001 - day * 0.00005 + (horizon === 3 ? 0.0005 : 0)
        const benchmark = day % 2 === 0 ? -0.006 : 0.004
        rows.push({
          signal_date: date,
          symbol: `S${symbolIndex}`,
          producer_run_id: `run-${date}`,
          strategy_id: strategyId,
          strategy_version: strategyVersion,
          strategy_status: strategyStatus,
          alpha_bucket: alphaBucket,
          affinity: symbolIndex + 1,
          position_weight: 1 + ((day + symbolIndex) % 3),
          overlap: symbolIndex / 3,
          market_regime: day % 2 === 0 ? 'sideways' : 'volatile',
          maximum_adverse_excursion: -0.01 - symbolIndex * 0.001,
          horizon_days: horizon,
          outcome_known_date: `2026-08-${String(day + 1).padStart(2, '0')}`,
          absolute_return_net: benchmark + residual,
          benchmark_return_net: benchmark,
          residual_return_net: residual,
          cross_section_rank: symbolIndex / 3,
        })
      }
    }
  }
  return rows
}

const trend = DEFAULT_STRATEGY_SPECS.find((spec) => spec.id === 'trend_following_seed_v1')!
const trendProfile = buildStrategyEvidenceProfile(trend, { availableOutcomeHorizonDays: [3, 5, 10] })
const trendRows = computeStrategyEvidenceMetricRows(
  trendProfile,
  observations(trend.id, trend.version, trend.status, trend.alphaBucket),
  '2026-08-16',
)
assert.equal(trendRows.length, trendProfile.required_metrics.length)
assert.equal(trendRows.find((row) => row.metric_name === 'regime_consistency')?.metric_status, 'ready')
for (const metric of ['residual_return_lcb90', 'rank_ic', 'max_drawdown', 'turnover_after_cost']) {
  const row = trendRows.find((item) => item.metric_name === metric)
  assert(row, `${metric} row must exist`)
  assert.equal(row.metric_status, 'ready', `${metric} must be ready with mature synthetic evidence`)
  assert.notEqual(row.metric_value, null)
  assert(row.sample_count >= STRATEGY_EVIDENCE_MIN_SAMPLES)
  assert(row.mature_dates >= STRATEGY_EVIDENCE_MIN_MATURE_DATES)
}

const reversion = DEFAULT_STRATEGY_SPECS.find((spec) => spec.id === 'finlab_ai_skill_reversion_value_v1')!
const reversionProfile = buildStrategyEvidenceProfile(reversion, { availableOutcomeHorizonDays: [3, 5, 10] })
const reversionRows = computeStrategyEvidenceMetricRows(
  reversionProfile,
  observations(reversion.id, reversion.version, reversion.status, reversion.alphaBucket),
  '2026-08-16',
)
assert.equal(reversionRows.find((row) => row.metric_name === 'time_to_reversion')?.metric_status, 'ready')
assert.equal(reversionRows.find((row) => row.metric_name === 'time_to_reversion')?.metric_value, 3)
assert.equal(reversionRows.find((row) => row.metric_name === 'maximum_adverse_excursion')?.metric_status, 'ready')
assert.equal(reversionRows.find((row) => row.metric_name === 'regime_consistency')?.metric_status, 'ready')

const defensive = DEFAULT_STRATEGY_SPECS.find((spec) => spec.id === 'defensive_accumulation_seed_v1')!
const defensiveProfile = buildStrategyEvidenceProfile(defensive, { availableOutcomeHorizonDays: [3, 5, 10] })
const defensiveRows = computeStrategyEvidenceMetricRows(
  defensiveProfile,
  observations(defensive.id, defensive.version, defensive.status, defensive.alphaBucket),
  '2026-08-16',
)
assert(defensiveRows.every((row) => row.metric_status === 'ready'))
assert(defensiveRows.every((row) => row.metric_value != null))

const immatureRows = computeStrategyEvidenceMetricRows(
  defensiveProfile,
  observations(defensive.id, defensive.version, defensive.status, defensive.alphaBucket).slice(0, 12),
  '2026-08-16',
)
assert(immatureRows.some((row) => row.metric_status === 'insufficient_samples' || row.metric_status === 'not_available'))

const zeroHitRows = computeStrategyEvidenceMetricRows(
  reversionProfile,
  [],
  '2026-08-16',
)
assert(zeroHitRows.every((row) => row.metric_status === 'not_available'))
assert(zeroHitRows.every((row) => (
  JSON.parse(row.evidence_json).missing_reason === 'no_strategy_hits_in_observation_window'
)), 'zero-hit strategies must not be misclassified as missing price or regime dependencies')
assert(zeroHitRows.every((row) => (
  JSON.parse(row.evidence_json).root_cause_class === 'strategy_coverage'
)))

const oneMatureDateLcb = computeStrategyEvidenceMetricRows(
  trendProfile,
  observations(trend.id, trend.version, trend.status, trend.alphaBucket)
    .filter((row) => row.signal_date === '2026-07-01'),
  '2026-08-16',
).find((row) => row.metric_name === 'residual_return_lcb90')
assert.equal(oneMatureDateLcb?.metric_status, 'not_available')
assert.equal(JSON.parse(oneMatureDateLcb!.evidence_json).missing_reason, 'insufficient_mature_dates_for_estimator')

const zeroWeightRows = observations(trend.id, trend.version, trend.status, trend.alphaBucket)
  .filter((row) => (
    Number(row.signal_date.slice(-2)) % 2 === 0 ? row.symbol !== 'S3' : row.symbol !== 'S0'
  ))
  .map((row) => ({ ...row, position_weight: 0 }))
const zeroWeightTurnover = computeStrategyEvidenceMetricRows(
  trendProfile,
  zeroWeightRows,
  '2026-08-16',
).find((row) => row.metric_name === 'turnover_after_cost')
assert.notEqual(zeroWeightTurnover?.metric_value, null, 'zero-authority shadow weights must use equal-weight observation turnover')

assert.equal(maximumAdverseExcursionFromPricePath([{
  stock_id: 1, date: '2026-08-03', open: 100, low: 98, close: 100, adj_close: 50,
}, {
  stock_id: 1, date: '2026-08-04', open: 99, low: 90, close: 100, adj_close: 50,
}, {
  stock_id: 1, date: '2026-08-05', open: 95, low: 92, close: 100, adj_close: 50,
}], '2026-08-03', '2026-08-05'), -0.1)
assert.equal(fundamentalRevisionPersistenceAsOf([
  { stock_id: '2330', revenue_month: '2026-05-01', yoy: 10, previous_comparison_pct: null, knowledge_time: '2026-06-10T00:00:00.000Z', payload_checksum: 'a' },
  { stock_id: '2330', revenue_month: '2026-05-01', yoy: 12, previous_comparison_pct: null, knowledge_time: '2026-06-20T00:00:00.000Z', payload_checksum: 'b' },
  { stock_id: '2330', revenue_month: '2026-06-01', yoy: 11, previous_comparison_pct: null, knowledge_time: '2026-07-10T00:00:00.000Z', payload_checksum: 'c' },
  { stock_id: '2330', revenue_month: '2026-06-01', yoy: 13, previous_comparison_pct: null, knowledge_time: '2026-07-20T00:00:00.000Z', payload_checksum: 'd' },
], '2026-07-31'), 1)
assert.equal(fundamentalRevisionPersistenceAsOf([
  { stock_id: '2330', revenue_month: '2026-05-01', yoy: 10, previous_comparison_pct: null, knowledge_time: '2026-06-10T00:00:00.000Z', payload_checksum: 'a' },
  { stock_id: '2330', revenue_month: '2026-05-01', yoy: 12, previous_comparison_pct: null, knowledge_time: '2026-06-20T00:00:00.000Z', payload_checksum: 'b' },
], '2026-07-31'), null)
assert.equal(fundamentalRevisionPersistenceAsOf([
  { stock_id: '2330', revenue_month: '2026-04-01', yoy: 8, previous_comparison_pct: null, knowledge_time: '2026-05-10T00:00:00.000Z', payload_checksum: 'a' },
  { stock_id: '2330', revenue_month: '2026-05-01', yoy: 10, previous_comparison_pct: null, knowledge_time: '2026-06-10T00:00:00.000Z', payload_checksum: 'b' },
  { stock_id: '2330', revenue_month: '2026-06-01', yoy: 13, previous_comparison_pct: null, knowledge_time: '2026-07-10T00:00:00.000Z', payload_checksum: 'c' },
], '2026-07-31'), 1, 'three PIT months must estimate persistent revenue improvement without requiring impossible same-month revisions')
assert.equal(fundamentalRevisionPersistenceAsOf([
  { stock_id: '2330', revenue_month: '2026-05-01', yoy: 10, previous_comparison_pct: null, knowledge_time: '2026-08-17T00:00:00.000Z', payload_checksum: 'a' },
  { stock_id: '2330', revenue_month: '2026-05-01', yoy: 12, previous_comparison_pct: null, knowledge_time: '2026-08-17T01:00:00.000Z', payload_checksum: 'b' },
  { stock_id: '2330', revenue_month: '2026-06-01', yoy: 11, previous_comparison_pct: null, knowledge_time: '2026-08-17T00:00:00.000Z', payload_checksum: 'c' },
  { stock_id: '2330', revenue_month: '2026-06-01', yoy: 13, previous_comparison_pct: null, knowledge_time: '2026-08-17T01:00:00.000Z', payload_checksum: 'd' },
], '2026-08-07'), null, 'future revenue revisions must not leak into an earlier signal date')

const revision = DEFAULT_STRATEGY_SPECS.find((spec) => spec.id === 'finlab_ai_skill_revenue_revision_breakout_v1')!
const revisionProfile = buildStrategyEvidenceProfile(revision, { availableOutcomeHorizonDays: [3, 5, 10] })
const nullRevisionMetric = computeStrategyEvidenceMetricRows(
  revisionProfile,
  observations(revision.id, revision.version, revision.status, revision.alphaBucket)
    .map((row) => ({ ...row, fundamental_revision_persistence: null })),
  '2026-08-16',
).find((row) => row.metric_name === 'fundamental_revision_persistence')
assert.equal(nullRevisionMetric?.metric_status, 'not_available')
assert.equal(nullRevisionMetric?.sample_count, 0, 'null evidence must not be coerced to numeric zero')


console.log('strategy evidence metrics tests passed')
