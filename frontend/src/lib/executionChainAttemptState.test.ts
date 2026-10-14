import {
  buildAttemptAwareJobMap,
  type AttemptAwareChainScope,
} from '../components/observability/executionChainAttemptState'
import type { SchedulerJob } from './api'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function job(
  id: string,
  lastStatus: SchedulerJob['lastStatus'],
  overrides: Partial<SchedulerJob> = {},
): SchedulerJob {
  return {
    id,
    name: id,
    schedule: '',
    cron: '',
    group: 'pipeline_chain',
    lastRun: '7/27 00:49',
    lastStatus,
    lastDuration: 'N/A',
    nextRun: 'N/A',
    history7d: [],
    rate7d: 'N/A',
    summary: '',
    accounting: {
      schedulerJobId: null,
      task: id,
      physicalRoot: false,
      desiredState: null,
      accountingClass: 'internal_chain',
      dependencyReviewed: true,
      ticketRequired: true,
    },
    ticket: {
      ticketId: null,
      physicalRootId: null,
      logicalTask: id,
      status: lastStatus,
      runDate: null,
      authority: 'scheduler_kv',
      durable: false,
      missing: true,
    },
    ...overrides,
  }
}

const scope: AttemptAwareChainScope = {
  orchestratorId: 'evening-chain',
  columns: [
    ['update'],
    ['regime-compute'],
    ['allocator-ev-readiness'],
    ['pipeline'],
    ['post-pipeline-chain'],
  ],
}

const inferStage = (summary?: string | null): string | null => (
  /regime/i.test(String(summary ?? '')) ? 'regime-compute' : null
)

// Actual incident: generic finalizer lock retries arrive after the indicator and
// regime receipts have completed, while mature evidence runs for several minutes.
{
  const chain = { orchestratorId: 'evening-chain', columns: [['indicator-queue'], ['regime-compute'], ['strategy-learning-mature-evidence'], ['screener']] }
  const identity = { runId: 'same-run', statusRunDate: '2026-10-14' }
  const base = new Map<string, SchedulerJob>([
    ['evening-chain', job('evening-chain', 'running', {...identity, summary: 'indicator finalizer deferred'})],
    ['indicator-queue', job('indicator-queue', 'success', {...identity, lastDuration: '2m51s'})],
    ['regime-compute', job('regime-compute', 'success', identity)],
    ['strategy-learning-mature-evidence', job('strategy-learning-mature-evidence', 'waiting', identity)],
    ['screener', job('screener', 'waiting', identity)],
  ])
  const infer = () => 'indicator-queue'
  const resolved = buildAttemptAwareJobMap(base, chain, infer)
  assert(resolved.get('indicator-queue')?.lastStatus === 'success', 'finalizer retry cannot restart completed same-run indicator')
  assert(resolved.get('regime-compute')?.lastStatus === 'success', 'finalizer retry cannot hide same-run regime completion')
  base.set('strategy-learning-mature-evidence', job('strategy-learning-mature-evidence', 'running', identity))
  assert(buildAttemptAwareJobMap(base, chain, infer).get('strategy-learning-mature-evidence')?.lastStatus === 'running', 'direct mature stage owns spinner')
  base.set('strategy-learning-mature-evidence', job('strategy-learning-mature-evidence', 'waiting', identity))
  base.set('indicator-queue', job('indicator-queue', 'success', {...identity, runId: 'old-run', lastDuration: '9m'}))
  const replay = buildAttemptAwareJobMap(base, chain, infer)
  assert(replay.get('indicator-queue')?.lastStatus === 'running', 'different run can replay a previously completed stage')
  assert(replay.get('indicator-queue')?.lastDuration === 'N/A', 'parent-derived replay cannot reuse old attempt duration')
  assert(replay.get('regime-compute')?.lastStatus === 'success', 'same-run downstream terminal receipt is stronger than upstream parent hint')
}

