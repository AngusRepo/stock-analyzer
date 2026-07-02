import {
  estimateSchedulerStatusKvReads,
  getSchedulerScanDates,
  resolveSchedulerLogStatus,
  selectSchedulerDisplayLogs,
  type SchedulerDisplayLogCandidate,
} from './schedulerStatus'
import * as fs from 'node:fs'

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
  const originalNow = Date.now
  Date.now = () => Date.parse('2026-05-08T04:00:00.000Z')
  try {
    const dates = getSchedulerScanDates()
    assert(dates.length === 7, 'scheduler status scan window must stay bounded for Cloudflare Worker KV subrequest budget')
    assert(dates.includes('2026-05-03'), 'scheduler scan window must include weekends so weekly/monthly jobs can show lastRun')
    assert(estimateSchedulerStatusKvReads() < 50, 'scheduler status must stay below Cloudflare Worker subrequest limits')
  } finally {
    Date.now = originalNow
  }
}

{
  const statusSource = fs.readFileSync('src/lib/schedulerStatus.ts', 'utf8')
  const loggerSource = fs.readFileSync('src/lib/schedulerRunLogger.ts', 'utf8')
  const policySource = fs.readFileSync('src/lib/schedulerPolicy.ts', 'utf8')
  assert(statusSource.includes('directFallback: false'), 'scheduler status must not per-task scan KV logs')
  assert(statusSource.includes('skipKvPolicy: true'), 'scheduler status nextRun must not probe KV policy per card')
  assert(loggerSource.includes('scheduler:run:daily:'), 'scheduler logger must maintain daily aggregate logs for OBS')
  assert(policySource.includes('skipKvPolicy?: boolean'), 'scheduler policy must expose no-KV nextRun mode')
}

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
