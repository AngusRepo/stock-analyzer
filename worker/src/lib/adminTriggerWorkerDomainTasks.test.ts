import { strict as assert } from 'node:assert'
import * as fs from 'node:fs'
import {
  normalizeAndValidateAuditJsonTargets,
  summarizeMlControllerWarmupTargets,
} from './adminTriggerWorkerDomainTasks'

const healthy = summarizeMlControllerWarmupTargets({
  targets: {
    predict_batch_v2: { status: 'ok' },
    gnn_graphsage_universal_predict: { status: 'ok' },
    timesfm_universal_predict: { status: 'ok' },
    strategy_similarity_evidence: {
      status: 'ok',
      algorithm_owner: 'ml-service-modal-python',
      kmedoids_pam_preflight_status: 'pass',
    },
  },
})

assert.equal(healthy.ok, true)
assert.match(healthy.summary, /strategy_similarity_evidence=ok/)
assert.match(healthy.summary, /pam=pass/)
assert.match(healthy.summary, /owner=ml-service-modal-python/)

const degraded = summarizeMlControllerWarmupTargets({
  targets: {
    predict_batch_v2: { status: 'ok' },
    strategy_similarity_evidence: {
      status: 'degraded',
      algorithm_owner: 'ml-service-modal-python',
      kmedoids_pam_preflight_status: 'blocked',
    },
  },
})

assert.equal(degraded.ok, false)
assert.match(degraded.summary, /strategy_similarity_evidence=degraded/)
assert.match(degraded.summary, /pam=blocked/)

const malformed = summarizeMlControllerWarmupTargets({ targets: null })
assert.equal(malformed.ok, false)
assert.equal(malformed.summary, 'targets=unknown')

assert.deepEqual(normalizeAndValidateAuditJsonTargets(
  ['strategy_decision_log', 'screener_funnel_items,canonical_screener_funnel_items'],
  ['strategy_decision_log', 'screener_funnel_items', 'canonical_screener_funnel_items'],
), ['strategy_decision_log', 'screener_funnel_items', 'canonical_screener_funnel_items'])
assert.throws(
  () => normalizeAndValidateAuditJsonTargets(
    ['strategy_decision_lgo'],
    ['strategy_decision_log'],
  ),
  /audit_json_retention_unknown_target:strategy_decision_lgo/,
)
assert.deepEqual(normalizeAndValidateAuditJsonTargets([], ['strategy_decision_log']), [])
assert.throws(
  () => normalizeAndValidateAuditJsonTargets([''], ['strategy_decision_log']),
  /audit_json_retention_empty_target/,
)
assert.throws(
  () => normalizeAndValidateAuditJsonTargets(['strategy_decision_log,'], ['strategy_decision_log']),
  /audit_json_retention_empty_target/,
)

