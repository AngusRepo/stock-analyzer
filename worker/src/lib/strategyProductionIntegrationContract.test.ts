import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const learningSource = readFileSync(resolve(process.cwd(), 'src/lib/strategyLearning.ts'), 'utf8')
const screenerSource = readFileSync(resolve(process.cwd(), 'src/lib/marketScreener.ts'), 'utf8')
const policyStoreSource = readFileSync(resolve(process.cwd(), 'src/lib/strategyProductionPolicyStore.ts'), 'utf8')
const policyServiceSource = readFileSync(resolve(process.cwd(), 'src/lib/strategyProductionPolicyService.ts'), 'utf8')

assert.match(
  learningSource,
  /const productionPolicy = policy == null[\s\S]*?'production_policy'[\s\S]*?refreshStrategyProductionContributionPolicy/,
  'production firewall must only materialize after the persisted adaptive-policy evidence stage',
)
assert.match(
  learningSource,
  /knowledgeCutoffDate: date,[\s\S]*?gates: policy\.promotion_gate,[\s\S]*?adaptiveState: policy\.policy_state/,
  'production firewall must reuse the existing promotion-gate decisions and cutoff date',
)
assert.match(
  learningSource,
  /rewards,[\s\S]*?policy,[\s\S]*?productionPolicy/,
  'finalizer result must expose production policy lineage',
)

assert.match(policyServiceSource, /source: 'adaptive_strategy_policy_v2'/)
assert.doesNotMatch(policyServiceSource, /loadCurrentPromotedBaseWeights/)
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
assert.doesNotMatch(
  screenerSource,
  /loadPromotedStrategyMarginalEdgeWeightsBefore/,
  'marginal-edge fallback must also use the signal-date cutoff',
)
assert.match(
  screenerSource,
  /listStrategySpecsForLearning\(env\.DB, \{ asOfDate: endDate \}\)/,
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
assert.match(learningSource, /knowledge_cutoff_date < \?/)
assert.doesNotMatch(learningSource, /knowledge_cutoff_date <= \?/)

console.log('strategy production finalizer/screener/PIT integration contract tests passed')
