import * as fs from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const manifest = JSON.parse(fs.readFileSync('../infra/gcp-scheduler-jobs.json', 'utf8'))
const workflows = fs.readFileSync('src/lib/controllerResearchWorkflows.ts', 'utf8')
const adminTasks = fs.readFileSync('src/lib/adminTriggerGcpTasks.ts', 'utf8')
const adminControlRoutes = fs.readFileSync('src/routes/adminControlRoutes.ts', 'utf8')
const updateOrchestrator = fs.readFileSync('src/lib/updateOrchestrator.ts', 'utf8')
const policies = fs.readFileSync('src/lib/schedulerPolicy.ts', 'utf8')
const triggerRoutes = fs.readFileSync('src/routes/adminTriggerRoutes.ts', 'utf8')
const scheduleReadRoutes = fs.readFileSync('src/routes/scheduleReadRoutes.ts', 'utf8')
const walkForward = fs.readFileSync('../ml-controller/routers/walk_forward.py', 'utf8')
const retrainFollowup = fs.readFileSync('../ml-controller/routers/retrain_followup.py', 'utf8')
const trainingPolicy = fs.readFileSync('../ml-service/app/training_policy.py', 'utf8')
const shadowPacketMigration = fs.readFileSync('migrations/0100_expected_return_shadow_evaluation_packets.sql', 'utf8')

const daily = manifest.jobs.find((job: any) => job.id === 'active8-oof-daily')
const watchdog = manifest.jobs.find((job: any) => job.id === 'active8-oof-daily-watchdog')
const weekly = manifest.jobs.find((job: any) => job.id === 'active8-oof-weekly')
assert(daily?.task === 'active8-oof-daily' && daily?.schedule === '55 17 * * *', 'daily must materialize ready OOF cohorts after native lifecycle closure')
assert(watchdog?.task === 'active8-oof-daily' && watchdog?.schedule === '25,55 18-23 * * *', 'watchdog must retry the same idempotent daily lifecycle until the immutable-prep freshness watermark closes')
assert(weekly?.task === 'active8-oof-weekly' && weekly?.schedule === '5 23 * * 6', 'weekly must own deterministic purged OOF cohort generation')
assert(!manifest.jobs.some((job: any) => ['l4-alpha-ev-refresh', 'allocator-ev-fusion-refresh', 'monthly-l4-alpha-ev-refresh', 'monthly-allocator-ev-fusion-refresh', 'opb-arm-prior-refresh', 'monthly-opb-arm-prior-refresh'].includes(job.id)), 'legacy independent EV/OPB refresh jobs must not race the canonical OOF lifecycle')
assert(!['l4-alpha-ev-refresh', 'allocator-ev-fusion-refresh', 'monthly-l4-alpha-ev-refresh', 'monthly-allocator-ev-fusion-refresh', 'opb-arm-prior-refresh', 'monthly-opb-arm-prior-refresh'].some((task) => scheduleReadRoutes.includes(`task: '${task}'`)), 'schedule UI must not advertise legacy independent EV/OPB jobs removed from the canonical manifest')

