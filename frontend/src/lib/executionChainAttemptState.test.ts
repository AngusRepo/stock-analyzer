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
    ...overrides,
  }
}

const scope: AttemptAwareChainScope = {
  orchestratorId: 'evening-chain',
  columns: [
    ['update'],
    ['s12-structure-snapshot'],
    ['allocator-ev-readiness'],
    ['pipeline'],
    ['post-pipeline-chain'],
  ],
}

const inferStage = (summary?: string | null): string | null => (
  /s12/i.test(String(summary ?? '')) ? 's12-structure-snapshot' : null
)

{
  const base = new Map<string, SchedulerJob>([
    ['evening-chain', job('evening-chain', 'waiting', {
      statusScope: 'schedule',
      statusRunDate: null,
    })],
    ['update', job('update', 'success')],
    ['s12-structure-snapshot', job('s12-structure-snapshot', 'running', {
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
  assert(resolved.get('s12-structure-snapshot')?.lastStatus === 'running', 'direct running stage must remain current')
  assert(resolved.get('allocator-ev-readiness')?.lastStatus === 'waiting', 'first downstream stage must suppress older success')
  assert(resolved.get('pipeline')?.lastStatus === 'waiting', 'later downstream stage must suppress older success')
  assert(resolved.get('post-pipeline-chain')?.lastStatus === 'waiting', 'callback stage must suppress older success')
  assert(resolved.get('pipeline')?.statusScope === 'historical_replay', 'downstream waiting state must inherit direct replay scope')
  assert(resolved.get('pipeline')?.statusRunDate === '2026-07-24', 'downstream waiting state must inherit direct replay date')
}

{
  const base = new Map<string, SchedulerJob>([
    ['evening-chain', job('evening-chain', 'running', {
      summary: 'waiting for S12 structure snapshot callback',
      statusScope: 'historical_replay',
      statusRunDate: '2026-07-24',
    })],
    ['s12-structure-snapshot', job('s12-structure-snapshot', 'sleep')],
    ['allocator-ev-readiness', job('allocator-ev-readiness', 'success')],
  ])

  const resolved = buildAttemptAwareJobMap(base, scope, inferStage)
  assert(resolved.get('s12-structure-snapshot')?.lastStatus === 'running', 'parent hint must remain a fallback when direct status is absent')
  assert(resolved.get('allocator-ev-readiness')?.lastStatus === 'waiting', 'parent-derived current stage must suppress downstream history')
}

{
  const base = new Map<string, SchedulerJob>([
    ['evening-chain', job('evening-chain', 'waiting')],
    ['s12-structure-snapshot', job('s12-structure-snapshot', 'sleep')],
  ])
  assert(buildAttemptAwareJobMap(base, scope, inferStage) === base, 'inactive chain without direct running evidence must remain unchanged')
}
