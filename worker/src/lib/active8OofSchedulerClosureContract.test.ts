import * as fs from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const manifest = JSON.parse(fs.readFileSync('../infra/gcp-scheduler-jobs.json', 'utf8'))
const workflows = fs.readFileSync('src/lib/controllerResearchWorkflows.ts', 'utf8')
const adminTasks = fs.readFileSync('src/lib/adminTriggerGcpTasks.ts', 'utf8')
const policies = fs.readFileSync('src/lib/schedulerPolicy.ts', 'utf8')
const triggerRoutes = fs.readFileSync('src/routes/adminTriggerRoutes.ts', 'utf8')
const walkForward = fs.readFileSync('../ml-controller/routers/walk_forward.py', 'utf8')
const retrainFollowup = fs.readFileSync('../ml-controller/routers/retrain_followup.py', 'utf8')
const trainingPolicy = fs.readFileSync('../ml-service/app/training_policy.py', 'utf8')

const daily = manifest.jobs.find((job: any) => job.id === 'active8-oof-daily')
const watchdog = manifest.jobs.find((job: any) => job.id === 'active8-oof-daily-watchdog')
const weekly = manifest.jobs.find((job: any) => job.id === 'active8-oof-weekly')
assert(daily?.task === 'active8-oof-daily' && daily?.schedule === '55 17 * * 1-5', 'daily must materialize ready OOF cohorts after native lifecycle closure')
assert(watchdog?.task === 'active8-oof-daily' && watchdog?.schedule === '25,55 18-20 * * 1-5', 'watchdog must retry the same idempotent daily lifecycle after prep dependencies settle')
assert(weekly?.task === 'active8-oof-weekly' && weekly?.schedule === '5 23 * * 6', 'weekly must own deterministic purged OOF cohort generation')
assert(!manifest.jobs.some((job: any) => ['l4-alpha-ev-refresh', 'allocator-ev-fusion-refresh', 'monthly-l4-alpha-ev-refresh', 'monthly-allocator-ev-fusion-refresh', 'opb-arm-prior-refresh', 'monthly-opb-arm-prior-refresh'].includes(job.id)), 'legacy independent EV/OPB refresh jobs must not race the canonical OOF lifecycle')

assert(workflows.includes("'/walk_forward/oof/lifecycle'"), 'all Worker cadence tasks must call the same controller OOF lifecycle owner')
for (const task of ['active8-oof-daily', 'active8-oof-weekly', 'active8-oof-monthly']) {
  assert(adminTasks.includes(`'${task}'`), `${task} must have an admin trigger handler`)
  assert(policies.includes(`'${task}'`), `${task} must have an explicit scheduler policy`)
  assert(triggerRoutes.includes(`'${task}'`), `${task} must be synchronous and long-running observable work`)
}
assert(policies.includes("'active8-oof-daily': { kind: 'maintenance', holidayGated: false"), 'post-midnight daily OOF continuation must not be skipped by the next calendar day weekend/holiday gate')

assert(walkForward.includes('@router.post("/walk_forward/oof/lifecycle")'), 'controller must expose the shared OOF lifecycle owner')
assert(walkForward.includes('label_known_dates') && walkForward.includes('known <= cutoff'), 'OOF cohort generation must use row-level immutable label-known dates')
assert(walkForward.includes('cohort_dates = mature_dates[-OOF_MIN_MATURE_SESSIONS:]'), 'weekly/monthly OOF must use the deterministic mature-session cohort')
assert(walkForward.includes('train_window_days=OOF_TRAIN_SESSIONS') && walkForward.includes('test_window_days=OOF_TEST_SESSIONS'), 'OOF cohort must use the canonical 60/10 purged walk-forward windows')
assert(walkForward.includes('active8-oof-dispatch-v1') && walkForward.includes('cohort_orchestrator_active'), 'OOF generation must have a durable idempotent dispatch fence')
assert(walkForward.includes('active8-oof-lifecycle-receipt-v1'), 'materialization/promotion must write a durable per-cutoff receipt')
assert(
  walkForward.includes('active8-oof-full-fit-receipt-v1') &&
    walkForward.includes('FROM model_artifact_registry') &&
    walkForward.includes('full_fit_retry_limit_reached'),
  'full-fit dispatch must remain retryable until every eligible artifact reaches registry closure',
)
assert(
  walkForward.includes('dependency_retry_required = opb_failed or full_fit_retry_required') &&
    walkForward.includes('if not req.dry_run and not dependency_retry_required'),
  'failed OPB refresh or full-fit dispatch must leave lifecycle retryable instead of writing false closure',
)
assert(walkForward.indexOf('promoted = True') < walkForward.indexOf('/api/admin/trigger/opb-arm-prior-refresh'), 'OPB refresh must be event-driven only after successful EV promotion')

const monthlyHandoff = retrainFollowup.indexOf('run_walk_forward_oof_lifecycle')
const monthlyCallback = retrainFollowup.indexOf('scheduler_callback = await _callback_worker_scheduler(payload)')
assert(monthlyHandoff >= 0 && monthlyHandoff < monthlyCallback, 'monthly retrain must hand off to OOF lifecycle before reporting callback closure')
assert(retrainFollowup.includes('callback must retry until OOF handoff is durable'), 'failed monthly OOF handoff must keep retrain callback retryable')
assert(retrainFollowup.includes('_resume_oof_full_fit_lifecycle') && retrainFollowup.includes('oof_lifecycle_resume_manifest_identity_mismatch'), 'completed OOF full-fit must resume only its checksum-bound lifecycle')
assert(walkForward.includes('OOF_MATERIALIZE_EXPECTED_COHORT_ID'), 'durable materialization resume must remain bound to the originating cohort')
assert(walkForward.includes('outer_fold_majority_vote') && walkForward.includes('active8-oof-full-fit-feature-consensus-v1'), 'tree full-fit must use checksum-bound majority consensus from outer OOF feature selections')
for (const field of ['gcs_prefix', 'feature_pool_path', 'dataset_snapshot']) {
  assert(trainingPolicy.includes(`"${field}"`), `full-fit train payload must preserve ${field} lineage`)
}
