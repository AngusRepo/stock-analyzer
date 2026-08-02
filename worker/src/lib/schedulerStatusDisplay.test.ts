import {
  estimateSchedulerStatusKvReads,
  getSchedulerScanDates,
  mergeDirectSchedulerLog,
  reconcileDurablePipelineStageStatus,
  resolveSchedulerDisplayStatus,
  resolveSchedulerRunDisplayTime,
  resolveSchedulerLogStatus,
  selectSchedulerChainDates,
  selectSchedulerDisplayLogs,
  type SchedulerDisplayLogCandidate,
} from './schedulerStatus'
import { classifySchedulerSummary } from './schedulerRunLogger'
import * as fs from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

{
  const dates = ['2026-07-27', '2026-07-26', '2026-07-25', '2026-07-24', '2026-07-23']
  const selection = selectSchedulerChainDates(dates, {
    '2026-07-27': [],
    '2026-07-26': [],
    '2026-07-25': [],
    '2026-07-24': [{
      task: 'evening-chain',
      status: 'success',
      summary: 'historical replay completed after midnight',
      duration_ms: 0,
      run_date: '2026-07-24',
      timestamp: '2026-07-26T18:54:46.000Z',
    }],
    '2026-07-23': [],
  })
  assert(selection.activeChainDate === null, 'a completed replay must not be marked active')
  assert(selection.chainStatusDate === '2026-07-24', 'completed replay must remain the canonical chain status date')
}

{
  const dates = ['2026-07-27', '2026-07-24']
  const selection = selectSchedulerChainDates(dates, {
    '2026-07-27': [{
      task: 'evening-chain',
      status: 'success',
      summary: 'latest chain completed',
      duration_ms: 0,
      run_date: '2026-07-27',
      timestamp: '2026-07-27T13:56:29.000Z',
    }],
    '2026-07-24': [{
      task: 'evening-chain',
      status: 'success',
      summary: 'older replay completed',
      duration_ms: 0,
      run_date: '2026-07-24',
      timestamp: '2026-07-26T18:54:46.000Z',
    }],
  })
  assert(selection.chainStatusDate === '2026-07-27', 'latest completed chain must replace the older replay date')
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
    const anchoredDates = getSchedulerScanDates('2026-08-02')
    assert(anchoredDates[0] === '2026-08-02', 'scheduler scan must honor an explicit readiness run date after timezone rollover')
    assert(anchoredDates[6] === '2026-07-27', 'anchored scheduler scan must preserve the bounded seven-day window')
  } finally {
    Date.now = originalNow
  }
}

{
  const statusSource = fs.readFileSync('src/lib/schedulerStatus.ts', 'utf8')
  const loggerSource = fs.readFileSync('src/lib/schedulerRunLogger.ts', 'utf8')
  const policySource = fs.readFileSync('src/lib/schedulerPolicy.ts', 'utf8')
  assert(statusSource.includes('directFallback: false'), 'scheduler status must not per-task scan KV logs')
  assert(statusSource.includes('const cadenceDirectReads = JOB_DEFS.flatMap') && statusSource.includes('isCurrentCadenceCycle(date, today, def.group)'), 'weekly/monthly current-cycle status must directly recover task logs lost from concurrent daily aggregate writes')
  assert(statusSource.includes('skipKvPolicy: true'), 'scheduler status nextRun must not probe KV policy per card')
  assert(statusSource.includes("id: 's12-structure-snapshot'") && statusSource.includes("'s12-structure-snapshot',"), 'S12 runtime logs must be exposed as a first-class chain stage')
  assert(loggerSource.includes('scheduler:run:daily:'), 'scheduler logger must maintain daily aggregate logs for OBS')
  assert(policySource.includes('skipKvPolicy?: boolean'), 'scheduler policy must expose no-KV nextRun mode')
}

{
  const display = selectSchedulerDisplayLogs(logs)
  assert(display.lastAttempt?.timestamp === '2026-04-29T05:30:00.000Z', 'lastAttempt must show the newest cron attempt even when skipped')
  assert(display.lastEffective?.timestamp === '2026-04-28T02:10:00.000Z', 'lastEffective should preserve the latest non-skipped run')
}

{
  const aggregate: SchedulerDisplayLogCandidate['log'] = {
    task: 'evening-chain',
    status: 'success',
    summary: 'older aggregate completion',
    duration_ms: 0,
    run_date: '2026-07-24',
    timestamp: '2026-07-26T07:03:00.000Z',
  }
  const direct: SchedulerDisplayLogCandidate['log'] = {
    task: 'evening-chain',
    status: 'running',
    summary: 'new replay reached screener',
    duration_ms: 0,
    run_date: '2026-07-24',
    timestamp: '2026-07-26T13:52:50.000Z',
  }
  const merged = mergeDirectSchedulerLog([aggregate!], direct)
  assert(merged[0].status === 'running', 'newer direct root head must replace an older aggregate completion')
}

