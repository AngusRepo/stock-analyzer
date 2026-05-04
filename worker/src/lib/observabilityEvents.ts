import type { Bindings } from '../types'
import { twToday } from './dateUtils'
import { buildDataQualityReport, type DataQualityCheck } from './dataQualityMonitor'
import { buildDeployGateReport } from './deployGate'
import { getSchedulerStatus } from './schedulerStatus'
import { controllerJson } from './controllerClient'

export type ObservabilitySeverity = 'ok' | 'info' | 'warn' | 'error'
export type ObservabilityDomain =
  | 'scheduler'
  | 'data_quality'
  | 'deploy_gate'
  | 'model_pool'
  | 'owner_boundary'

const OBSERVABILITY_SEVERITIES: ObservabilitySeverity[] = ['ok', 'info', 'warn', 'error']
const OBSERVABILITY_DOMAINS: ObservabilityDomain[] = [
  'scheduler',
  'data_quality',
  'deploy_gate',
  'model_pool',
  'owner_boundary',
]

export interface ObservabilityEvent {
  id: string
  ts: string
  severity: ObservabilitySeverity
  domain: ObservabilityDomain
  source: string
  status: string
  title: string
  summary: string
  owner: string
  impact: string
  next_action: string
  runbook?: string
  evidence: Record<string, unknown>
}

export interface ObservabilityEventReport {
  success: true
  version: 'obs-event-contract-v1'
  generated_at: string
  date: string
  overall: ObservabilitySeverity
  counts: Record<ObservabilitySeverity, number>
  events: ObservabilityEvent[]
  domains: Array<{
    domain: ObservabilityDomain
    owner: string
    severity: ObservabilitySeverity
    event_count: number
  }>
  owner_boundaries: Array<{
    owner: string
    responsibility: string
    source_of_truth: string
  }>
  audit?: {
    recent: ObservabilityAuditRow[]
  }
}

export interface ObservabilityAuditRow {
  event_id: string
  date: string
  severity: ObservabilitySeverity
  domain: ObservabilityDomain
  source: string
  status: string
  title: string
  summary: string
  owner: string
  impact?: string | null
  next_action?: string | null
  evidence?: Record<string, unknown>
  created_at: string
}

export function normalizeObservabilityAuditFilters(input: {
  date?: string | null
  limit?: string | number | null
  severity?: string | null
  domain?: string | null
}): {
  date?: string
  limit: number
  severity?: ObservabilitySeverity
  domain?: ObservabilityDomain
} {
  const rawLimit = typeof input.limit === 'number'
    ? input.limit
    : Number.parseInt(String(input.limit ?? '50'), 10)
  const severity = OBSERVABILITY_SEVERITIES.includes(input.severity as ObservabilitySeverity)
    ? input.severity as ObservabilitySeverity
    : undefined
  const domain = OBSERVABILITY_DOMAINS.includes(input.domain as ObservabilityDomain)
    ? input.domain as ObservabilityDomain
    : undefined

  return {
    date: input.date?.trim() || undefined,
    limit: Math.max(1, Math.min(Number.isFinite(rawLimit) ? rawLimit : 50, 200)),
    severity,
    domain,
  }
}

type SchedulerJobSnapshot = {
  id: string
  name: string
  group: string
  lastStatus: string
  lastDuration?: string
  lastRun?: string
  summary?: string
  lastError?: string
}

const OWNER_BOUNDARIES: ObservabilityEventReport['owner_boundaries'] = [
  { owner: 'GCP Scheduler', responsibility: 'Canonical schedule trigger', source_of_truth: 'infra/gcp-scheduler-jobs.json + scheduler callback' },
  { owner: 'Cloud Run', responsibility: 'Pipeline and controller orchestration', source_of_truth: 'ml-controller graphs/services' },
  { owner: 'Modal', responsibility: 'Heavy ML runtime and model artifacts', source_of_truth: 'ml-service runtime + GCS metadata' },
  { owner: 'Worker', responsibility: 'Serving APIs, D1/KV state, UI contracts', source_of_truth: 'worker routes/lib contracts' },
  { owner: 'Frontend', responsibility: 'Read-only decision cockpit', source_of_truth: 'typed API payloads, no business ownership' },
]

function eventId(domain: ObservabilityDomain, source: string, id: string) {
  return `${domain}:${source}:${id}`.replace(/\s+/g, '-').toLowerCase()
}

