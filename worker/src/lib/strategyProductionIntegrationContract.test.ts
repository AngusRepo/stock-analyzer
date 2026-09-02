import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const learningSource = readFileSync(resolve(process.cwd(), 'src/lib/strategyLearning.ts'), 'utf8')
const screenerSource = readFileSync(resolve(process.cwd(), 'src/lib/marketScreener.ts'), 'utf8')
const policyStoreSource = readFileSync(resolve(process.cwd(), 'src/lib/strategyProductionPolicyStore.ts'), 'utf8')
const policyServiceSource = readFileSync(resolve(process.cwd(), 'src/lib/strategyProductionPolicyService.ts'), 'utf8')
const adminReadSource = readFileSync(resolve(process.cwd(), 'src/routes/adminReadRoutes.ts'), 'utf8')
const adminWriteSource = readFileSync(resolve(process.cwd(), 'src/routes/adminWriteRoutes.ts'), 'utf8')

const evidenceProfilesRoute = adminReadSource.slice(
  adminReadSource.indexOf("adminReadRoutes.get('/api/admin/strategy/evidence-profiles'"),
  adminReadSource.indexOf("adminReadRoutes.get('/api/admin/strategy/learning'"),
)
const formalLaneSource = evidenceProfilesRoute.slice(
  evidenceProfilesRoute.indexOf('formal: {'),
  evidenceProfilesRoute.indexOf('threshold_route_shadow:'),
)

assert.match(
  evidenceProfilesRoute,
  /import\('\.\.\/lib\/strategyProductionPolicyStore'\)/,
  'formal evidence read API must use the validated production-policy serving loader',
)
assert.match(
  evidenceProfilesRoute,
  /loadStrategyProductionPolicyBefore\(\s*learningDb,\s*twToday\(\),\s*runtimeSpecs\.map\(\(spec\) => spec\.id\),\s*\)\.catch\(\(\) => null\)/,
  'formal evidence read API must validate the complete non-retired runtime strategy set at the serving cutoff',
)
assert.match(
  evidenceProfilesRoute,
  /AND knowledge_cutoff_date=\?[\s\S]*?productionPolicyState\.knowledge_cutoff_date,[\s\S]*?productionPolicyState\.base_weight_run_id/,
  'formal cooldown reasons must resolve the adaptive policy row from the loaded production policy cutoff and base run',
)
assert.match(
  evidenceProfilesRoute,
  /lifecycle_recommendations_json[\s\S]*?base_lifecycle_recommendations: formalPolicy[\s\S]*?parseObject\(formalPolicy\.lifecycle_recommendations_json\)/,
  'formal lineage must expose persisted per-strategy lifecycle reasons from the same base policy row',
)
assert.doesNotMatch(
  evidenceProfilesRoute,
  /FROM strategy_production_policy_history_v1/,
  'formal evidence read API must not trust a raw latest active production-policy row',
)
assert.doesNotMatch(evidenceProfilesRoute, /const parseStringArray =/)
assert.doesNotMatch(evidenceProfilesRoute, /const parseNumberRecord =/)
assert.match(
  evidenceProfilesRoute,
  /const formalPolicyLineage = productionPolicyState && loadedProductionPolicy \? \{[\s\S]*?strategy_weights: productionPolicyState\.strategy_weights,[\s\S]*?positive_weight_count: productionPolicyState\.evidence\.positive_weight_count,[\s\S]*?evidence: productionPolicyState\.evidence,[\s\S]*?checksum: loadedProductionPolicy\.checksum,[\s\S]*?created_at: loadedProductionPolicy\.created_at/,
  'formal evidence read API must build lineage only from the validated loaded policy state',
)
assert.match(
  formalLaneSource,
  /formal_policy_lineage: formalPolicyLineage/,
  'lanes.formal must expose the sanitized formal policy lineage',
)
assert.doesNotMatch(
  formalLaneSource,
  /\w+\s*:\s*productionPolicy(?:\s*[,}])/,
  'lanes.formal must never return the raw production policy database row',
)
assert.doesNotMatch(
  formalLaneSource,
  /(?:^|[{,])\s*productionPolicy\s*[,}]/m,
  'lanes.formal must never return the raw production policy database row by shorthand',
)
assert.match(formalLaneSource, /status: servingProductionPolicyAvailable \? 'active' : 'unavailable'/)
assert.match(formalLaneSource, /production_effect: servingProductionPolicyAvailable/)
assert.doesNotMatch(
  formalLaneSource,
  /formalOwnerIntegrated/,
  'formal serving status must not be coupled to multi-horizon evidence-owner integration',
)
assert.match(evidenceProfilesRoute, /const formalOwnerIntegrated = storedOwnerLineageValid/)

assert.match(
  learningSource,
  /const productionPolicy = policy == null[\s\S]*?'production_policy'[\s\S]*?refreshStrategyProductionContributionPolicy/,
  'production firewall must only materialize after the persisted adaptive-policy evidence stage',
)
assert.match(adminWriteSource, /\/api\/admin\/strategy\/production-policy\/recover/,
  'production firewall recovery needs an explicit protected owner outside the high-write finalizer')
assert.match(adminWriteSource, /formal_strategy_evidence_closure_required:/,
  'production firewall recovery must require successful formal revenue-PIT closure')
assert.match(adminWriteSource, /X-Confirm-Strategy-Production-Policy/,
  'production firewall recovery must require a distinct confirmation header')
assert.doesNotMatch(adminWriteSource.slice(
  adminWriteSource.indexOf("adminWriteRoutes.post('/api/admin/strategy/production-policy/recover'"),
  adminWriteSource.indexOf("adminWriteRoutes.post('/api/admin/entry-model-v2/replay'"),
), /allowPromotion|submitOrder|LIVE_EXECUTION/,
  'production firewall recovery must not promote strategies or reach order submission')
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
  /loadStrategyProductionPolicyBefore\(databaseForDataDomain\(env, 'learning'\), endDate, strategyIds\)/,
  'screener must load the immutable production policy point-in-time',
)
assert.match(
  screenerSource,
  /runtimeStrategyRoutingWeights = runtimeStrategyWeightResolution\.routingWeights/,
  'screener must retain the bounded numeric routing weights resolved from the formal production policy',
)
assert.match(
  screenerSource,
  /buildStrategySimilarityEvidencePayload\([\s\S]*?strategyWeights: evaluationStrategyWeights/,
  'similarity/evidence reconstruction must continue to observe every strategy with unit evaluation weights',
)
assert.match(
  screenerSource,
  /buildLayer1StrategyBreadthPlan\([\s\S]*?productionStrategyWeights: runtimeStrategyRoutingWeights,[\s\S]*?performanceWeightOwner: runtimeStrategyPerformanceWeightOwner/,
  'production L1/PLE routing must consume numeric formal weights and the single performance-weight owner',
)
assert.doesNotMatch(
  screenerSource,
  /loadPromotedStrategyMarginalEdgeWeightsBefore/,
  'marginal-edge fallback must also use the signal-date cutoff',
)
assert.match(
  screenerSource,
  /listStrategySpecsForLearning\(databaseForDataDomain\(env, 'learning'\), \{ asOfDate: endDate \}\)/,
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