{
  const aggregate: SchedulerDisplayLogCandidate['log'] = {
    task: 'evening-chain',
    status: 'running',
    summary: 'new aggregate state',
    duration_ms: 0,
    timestamp: '2026-07-26T13:52:50.000Z',
  }
  const direct: SchedulerDisplayLogCandidate['log'] = {
    task: 'evening-chain',
    status: 'success',
    summary: 'stale direct state',
    duration_ms: 0,
    timestamp: '2026-07-26T07:03:00.000Z',
  }
  const merged = mergeDirectSchedulerLog([aggregate!], direct)
  assert(merged[0].status === 'running', 'older direct root head must not overwrite a newer aggregate state')
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
      status: 'success',
      summary: 'live canonical chain completed after Taipei midnight',
      duration_ms: 6_125_000,
      run_date: '2026-07-30',
      run_scope: 'live_canonical',
      timestamp: '2026-07-30T17:06:00.000Z',
    },
    def: { id: 'evening-chain', group: 'pipeline_chain', chainIndex: 2 },
    nextRun: '7/31 21:00',
    today: '2026-07-31',
    nowMs: Date.parse('2026-07-30T17:10:00.000Z'),
  })
  assert(status.status === 'success', 'cross-midnight live canonical completion must retain terminal status')
  assert(status.statusScope === 'today', 'live canonical scope must not be mislabeled as historical replay')
  assert(status.statusRunDate === '2026-07-30', 'live canonical scope must retain its business date')
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
    todayLog: {
      task: 'screener',
      status: 'skipped',
      summary: 'today scheduler window skipped while historical replay remains active',
      duration_ms: 0,
      run_date: '2026-07-27',
      timestamp: '2026-07-26T16:05:00.000Z',
    },
    lastAttempt: {
      task: 'screener',
      status: 'success',
      summary: 'historical replay screener completed before midnight',
      duration_ms: 268_952,
      run_date: '2026-07-24',
      timestamp: '2026-07-26T13:57:34.432Z',
    },
    activeReplayLog: {
      task: 'screener',
      status: 'success',
      summary: 'historical replay screener completed before midnight',
      duration_ms: 268_952,
      run_date: '2026-07-24',
      timestamp: '2026-07-26T13:57:34.432Z',
    },
    activeReplayRunDate: '2026-07-24',
    activeReplayIsRunning: true,
    def: { id: 'screener', group: 'pipeline_chain', chainIndex: 6 },
    nextRun: '7/27 21:38',
    today: '2026-07-27',
    nowMs: Date.parse('2026-07-26T16:21:30.000Z'),
  })
  assert(status.status === 'success', 'completed upstream stage must stay completed when an active replay crosses midnight')
  assert(status.statusScope === 'historical_replay', 'cross-midnight upstream stage must retain replay scope')
  assert(status.statusRunDate === '2026-07-24', 'cross-midnight upstream stage must retain the active replay date')
}

