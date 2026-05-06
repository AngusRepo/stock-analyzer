import type { ObservabilityDomain, ObservabilityEvent, ObservabilityEventReport, ObservabilitySeverity } from './observabilityEvents'

export type IncidentStatus = 'open' | 'watch' | 'resolved'

export interface ObservabilityIncident {
  id: string
  severity: ObservabilitySeverity
  status: IncidentStatus
  domain: ObservabilityDomain
  owner: string
  title: string
  root_cause: string
  impact: string
  first_seen: string
  last_seen: string
  affected_symbols: string[]
  run_ids: string[]
  next_action: string
  source_event_ids: string[]
  evidence: Record<string, unknown>
}

export interface ObservabilityDrilldownReport {
  success: true
  version: 'obs-drilldown-v1'
  generated_at: string
  date: string
  overall: ObservabilitySeverity
  incidents: ObservabilityIncident[]
  domain_summary: Array<{
    domain: ObservabilityDomain
    owner: string
    open_count: number
    worst_severity: ObservabilitySeverity
  }>
  operator_questions: Array<{
    question: string
    answer_path: string
  }>
}

const SEVERITY_ORDER: Record<ObservabilitySeverity, number> = {
  ok: 0,
  info: 1,
  warn: 2,
  error: 3,
}

function worstSeverity(events: ObservabilityEvent[]): ObservabilitySeverity {
  return events.reduce<ObservabilitySeverity>((worst, event) => (
    SEVERITY_ORDER[event.severity] > SEVERITY_ORDER[worst] ? event.severity : worst
  ), 'ok')
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function cleanStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => cleanText(item))
    .filter(Boolean)
    .slice(0, 50)
}

function collectRunIds(event: ObservabilityEvent): string[] {
  const evidence = event.evidence ?? {}
  const direct = [
    evidence.run_id,
    evidence.runId,
    evidence.task_id,
    evidence.execution_id,
    evidence.pipeline_run_id,
  ].map(cleanText).filter(Boolean)
  return [...new Set(direct)]
}

function collectAffectedSymbols(event: ObservabilityEvent): string[] {
  const evidence = event.evidence ?? {}
  const explicit = [
    ...cleanStringArray(evidence.affected_symbols),
    ...cleanStringArray(evidence.symbols),
    ...cleanStringArray(evidence.missing_outcome_symbols),
  ]
  const sampleRows = Array.isArray(evidence.sample_rows) ? evidence.sample_rows : []
  for (const row of sampleRows.slice(0, 50)) {
    if (row && typeof row === 'object') {
      const symbol = cleanText((row as Record<string, unknown>).symbol)
      if (symbol) explicit.push(symbol)
    }
  }
  return [...new Set(explicit)].slice(0, 50)
}

function inferRootCause(event: ObservabilityEvent): string {
  const evidence = event.evidence ?? {}
  if (event.domain === 'scheduler') {
    const runId = cleanText(evidence.run_id) || cleanText(evidence.task_id)
    return runId
      ? `scheduler_callback_or_run_state:${runId}`
      : `scheduler_status:${event.status}`
  }
  if (event.domain === 'data_quality') {
    return `data_quality_gate:${event.status}:${event.source}`
  }
  if (event.domain === 'model_pool') {
    return cleanText(evidence.root_cause)
      || cleanText(evidence.last_ic_root_cause)
      || cleanText(evidence.blocker)
      || `model_pool:${event.status}`
  }
  if (event.domain === 'validation') {
    const failed = cleanStringArray(evidence.failed_gates)
    return failed.length ? `validation_failed_gates:${failed.join(',')}` : `validation:${event.status}`
  }
  if (event.domain === 'adaptive_meta') {
    const provenance = evidence.provenance && typeof evidence.provenance === 'object'
      ? evidence.provenance as Record<string, unknown>
      : {}
    return provenance.fallback === true
      ? 'adaptive_params_fallback_or_stale'
      : `adaptive_meta:${event.status}`
  }
  return `${event.domain}:${event.status}`
}

function incidentStatus(severity: ObservabilitySeverity): IncidentStatus {
  if (severity === 'ok') return 'resolved'
  if (severity === 'info') return 'watch'
  return 'open'
}

function mergeEvents(domain: ObservabilityDomain, events: ObservabilityEvent[]): ObservabilityIncident {
  const severity = worstSeverity(events)
  const primary = events.find((event) => event.severity === severity) ?? events[0]
  const eventTimes = events
    .map((event) => event.ts)
    .filter(Boolean)
    .sort()
  const runIds = [...new Set(events.flatMap(collectRunIds))]
  const affectedSymbols = [...new Set(events.flatMap(collectAffectedSymbols))]
  return {
    id: `incident:${domain}:${primary.source}`.replace(/\s+/g, '-').toLowerCase(),
    severity,
    status: incidentStatus(severity),
    domain,
    owner: primary.owner,
    title: primary.title,
    root_cause: inferRootCause(primary),
    impact: primary.impact,
    first_seen: eventTimes[0] ?? primary.ts,
    last_seen: eventTimes[eventTimes.length - 1] ?? primary.ts,
    affected_symbols: affectedSymbols,
    run_ids: runIds,
    next_action: primary.next_action,
    source_event_ids: events.map((event) => event.id),
    evidence: {
      event_count: events.length,
      statuses: [...new Set(events.map((event) => event.status))],
      sources: [...new Set(events.map((event) => event.source))],
      run_ids: runIds,
      affected_symbols: affectedSymbols,
    },
  }
}

export function buildObservabilityDrilldown(report: ObservabilityEventReport): ObservabilityDrilldownReport {
  const actionable = report.events.filter((event) => event.severity !== 'ok')
  const source = actionable.length ? actionable : report.events.slice(0, 1)
  const byDomain = new Map<ObservabilityDomain, ObservabilityEvent[]>()
  for (const event of source) {
    byDomain.set(event.domain, [...(byDomain.get(event.domain) ?? []), event])
  }
  const incidents = [...byDomain.entries()]
    .map(([domain, events]) => mergeEvents(domain, events))
    .sort((a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity])

  return {
    success: true,
    version: 'obs-drilldown-v1',
    generated_at: report.generated_at,
    date: report.date,
    overall: report.overall,
    incidents,
    domain_summary: incidents.map((incident) => ({
      domain: incident.domain,
      owner: incident.owner,
      open_count: incident.status === 'open' ? 1 : 0,
      worst_severity: incident.severity,
    })),
    operator_questions: [
      { question: '哪裡壞？', answer_path: 'incidents[].domain + incidents[].title' },
      { question: '為什麼壞？', answer_path: 'incidents[].root_cause + incidents[].evidence' },
      { question: '影響哪些股票或 run？', answer_path: 'incidents[].affected_symbols + incidents[].run_ids' },
      { question: '下一步做什麼？', answer_path: 'incidents[].next_action' },
    ],
  }
}
