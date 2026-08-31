import * as fs from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const adminControlRoutes = fs.readFileSync('src/routes/adminControlRoutes.ts', 'utf8')
const schedulerRunLogger = fs.readFileSync('src/lib/schedulerRunLogger.ts', 'utf8')
const finLabDispatchFence = fs.readFileSync('src/lib/finLabDispatchFence.ts', 'utf8')
const pipelineCallbackMarker = adminControlRoutes.indexOf("if (body.task === 'pipeline'")
const pipelineCallbackEndMarker = adminControlRoutes.indexOf("if (body.task === 's12-structure-batch')", pipelineCallbackMarker)
const pipelineCallbackBlock = adminControlRoutes.slice(pipelineCallbackMarker, pipelineCallbackEndMarker)
const pipelineContinuationMarker = pipelineCallbackBlock.indexOf(
  'const continuation = await queuePostPipelineStage(c.env',
)
const pipelineOwnershipFenceMarker = pipelineCallbackBlock.indexOf(
  'if (continuation.canonicalRunId !== callbackRunId)',
)
const pipelineRootAdoptionMarker = adminControlRoutes.indexOf(
  'pipeline terminal success accepted; post-pipeline owner confirmed',
  pipelineCallbackMarker,
)
const pipelineCatchMarker = pipelineCallbackBlock.indexOf('} catch (e: any) {')
const pipelineCatchBlock = pipelineCallbackBlock.slice(pipelineCatchMarker)

assert(
  adminControlRoutes.includes("adminControlRoutes.post('/api/admin/cron-callback'") &&
    adminControlRoutes.includes("adminControlRoutes.post('/api/admin/scheduler-callback'"),
  'cron and scheduler callbacks must share the callback handler',
)

assert(
  adminControlRoutes.includes('const callbackRunDate') &&
    adminControlRoutes.includes("typeof body.run_date === 'string'") &&
    adminControlRoutes.includes("typeof body.date === 'string'"),
  'callback handler must resolve explicit run_date/date before logging',
)

assert(
  adminControlRoutes.includes('const callbackRunId') &&
    adminControlRoutes.includes('run_id: callbackRunId') &&
    adminControlRoutes.includes('run_date: callbackRunDate'),
  'callback handler must persist run_id and run_date to scheduler logs',
)

assert(
  pipelineCallbackMarker >= 0 &&
    pipelineCallbackEndMarker > pipelineCallbackMarker &&
    pipelineContinuationMarker >= 0 &&
    pipelineOwnershipFenceMarker > pipelineContinuationMarker &&
    pipelineRootAdoptionMarker > pipelineCallbackMarker + pipelineOwnershipFenceMarker &&
    pipelineCallbackBlock.slice(pipelineOwnershipFenceMarker).includes('strict: true'),
  'pipeline success callback must queue the durable stage and verify canonical ownership before adopting the root run id',
)

assert(
  pipelineCallbackBlock.includes("error: 'post_pipeline_stage_owner_conflict'") &&
    pipelineCallbackBlock.includes('root_owner_unchanged=true') &&
    pipelineCallbackBlock.includes('active_run_id: continuation.canonicalRunId') &&
    pipelineCallbackBlock.includes('}, 409)'),
  'an active old stage lease must fail closed as retryable waiting without changing the root owner',
)

assert(
  pipelineCatchMarker >= 0 &&
    !pipelineCatchBlock.includes("logSchedulerResult(c.env.KV, 'evening-chain'") &&
    pipelineCatchBlock.includes("error: 'post_pipeline_callback_chain_failed'") &&
    pipelineCatchBlock.includes('}, 503)'),
  'callback exceptions before confirmed stage ownership must remain retryable and must never adopt the root owner',
)

assert(
  adminControlRoutes.includes("body.task === 'finlab-v4-backfill'") &&
    adminControlRoutes.includes("type: 'finlab_backfill_complete'") &&
    adminControlRoutes.includes('continue_evening_chain'),
  'FinLab backfill callback must enqueue the post-backfill evening-chain continuation',
)
assert(
  adminControlRoutes.includes('resolveFinLabDispatchFence') &&
    finLabDispatchFence.includes('stale_dispatch_attempt') &&
    finLabDispatchFence.includes('stale_run_id') &&
    finLabDispatchFence.includes('incomingAttempt < activeAttempt'),
  'FinLab callback must fence stale run IDs and late callbacks from superseded Modal attempts',
)
assert(
  adminControlRoutes.includes("logSchedulerResult(c.env.KV, 'finlab-backfill-watchdog'") &&
    adminControlRoutes.includes('dispatchAttempt > 1') &&
    adminControlRoutes.includes('FinLab watchdog terminal callback status=') &&
    adminControlRoutes.includes('supersedePrevious: true'),
  'retried FinLab terminal callbacks must settle the watchdog card and supersede its running reservation',
)
const finLabContinuationStart = adminControlRoutes.indexOf("if (body.task === 'finlab-v4-backfill'")
const finLabContinuationBlock = adminControlRoutes.slice(finLabContinuationStart)
assert(
  finLabContinuationBlock.includes("logSchedulerResult(c.env.KV, 'evening-chain'") &&
    finLabContinuationBlock.includes("status: 'running'") &&
    finLabContinuationBlock.includes('supersedePrevious: true'),
  'FinLab success continuation must visibly recover the same-run evening-chain head from its earlier error',
)

assert(
  schedulerRunLogger.includes('run_id?: string') &&
    schedulerRunLogger.includes('run_date?: string') &&
    schedulerRunLogger.includes('run_id: result.run_id') &&
    schedulerRunLogger.includes('run_date: today'),
  'canonical scheduler logger must store run_id/run_date payload fields',
)
