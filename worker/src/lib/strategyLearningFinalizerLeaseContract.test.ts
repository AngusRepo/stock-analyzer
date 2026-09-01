import assert from 'node:assert/strict'
import fs from 'node:fs'

const runState = fs.readFileSync('src/lib/strategyLearningRunState.ts', 'utf8')
const finalizer = fs.readFileSync('src/lib/strategyLearning.ts', 'utf8')
const orchestrator = fs.readFileSync('src/lib/updateOrchestrator.ts', 'utf8')
const manual = fs.readFileSync('src/lib/adminTriggerWorkerDomainTasks.ts', 'utf8')
const finalizedTelemetry = fs.readFileSync('src/lib/strategyLearningFinalizedTelemetry.ts', 'utf8')
const opsMigration = fs.readFileSync('domain-migrations/ops/0012_evening_strategy_and_pit_residual_closure.sql', 'utf8')
const opsSchema = fs.readFileSync('domain-schemas/ops.sql', 'utf8')

for (const field of [
  'production_authority_intent',
  'policy_closure_status',
  'policy_closure_reason',
  'policy_closure_completed_at',
]) {
  assert.match(opsMigration, new RegExp(field), `Ops migration must materialize ${field}`)
  assert.match(opsSchema, new RegExp(field), `Ops schema must expose ${field}`)
}
assert.match(opsMigration, /legacy_success_backfill_no_durable_policy_closure/)
assert.match(opsMigration, /WHERE status='success'[\s\S]*policy_closure_status='pending'/)
assert.match(opsMigration, /policy_closure_status='evidence_only'/)

const initializeWriter = runState.slice(
  runState.indexOf('export async function initializeStrategyLearningRun'),
  runState.indexOf('export async function loadStrategyLearningRun'),
)
assert.match(initializeWriter, /ON CONFLICT\(business_date\) DO UPDATE SET[\s\S]*WHERE strategy_learning_runs\.status<>'success'/)

for (const writer of [
  'checkpointStrategyLearningPage',
  'completeStrategyLearningRun',
  'markStrategyLearningRunFinalized',
  'deferStrategyLearningFinalizer',
  'failStrategyLearningRun',
]) {
  const start = runState.indexOf(`export async function ${writer}`)
  assert.ok(start >= 0, `${writer} must exist`)
  const next = runState.indexOf('\nexport async function ', start + 1)
  const block = runState.slice(start, next >= 0 ? next : undefined)
  assert.match(block, /canonical_run_id=\?/)
  assert.match(block, /lease_owner=\?/)
  assert.match(block, /lease_expires_at >= CURRENT_TIMESTAMP/)
}
assert.doesNotMatch(runState, /meta\?\.changes/, 'writer-epoch triggers make meta.changes unsafe for lease fencing')
for (const alias of ['renewed', 'checkpointed', 'completed', 'finalized', 'reclaimed', 'released', 'deferred', 'failed']) {
  assert.match(runState, new RegExp(`RETURNING 1 AS ${alias}`), `${alias} mutation must fence by returned target row`)
}
const finalizeWriter = runState.slice(runState.indexOf('export async function markStrategyLearningRunFinalized'))
assert.match(finalizeWriter, /FROM pipeline_stage_runs p/)
assert.match(finalizeWriter, /p\.stage='post_verify_chain'/)
assert.match(finalizeWriter, /p\.canonical_run_id=strategy_learning_runs\.canonical_run_id/)
assert.doesNotMatch(
  finalizeWriter.slice(0, finalizeWriter.indexOf('\nexport async function ', 1)),
  /SET status='success', lease_owner=NULL/,
)
assert.match(runState, /export async function hasStrategyLearningPostVerifyAuthority/)
const closePostVerify = runState.slice(
  runState.indexOf('export async function closeStrategyLearningPostVerifyStage'),
  runState.indexOf('export async function hasStrategyLearningPostVerifyAuthority'),
)
assert.match(closePostVerify, /production_authority_intent=1/)
assert.match(closePostVerify, /policy_closure_status='materialized'/)
assert.doesNotMatch(closePostVerify, /policy_closure_status IN \('materialized', 'evidence_only'\)/)
assert.match(runState, /export async function adoptStrategyLearningPostVerifyAuthority/)
const authorityAdoption = runState.slice(
  runState.indexOf('export async function adoptStrategyLearningPostVerifyAuthority'),
  runState.indexOf('export async function reclaimStrategyLearningFinalizedLease'),
)
assert.match(authorityAdoption, /status='queued'/)
assert.match(authorityAdoption, /lease_owner IS NULL AND lease_expires_at IS NULL/)
assert.match(authorityAdoption, /processed_candidates=expected_candidates/)
assert.match(authorityAdoption, /persisted_decision_rows=expected_decision_rows/)
assert.match(authorityAdoption, /last_error LIKE 'strategy_learning_finalize_authority_lost:%'/)
assert.match(authorityAdoption, /p\.stage='post_verify_chain'/)
assert.match(authorityAdoption, /p\.status IN \('running', 'waiting', 'success'\)/)
assert.match(runState, /export async function releaseStrategyLearningFinalizedLease/)
assert.match(runState, /export async function reclaimStrategyLearningFinalizedLease/)
const reclaimWriter = runState.slice(runState.indexOf('export async function reclaimStrategyLearningFinalizedLease'))
assert.match(reclaimWriter, /status='success' AND completed_at IS NOT NULL/)
assert.match(reclaimWriter, /lease_owner IS NOT NULL AND lease_owner=\?/)
assert.match(reclaimWriter, /lease_expires_at IS NOT NULL/)
assert.match(reclaimWriter, /lease_expires_at < CURRENT_TIMESTAMP/)
assert.match(reclaimWriter, /p\.stage='post_verify_chain'/)
const releaseWriter = runState.slice(runState.indexOf('export async function releaseStrategyLearningFinalizedLease'))
assert.match(releaseWriter, /status='success' AND completed_at IS NOT NULL/)
assert.match(releaseWriter, /lease_owner=\? AND lease_expires_at >= CURRENT_TIMESTAMP/)
assert.match(releaseWriter, /p\.stage='post_verify_chain'/)
assert.match(runState, /setIntervalFn[\s\S]*60_000[\s\S]*heartbeatStrategyLearningLease/)

