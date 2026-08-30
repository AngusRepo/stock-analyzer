import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { buildMultiStrategyPleRoutingPlan } from './multiStrategyPleRouter'
import { buildSelectionEvidenceV4 } from './selectionReferenceEvidence'
import { DEFAULT_STRATEGY_SPECS, type StrategySpec } from './strategySpec'

const base = DEFAULT_STRATEGY_SPECS[0]
const spec: StrategySpec = {
  ...base,
  id: 's06_regime_veto_contract_v1',
  name: 'S06 regime veto contract',
  status: 'active' as const,
  promotionStatus: 'production' as const,
  supportedRegimes: ['bull'],
  thresholds: { minPrice: 10 },
}
const candidate = {
  symbol: '2330',
  name: 'TSMC',
  current_price: 20,
  market_segment: 'LISTED',
  eligible_for_ml: true,
  raw_signals: { close: 20 },
}

const plan = buildMultiStrategyPleRoutingPlan([candidate], [spec], {
  maxSlateSize: 1,
  minRouteScore: 0,
  regime: 'sideways',
  strategyWeights: { [spec.id]: 1 },
})
const annotated = plan.l0Annotated[0]
assert.equal(annotated.strategy_pre_regime_setup_hit_vector?.[spec.id], 1)
assert.equal(annotated.strategy_regime_eligible_vector?.[spec.id], 0)
assert.equal(annotated.strategy_hit_vector?.[spec.id], 0)
assert.equal(annotated.strategy_formal_veto_reason_vector?.[spec.id], 'unsupported_regime:sideways')
assert.ok((annotated.strategy_counterfactual_affinity_vector?.[spec.id] ?? 0) > 0)
assert.equal(annotated.strategy_counterfactual_production_effect_vector?.[spec.id], 0)

const evidence = buildSelectionEvidenceV4({
  signalDate: '2026-08-28',
  producerRunId: 's06-regime-veto-contract',
  candidates: [annotated],
  specs: [spec],
  strategyRegistryChecksum: 'registry-checksum',
})
assert.equal(evidence.matrix[0].pre_regime_setup_hit, 1)
assert.equal(evidence.matrix[0].regime_eligible, 0)
assert.equal(evidence.matrix[0].strategy_hit, 0)
assert.equal(evidence.matrix[0].formal_veto_reason, 'unsupported_regime:sideways')
assert.ok(evidence.matrix[0].counterfactual_affinity > 0)
assert.equal(evidence.matrix[0].counterfactual_production_effect, 0)

const migration = fs.readFileSync(
  path.join(process.cwd(), 'domain-migrations', 'learning', '0034_strategy_lifecycle_and_regime_veto_evidence.sql'),
  'utf8',
)
for (const field of [
  'pre_regime_setup_hit',
  'regime_eligible',
  'formal_veto_reason',
  'counterfactual_affinity',
  'counterfactual_production_effect',
]) assert.match(migration, new RegExp(field))
assert.match(migration, /CHECK\(counterfactual_production_effect = 0\)/)

console.log('strategyRegimeVetoCounterfactual: OK')
