import assert from 'node:assert/strict'
import { loadFeatureRegistrySnapshot } from '../strategy-discovery/featureRegistry'
import { buildStrategyRegistrySnapshot, strategyCardFromRegistryRow } from '../strategy-discovery/strategyRegistry'

function strategyRow(i: number): Record<string, unknown> {
  const id = `S${String(i + 1).padStart(2, '0')}`
  return {
    strategy_id: id,
    version: 'strategy-spec-v1',
    name: `Strategy ${id}`,
    status: 'active',
    alpha_bucket: i % 2 ? 'trend' : 'defensive',
    family_id: `F${i}`,
    variant_id: `V${i}`,
    owner_type: 'strategy',
    promotion_status: 'production',
    supported_regimes_json: '["bull","sideways"]',
    thesis: `Hypothesis ${id}`,
    thresholds_json: JSON.stringify({ featureRefs: { weightedScore: { min: 0.5, terms: [{ featureRef: 'l1_bbBandwidthPct', weight: 1 }] } } }),
    candidate_policy_json: '{}',
    risk_notes_json: '[]',
    source_refs_json: '[]',
  }
}

async function main() {
  const featureSnapshot = await loadFeatureRegistrySnapshot({ l1_bbBandwidthPct: ['S01'] })
  assert.equal(featureSnapshot.cards.length, 137)
  assert.equal(featureSnapshot.cards.find((card) => card.feature_id === 'l1_bbBandwidthPct')?.used_by_strategies[0], 'S01')
  assert.match(featureSnapshot.featureVersion, /^FV-[a-f0-9]{16}$/)

  const card = strategyCardFromRegistryRow(strategyRow(0))
  assert.deepEqual(card.feature_ids, ['l1_bbBandwidthPct'])
  assert.equal(card.transaction_cost, 'UNKNOWN')

  const runtimeOnlyCard = strategyCardFromRegistryRow({
    ...strategyRow(0),
    thresholds_json: JSON.stringify({
      minPrice: 10,
      minForeignTrustNet5d: 0,
      dsl: { all: [{ signal: 'technicalIndicators.stockTechS01Admission', op: '==', value: 1 }] },
    }),
  })
  assert.deepEqual(runtimeOnlyCard.feature_ids, [
    'runtime_signal:technicalIndicators.stockTechS01Admission',
    'threshold:minForeignTrustNet5d',
  ])

  await assert.rejects(() => buildStrategyRegistrySnapshot([strategyRow(0)]), /strategy_count_mismatch/)
  const snapshot = await buildStrategyRegistrySnapshot(Array.from({ length: 13 }, (_, i) => strategyRow(i)))
  assert.equal(snapshot.cards.length, 13)
  assert.equal(snapshot.featureUsage.l1_bbBandwidthPct.length, 13)
  assert.match(snapshot.strategyVersion, /^SV-[a-f0-9]{16}$/)
}

void main()