{
  const base = new Map<string, SchedulerJob>([
    ['evening-chain', job('evening-chain', 'waiting', {
      statusScope: 'schedule',
      statusRunDate: null,
    })],
    ['update', job('update', 'success')],
    ['regime-compute', job('regime-compute', 'running', {
      statusScope: 'historical_replay',
      statusRunDate: '2026-07-24',
      runId: '2026-07-24-ms1uujzd',
    })],
    ['allocator-ev-readiness', job('allocator-ev-readiness', 'success')],
    ['pipeline', job('pipeline', 'success')],
    ['post-pipeline-chain', job('post-pipeline-chain', 'success')],
  ])

  const resolved = buildAttemptAwareJobMap(base, scope, inferStage)

  assert(resolved.get('update')?.lastStatus === 'success', 'completed upstream stage must remain completed')
  assert(resolved.get('regime-compute')?.lastStatus === 'running', 'direct running stage must remain current')
  assert(resolved.get('allocator-ev-readiness')?.lastStatus === 'waiting', 'first downstream stage must suppress older success')
  assert(resolved.get('pipeline')?.lastStatus === 'waiting', 'later downstream stage must suppress older success')
  assert(resolved.get('post-pipeline-chain')?.lastStatus === 'waiting', 'callback stage must suppress older success')
  assert(resolved.get('pipeline')?.statusScope === 'historical_replay', 'downstream waiting state must inherit direct replay scope')
  assert(resolved.get('pipeline')?.statusRunDate === '2026-07-24', 'downstream waiting state must inherit direct replay date')
}

{
  const base = new Map<string, SchedulerJob>([
    ['evening-chain', job('evening-chain', 'running', {
      summary: 'waiting for HMM regime callback',
      statusScope: 'historical_replay',
      statusRunDate: '2026-07-24',
    })],
    ['regime-compute', job('regime-compute', 'sleep')],
    ['allocator-ev-readiness', job('allocator-ev-readiness', 'success')],
  ])

  const resolved = buildAttemptAwareJobMap(base, scope, inferStage)
  assert(resolved.get('regime-compute')?.lastStatus === 'running', 'parent hint must remain a fallback when direct status is absent')
  assert(resolved.get('allocator-ev-readiness')?.lastStatus === 'waiting', 'parent-derived current stage must suppress downstream history')
}

{
  const base = new Map<string, SchedulerJob>([
    ['evening-chain', job('evening-chain', 'waiting')],
    ['regime-compute', job('regime-compute', 'sleep')],
  ])
  assert(buildAttemptAwareJobMap(base, scope, inferStage) === base, 'inactive chain without direct running evidence must remain unchanged')
}

{
  const liveScope: AttemptAwareChainScope = {
    orchestratorId: 'evening-chain',
    columns: [
      ['finlab-v4-backfill'],
      ['update'],
      ['pipeline'],
    ],
  }
  const base = new Map<string, SchedulerJob>([
    ['evening-chain', job('evening-chain', 'running', {
      summary: 'awaiting FinLab canonical callback',
      statusScope: 'today',
      statusRunDate: '2026-09-02',
    })],
    ['finlab-v4-backfill', job('finlab-v4-backfill', 'waiting', {
      statusScope: 'today',
      statusRunDate: '2026-09-02',
    })],
    ['update', job('update', 'waiting', {
      statusScope: 'today',
      statusRunDate: '2026-09-02',
    })],
    ['pipeline', job('pipeline', 'running', {
      lastRun: '8/28 03:45',
      statusScope: 'historical_replay',
      statusRunDate: '2026-08-27',
    })],
  ])
  const resolved = buildAttemptAwareJobMap(
    base,
    liveScope,
    (summary) => /finlab/i.test(String(summary ?? '')) ? 'finlab-v4-backfill' : null,
  )
  assert(resolved.get('finlab-v4-backfill')?.lastStatus === 'running', 'same-date parent hint must identify the true current stage')
  assert(resolved.get('finlab-v4-backfill')?.statusRunDate === '2026-09-02', 'derived current stage must retain the active business date')
  assert(resolved.get('pipeline')?.lastStatus === 'waiting', 'stale prior-date pipeline running evidence must be suppressed')
  assert(resolved.get('pipeline')?.statusRunDate === '2026-09-02', 'suppressed downstream stage must inherit the active business date')
}
