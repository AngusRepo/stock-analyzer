import { buildObservabilityDrilldown } from './observabilityDrilldown'
import type { ObservabilityEventReport } from './observabilityEvents'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const report: ObservabilityEventReport = {
  success: true,
  version: 'obs-event-contract-v1',
  generated_at: '2026-05-05T01:00:00.000Z',
  date: '2026-05-05',
  overall: 'error',
  counts: { ok: 1, info: 0, warn: 1, error: 1 },
  owner_boundaries: [],
  domains: [],
  events: [
    {
      id: 'scheduler:pipeline',
      ts: '2026-05-05T01:00:00.000Z',
      severity: 'error',
      domain: 'scheduler',
      source: 'scheduler_status',
      status: 'failed',
      title: 'Pipeline',
      summary: 'callback timeout',
      owner: 'GCP Scheduler',
      impact: 'Recommendations may be stale.',
      next_action: 'Open scheduler trace and compare callback payload.',
      evidence: { task_id: 'pipeline', run_id: 'pipeline-v2-abc' },
    },
    {
      id: 'data_quality:price',
      ts: '2026-05-05T01:00:00.000Z',
      severity: 'warn',
      domain: 'data_quality',
      source: 'data_quality_report',
      status: 'warn',
      title: 'Price freshness',
      summary: 'one symbol stale',
      owner: 'Worker',
      impact: 'Cards may show stale close.',
      next_action: 'Trace data update writer.',
      evidence: { affected_symbols: ['4938'] },
    },
    {
      id: 'scheduler:stable',
      ts: '2026-05-05T01:00:00.000Z',
      severity: 'ok',
      domain: 'scheduler',
      source: 'scheduler_status',
      status: 'ok',
      title: 'Scheduler stable',
      summary: 'ok',
      owner: 'GCP Scheduler',
      impact: 'healthy',
      next_action: 'watch',
      evidence: {},
    },
  ],
}

{
  const drilldown = buildObservabilityDrilldown(report)
  assert(drilldown.version === 'obs-drilldown-v1', 'drilldown should expose v1 contract')
  assert(drilldown.incidents.length === 2, 'drilldown should focus on non-ok incidents')
  assert(drilldown.incidents[0].domain === 'scheduler', 'highest severity incident should come first')
  assert(drilldown.incidents[0].run_ids.includes('pipeline-v2-abc'), 'scheduler incident should expose run_id')
  assert(drilldown.incidents[1].affected_symbols.includes('4938'), 'data-quality incident should expose affected symbols')
  assert(drilldown.operator_questions.some((row) => row.question.includes('為什麼')), 'drilldown should answer root-cause questions')
}

{
  const drilldown = buildObservabilityDrilldown(report, {
    auditRows: [{
      event_id: 'data_quality:price',
      date: '2026-05-04',
      severity: 'warn',
      domain: 'data_quality',
      source: 'data_quality_report',
      status: 'warn',
      title: 'Price freshness',
      summary: 'one symbol stale',
      owner: 'Worker',
      impact: 'Cards may show stale close.',
      next_action: 'Trace data update writer.',
      evidence: {},
      created_at: '2026-05-04T10:15:00.000Z',
    }],
  })
  const incident = drilldown.incidents.find((item) => item.domain === 'data_quality')
  assert(incident?.first_seen === '2026-05-04T10:15:00.000Z', 'drilldown should prefer persisted audit first_seen over page-open generated_at')
  assert(incident?.last_seen === '2026-05-05T01:00:00.000Z', 'drilldown should keep live event as last_seen when issue is still active')
}

{
  const healthy = buildObservabilityDrilldown({ ...report, overall: 'ok', events: [report.events[2]], counts: { ok: 1, info: 0, warn: 0, error: 0 } })
  assert(healthy.incidents.length === 1, 'healthy report should keep one baseline incident')
  assert(healthy.incidents[0].status === 'resolved', 'healthy baseline should be resolved')
}
