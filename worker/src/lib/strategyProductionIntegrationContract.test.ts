import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const learningSource = readFileSync(resolve(process.cwd(), 'src/lib/strategyLearning.ts'), 'utf8')
const screenerSource = readFileSync(resolve(process.cwd(), 'src/lib/marketScreener.ts'), 'utf8')
const policyStoreSource = readFileSync(resolve(process.cwd(), 'src/lib/strategyProductionPolicyStore.ts'), 'utf8')
const marginalEdgePitSource = readFileSync(resolve(process.cwd(), 'src/lib/strategyMarginalEdgePointInTime.ts'), 'utf8')

assert.match(
  learningSource,
  /const productionPolicy = policy == null[\s\S]*?'production_policy'[\s\S]*?refreshStrategyProductionContributionPolicy/,
  'production firewall must only materialize after the persisted adaptive-policy evidence stage',
)
assert.match(
  learningSource,
  /knowledgeCutoffDate: date,[\s\S]*?gates: policy\.promotion_gate/,
  'production firewall must reuse the existing promotion-gate decisions and cutoff date',
)
assert.match(
  learningSource,
  /rewards,[\s\S]*?policy,[\s\S]*?productionPolicy,[\s\S]*?thresholdCalibration/,
  'finalizer result must expose production policy lineage',
)

assert.doesNotMatch(
  screenerSource,
  /getLatestStrategyPolicyState/,
  'screener must never serve the experimental adaptive shadow policy',
)
assert.match(
  screenerSource,
  /loadStrategyProductionPolicyBefore\(env\.DB, endDate, strategyIds\)/,
  'screener must load the immutable production policy point-in-time',
)
assert.match(
  screenerSource,
  /loadPromotedStrategyMarginalEdgeWeightsBefore\([\s\S]*?strategyIds,[\s\S]*?endDate/,
  'marginal-edge fallback must also use the signal-date cutoff',
)
assert.match(
  screenerSource,
  /const activeStrategyWeights = productionPolicyState\?\.state\.strategy_weights[\s\S]*?\?\? marginalEdgeState\?\.weights/,
  'production firewall must take precedence over PIT marginal-edge weights',
)
assert.match(
  screenerSource,
  /strategy_production_policy_checksum:[\s\S]*?strategy_production_policy_quarantined_strategy_ids:/,
  'screener telemetry must persist policy checksum and quarantined strategy ids',
)

assert.match(policyStoreSource, /knowledge_cutoff_date < \?/)
assert.doesNotMatch(policyStoreSource, /knowledge_cutoff_date <= \?/)
assert.match(policyStoreSource, /PRIMARY KEY\(policy_id, knowledge_cutoff_date, checksum\)/)
assert.match(policyStoreSource, /knowledge_cutoff_date=\? AND checksum=\?/)
assert.match(marginalEdgePitSource, /as_of_date < \?/)
assert.doesNotMatch(marginalEdgePitSource, /as_of_date <= \?/)

console.log('strategy production finalizer/screener/PIT integration contract tests passed')