assert.match(finalizer, /await runtime\.assertLease\?\.\(stage\)[\s\S]*const result = await task\(\)/)
assert.match(finalizer, /const result = await task\(\)[\s\S]*await runtime\.assertLease\?\.\(stage\)[\s\S]*onStageComplete/)
assert.match(finalizer, /onStageComplete[\s\S]*await runtime\.assertLease\?\.\(stage\)[\s\S]*'success'/)

const queueStart = orchestrator.indexOf("if (msg.type === 'strategy_learning_materialize')")
const queueEnd = orchestrator.indexOf("if (msg.type === 'source_readiness_retry')", queueStart)
const queueBlock = orchestrator.slice(queueStart, queueEnd)
assert.match(queueBlock, /const learningDb = databaseForDataDomain\(env, 'learning'\)/)
assert.match(queueBlock, /const runStateDb = opsDb/)
assert.match(queueBlock, /claimStrategyLearningPage\(runStateDb/)
assert.match(queueBlock, /startStrategyLearningLeaseHeartbeat\(runStateDb/)
assert.doesNotMatch(queueBlock, /(?:loadStrategyLearningRun|seedDefaultStrategySpecRegistry|listStrategySpecsForLearning|initializeStrategyLearningRun|claimStrategyLearningPage|materializeStrategyDecisionLogChunk|checkpointStrategyLearningPage|completeStrategyLearningRun|startStrategyLearningLeaseHeartbeat|finalizeStrategyLearningEvidenceV5|markStrategyLearningRunFinalized|deferStrategyLearningFinalizer|failStrategyLearningRun)\(env\.DB/)
assert.match(queueBlock, /assertLease: assertFinalizerLease/)
assert.match(queueBlock, /finally \{[\s\S]*finalizerHeartbeat\?\.stop\(\)/)
assert.match(queueBlock, /const existingState = await loadStrategyLearningRun/)
assert.match(queueBlock, /reconcileStrategyLearningFinalizedRetryFastPath/)
assert.match(queueBlock, /no_live_telemetry_lease[\s\S]*root telemetry unchanged/)
const queueExistingLoad = queueBlock.indexOf('const existingState = await loadStrategyLearningRun')
const queueEarlyReturn = queueBlock.indexOf('if (await handleFinalizedRetry(existingState)) return', queueExistingLoad)
const queueStrategyImport = queueBlock.indexOf("await import('./strategyLearning')", queueExistingLoad)
const queueSeed = queueBlock.indexOf('await seedDefaultStrategySpecRegistry', queueExistingLoad)
const queueList = queueBlock.indexOf('await listStrategySpecsForLearning', queueExistingLoad)
const queueInitialize = queueBlock.indexOf('await initializeStrategyLearningRun', queueExistingLoad)
const queueSecondSuccessCheck = queueBlock.indexOf('if (await handleFinalizedRetry(state)) return', queueInitialize)
assert.ok(
  queueExistingLoad >= 0 && queueEarlyReturn > queueExistingLoad
  && queueEarlyReturn < queueStrategyImport && queueEarlyReturn < queueSeed
  && queueEarlyReturn < queueList && queueEarlyReturn < queueInitialize
  && queueSecondSuccessCheck > queueInitialize,
  'queue finalized retry must return before seed/list/init and recheck after initialize for races',
)
assert.match(queueBlock, /if \(durableFinalized\) throw error/)
assert.match(queueBlock, /if \(!finalized\)[\s\S]*return/)
const queueFinalizeCall = queueBlock.indexOf('const finalized = await markStrategyLearningRunFinalized')
const queueDurableFinalized = queueBlock.indexOf('durableFinalized = true', queueFinalizeCall)
const queueSuccessWrite = queueBlock.indexOf('await reconcileAndReleaseStrategyLearningFinalizedTelemetry(', queueDurableFinalized)
assert.ok(
  queueFinalizeCall >= 0 && queueDurableFinalized >= 0 && queueSuccessWrite >= 0
  && queueFinalizeCall < queueDurableFinalized && queueDurableFinalized < queueSuccessWrite,
  'queue root/task success must follow fenced D1 finalization',
)

const manualStart = manual.indexOf("'strategy-learning-finalize': async () =>")
const manualEnd = manual.indexOf("'selection-reference-identity-repair': async () =>", manualStart)
const manualBlock = manual.slice(manualStart, manualEnd)
assert.match(manualBlock, /reconcileStrategyLearningFinalizedRetryFastPath/)
assert.match(manualBlock, /no_live_telemetry_lease[\s\S]*already_finalized_without_live_telemetry_lease/)
const manualStateLoad = manualBlock.indexOf('const runState = await loadStrategyLearningRun')
const manualFastPath = manualBlock.indexOf('await reconcileStrategyLearningFinalizedRetryFastPath', manualStateLoad)
const manualStrategyImport = manualBlock.indexOf("await import('./strategyLearning')", manualStateLoad)
const manualCoverage = manualBlock.indexOf('await completeStrategyLearningRun', manualStateLoad)
assert.ok(
  manualStateLoad >= 0 && manualFastPath > manualStateLoad
  && manualFastPath < manualStrategyImport && manualFastPath < manualCoverage,
  'manual finalized retry must return before strategy/reference/policy work',
)
assert.match(manualBlock, /const learningDb = databaseForDataDomain\(c\.env, 'learning'\)/)
assert.match(manualBlock, /const runStateDb = databaseForDataDomain\(c\.env, 'ops'\)/)
assert.match(manualBlock, /claimStrategyLearningPage\(runStateDb/)
assert.match(manualBlock, /startStrategyLearningLeaseHeartbeat\(runStateDb/)
assert.doesNotMatch(manualBlock, /(?:loadStrategyLearningRun|claimStrategyLearningPage|completeStrategyLearningRun|startStrategyLearningLeaseHeartbeat|finalizeStrategyLearningEvidenceV5|markStrategyLearningRunFinalized|deferStrategyLearningFinalizer|failStrategyLearningRun)\(c\.env\.DB/)
assert.match(manualBlock, /assertLease: assertFinalizerLease/)
assert.match(manualBlock, /finally \{[\s\S]*finalizerHeartbeat\?\.stop\(\)/)
assert.match(manualBlock, /if \(durableFinalized\) throw error/)
assert.match(manualBlock, /if \(!finalized\)[\s\S]*return/)
const manualFinalizeCall = manualBlock.indexOf('const finalized = await markStrategyLearningRunFinalized')
const manualDurableFinalized = manualBlock.indexOf('durableFinalized = true', manualFinalizeCall)
const manualSuccessWrite = manualBlock.indexOf('await reconcileAndReleaseStrategyLearningFinalizedTelemetry(', manualDurableFinalized)
assert.ok(
  manualFinalizeCall >= 0 && manualDurableFinalized >= 0 && manualSuccessWrite >= 0
  && manualFinalizeCall < manualDurableFinalized && manualDurableFinalized < manualSuccessWrite,
  'manual root/task success must follow fenced D1 finalization',
)

assert.match(finalizedTelemetry, /strict: true/)
assert.match(finalizedTelemetry, /if \(input\.runScope === 'historical_replay'\) return/)
assert.match(finalizedTelemetry, /input\.runScope !== 'historical_replay'[\s\S]*closeStrategyLearningPostVerifyStage/)
assert.doesNotMatch(
  finalizedTelemetry, /export async function reconcileStrategyLearningFinalizedTelemetry/,
)
assert.match(finalizedTelemetry, /export async function reconcileStrategyLearningFinalizedRetryFastPath/)
const guardedReconcile = finalizedTelemetry.slice(
  finalizedTelemetry.indexOf('export async function reconcileAndReleaseStrategyLearningFinalizedTelemetry'),
)
const authorityCheck = guardedReconcile.indexOf('hasStrategyLearningPostVerifyAuthority')
const leaseRenewal = guardedReconcile.indexOf('heartbeatStrategyLearningLease')
const expiredReclaim = guardedReconcile.indexOf('reclaimStrategyLearningFinalizedLease')
const telemetryWrites = guardedReconcile.indexOf('reconcileStrategyLearningFinalizedTelemetry')
const fencedRelease = guardedReconcile.indexOf('releaseStrategyLearningFinalizedLease')
assert.ok(authorityCheck >= 0 && authorityCheck < leaseRenewal && leaseRenewal < expiredReclaim
  && expiredReclaim < telemetryWrites && telemetryWrites < fencedRelease)
for (const task of ['strategy-learning', 'post-verify-chain', 'evening-chain']) {
  assert.match(finalizedTelemetry, new RegExp(`logSchedulerResult\\(kv, '${task}'`))
}
