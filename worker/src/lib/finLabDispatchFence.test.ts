import { resolveFinLabDispatchFence } from './finLabDispatchFence'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const staleAttempt = resolveFinLabDispatchFence({
  activeRunId: 'finlab-20260709',
  activeSummary: 'triggered run_id=finlab-20260709 dispatch_attempt=2',
  incomingRunId: 'finlab-20260709',
  incomingAttempt: 1,
})
assert(staleAttempt.ignored && staleAttempt.reason === 'stale_dispatch_attempt', 'late callback from attempt 1 must be fenced')

const staleRun = resolveFinLabDispatchFence({
  activeRunId: 'finlab-new',
  activeSummary: 'triggered run_id=finlab-new dispatch_attempt=1',
  incomingRunId: 'finlab-old',
  incomingAttempt: 3,
})
assert(staleRun.ignored && staleRun.reason === 'stale_run_id', 'callback from an older run id must be fenced')

const active = resolveFinLabDispatchFence({
  activeRunId: 'finlab-20260709',
  activeSummary: 'running run_id=finlab-20260709 dispatch_attempt=2',
  incomingRunId: 'finlab-20260709',
  incomingAttempt: 2,
})
assert(!active.ignored, 'callback from the active attempt must pass')

console.log('finLabDispatchFence tests passed')
