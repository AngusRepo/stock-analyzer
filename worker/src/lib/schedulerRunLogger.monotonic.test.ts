import { resolveMonotonicSchedulerEntry, type SchedulerRunLogEntry } from './schedulerRunLogger'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function entry(status: SchedulerRunLogEntry['status'], runId = 'run-1'): SchedulerRunLogEntry {
  return {
    task: 'evening-chain',
    status,
    summary: status,
    duration_ms: 1,
    timestamp: '2026-07-13T13:00:00.000Z',
    run_id: runId,
    run_date: '2026-07-13',
  }
}

assert(
  resolveMonotonicSchedulerEntry(entry('error'), entry('success')).status === 'error',
  'same-run error must be terminal and cannot be overwritten by success',
)
assert(
  resolveMonotonicSchedulerEntry(entry('success'), entry('running')).status === 'success',
  'same-run terminal success must not regress to running',
)
assert(
  resolveMonotonicSchedulerEntry(entry('error', 'old-run'), entry('success', 'retry-run')).status === 'success',
  'a new run id must be allowed to recover a prior failed date',
)

{
  const previous = { ...entry('error'), run_id: undefined }
  const incoming = { ...entry('success'), run_id: undefined }
  assert(
    resolveMonotonicSchedulerEntry(previous, incoming).status === 'error',
    'same-date logs without run ids must not overwrite a terminal error',
  )
}

{
  const previous = { ...entry('success'), run_id: undefined }
  const incoming = { ...entry('running'), run_id: undefined }
  assert(
    resolveMonotonicSchedulerEntry(previous, incoming).status === 'success',
    'same-date logs without run ids must not regress terminal success to pending',
  )
}

{
  const previous = { ...entry('error'), run_id: undefined }
  assert(
    resolveMonotonicSchedulerEntry(previous, entry('running', 'retry-run')).status === 'running',
    'an explicit new run id must recover a legacy run that had no id',
  )
}
