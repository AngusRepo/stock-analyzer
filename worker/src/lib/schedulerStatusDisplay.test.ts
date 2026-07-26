import {
  estimateSchedulerStatusKvReads,
  getSchedulerScanDates,
  resolveSchedulerDisplayStatus,
  resolveSchedulerLogStatus,
  selectSchedulerDisplayLogs,
  type SchedulerDisplayLogCandidate,
} from './schedulerStatus'
import { classifySchedulerSummary } from './schedulerRunLogger'
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
  const status = classifySchedulerSummary('allocator_ev_fusion_refresh failed_validation cadence=weekly decision=FAIL')
  assert(status === 'error', 'artifact refresh failed_validation summaries must be logged as scheduler errors')
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

{
  const status = resolveSchedulerDisplayStatus({
    lastAttempt: {
      task: 'evening-chain',
      status: 'running',
      summary: 'historical chain waiting for upstream data',
      duration_ms: 0,
      run_date: '2026-07-24',
      timestamp: '2026-07-26T03:39:00.000Z',
    },
    def: { id: 'evening-chain', group: 'pipeline_chain', chainIndex: 2 },
    nextRun: '7/27 21:00',
    today: '2026-07-26',
    nowMs: Date.parse('2026-07-26T03:44:00.000Z'),
  })
  assert(status.status === 'running', 'fresh historical replay written today must light the execution chain')
  assert(status.statusScope === 'historical_replay', 'historical replay scope must be explicit for the UI')
  assert(status.statusRunDate === '2026-07-24', 'historical replay must expose its effective run date')
}

{
  const status = resolveSchedulerDisplayStatus({
    lastAttempt: {
      task: 'evening-chain',
      status: 'running',
      summary: 'old historical chain log',
      duration_ms: 0,
      run_date: '2026-07-24',
      timestamp: '2026-07-24T03:39:00.000Z',
    },
    def: { id: 'evening-chain', group: 'pipeline_chain', chainIndex: 2 },
    nextRun: '7/27 21:00',
    today: '2026-07-26',
    nowMs: Date.parse('2026-07-26T03:44:00.000Z'),
  })
  assert(status.status === 'sleep', 'old historical logs must not falsely light the current execution chain')
  assert(status.statusScope === 'schedule', 'old historical logs must fall back to schedule state')
  assert(status.statusRunDate === null, 'schedule state must not claim an active replay date')
}

{
  const status = resolveSchedulerDisplayStatus({
    lastAttempt: {
      task: 'evening-chain',
      status: 'running',
      summary: 'historical chain lost its callback',
      duration_ms: 0,
      run_date: '2026-07-24',
      timestamp: '2026-07-26T00:00:00.000Z',
    },
    def: { id: 'evening-chain', group: 'pipeline_chain', chainIndex: 2 },
    nextRun: '7/27 21:00',
    today: '2026-07-26',
    nowMs: Date.parse('2026-07-26T03:44:00.000Z'),
  })
  assert(status.status === 'failed', 'stale historical replay must become a death point after its SLA')
  assert(status.statusScope === 'historical_replay', 'stale historical replay must retain replay context')
  assert(status.staleReason?.includes('no final callback'), 'stale historical replay must explain the missing callback')
}

{
  const status = resolveSchedulerDisplayStatus({
    todayLog: {
      task: 'evening-chain',
      status: 'success',
      summary: 'today chain completed',
      duration_ms: 1_000,
      run_date: '2026-07-26',
      timestamp: '2026-07-26T03:40:00.000Z',
    },
    lastAttempt: {
      task: 'evening-chain',
      status: 'running',
      summary: 'historical chain running',
      duration_ms: 0,
      run_date: '2026-07-24',
      timestamp: '2026-07-26T03:39:00.000Z',
    },
    def: { id: 'evening-chain', group: 'pipeline_chain', chainIndex: 2 },
    nextRun: '7/27 21:00',
    today: '2026-07-26',
    nowMs: Date.parse('2026-07-26T03:44:00.000Z'),
  })
  assert(status.status === 'success', 'today log must take precedence over an older historical replay attempt')
  assert(status.statusScope === 'today', 'today log must keep today scope')
}