assert(workflows.includes("'/walk_forward/oof/lifecycle'"), 'all Worker cadence tasks must call the same controller OOF lifecycle owner')
assert(workflows.includes("dispatch_full_fit: cadence !== 'daily'"), 'daily evidence materialization must not implicitly dispatch Active-8 full-fit training')
assert(workflows.includes('promote: options.continuationOnly ? false : true'), 'cohort continuation must never promote a candidate')
assert(workflows.includes("dispatch_full_fit: cadence !== 'daily'"), 'weekly/monthly continuation must poll the existing full-fit lifecycle')
assert(workflows.includes('continuation_only: options.continuationOnly === true'), 'Worker must explicitly attest materialization-only continuation')
assert(workflows.includes("evidence_mode: 'purged_oof'"), 'manual Fusion refresh must use formal purged OOF evidence')
for (const task of ['active8-oof-daily', 'active8-oof-weekly', 'active8-oof-monthly']) {
  assert(adminTasks.includes(`'${task}'`), `${task} must have an admin trigger handler`)
  assert(policies.includes(`'${task}'`), `${task} must have an explicit scheduler policy`)
  assert(triggerRoutes.includes(`'${task}'`), `${task} must be synchronous and long-running observable work`)
}
assert(policies.includes("'active8-oof-daily': { kind: 'maintenance', holidayGated: false"), 'post-midnight daily OOF continuation must not be skipped by the next calendar day weekend/holiday gate')
assert(adminControlRoutes.includes("body.task === 'active8-oof-daily'"), 'daily OOF callback must own an event-driven follow-up')
assert(adminControlRoutes.includes("active8FreshnessStatus === 'fresh'"), 'Allocator follow-up must run only after the durable OOF freshness audit passes')
assert(adminControlRoutes.includes('readinessRunDate = active8FreshnessBusinessDate ?? callbackRunDate'), 'fresh daily OOF callback must prefer immutable prep business date over the post-midnight scheduler date')
assert(adminControlRoutes.includes('runDailyAllocatorEvReadiness(c.env, readinessRunDate, {'), 'fresh daily OOF callback must re-evaluate Allocator readiness for the immutable prep business date')
assert(adminControlRoutes.includes('knowledgeCutoffDate: callbackRunDate'), 'post-midnight OOF follow-up must inspect evidence using the callback knowledge cutoff')
assert(adminControlRoutes.includes('attemptId: callbackAttemptId'), 'OOF follow-up must preserve the materialization attempt identity')
assert(updateOrchestrator.includes('inspectExpectedReturnLifecycleHealth(env, knowledgeCutoffDate)'), 'Allocator lifecycle health must use the callback knowledge cutoff')
assert(updateOrchestrator.includes('refreshExpectedReturnServingState(env, knowledgeCutoffDate)'), 'Allocator serving state must use the callback knowledge cutoff')
assert(updateOrchestrator.includes('const schedulerRunId = options.runId ??'), 'each readiness inspection must have an explicit scheduler run identity')
assert(updateOrchestrator.includes('run_id: schedulerRunId'), 'readiness result must supersede stale red telemetry as an explicit run')
assert(updateOrchestrator.includes("'safe_abstain'"), 'completed Allocator inspection without a production owner must have a terminal safe-abstain state')
assert(updateOrchestrator.includes('const operationallyHealthy = hardAlerts.length === 0'), 'only hard lifecycle/serving alerts may fail the Allocator job operationally')
assert(/!safeProductionLane\s+\? 'safe_abstain'/.test(updateOrchestrator), 'missing quality-qualified owner must abstain without fabricating an execution error')
assert(updateOrchestrator.includes("status: state === 'fatal' ? 'error' : 'success'"), 'safe abstention must close Scheduler green while preserving fatal infrastructure errors')
assert(updateOrchestrator.includes('action_ready=${safeProductionLane ? 1 : 0}'), 'Allocator summary must separate job completion from BUY/allocation readiness')
assert(!adminControlRoutes.includes("active8FreshnessStatus === 'fresh'\n    && callbackRunDate\n    &&"), 'OOF follow-up must not silently add an unrelated promotion or training condition')
assert(adminControlRoutes.includes("type: 'active8_oof_continuation'"), 'weekly/monthly spawned cohorts must enqueue a delayed durable continuation')
assert(adminControlRoutes.includes('oofExpectedCohortId: expectedCohortId'), 'continuation must stay pinned to the exact immutable cohort identity')
assert(adminControlRoutes.includes('delaySeconds: 300'), 'continuation retries must be delayed instead of hot-looping')
assert(updateOrchestrator.includes("if (msg.type === 'active8_oof_continuation')"), 'update queue must consume the durable OOF continuation')
assert(updateOrchestrator.includes('continuationOnly: true'), 'queue continuation must enforce materialization-only mode')