function worstSeverity(items: ObservabilitySeverity[]): ObservabilitySeverity {
  if (items.includes('error')) return 'error'
  if (items.includes('warn')) return 'warn'
  if (items.includes('info')) return 'info'
  return 'ok'
}

function countBySeverity(events: ObservabilityEvent[]): Record<ObservabilitySeverity, number> {
  return events.reduce<Record<ObservabilitySeverity, number>>((acc, event) => {
    acc[event.severity] += 1
    return acc
  }, { ok: 0, info: 0, warn: 0, error: 0 })
}

function schedulerSeverity(status: string): ObservabilitySeverity {
  if (status === 'failed' || status === 'error') return 'error'
  if (status === 'running') return 'warn'
  if (status === 'skip' || status === 'skipped') return 'info'
  return 'ok'
}

function dataQualitySeverity(status: string): ObservabilitySeverity {
  if (status === 'fail') return 'error'
  if (status === 'warn') return 'warn'
  return 'ok'
}

function deployGateSeverity(decision: string | undefined): ObservabilitySeverity {
  const value = String(decision ?? '').toLowerCase()
  if (value === 'block' || value === 'fail' || value === 'failed') return 'error'
  if (value === 'warn' || value === 'warning') return 'warn'
  if (!value || value === 'unknown') return 'warn'
  return 'ok'
}

