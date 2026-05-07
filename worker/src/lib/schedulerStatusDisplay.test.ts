import {
  resolveSchedulerLogStatus,
  selectSchedulerDisplayLogs,
  type SchedulerDisplayLogCandidate,
} from './schedulerStatus'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const logs: SchedulerDisplayLogCandidate[] = [
  {
    date: '2026-04-29',
    log: {
      task: 'intraday-check',
      status: 'skipped',
      summary: 'heartbeat ok; state=empty',
      duration_ms: 20,
      timestamp: '2026-04-29T05:30:00.000Z',
    },
  },
  {
    date: '2026-04-28',
    log: {
      task: 'intraday-check',
      status: 'success',
      summary: 'buy placed',
      duration_ms: 120,
      timestamp: '2026-04-28T02:10:00.000Z',
    },
  },
]

{
  const display = selectSchedulerDisplayLogs(logs)
  assert(display.lastAttempt?.timestamp === '2026-04-29T05:30:00.000Z', 'lastAttempt must show the newest cron attempt even when skipped')
  assert(display.lastEffective?.timestamp === '2026-04-28T02:10:00.000Z', 'lastEffective should preserve the latest non-skipped run')
}

{
  const status = resolveSchedulerLogStatus(
    {
      task: 'evening-chain',
      status: 'running',
      summary: 'chain started',
      duration_ms: 0,
      timestamp: '2026-05-07T08:00:00.000Z',
    },
    { id: 'evening-chain', group: 'pipeline_chain' },
    Date.parse('2026-05-07T10:00:00.000Z'),
  )
  assert(status.status === 'failed', 'stale running pipeline-chain log should render as failed instead of infinite running')
  assert(status.staleRunning === true, 'stale running marker should be explicit')
  assert(status.staleReason?.includes('no final callback'), 'stale running reason should tell the operator what is missing')
}

{
  const status = resolveSchedulerLogStatus(
    {
      task: 'evening-chain',
      status: 'running',
      summary: 'chain started',
      duration_ms: 0,
      timestamp: '2026-05-07T08:00:00.000Z',
    },
    { id: 'evening-chain', group: 'pipeline_chain' },
    Date.parse('2026-05-07T08:10:00.000Z'),
  )
  assert(status.status === 'running', 'fresh running job should remain running before SLA expires')
}
