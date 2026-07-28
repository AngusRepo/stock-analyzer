import assert from 'node:assert/strict'
import fs from 'node:fs'

const registry = fs.readFileSync('src/lib/expectedReturnServingRegistry.ts', 'utf8')
const servingState = fs.readFileSync('src/lib/expectedReturnServingState.ts', 'utf8')
const promotionRoute = fs.readFileSync('src/routes/adminConfigCoreRoutes.ts', 'utf8')
const orchestrator = fs.readFileSync('src/lib/updateOrchestrator.ts', 'utf8')
const migration = fs.readFileSync('migrations/0087_expected_return_serving_baseline.sql', 'utf8')

assert(registry.includes('FROM model_champion_pointers p'))
assert(registry.includes('LEFT JOIN expected_return_artifact_payloads x'))
assert(registry.includes('champion_payload_checksum_mismatch'))
assert(registry.includes('legacy_config_fallback_blocked'))
assert(registry.includes('await db.batch(['))
assert(registry.includes('INSERT INTO model_champion_pointers'))
assert(registry.includes('INSERT OR IGNORE INTO model_champion_history'))
assert(registry.includes('offline_gate_decision !== \'PASS\''))
assert(registry.includes("candidate_cohort.status = 'ready'"))
assert(registry.includes('ORDER BY candidate.updated_at DESC, candidate.cohort_id DESC'))
assert(!registry.includes('SELECT artifact_kind, MAX(max_date) AS max_date'))
assert(registry.includes('champion_payload_table_version_mismatch'))
assert(registry.includes("candidate_type IN ('l4_alpha_ev_refresh', 'allocator_ev_fusion_refresh')"))
assert(registry.includes('production_candidate_not_champion_pointer'))

assert(servingState.includes("state: 'production_primary' | 'safe_abstention' | 'no_eligible_owner'"))
assert(servingState.includes("sourceOfTruth: 'model_champion_pointers+artifact_payloads'"))
assert(servingState.includes("artifact.serving_mode === 'abstention_baseline'"))
assert(servingState.includes("artifact.validation_packet?.alpha_quality_passed !== false"))

const promoteStart = promotionRoute.indexOf("adminConfigCoreRoutes.post('/api/admin/config/expected-return/promote'")
const promoteEnd = promotionRoute.indexOf("adminConfigCoreRoutes.post('/api/admin/config/push-defaults'", promoteStart)
const promoteBody = promotionRoute.slice(promoteStart, promoteEnd)
assert(
  promoteBody.indexOf('pointerCommit = await commitExpectedReturnChampion')
    < promoteBody.indexOf('snapshot = await setTradingConfig'),
)
assert(promoteBody.includes('D1 pointer + payload is the serving authority'))
assert(
  promoteBody.indexOf('hydrateExpectedReturnConfigFromPointers') < promoteBody.indexOf('const plan = buildExpectedReturnOwnerPromotionPlan'),
)

const readinessStart = orchestrator.indexOf('async function runDailyAllocatorEvReadiness')
const readinessEnd = orchestrator.indexOf('async function continuePostScreenerPipeline', readinessStart)
const readinessBody = orchestrator.slice(readinessStart, readinessEnd)
assert(readinessBody.includes('inspectExpectedReturnLifecycleHealth'))
assert(!readinessBody.includes('runL4AlphaEvRefresh'))
assert(!readinessBody.includes('runAllocatorEvFusionRefresh'))

for (const owner of ['l4_alpha_ev', 'allocator_ev_fusion']) {
  assert(migration.includes(`'${owner}'`))
}
assert.equal((migration.match(/contract_valid_abstention_bootstrap/g) ?? []).length, 2)
assert.equal((migration.match(/ON CONFLICT\(model_name\) DO NOTHING/g) ?? []).length, 2)
assert(migration.includes("serving_mode TEXT NOT NULL CHECK(serving_mode IN ('alpha','abstention_baseline'))"))
assert(migration.includes("promotion_decision = 'baseline_retained_for_rollback'"))
assert(migration.includes('pointer.champion_artifact_id != model_artifact_registry.artifact_id'))
assert(migration.includes('UPDATE model_champion_history'))
assert(migration.includes('SET retired_at = COALESCE(retired_at, CURRENT_TIMESTAMP)'))

console.log('expectedReturnServingRegistryContract tests passed')
