import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { hydrateS12StrategyEvidence } from './strategyLearning'
import { assessStrategySpecEvaluability, type StrategyCandidateInput, type StrategySpec } from './strategySpec'

async function main(): Promise<void> {
const rows = [
  { symbol: '1001', source: 's12_candidate_snapshot', state: 'execution_ready', ready: 1, invalidated: 0 },
  { symbol: '1002', source: 's12_candidate_snapshot_reconstruction', state: 'waiting_15m_zone_touch', ready: 0, invalidated: 0 },
  { symbol: '1003', source: 's12_candidate_snapshot', state: 'data_unavailable', ready: 0, invalidated: 0 },
]

const db = {
  prepare() {
    return {
      bind() { return this },
      async all() { return { results: rows } },
    }
  },
} as any

const candidates: StrategyCandidateInput[] = ['1001', '1002', '1003', '1004'].map((symbol) => ({
  symbol,
  raw_signals: { technicalIndicators: {} },
}))
const telemetry = await hydrateS12StrategyEvidence(db, '2026-07-28', candidates)
assert.deepEqual(telemetry, { available: 2, unavailable: 1, missing: 1 })
assert.equal(candidates[0].raw_signals && typeof candidates[0].raw_signals === 'object'
  ? candidates[0].raw_signals.technicalIndicators?.stockTechS12Signal
  : null, 1)
assert.equal(candidates[1].raw_signals && typeof candidates[1].raw_signals === 'object'
  ? candidates[1].raw_signals.technicalIndicators?.stockTechS12Signal
  : null, 0)

const spec: StrategySpec = {
  id: 'stock_tech_s12_multitimeframe_smc_reclaim_v2',
  version: 'strategy-spec-v1',
  name: 'S12 formal structure',
  status: 'candidate',
  owner: 'strategy',
  familyId: 'SMC_STRUCTURE_RECLAIM',
  variantId: 's12_formal_intraday_snapshot',
  ownerType: 'strategy',
  promotionStatus: 'candidate',
  alphaBucket: 'breakout_vol_expansion',
  supportedRegimes: ['bull', 'sideways', 'volatile'],
  thesis: 'test',
  thresholds: {
    dsl: {
      all: [
        { signal: 'technicalIndicators.stockTechS12StructureAvailable', op: '>=', value: 1 },
        { signal: 'technicalIndicators.stockTechS12Signal', op: '>=', value: 1 },
      ],
    },
  },
  candidatePolicy: { evidenceRequirements: ['s12_structure_snapshots'], maxMlShare: 0.15 },
  riskNotes: [],
  createdBy: 'p5_strategy_governance',
}
assert.equal(assessStrategySpecEvaluability(candidates[0], spec).evaluable, true)
assert.equal(assessStrategySpecEvaluability(candidates[1], spec).evaluable, true, 'waiting structure is an evaluable no-match')
assert.equal(assessStrategySpecEvaluability(candidates[2], spec).evaluable, false, 'data_unavailable must not enter the promotion denominator')
assert.equal(assessStrategySpecEvaluability(candidates[3], spec).evaluable, false, 'missing snapshot must remain unavailable')

const learningSource = readFileSync('src/lib/strategyLearning.ts', 'utf8')
assert.match(learningSource, /FROM s12_replay_trade_outcomes o/, 'S12 Strategy Lab rewards must come from the formal replay execution owner')
assert.match(learningSource, /sample_eligible=1/, 'S12 execution rewards must reject ineligible replay rows')
assert.match(learningSource, /S12_REPLAY_ENGINE_SIGNATURE/, 'S12 execution rewards must enforce the current replay lineage')
assert.match(learningSource, /CANONICAL_SELECTION_ROUNDTRIP_COST_BPS/, 'S12 execution rewards must report cost-net returns')
assert.match(learningSource, /production_owned_by_s12_calibration_not_selection_replacement/, 'S12 must not enter the selection-strategy replacement gate')

const schemaSource = readFileSync('schema.sql', 'utf8')
assert.match(schemaSource, /signal_date\s+TEXT/, 'fresh D1 schema must include S12 replay signal_date')
assert.match(schemaSource, /idx_s12_replay_trade_outcomes_signal_date/, 'fresh D1 schema must index S12 replay signal dates')

const edgeSource = readFileSync('src/lib/strategyMarginalEdgeV4.ts', 'utf8')
assert.doesNotMatch(edgeSource, /m\.family_id <> 'SMC_STRUCTURE_RECLAIM'/, 'selection Edge V6 must retain daily SMRC evidence')
assert.match(edgeSource, /eligible_owner\.variant_id NOT LIKE 's12_%'/, 'selection Edge V6 must exclude all S12 execution variants while retaining daily SMRC')
assert.match(edgeSource, /eligible_owner\.promotion_status <> 'retired'/, 'retired S12 lineage must not re-enter selection replacement')

console.log('strategyS12EvidenceOwner tests passed')

}
main().catch((error) => { console.error(error); process.exitCode = 1 })