{
  const status = resolveSchedulerDisplayStatus({
    lastAttempt: {
      task: 'evening-chain',
      status: 'running',
      summary: 'historical chain still owns the active replay',
      duration_ms: 0,
      run_date: '2026-07-24',
      timestamp: '2026-07-26T13:57:36.352Z',
    },
    activeReplayLog: {
      task: 'evening-chain',
      status: 'running',
      summary: 'historical chain still owns the active replay',
      duration_ms: 0,
      run_date: '2026-07-24',
      timestamp: '2026-07-26T13:57:36.352Z',
    },
    activeReplayRunDate: '2026-07-24',
    activeReplayHeartbeatAt: '2026-07-26T16:21:29.943Z',
    def: { id: 'evening-chain', group: 'pipeline_chain', chainIndex: 2 },
    nextRun: '7/27 21:00',
    today: '2026-07-27',
    nowMs: Date.parse('2026-07-26T16:21:30.000Z'),
  })
  assert(status.status === 'running', 'active replay parent must remain running after midnight')
  assert(status.statusScope === 'historical_replay', 'cross-midnight parent must retain replay scope')
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


{
  const status = resolveSchedulerDisplayStatus({
    todayLog: {
      task: 'market-close-refresh',
      status: 'success',
      summary: 'refreshed 1967 close prices',
      duration_ms: 65_274,
      run_date: '2026-07-29',
      timestamp: '2026-07-29T10:11:07.000Z',
    },
    lastAttempt: {
      task: 'market-close-refresh',
      status: 'success',
      summary: 'prior trading session close refresh',
      duration_ms: 65_274,
      run_date: '2026-07-28',
      timestamp: '2026-07-28T10:11:07.000Z',
    },
    activeReplayLog: {
      task: 'market-close-refresh',
      status: 'success',
      summary: 'terminal prior-session chain snapshot',
      duration_ms: 65_274,
      run_date: '2026-07-28',
      timestamp: '2026-07-28T10:11:07.000Z',
    },
    activeReplayRunDate: '2026-07-28',
    activeReplayIsRunning: false,
    def: { id: 'market-close-refresh', group: 'pipeline_chain', chainIndex: 1 },
    nextRun: '7/30 18:10',
    today: '2026-07-29',
    nowMs: Date.parse('2026-07-29T10:12:00.000Z'),
  })
  assert(status.status === 'success', 'today close refresh must not be hidden by a terminal prior-session chain snapshot')
  assert(status.statusScope === 'today', 'today close refresh must retain today scope')
  assert(status.statusRunDate === '2026-07-29', 'today close refresh must expose today as its run date')
}

{
  const displayTime = resolveSchedulerRunDisplayTime({
    jobId: 'post-verify-chain',
    displayTimestamp: '2026-07-28T14:22:42.000Z',
    durable: {
      business_date: '2026-07-28',
      stage: 'post_verify_chain',
      canonical_run_id: 'verify-2026-07-28-a0891e08145a',
      status: 'success',
      attempt_count: 1,
      started_at: '2026-07-28 14:21:16',
      completed_at: '2026-07-28 14:22:42',
      updated_at: '2026-07-28 14:22:42',
      last_error: null,
    },
  })
  assert(displayTime.timestamp === '2026-07-28T14:21:16Z', 'callback containers must display durable started_at')
  assert(displayTime.basis === 'started', 'callback container timestamp basis must be explicit')
}
{
  const status = reconcileDurablePipelineStageStatus({
    jobId: 'post-pipeline-chain',
    runDate: '2026-07-27',
    baseStatus: 'success',
    baseTimestamp: '2026-07-27T13:46:39.887Z',
    durable: {
      business_date: '2026-07-27',
      stage: 'post_pipeline_chain',
      canonical_run_id: 'pipeline-v2-m82fp',
      status: 'success',
      attempt_count: 2,
      updated_at: '2026-07-27 15:30:11',
      last_error: null,
    },
  })
  assert(status === null, 'later durable success readback must not replace the original scheduler completion time')
}

{
  const status = reconcileDurablePipelineStageStatus({
    jobId: 'post-pipeline-chain',
    runDate: '2026-07-24',
    baseStatus: 'failed',
    baseTimestamp: '2026-07-26T06:22:00.000Z',
    durable: {
      business_date: '2026-07-24',
      stage: 'post_pipeline_chain',
      canonical_run_id: 'pipeline-v2-zkgm6',
      status: 'success',
      attempt_count: 4,
      updated_at: '2026-07-26 06:51:33',
      last_error: null,
    },
  })
  assert(status?.lastStatus === 'success', 'newer durable success must replace a stale KV callback error')
  assert(status?.recoveredFromStatus === 'failed', 'recovered callback state must remain explicit for operators')
  assert(status?.lastError == null, 'recovered callback state must not retain the stale error text')
  assert(status?.attemptCount === 4, 'durable attempt count must be exposed as recovery evidence')
}


{
  const status = reconcileDurablePipelineStageStatus({
    jobId: 'post-pipeline-chain',
    runDate: '2026-07-27',
    baseStatus: 'success',
    baseTimestamp: '2026-07-27T13:46:39.887Z',
    durable: {
      business_date: '2026-07-27',
      stage: 'post_pipeline_chain',
      canonical_run_id: 'pipeline-v2-m82fp',
      status: 'success',
      attempt_count: 2,
      updated_at: '2026-07-27 15:30:11',
      last_error: null,
    },
  })
  assert(status === null, 'later durable success readback must not replace the original scheduler completion time')
}

{
  const status = reconcileDurablePipelineStageStatus({
    jobId: 'post-pipeline-chain',
    runDate: '2026-07-24',
    baseStatus: 'failed',
    baseTimestamp: '2026-07-26T07:00:00.000Z',
    durable: {
      business_date: '2026-07-24',
      stage: 'post_pipeline_chain',
      canonical_run_id: 'pipeline-v2-zkgm6',
      status: 'success',
      attempt_count: 4,
      updated_at: '2026-07-26 06:51:33',
      last_error: null,
    },
  })
  assert(status === null, 'older durable state must not overwrite newer scheduler evidence')
}
{
  const unrelatedStage = resolveSchedulerDisplayStatus({
    lastAttempt: {
      task: 'screener',
      status: 'success',
      summary: '7/31 canonical screener completed',
      duration_ms: 1_000,
      run_date: '2026-07-31',
      timestamp: '2026-07-31T14:00:00.000Z',
    },
    activeReplayLog: {
      task: 'screener',
      status: 'success',
      summary: '7/31 canonical screener completed',
      duration_ms: 1_000,
      run_date: '2026-07-31',
      timestamp: '2026-07-31T14:00:00.000Z',
    },
    activeReplayRunDate: '2026-07-31',
    activeReplayHeartbeatAt: '2026-08-01T01:05:00.000Z',
    activeReplayIsRunning: false,
    def: { id: 'screener', group: 'pipeline_chain', chainIndex: 6 },
    nextRun: '8/3 21:38',
    today: '2026-08-01',
    nowMs: Date.parse('2026-08-01T01:06:00.000Z'),
  })
  assert(unrelatedStage.status === 'sleep', 'a terminal child replay heartbeat must not turn unrelated 7/31 stages yellow on 8/1')
  assert(unrelatedStage.statusScope === 'schedule', 'unrelated stages must return to non-trading-day schedule scope')

  const replayedStage = resolveSchedulerDisplayStatus({
    lastAttempt: {
      task: 'active8-oof-daily',
      status: 'success',
      summary: '7/31 shadow coverage repaired on 8/1',
      duration_ms: 1_000,
      run_date: '2026-07-31',
      timestamp: '2026-08-01T01:05:00.000Z',
    },
    activeReplayLog: {
      task: 'active8-oof-daily',
      status: 'success',
      summary: '7/31 shadow coverage repaired on 8/1',
      duration_ms: 1_000,
      run_date: '2026-07-31',
      timestamp: '2026-08-01T01:05:00.000Z',
    },
    activeReplayRunDate: '2026-07-31',
    activeReplayHeartbeatAt: '2026-08-01T01:05:00.000Z',
    activeReplayIsRunning: false,
    def: { id: 'active8-oof-daily', group: 'pipeline_chain', chainIndex: 23 },
    nextRun: '8/3 00:55',
    today: '2026-08-01',
    nowMs: Date.parse('2026-08-01T01:06:00.000Z'),
  })
  assert(replayedStage.status === 'success', 'the stage actually repaired on 8/1 must remain green')
  assert(replayedStage.statusScope === 'historical_replay', 'the repaired stage must retain its 7/31 replay scope')
}
{
  const status = resolveSchedulerDisplayStatus({
    lastAttempt: {
      task: 'weekly-audit',
      status: 'success',
      summary: 'Friday weekly audit closed',
      duration_ms: 1000,
      run_date: '2026-07-31',
      timestamp: '2026-07-31T10:30:00.000Z',
    },
    cadenceCycleLog: {
      task: 'weekly-audit',
      status: 'success',
      summary: 'Friday weekly audit closed',
      duration_ms: 1000,
      run_date: '2026-07-31',
      timestamp: '2026-07-31T10:30:00.000Z',
    },
    def: { id: 'weekly-audit', group: 'weekly' },
    nextRun: '8/7 18:30',
    today: '2026-08-02',
    nowMs: Date.parse('2026-08-02T09:00:00.000Z'),
  })
  assert(status.status === 'success', 'Friday success must remain closed throughout the same weekly cycle')
  assert(status.statusScope === 'cadence_cycle', 'weekly cross-date status must identify cadence-cycle authority')
  assert(status.statusRunDate === '2026-07-31', 'weekly cycle must preserve the actual run date')
}

{
  const triggered = {
    task: 'monthly-optuna',
    status: 'triggered' as const,
    summary: 'callback expected',
    duration_ms: 0,
    run_date: '2026-08-01',
    timestamp: '2026-08-01T08:00:00.000Z',
  }
  const status = resolveSchedulerDisplayStatus({
    lastAttempt: triggered,
    cadenceCycleLog: triggered,
    def: { id: 'monthly-optuna', group: 'monthly' },
    nextRun: '9/5 16:00',
    today: '2026-08-02',
    nowMs: Date.parse('2026-08-02T09:00:00.000Z'),
  })
  assert(status.status === 'failed', 'stale monthly callback must remain visible instead of becoming out-of-window')
  assert(status.statusScope === 'cadence_cycle', 'monthly stale callback must retain current-cycle authority')
  assert(status.staleReason?.includes('no final callback'), 'monthly stale callback must explain missing closure')
}