const source = fs.readFileSync('src/lib/adminTriggerWorkerDomainTasks.ts', 'utf8')
const finalizedTelemetry = fs.readFileSync('src/lib/strategyLearningFinalizedTelemetry.ts', 'utf8')
assert.match(source, /'strategy-learning': \(\) => enqueueStrategyLearningMaterialization/)
assert.match(source, /type: 'strategy_learning_materialize'/)
assert.match(source, /production_recovery/)
assert.match(source, /policyMutationAllowed: forcePolicy/)
assert.match(source, /force: forcePolicy \|\| productionRecovery/)
assert.match(source, /'strategy-learning-finalize': async/)
assert.match(
  source,
  /'strategy-learning-finalize': async[\s\S]*recoverMatureSelectionEvidence[\s\S]*route_backfill_eligible=/,
)
assert.match(source, /completeStrategyLearningRun/)
assert.match(source, /finalizeStrategyLearningEvidenceV5/)
assert.match(source, /strategy_pit_rebuild=/)
assert.match(source, /allowPromotion: currentBusinessDateRun/)
assert.match(source, /resolveEveningChainRunAuthority/)
assert.match(source, /productionAuthority\?\.allowed === true/)
assert.match(source, /reconcileAndReleaseStrategyLearningFinalizedTelemetry\(/)
assert.match(source, /reconcileStrategyLearningFinalizedRetryFastPath\(/)
assert.match(source, /runScope,/)
assert.match(finalizedTelemetry, /strict: true/)
assert.match(finalizedTelemetry, /releaseStrategyLearningFinalizedLease/)
assert.match(finalizedTelemetry, /'strategy-learning'[\s\S]*'post-verify-chain'[\s\S]*'evening-chain'/)
assert.match(source, /reward_stale_retired/)
assert.match(source, /callback expected/)
assert.match(source, /'audit-json-retention': async/)
assert.match(source, /AUDIT_JSON_ARCHIVE_CONFIRM_PHRASE/)
assert.match(source, /AUDIT_JSON_ARCHIVE_TARGET_IDS/)
assert.match(source, /normalizeAndValidateAuditJsonTargets/)
assert.match(source, /audit_json_durable_requires_confirm_archive/)
assert.match(source, /auditJsonOptions:/)
assert.match(source, /confirmPhrase !== AUDIT_JSON_ARCHIVE_CONFIRM_PHRASE/)
assert.match(source, /PAPER_SHADOW_BACKFILL_ACTIVE_KEY/)
assert.match(source, /paperShadowSourceMutationProtected/)
assert.match(source, /\['shadow', 'read_cutover', 'write_cutover'\]\.includes\(cutoverStatus\)/)
assert.match(source, /requestedAuditTargets[\s\S]*target !== 'paper_execution_events'/)
assert.match(source, /target === 'superseded_pending_events'[\s\S]*paper_shadow_parity_protected/)
assert.match(source, /'s12-research-recovery': async/)
assert.match(source, /delaySeconds > 43_200/)
assert.match(source, /type: 's12_research_recovery'/)

const triggerRoutes = fs.readFileSync('src/routes/adminTriggerRoutes.ts', 'utf8')
assert.match(triggerRoutes, /'audit-json-retention'/)
assert.match(triggerRoutes, /'strategy-learning-finalize'/)

const updateOrchestrator = fs.readFileSync('src/lib/updateOrchestrator.ts', 'utf8')
assert.match(updateOrchestrator, /S12_REPLAY_QUEUE_CHUNK_SIZE = 20/)
assert.match(updateOrchestrator, /msg\.type === 's12_replay_backfill_chunk'/)
assert.match(updateOrchestrator, /runS12HistoricalReplayForDate\(env, triggerTime/)
assert.match(updateOrchestrator, /type: 's12_replay_backfill_chunk'/)
assert.match(updateOrchestrator, /cursor: nextOffset/)
assert.match(updateOrchestrator, /logSchedulerResult\(env\.KV, 's12-replay-backfill'/)
assert.match(source, /requestedScope === 'fusion_snapshot_missing'/)
assert.match(source, /requestedScope === 'fusion_snapshot_structure'/)
assert.match(source, /requestedScope === 'signed_eligible_repair'/)
assert.match(source, /replayScope/)
assert.match(updateOrchestrator, /loadFusionSnapshotMissingReplaySymbols/)
assert.match(updateOrchestrator, /loadSignedEligibleRepairSymbolsByHistoricalDate/)
assert.match(updateOrchestrator, /signedEligibleRepair: replayScope === 'signed_eligible_repair'/)
assert.match(updateOrchestrator, /signed replay made no strict-eligible lineage progress/)
assert.match(updateOrchestrator, /S12_REPLAY_LEASE_RETRY_BASE_DELAY_SECONDS = 60/)
assert.match(updateOrchestrator, /S12_REPLAY_LEASE_RETRY_MAX_DELAY_SECONDS = 180/)
assert.match(updateOrchestrator, /S12_REPLAY_LEASE_RETRY_MAX_ATTEMPTS = 60/)
assert.match(updateOrchestrator, /s12ReplayLeaseRetryDelaySeconds/)
assert.match(updateOrchestrator, /s12_research_lease_busy:/)
assert.match(updateOrchestrator, /leaseRetryAttempt: leaseRetryAttempt \+ 1/)
assert.match(updateOrchestrator, /scope=\$\{replayScope\}/)
assert.match(updateOrchestrator, /msg\.type === 's12_research_recovery'/)
assert.match(updateOrchestrator, /loadS12ResearchUsageStatus/)
assert.match(updateOrchestrator, /source: 's12_research_structure_reconstruction'/)
assert.match(updateOrchestrator, /runAllocatorEvFeatureSnapshotBackfill/)

const replaySource = fs.readFileSync('src/lib/s12ReplayTradeOutcome.ts', 'utf8')
assert.match(replaySource, /loadFusionSnapshotMissingReplaySymbols/)
assert.match(replaySource, /allocator_ev_feature_snapshots/)
assert.match(replaySource, /json_extract\(fs\.score_components, '\$\.version'\) = 'score_v2'/)
assert.match(replaySource, /fs\.snapshot_source = 'allocator_ev_asof_backfill_v2'/)
assert.match(replaySource, /ALLOCATOR_EV_SNAPSHOT_AS_OF_GUARD/)
assert.match(replaySource, /prediction_before_next_executable_session_open;exact_active8_artifact_lineage;l4_trained_before_snapshot;s12_samples_before_run/)
assert.match(replaySource, /selection_reference_snapshots_v1 r/)
assert.match(replaySource, /replay\.signal_date=r\.signal_date/)
assert.match(replaySource, /s12_multisession_structure_replay_v3/)
assert.match(replaySource, /resolveNextExecutableSessionDate/)
assert.match(replaySource, /loadReplayReadySignalDates/)
assert.match(replaySource, /NOT EXISTS/)

const replayDateMigration = fs.readFileSync('migration_s12_replay_signal_execution_date_2026_07_12.sql', 'utf8')
assert.match(replayDateMigration, /ADD COLUMN signal_date TEXT/)
assert.match(replayDateMigration, /symbol, signal_date, setup_id/)

const schedulerPolicy = fs.readFileSync('src/lib/schedulerPolicy.ts', 'utf8')
assert.match(schedulerPolicy, /'audit-json-retention'/)

const schedulerManifest = fs.readFileSync('../infra/gcp-scheduler-jobs.json', 'utf8')
assert.match(schedulerManifest, /"id": "audit-json-retention"/)
assert.match(schedulerManifest, /confirm_archive=ARCHIVE_D1_AUDIT_JSON_TO_R2/)
assert.match(schedulerManifest, /audit-json-retention[^\n]+durable=1/)
assert.match(schedulerManifest, /"id": "artifact-reconcile"/)
assert.doesNotMatch(schedulerManifest, /"id": "d1-evidence-scrub"/)
assert.doesNotMatch(schedulerManifest, /"id": "legacy-evidence-migration"/)
assert.doesNotMatch(schedulerManifest, /"id": "cleanup-dlq-replay"/)
assert.match(schedulerManifest, /legacy-strategy-evidence-migration[^\n]+durable=1/)
for (const retired of ['d1-evidence-scrub', 'legacy-evidence-migration', 'cleanup-dlq-replay']) {
  assert.match(schedulerManifest, new RegExp(`"${retired}"`))
}
assert.match(source, /D1_MAINTENANCE_REQUEST_BUDGET_MS = 45_000/)
assert.match(source, /leaseSeconds: 300/)
assert.match(schedulerManifest, /"id": "storage-health-check"/)
assert.doesNotMatch(schedulerManifest, /"id": "storage-health-gate"/)
assert.match(schedulerManifest, /"id": "storage-integrity-audit"/)