assert(walkForward.includes('@router.post("/walk_forward/oof/lifecycle")'), 'controller must expose the shared OOF lifecycle owner')
assert(walkForward.includes('label_known_dates') && walkForward.includes('known <= cutoff'), 'OOF cohort generation must use row-level immutable label-known dates')
assert(walkForward.includes('cohort_dates = mature_dates[-OOF_MIN_MATURE_SESSIONS:]'), 'weekly/monthly OOF must use the deterministic mature-session cohort')
assert(walkForward.includes('train_window_days=OOF_TRAIN_SESSIONS') && walkForward.includes('test_window_days=OOF_TEST_SESSIONS'), 'OOF cohort must use the canonical 60/10 purged walk-forward windows')
assert(walkForward.includes('active8-oof-dispatch-v1') && walkForward.includes('cohort_orchestrator_active'), 'OOF generation must have a durable idempotent dispatch fence')
assert(
  walkForward.includes('if req.continuation_only:') &&
    walkForward.includes('cohort_manifest_not_ready_for_continuation') &&
    walkForward.includes('"training_dispatched": False') &&
    walkForward.indexOf('if req.continuation_only:') < walkForward.indexOf('plan = WalkForwardRequest('),
  'continuation must stop before training dispatch while the existing cohort manifest is not ready',
)
assert(
  walkForward.includes('active8-oof-lifecycle-receipt-v12-feature-source-attested') &&
    walkForward.includes('_oof_lifecycle_receipt_matches_active_policy'),
  'materialization/promotion must invalidate stale receipts when the active PIT policy changes',
)
assert(
  walkForward.includes('build_frozen_oof_forward_extension') &&
    walkForward.indexOf('extension.get("error")') >= 0 &&
    walkForward.indexOf('extension.get("error")') < walkForward.indexOf('daily_forward_extension_dispatched_training') &&
    walkForward.includes('daily_forward_extension_dispatched_training') &&
    walkForward.includes('daily_forward_extension_claimed_promotion_eligibility') &&
    walkForward.includes('forward_extension_manifest_path=forward_extension_manifest_path') &&
    walkForward.includes('forward_extension_retry_required'),
  'daily lifecycle must feed exact frozen forward evidence into materialization, without training or promotion, and remain retryable when blocked',
)
assert(
  walkForward.includes('"evidence_closure"') && walkForward.includes('"serving_closure"'),
  'lifecycle receipts must not conflate materialized evidence with a promoted serving champion',
)
assert(
  walkForward.includes('archive_ev_shadow_evaluation_packets') &&
    walkForward.includes('shadow_evaluation_packets') &&
    shadowPacketMigration.includes("policy_decision = 'shadow_only'") &&
    !shadowPacketMigration.includes('model_artifact_registry'),
  'daily frozen-forward L4/Fusion evaluation packets must persist separately from promotion candidates',
)
assert(
  walkForward.includes('active8-oof-full-fit-receipt-v1') &&
    walkForward.includes('FROM model_artifact_registry') &&
    walkForward.includes('full_fit_retry_limit_reached'),
  'full-fit dispatch must remain retryable until every eligible artifact reaches registry closure',
)
assert(
  walkForward.includes('if forward_extension_retry_required:') &&
    walkForward.includes('"reason": "daily_forward_extension_not_materialized"') &&
    walkForward.includes('"dependency_retry_required": True') &&
    walkForward.includes('dependency_retry_required = opb_failed or full_fit_retry_required') &&
    walkForward.includes('if not req.dry_run and not dependency_retry_required'),
  'frozen-forward gaps must stop before stale materialization; failed OPB/full-fit must remain terminal and retryable',
)
assert(
  walkForward.includes('"mature_max_date"') &&
    walkForward.includes('"calendar": calendar_evidence'),
  'OOF lifecycle and receipts must expose the immutable-prep mature watermark to durable callbacks',
)
const oofJob = fs.readFileSync('../ml-controller/oof_materialize_job_main.py', 'utf8')
assert(oofJob.includes('oof_freshness_closure_failed') && oofJob.includes('effective_oof_max_behind_immutable_prep'), 'terminal OOF success must fail closed when effective max is stale')
assert(oofJob.includes('"business_date": str(prep_lifecycle.get("business_date")'), 'OOF callback freshness metadata must carry the immutable prep business date across midnight')
assert(walkForward.indexOf('promoted = True') < walkForward.indexOf('/api/admin/trigger/opb-arm-prior-refresh'), 'OPB refresh must be event-driven only after successful EV promotion')

const monthlyHandoff = retrainFollowup.indexOf('run_walk_forward_oof_lifecycle')
const monthlyCallback = retrainFollowup.indexOf('scheduler_callback = await _callback_worker_scheduler(payload)')
assert(monthlyHandoff >= 0 && monthlyHandoff < monthlyCallback, 'Active-8 full-fit must resume its OOF lifecycle before reporting callback closure')
assert(
  retrainFollowup.includes('OOF full-fit completed but lifecycle resume failed') && retrainFollowup.indexOf('raise HTTPException(', monthlyHandoff) < monthlyCallback,
  'failed Active-8 lifecycle resume must return a retryable non-2xx before scheduler callback closure',
)
assert(retrainFollowup.includes('_resume_oof_full_fit_lifecycle') && retrainFollowup.includes('oof_lifecycle_resume_manifest_identity_mismatch'), 'completed OOF full-fit must resume only its checksum-bound lifecycle')
assert(walkForward.includes('OOF_MATERIALIZE_EXPECTED_COHORT_ID'), 'durable materialization resume must remain bound to the originating cohort')
assert(walkForward.includes('OOF_MATERIALIZE_DISPATCH_FULL_FIT') && walkForward.includes('if not req.dry_run and req.dispatch_full_fit'), 'full-fit training must require an explicit lifecycle dispatch flag')
assert(walkForward.includes('full_fit_poll_only=req.continuation_only'), 'continuation must carry an explicit poll-only guard into materialization')
assert(walkForward.includes('allow_new_dispatch=not req.full_fit_poll_only'), 'poll-only continuation must be unable to start a replacement retrain')
assert(walkForward.includes('if not allow_new_dispatch:'), 'full-fit dispatcher must fail closed when a poll-only receipt is missing or terminal-failed')
assert(walkForward.includes('outer_fold_majority_vote') && walkForward.includes('active8-oof-full-fit-feature-consensus-v1'), 'tree full-fit must use checksum-bound majority consensus from outer OOF feature selections')
for (const field of ['gcs_prefix', 'feature_pool_path', 'dataset_snapshot']) {
  assert(trainingPolicy.includes(`"${field}"`), `full-fit train payload must preserve ${field} lineage`)
}
