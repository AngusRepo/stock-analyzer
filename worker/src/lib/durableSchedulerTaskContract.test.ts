import assert from 'node:assert/strict'
import fs from 'node:fs'

const route = fs.readFileSync('src/routes/adminTriggerRoutes.ts', 'utf8')
const types = fs.readFileSync('src/types.ts', 'utf8')
const orchestrator = fs.readFileSync('src/lib/updateOrchestrator.ts', 'utf8')
const processor = fs.readFileSync('src/lib/durableSchedulerTask.ts', 'utf8')
const gcpCron = fs.readFileSync('src/lib/cronGcpDomainTasks.ts', 'utf8')
const wrangler = fs.readFileSync('wrangler.toml', 'utf8')

assert(types.includes("| 'scheduled_admin_task'"))
assert(types.includes("scheduledTask?: 'external-evidence' | 'weekly-cleanup' | 's12-smcvwap-calibration'"))
assert(route.includes("type: 'scheduled_admin_task'"))
assert(route.includes("mode: 'durable_queue'"))
assert(route.includes('durable queue enqueue failed'))
assert(route.indexOf('UPDATE_QUEUE.send') < route.indexOf("mode: 'durable_queue'"))
assert(orchestrator.includes("msg.type === 'scheduled_admin_task'"))
assert(orchestrator.includes('processDurableSchedulerTask'))
assert(processor.includes("task === 'external-evidence'"))
assert(processor.includes("taskName: 'weekly-cleanup'"))
assert(processor.includes("task === 's12-smcvwap-calibration'"))
assert(processor.includes("databaseForDataDomain(env, 'learning')"))
assert(
  processor.includes("runWithMaintenanceLease(databaseForDataDomain(env, 'ops')"),
  'weekly cleanup lease must use the formal Ops D1 owner',
)
assert(processor.includes("resolveS12CalibrationCadence('auto', runDate)"))
assert(processor.includes('putTerminalReceipt'))
assert(processor.includes('runWeeklyCleanupClosure'))
assert(processor.includes('requireWeeklyLifecycleDryRunSuccess(lifecycle)'), 'weekly cleanup must fail closed on lifecycle non-success')
assert(processor.includes("summary.startsWith('model_pool dry_run=')"), 'lifecycle success must require the canonical dry-run receipt')
assert(processor.includes('putManualRunLog'))
assert(processor.includes('throw error'))
assert(
  gcpCron.includes("return 'triggered s12-smcvwap-calibration") && gcpCron.includes('callback expected'),
  'S12 enqueue must remain triggered until durable terminal callback, not report premature success',
)
assert(/queue = "stockvision-update-queue"[\s\S]+max_retries = 8[\s\S]+dead_letter_queue = "stockvision-update-queue-dlq"/.test(wrangler))

console.log('durable scheduler task contract tests passed')
