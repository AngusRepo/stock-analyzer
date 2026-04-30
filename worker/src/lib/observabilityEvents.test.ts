import {
  buildEventsFromDataQuality,
  buildEventsFromScheduler,
  normalizeObservabilityAuditFilters,
  selectPersistableObservabilityEvents,
  type ObservabilityEvent,
} from './observabilityEvents'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const generatedAt = '2026-04-30T01:00:00.000Z'

{
  const events = buildEventsFromScheduler({
    generatedAt,
    jobs: [
      {
        id: 'pipeline',
        name: 'Pipeline',
        group: 'pipeline_chain',
        lastStatus: 'failed',
        lastDuration: '12s',
        lastRun: '4/30 17:30',
        summary: 'callback timeout',
      },
    ],
  })

  assert(events.length === 1, 'failed scheduler job should create one event')
  assert(events[0].severity === 'error', 'failed scheduler job should be error severity')
  assert(events[0].domain === 'scheduler', 'scheduler event should keep scheduler domain')
  assert(events[0].next_action.includes('callback'), 'scheduler event should point to callback investigation')
}

{
  const events = buildEventsFromDataQuality({
    generatedAt,
    checks: [
      { id: 'price_freshness', label: 'Price data', status: 'fail', summary: 'latest=2026-04-29 lag=1d' },
      { id: 'schema', label: 'Schema', status: 'ok', summary: 'ok' },
    ],
  })

  assert(events.length === 1, 'data quality should emit actionable non-ok checks only')
  assert(events[0].severity === 'error', 'failed data quality check should be error severity')
  assert(events[0].title === 'Price data', 'data quality event should preserve check label')
}

{
  const warnEvent: ObservabilityEvent = {
    id: 'data_quality:price',
    ts: generatedAt,
    severity: 'warn',
    domain: 'data_quality',
    source: 'data_quality_report',
    status: 'warn',
    title: 'Price data',
    summary: 'stale',
    owner: 'Worker',
    impact: 'degraded',
    next_action: 'trace writer',
    evidence: {},
  }
  const okEvent: ObservabilityEvent = {
    ...warnEvent,
    id: 'scheduler:stable',
    severity: 'ok',
    domain: 'scheduler',
    source: 'scheduler_status',
    status: 'ok',
    title: 'Scheduler stable',
    summary: 'ok',
  }

  const mixed = selectPersistableObservabilityEvents([okEvent, warnEvent])
  assert(mixed.length === 1 && mixed[0].id === warnEvent.id, 'audit snapshot should persist non-ok events before stable noise')

  const stable = selectPersistableObservabilityEvents([okEvent, { ...okEvent, id: 'data_quality:stable' }])
  assert(stable.length === 1 && stable[0].id === okEvent.id, 'fully healthy snapshot should persist one stable baseline only')
}

{
  const filters = normalizeObservabilityAuditFilters({
    date: '2026-04-30',
    severity: 'critical',
    domain: 'legacy_cron',
    limit: '999',
  })

  assert(filters.date === '2026-04-30', 'audit filter should preserve valid date')
  assert(filters.severity === undefined, 'audit filter should drop unknown severity')
  assert(filters.domain === undefined, 'audit filter should drop unknown domain')
  assert(filters.limit === 200, 'audit filter should clamp oversized limit')
}