function modelIcValue(model: Record<string, unknown>): number | null {
  const raw = model.ic_4w_avg ?? model.rolling_ic
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

function isStateSpaceOverlayModel(name: string, model: Record<string, unknown>): boolean {
  return (
    name === 'KalmanFilter' ||
    name === 'MarkovSwitching' ||
    model.model_type === 'state_space_overlay' ||
    model.balance_family === 'state_space'
  )
}

export function buildEventsFromScheduler(input: {
  generatedAt: string
  jobs?: SchedulerJobSnapshot[]
}): ObservabilityEvent[] {
  const jobs = input.jobs ?? []
  const actionable = jobs.filter((job) => ['failed', 'running'].includes(job.lastStatus))
  if (!actionable.length) {
    return [{
      id: eventId('scheduler', 'scheduler_status', 'stable'),
      ts: input.generatedAt,
      severity: 'ok',
      domain: 'scheduler',
      source: 'scheduler_status',
      status: 'ok',
      title: 'Scheduler stable',
      summary: 'No failed or running scheduler jobs in the current payload.',
      owner: 'GCP Scheduler',
      impact: 'Cron surface is healthy for the current visible window.',
      next_action: 'Keep watching callback round-trip and freshness gates.',
      runbook: 'P8 scheduler callback contract',
      evidence: { job_count: jobs.length },
    }]
  }

  return actionable.map((job) => ({
    id: eventId('scheduler', 'scheduler_status', job.id),
    ts: input.generatedAt,
    severity: schedulerSeverity(job.lastStatus),
    domain: 'scheduler',
    source: 'scheduler_status',
    status: job.lastStatus,
    title: job.name,
    summary: job.lastError || job.summary || `${job.name} is ${job.lastStatus}`,
    owner: job.group === 'intraday' ? 'Worker' : 'GCP Scheduler',
    impact: job.lastStatus === 'failed'
      ? 'Downstream recommendations, ML freshness, or execution state may be stale.'
      : 'A background run is still in-flight; UI should not mark this domain as healthy yet.',
    next_action: job.lastStatus === 'failed'
      ? 'Open scheduler trace, inspect callback payload, then compare with Cloud Run/Worker logs.'
      : 'Wait for final callback; alert if the run exceeds its SLA.',
    runbook: 'P8 scheduler callback contract',
    evidence: {
      task_id: job.id,
      group: job.group,
      last_run: job.lastRun,
      duration: job.lastDuration,
      summary: job.summary,
    },
  }))
}

export function buildEventsFromDataQuality(input: {
  generatedAt: string
  checks?: DataQualityCheck[]
}): ObservabilityEvent[] {
  const checks = input.checks ?? []
  const actionable = checks.filter((check) => check.status !== 'ok')
  if (!actionable.length) {
    return [{
      id: eventId('data_quality', 'data_quality_report', 'stable'),
      ts: input.generatedAt,
      severity: 'ok',
      domain: 'data_quality',
      source: 'data_quality_report',
      status: 'ok',
      title: 'Data quality stable',
      summary: 'Freshness, schema, parity, and source-role checks are OK.',
      owner: 'Worker',
      impact: 'Dashboard and Bot can trust the current serving data contract.',
      next_action: 'Keep the gate wired before recommendation and IC decisions.',
      runbook: 'P6/P9 data quality gate',
      evidence: { check_count: checks.length },
    }]
  }

  return actionable.map((check) => ({
    id: eventId('data_quality', 'data_quality_report', check.id),
    ts: input.generatedAt,
    severity: dataQualitySeverity(check.status),
    domain: 'data_quality',
    source: 'data_quality_report',
    status: check.status,
    title: check.label,
    summary: check.summary,
    owner: 'Worker',
    impact: check.status === 'fail'
      ? 'Serving data may be stale or structurally unsafe; downstream recommendations should be treated as degraded.'
      : 'Serving data is usable but needs review before trusting score/ranking explanations.',
    next_action: 'Inspect evidence metrics, then trace the owner pipeline that writes this dataset.',
    runbook: 'P6/P9 data quality gate',
    evidence: check.metrics ?? {},
  }))
}

export function buildEventsFromDeployGate(input: {
  generatedAt: string
  decision?: string
  checks?: Array<{ id?: string; name?: string; status?: string; summary?: string; metrics?: Record<string, unknown> }>
}): ObservabilityEvent[] {
  const severity = deployGateSeverity(input.decision)
  if (severity === 'ok') {
    return [{
      id: eventId('deploy_gate', 'deploy_gate', 'pass'),
      ts: input.generatedAt,
      severity: 'ok',
      domain: 'deploy_gate',
      source: 'deploy_gate',
      status: input.decision ?? 'pass',
      title: 'Deploy gate pass',
      summary: 'Predeploy checks are passing for the current payload.',
      owner: 'Worker',
      impact: 'Local gate sees no blocker in the current checked surfaces.',
      next_action: 'Run live smoke after deploy; do not skip callback round-trip.',
      runbook: 'P9 deploy gate',
      evidence: { decision: input.decision },
    }]
  }

  const checks = input.checks?.filter((check) => dataQualitySeverity(String(check.status ?? 'ok')) !== 'ok') ?? []
  return (checks.length ? checks : [{ id: 'decision', name: 'Deploy gate', status: input.decision, summary: 'Deploy gate did not pass' }]).map((check) => ({
    id: eventId('deploy_gate', 'deploy_gate', String(check.id ?? check.name ?? 'decision')),
    ts: input.generatedAt,
    severity,
    domain: 'deploy_gate',
    source: 'deploy_gate',
    status: String(check.status ?? input.decision ?? 'unknown'),
    title: String(check.name ?? check.id ?? 'Deploy gate'),
    summary: String(check.summary ?? 'Deploy gate did not pass'),
    owner: 'Worker',
    impact: 'Deploy should not be treated as safe until this gate is resolved.',
    next_action: 'Fix blocker or explicitly document why this warning is acceptable before deploy.',
    runbook: 'P9 deploy gate',
    evidence: check.metrics ?? { decision: input.decision },
  }))
}

export function buildEventsFromModelPool(input: {
  generatedAt: string
  models?: Record<string, Record<string, unknown>>
  sourceError?: string
}): ObservabilityEvent[] {
  if (input.sourceError) {
    return [{
      id: eventId('model_pool', 'model_pool_lineage', 'unavailable'),
      ts: input.generatedAt,
      severity: 'error',
      domain: 'model_pool',
      source: 'model_pool_lineage',
      status: 'unavailable',
      title: 'Model pool unavailable',
      summary: 'Model lineage payload is unavailable.',
      owner: 'Cloud Run',
      impact: 'OBS cannot verify IC, metadata, challenger, or active model lineage.',
      next_action: 'Check ml-controller health and model_pool lineage endpoint.',
      runbook: 'P1/P4 model lifecycle contract',
      evidence: { error: input.sourceError },
    }]
  }

  const entries = Object.entries(input.models ?? {})
    .filter(([name, model]) => !isStateSpaceOverlayModel(name, model))
  const weak = entries.filter(([, model]) => {
    const ic = modelIcValue(model)
    const diagnosis = model.lifecycle_diagnosis as Record<string, unknown> | undefined
    return ic == null || Math.abs(ic) < 0.0001 || model.metadata_exists === false || diagnosis?.status === 'artifact_mismatch'
  })

  if (!weak.length) {
    return [{
      id: eventId('model_pool', 'model_pool_lineage', 'stable'),
      ts: input.generatedAt,
      severity: 'ok',
      domain: 'model_pool',
      source: 'model_pool_lineage',
      status: 'ok',
      title: 'Model lifecycle stable',
      summary: 'Model metadata and IC signals are populated in lineage payload.',
      owner: 'Cloud Run',
      impact: 'Model pool has enough visible lifecycle evidence for OBS.',
      next_action: 'Keep weekly IC tracker and challenger events observable.',
      runbook: 'P1/P4 model lifecycle contract',
      evidence: { model_count: entries.length },
    }]
  }

  return weak.slice(0, 12).map(([name, model]) => ({
    id: eventId('model_pool', 'model_pool_lineage', name),
    ts: input.generatedAt,
    severity: model.metadata_exists === false || (model.lifecycle_diagnosis as Record<string, unknown> | undefined)?.status === 'artifact_mismatch' ? 'error' : 'warn',
    domain: 'model_pool',
    source: 'model_pool_lineage',
    status: String((model.lifecycle_diagnosis as Record<string, unknown> | undefined)?.status ?? (model.metadata_exists === false ? 'metadata_missing' : 'weak_ic')),
    title: name,
    summary: model.metadata_exists === false
      ? `${name} metadata is missing`
      : `${name} IC is weak or unavailable (${String((model.lifecycle_diagnosis as Record<string, unknown> | undefined)?.root_cause ?? model.last_ic_root_cause ?? model.last_ic_status ?? 'unknown')})`,
    owner: 'Cloud Run',
    impact: 'Model votes may be deweighted, neutralized, or harder to audit.',
    next_action: 'Trace latest training artifact metadata, weekly IC tracker, and promote/degrade event logs.',
    runbook: 'P1/P4 model lifecycle contract',
    evidence: {
      status: model.status,
      ic_4w_avg: model.ic_4w_avg,
      rolling_ic: model.rolling_ic,
      ic_status: model.last_ic_status,
      ic_root_cause: model.last_ic_root_cause,
      lifecycle_diagnosis: model.lifecycle_diagnosis,
      sample_count: model.last_ic_sample_count,
      ic_diagnostics: model.last_ic_diagnostics,
      metadata_exists: model.metadata_exists,
      family: model.balance_family ?? model.model_type,
    },
  }))
}

export function buildObservabilityEventReport(input: {
  date: string
  generatedAt: string
  schedulerJobs?: SchedulerJobSnapshot[]
  dataQualityChecks?: DataQualityCheck[]
  deployDecision?: string
  deployChecks?: Array<{ id?: string; name?: string; status?: string; summary?: string; metrics?: Record<string, unknown> }>
  modelPoolModels?: Record<string, Record<string, unknown>>
  modelPoolError?: string
}): ObservabilityEventReport {
  const events = [
    ...buildEventsFromScheduler({ generatedAt: input.generatedAt, jobs: input.schedulerJobs }),
    ...buildEventsFromDataQuality({ generatedAt: input.generatedAt, checks: input.dataQualityChecks }),
    ...buildEventsFromDeployGate({
      generatedAt: input.generatedAt,
      decision: input.deployDecision,
      checks: input.deployChecks,
    }),
    ...buildEventsFromModelPool({
      generatedAt: input.generatedAt,
      models: input.modelPoolModels,
      sourceError: input.modelPoolError,
    }),
  ]

  const domains = Array.from(new Set(events.map((event) => event.domain))).map((domain) => {
    const domainEvents = events.filter((event) => event.domain === domain)
    const owner = domainEvents[0]?.owner ?? 'unknown'
    return {
      domain,
      owner,
      severity: worstSeverity(domainEvents.map((event) => event.severity)),
      event_count: domainEvents.length,
    }
  })

  return {
    success: true,
    version: 'obs-event-contract-v1',
    generated_at: input.generatedAt,
    date: input.date,
    overall: worstSeverity(events.map((event) => event.severity)),
    counts: countBySeverity(events),
    events,
    domains,
    owner_boundaries: OWNER_BOUNDARIES,
  }
}

export async function buildLiveObservabilityEventReport(env: Bindings, options: { date?: string; live?: boolean } = {}) {
  const date = options.date ?? twToday()
  const generatedAt = new Date().toISOString()

  const [scheduler, dataQuality, deployGate, modelPoolResult] = await Promise.all([
    getSchedulerStatus(env).catch((error: unknown) => ({ error: String(error), jobs: [] })),
    buildDataQualityReport(env, { date }).catch((error: unknown) => ({
      overall: 'fail' as const,
      checks: [{
        id: 'data_quality_unavailable',
        label: 'Data Quality unavailable',
        status: 'fail' as const,
        summary: String(error),
      }],
    })),
    buildDeployGateReport(env, { date, includeLiveController: options.live === true }).catch((error: unknown) => ({
      decision: 'block',
      checks: [{
        id: 'deploy_gate_unavailable',
        name: 'Deploy gate unavailable',
        status: 'fail',
        summary: String(error),
      }],
    })),
    controllerJson<{ models?: Record<string, Record<string, unknown>> }>(env, '/model_pool/lineage', { timeoutMs: 12_000 })
      .then((payload) => ({ payload }))
      .catch((error: unknown) => ({ error: String(error) })),
  ])

  const modelPoolPayload = 'payload' in modelPoolResult ? modelPoolResult.payload : undefined
  const modelPoolError = 'error' in modelPoolResult ? modelPoolResult.error : undefined

  return buildObservabilityEventReport({
    date,
    generatedAt,
    schedulerJobs: 'jobs' in scheduler ? scheduler.jobs as SchedulerJobSnapshot[] : [],
    dataQualityChecks: dataQuality.checks,
    deployDecision: String(deployGate.decision ?? 'unknown'),
    deployChecks: deployGate.checks,
    modelPoolModels: modelPoolPayload?.models,
    modelPoolError,
  })
}

function safeJsonParse(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || !value.trim()) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

export async function listObservabilityAuditEvents(env: Bindings, options: {
  date?: string
  limit?: number
  severity?: ObservabilitySeverity
  domain?: ObservabilityDomain
} = {}): Promise<ObservabilityAuditRow[]> {
  const limit = Math.max(1, Math.min(Number(options.limit ?? 50), 200))
  const conditions: string[] = []
  const binds: unknown[] = []

  if (options.date) {
    conditions.push('date = ?')
    binds.push(options.date)
  }
  if (options.severity) {
    conditions.push('severity = ?')
    binds.push(options.severity)
  }
  if (options.domain) {
    conditions.push('domain = ?')
    binds.push(options.domain)
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const { results } = await env.DB.prepare(`
    SELECT event_id, date, severity, domain, source, status, title, summary,
           owner, impact, next_action, evidence, created_at
      FROM observability_events
      ${where}
     ORDER BY created_at DESC
     LIMIT ?
  `).bind(...binds, limit).all<Record<string, unknown>>()

  return (results ?? []).map((row) => ({
    event_id: String(row.event_id ?? ''),
    date: String(row.date ?? ''),
    severity: String(row.severity ?? 'info') as ObservabilitySeverity,
    domain: String(row.domain ?? 'owner_boundary') as ObservabilityDomain,
    source: String(row.source ?? ''),
    status: String(row.status ?? ''),
    title: String(row.title ?? ''),
    summary: String(row.summary ?? ''),
    owner: String(row.owner ?? ''),
    impact: row.impact == null ? null : String(row.impact),
    next_action: row.next_action == null ? null : String(row.next_action),
    evidence: safeJsonParse(row.evidence),
    created_at: String(row.created_at ?? ''),
  }))
}

export function selectPersistableObservabilityEvents(events: ObservabilityEvent[]): ObservabilityEvent[] {
  const actionable = events.filter((event) => event.severity !== 'ok')
  if (actionable.length > 0) return actionable
  return events.slice(0, 1)
}

export async function persistObservabilitySnapshot(env: Bindings, report: ObservabilityEventReport): Promise<{
  inserted: number
  skipped: number
}> {
  let inserted = 0
  let skipped = 0

  for (const event of selectPersistableObservabilityEvents(report.events)) {
    const existing = await env.DB.prepare(`
      SELECT id FROM observability_events
       WHERE event_id = ?
         AND date = ?
         AND severity = ?
         AND status = ?
         AND summary = ?
       LIMIT 1
    `).bind(event.id, report.date, event.severity, event.status, event.summary).first<{ id: number }>()

    if (existing) {
      skipped += 1
      continue
    }

    await env.DB.prepare(`
      INSERT INTO observability_events (
        event_id, date, severity, domain, source, status, title, summary,
        owner, impact, next_action, evidence, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      event.id,
      report.date,
      event.severity,
      event.domain,
      event.source,
      event.status,
      event.title,
      event.summary,
      event.owner,
      event.impact,
      event.next_action,
      JSON.stringify(event.evidence ?? {}),
      event.ts,
    ).run()
    inserted += 1
  }

  return { inserted, skipped }
}
