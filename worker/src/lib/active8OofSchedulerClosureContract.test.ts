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

const daily = manifest.jobs.find((job: any) => job.id === 'active8-oof-daily')
const weekly = manifest.jobs.find((job: any) => job.id === 'active8-oof-weekly')
assert(daily?.task === 'active8-oof-daily' && daily?.schedule === '55 17 * * 1-5', 'daily must materialize ready OOF cohorts after native lifecycle closure')
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
assert(walkForward.includes('mature_dates = dates[:-5]'), 'OOF cohort generation must purge the five-session unresolved label horizon')
assert(walkForward.includes('cohort_dates = mature_dates[-90:]'), 'weekly/monthly OOF must use the deterministic 90-session three-fold cohort')
assert(walkForward.includes('train_window_days=60') && walkForward.includes('test_window_days=10'), 'OOF cohort must use the canonical 60/10 purged walk-forward windows')
assert(walkForward.includes('active8-oof-dispatch-v1') && walkForward.includes('cohort_orchestrator_active'), 'OOF generation must have a durable idempotent dispatch fence')
assert(walkForward.includes('active8-oof-lifecycle-receipt-v1'), 'materialization/promotion must write a durable per-cutoff receipt')
assert(walkForward.includes('if not req.dry_run and not opb_failed'), 'failed post-promotion OPB refresh must leave lifecycle retryable instead of writing false closure')
assert(walkForward.indexOf('promoted = True') < walkForward.indexOf('/api/admin/trigger/opb-arm-prior-refresh'), 'OPB refresh must be event-driven only after successful EV promotion')

const monthlyHandoff = retrainFollowup.indexOf('run_walk_forward_oof_lifecycle')
const monthlyCallback = retrainFollowup.indexOf('scheduler_callback = await _callback_worker_scheduler(payload)')
assert(monthlyHandoff >= 0 && monthlyHandoff < monthlyCallback, 'monthly retrain must hand off to OOF lifecycle before reporting callback closure')
assert(retrainFollowup.includes('callback must retry until OOF handoff is durable'), 'failed monthly OOF handoff must keep retrain callback retryable')
