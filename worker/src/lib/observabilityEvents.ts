import type { Bindings } from '../types'
import { twToday } from './dateUtils'
import { buildDataQualityReport, type DataQualityCheck } from './dataQualityMonitor'
import { buildDeployGateReport } from './deployGate'
import { getSchedulerStatus } from './schedulerStatus'
import { controllerJson } from './controllerClient'
import { evaluateGaPromotion } from './gaPromotion'

export type ObservabilitySeverity = 'ok' | 'info' | 'warn' | 'error'
export type ObservabilityDomain =
  | 'scheduler'
  | 'data_quality'
  | 'deploy_gate'
  | 'model_pool'
  | 'validation'
  | 'adaptive_meta'
  | 'owner_boundary'

const OBSERVABILITY_SEVERITIES: ObservabilitySeverity[] = ['ok', 'info', 'warn', 'error']
const OBSERVABILITY_DOMAINS: ObservabilityDomain[] = [
  'scheduler',
  'data_quality',
  'deploy_gate',
  'model_pool',
  'validation',
  'adaptive_meta',
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
  lastRunAt?: string | null
  lastAttemptAt?: string | null
  lastEffectiveRunAt?: string | null
  summary?: string
  lastError?: string
}

const OWNER_BOUNDARIES: ObservabilityEventReport['owner_boundaries'] = [
  { owner: 'GCP Scheduler', responsibility: 'Canonical schedule trigger', source_of_truth: 'infra/gcp-scheduler-jobs.json + scheduler callback' },
  { owner: 'Cloud Run', responsibility: 'Pipeline and controller orchestration', source_of_truth: 'ml-controller graphs/services' },
  { owner: 'Modal', responsibility: 'Heavy ML runtime and model artifacts', source_of_truth: 'ml-service runtime + GCS metadata' },
  { owner: 'Worker', responsibility: 'Serving APIs, D1/KV state, UI contracts', source_of_truth: 'worker routes/lib contracts' },
  { owner: 'Adaptive Meta Layer', responsibility: 'Regime-aware deltas, bandit protection, and meta optimizer boundaries', source_of_truth: 'ml:adaptive_params + market_regime_state' },
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

function schedulerEventTimestamp(job: SchedulerJobSnapshot, generatedAt: string): string {
  return job.lastRunAt || job.lastAttemptAt || job.lastEffectiveRunAt || generatedAt
}

function normalizeEvidenceTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const text = value.trim()
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) return text
  if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(text)) return `${text.replace(' ', 'T')}Z`
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return `${text}T00:00:00.000Z`
  return null
}

function collectEvidenceTimestamps(value: unknown, parentKey = ''): string[] {
  if (value == null) return []
  if (Array.isArray(value)) return value.flatMap((item) => collectEvidenceTimestamps(item, parentKey))
  if (typeof value !== 'object') {
    return /(latest|created|updated|seen|run|verified|manifest|date|at)$/i.test(parentKey)
      && !/^target_date$/i.test(parentKey)
      ? [normalizeEvidenceTimestamp(value)].filter((item): item is string => Boolean(item))
      : []
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) => (
    collectEvidenceTimestamps(nested, key)
  ))
}

function dataQualityEventTimestamp(check: DataQualityCheck, generatedAt: string): string {
  const evidenceTimes = collectEvidenceTimestamps(check.metrics)
    .filter((value) => Number.isFinite(new Date(value).getTime()))
    .sort()
  return evidenceTimes.at(-1) ?? generatedAt
}

function dataQualitySeverity(status: string): ObservabilitySeverity {
  if (status === 'fail') return 'error'
  if (status === 'warn') return 'warn'
  return 'ok'
}

function dataQualityImpact(check: DataQualityCheck): string {
  if (check.id === 'classification_coverage') {
    return 'Classification coverage affects sector/theme grouping and recommendation lane explanations; tradable lane should be evaluated separately from emerging research lane.'
  }
  if (check.id.includes('price')) return 'Cards, quote sanity, fills, and recommendations may use stale or incomplete price data.'
  if (check.id === 'chip_freshness') return 'Chip, market-risk, screener foreign-flow overlays, and recommendation context may be using stale canonical_chip_daily or legacy fallback data.'
  if (check.id === 'institutional_amount_freshness') return 'Official institutional amount context may be stale; homepage market regime, chips tile, and allocation risk context should be treated as degraded.'
  if (check.id.includes('prediction') || check.id.includes('model')) return 'ML votes, IC weighting, and recommendation confidence may be degraded.'
  return check.status === 'fail'
    ? 'Serving data may be stale or structurally unsafe; downstream recommendations should be treated as degraded.'
    : 'Serving data is usable but needs review before trusting score/ranking explanations.'
}

function dataQualityNextAction(check: DataQualityCheck): string {
  if (check.id === 'classification_coverage') {
    return 'Inspect tradable_missing_industry_tags first; if zero, treat emerging research mapping as taxonomy backlog, not a trading blocker.'
  }
  if (check.id.includes('price')) return 'Open price freshness drilldown, compare latest stock_prices date with the data update run, then rerun evening chain only after update completes.'
  if (check.id === 'chip_freshness') return 'Check FINLAB_DAILY_PRICE_LANES includes chip_diversity and emerging_chip_diversity, verify canonical_chip_daily row counts, then rerun evening chain only after FinLab primary materialization is fresh.'
  if (check.id === 'institutional_amount_freshness') return 'Check FINLAB_DAILY_PRICE_LANES includes institutional_amount_summary and verify canonical_institutional_amount_daily freshness before rerunning dependent schedulers.'
  if (check.id.includes('prediction')) return 'Open model/prediction coverage and compare expected model rows vs actual prediction rows for the target date.'
  return 'Inspect evidence metrics, then trace the owner pipeline that writes this dataset.'
}

function deployGateSeverity(decision: string | undefined): ObservabilitySeverity {
  const value = String(decision ?? '').toLowerCase()
  if (value === 'block' || value === 'fail' || value === 'failed') return 'error'
  if (value === 'warn' || value === 'warning') return 'warn'
  if (!value || value === 'unknown') return 'warn'
  return 'ok'
}

function validationSeverity(decision: unknown): ObservabilitySeverity {
  const value = String(decision ?? '').toUpperCase()
  if (value === 'FAIL' || value === 'BLOCK') return 'error'
  if (value === 'WARN' || value === 'WARNING') return 'warn'
  if (!value || value === 'UNKNOWN' || value === 'MISSING') return 'warn'
  return 'ok'
}

function adaptiveMetaSeverity(params?: Record<string, unknown>): ObservabilitySeverity {
  if (!params) return 'warn'
  const provenance = params.provenance as Record<string, unknown> | undefined
  const metaLayer = params.meta_layer as Record<string, unknown> | undefined
  if (!provenance || provenance.fallback === true) return 'warn'
  if (!metaLayer || !Array.isArray(metaLayer.alpha_vote_models) || !Array.isArray(metaLayer.state_space_overlays)) return 'warn'
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

  return actionable.map((job) => {
    const eventTs = schedulerEventTimestamp(job, input.generatedAt)
    return {
      id: eventId('scheduler', 'scheduler_status', job.id),
      ts: eventTs,
      severity: schedulerSeverity(job.lastStatus),
      domain: 'scheduler' as const,
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
        last_run_at: job.lastRunAt,
        last_attempt_at: job.lastAttemptAt,
        last_effective_run_at: job.lastEffectiveRunAt,
        duration: job.lastDuration,
        summary: job.summary,
      },
    }
  })
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
    ts: dataQualityEventTimestamp(check, input.generatedAt),
    severity: dataQualitySeverity(check.status),
    domain: 'data_quality',
    source: 'data_quality_report',
    status: check.status,
    title: check.label,
    summary: check.summary,
    owner: 'Worker',
    impact: dataQualityImpact(check),
    next_action: dataQualityNextAction(check),
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

export function buildEventsFromValidation(input: {
  generatedAt: string
  validationPackets?: Array<Record<string, unknown>>
  sourceError?: string
}): ObservabilityEvent[] {
  if (input.sourceError) {
    return [{
      id: eventId('validation', 'validation_packet', 'unavailable'),
      ts: input.generatedAt,
      severity: 'warn',
      domain: 'validation',
      source: 'validation_packet',
      status: 'unavailable',
      title: 'Validation packet unavailable',
      summary: 'OBS could not read the latest Strategy Lab / backtest validation packet.',
      owner: 'Cloud Run',
      impact: 'Backtest, PBO, Monte Carlo, and DSR evidence may be invisible to the operator.',
      next_action: 'Check latest backtest_results.raw_results and /backtest/replay persistence.',
      runbook: 'P4/P9 validation governance',
      evidence: { error: input.sourceError },
    }]
  }

  const packets = (input.validationPackets ?? []).filter((packet) => Object.keys(packet).length > 0)
  if (!packets.length) {
    return [{
      id: eventId('validation', 'validation_packet', 'stable'),
      ts: input.generatedAt,
      severity: 'ok',
      domain: 'validation',
      source: 'validation_packet',
      status: 'ok',
      title: 'Validation governance quiet',
      summary: 'No latest validation packet is attached to the visible backtest row.',
      owner: 'Cloud Run',
      impact: 'No active validation failure is visible, but promotion should still require model_pool gates.',
      next_action: 'Run or persist /backtest/replay with validation_packet before promotion review.',
      runbook: 'P4/P9 validation governance',
      evidence: {},
    }]
  }

  return packets.slice(0, 6).map((packet, index) => {
    const decision = String(packet.decision ?? 'UNKNOWN').toUpperCase()
    const failedGates = Array.isArray(packet.failed_gates)
      ? packet.failed_gates.map(String)
      : []
    const warnings = Array.isArray(packet.warnings)
      ? packet.warnings.map(String)
      : []
    return {
      id: eventId('validation', 'validation_packet', String(packet.source ?? index)),
      ts: input.generatedAt,
      severity: validationSeverity(decision),
      domain: 'validation',
      source: 'validation_packet',
      status: decision.toLowerCase(),
      title: `Validation ${decision}`,
      summary: failedGates.length
        ? `Failed gates: ${failedGates.join(', ')}`
        : warnings.length
          ? `Warnings: ${warnings.join(', ')}`
          : 'Validation packet passed current governance gates.',
      owner: 'Cloud Run',
      impact: failedGates.length
        ? 'Strategy promotion or production confidence must be blocked until evidence is fixed.'
        : 'Validation evidence is visible for Strategy Lab and promotion review.',
      next_action: failedGates.length
        ? 'Open Strategy Lab/backtest replay evidence, inspect failed gates, then rerun validation.'
        : 'Keep validation packet attached to Strategy Lab and model_pool promote-check.',
      runbook: 'P4/P9 validation governance',
      evidence: {
        source: packet.source,
        decision,
        failed_gates: failedGates,
        warnings,
        gates: packet.gates,
        validation_scope: packet.validation_scope,
      },
    }
  })
}

export function buildEventsFromAdaptiveMeta(input: {
  generatedAt: string
  params?: Record<string, unknown>
  sourceError?: string
}): ObservabilityEvent[] {
  if (input.sourceError) {
    return [{
      id: eventId('adaptive_meta', 'adaptive_params', 'unavailable'),
      ts: input.generatedAt,
      severity: 'warn',
      domain: 'adaptive_meta',
      source: 'adaptive_params',
      status: 'unavailable',
      title: 'Adaptive params unavailable',
      summary: 'OBS could not read effective regime-aware adaptive params.',
      owner: 'Adaptive Meta Layer',
      impact: 'Screener, morning setup, and ML runtime may use fallback adaptive deltas.',
      next_action: 'Check Worker KV ml:adaptive_params, market_regime_state, and risk-assess scheduler.',
      runbook: 'P8 adaptive meta layer contract',
      evidence: { error: input.sourceError },
    }]
  }

  const params = input.params ?? {}
  const provenance = params.provenance as Record<string, unknown> | undefined
  const metaLayer = params.meta_layer as Record<string, unknown> | undefined
  const severity = adaptiveMetaSeverity(params)
  const source = String(provenance?.source ?? 'unknown')
  const regime = String(provenance?.regime ?? 'unknown')
  const fallback = provenance?.fallback === true
  const alphaCount = Array.isArray(metaLayer?.alpha_vote_models) ? metaLayer.alpha_vote_models.length : 0
  const overlays = Array.isArray(metaLayer?.state_space_overlays) ? metaLayer.state_space_overlays.map(String) : []
  const optimizers = Array.isArray(metaLayer?.meta_optimizers) ? metaLayer.meta_optimizers.map(String) : []

  return [{
    id: eventId('adaptive_meta', 'adaptive_params', 'effective'),
    ts: input.generatedAt,
    severity,
    domain: 'adaptive_meta',
    source: 'adaptive_params',
    status: severity === 'ok' ? 'ok' : fallback ? 'fallback' : 'incomplete',
    title: 'Adaptive meta layer',
    summary: fallback
      ? `Adaptive params are fallback or legacy (source=${source}, regime=${regime}).`
      : `Adaptive params resolved for regime=${regime}; alpha voters=${alphaCount}, overlays=${overlays.join(', ') || 'none'}.`,
    owner: 'Adaptive Meta Layer',
    impact: fallback
      ? 'Regime-aware thresholds and LinUCB protection may not be active until risk-assess refreshes KV.'
      : 'Screener, ML runtime, and morning setup share the same effective adaptive contract.',
    next_action: fallback
      ? 'Run adaptive update after verify or inspect /api/admin/adaptive-params for missing v2 provenance.'
      : 'Keep risk-assess, regime push, and payload_builder contract tests green.',
    runbook: 'P8 adaptive meta layer contract',
    evidence: {
      provenance,
      confidence_delta: params.confidence_delta,
      threshold_components: params.threshold_components,
      bandit_max_mult: params.bandit_max_mult,
      bandit_context: params.bandit_context,
      screener: params.screener,
      regime_overrides: params.regime_overrides,
      meta_layer: {
        alpha_vote_count: alphaCount,
        state_space_overlays: overlays,
        meta_optimizers: optimizers,
        adaptive_components: metaLayer?.adaptive_components,
        immutable_risk_boundaries: metaLayer?.immutable_risk_boundaries,
      },
    },
  }]
}

export function buildEventsFromGaOptimizer(input: {
  generatedAt: string
  state?: Record<string, unknown> | null
  sourceError?: string
}): ObservabilityEvent[] {
  if (input.sourceError) {
    return [{
      id: eventId('adaptive_meta', 'ga_optimizer', 'unavailable'),
      ts: input.generatedAt,
      severity: 'warn',
      domain: 'adaptive_meta',
      source: 'ga_optimizer',
      status: 'unavailable',
      title: 'GA optimizer unavailable',
      summary: 'OBS could not read optimizer:ga:latest.',
      owner: 'Adaptive Meta Layer',
      impact: 'GA production learning evidence is not visible; promotion should remain blocked.',
      next_action: 'Inspect Worker KV optimizer:ga:latest and the /optuna/ga_optimizer push path.',
      runbook: 'P8 GA production learning ladder',
      evidence: { error: input.sourceError },
    }]
  }

  const state = input.state
  if (!state) {
    return [{
      id: eventId('adaptive_meta', 'ga_optimizer', 'not_initialized'),
      ts: input.generatedAt,
      severity: 'warn',
      domain: 'adaptive_meta',
      source: 'ga_optimizer',
      status: 'not_initialized',
      title: 'GA optimizer not initialized',
      summary: 'optimizer:ga:latest is missing; GA is not yet learning in production.',
      owner: 'Adaptive Meta Layer',
      impact: 'GA learned policy candidates cannot influence promotion review until the learning loop writes evidence.',
      next_action: 'Run /optuna/ga_optimizer with push_kv after validation inputs are ready.',
      runbook: 'P8 GA production learning ladder',
      evidence: { latest_key: 'optimizer:ga:latest' },
    }]
  }

  const storedPromotion = state.promotion as Record<string, unknown> | undefined
  const evaluatedPromotion = evaluateGaPromotion(state as Record<string, any>)
  const promotion = {
    ...(storedPromotion ?? {}),
    ...evaluatedPromotion,
    level: storedPromotion?.level ?? evaluatedPromotion.level,
    status: storedPromotion?.status ?? evaluatedPromotion.status,
  } as Record<string, unknown>
  const level = String(promotion?.level ?? 'L0')
  const status = String(promotion?.status ?? state.status ?? 'learning')
  const approvalRequired = promotion?.approvalRequiredForNextLevel === true
  const canRequestNextLevel = promotion?.canRequestNextLevel === true
  const pendingApprovalLevel = promotion?.pendingApprovalLevel
  const missingEvidence = Array.isArray(promotion?.missingEvidence) ? promotion.missingEvidence.map(String) : []
  const best = state.best as Record<string, unknown> | undefined
  const gate = best?.gate as Record<string, unknown> | undefined
  const failed = Array.isArray(gate?.failed_gates) ? gate.failed_gates.map(String) : []
  const history = Array.isArray(state.history) ? state.history as Array<Record<string, unknown>> : []
  const bestCandidate = best?.candidate as Record<string, unknown> | undefined
  const candidateParams = bestCandidate?.params as Record<string, unknown> | undefined
  const learnedAlphaFramework =
    state.best_alphaFramework ??
    state.bestAlphaFramework ??
    candidateParams?.alphaFramework ??
    null
  const metrics = best?.metrics as Record<string, unknown> | undefined
  const contract = state.contract as Record<string, unknown> | undefined
  const meta = state.meta as Record<string, unknown> | undefined
  const severity: ObservabilitySeverity = failed.length || status === 'approval_required'
    ? 'warn'
    : level === 'L0'
      ? 'info'
      : canRequestNextLevel || approvalRequired
        ? 'warn'
        : 'ok'

  return [{
    id: eventId('adaptive_meta', 'ga_optimizer', level.toLowerCase()),
    ts: String(state.updated_at ?? input.generatedAt),
    severity,
    domain: 'adaptive_meta',
    source: 'ga_optimizer',
    status,
    title: `GA optimizer ${level}`,
    summary: `GA production learning is ${status}; level=${level}, next=${promotion?.nextLevel ?? 'none'}, ready_for_l3=${canRequestNextLevel ? 'yes' : 'no'}, approval=${approvalRequired ? 'required' : 'not required'}.`,
    owner: 'Adaptive Meta Layer',
    impact: approvalRequired
      ? 'Learned candidate is ready for the next production ladder step, but trading:config remains unchanged until Wei approval.'
      : 'GA learning evidence is visible without mutating trading:config.',
    next_action: String(promotion?.nextAction ?? (
      pendingApprovalLevel
        ? `Approve or reject pending ${pendingApprovalLevel} request after reviewing GA evidence.`
        : canRequestNextLevel
          ? 'Request Wei L3 approval after reviewing GA fitness, PBO/MC gates, and candidate diff.'
          : missingEvidence.length
            ? `Collect missing GA evidence: ${missingEvidence.join(', ')}.`
            : 'Keep GA history and promotion evidence fresh after validation runs.'
    )),
    runbook: 'P8 GA production learning ladder',
    evidence: {
      promotion,
      production_learning_loop: state.production_learning_loop,
      mutates_trading_config: state.mutates_trading_config,
      learning_updated_at: state.updated_at ?? input.generatedAt,
      best_score: best?.score,
      best_candidate_id: bestCandidate?.id,
      best_metrics: metrics,
      learned_alpha_framework: learnedAlphaFramework,
      population_size: state.population_size ?? meta?.population_size,
      generations: state.generations ?? meta?.generations,
      run_population_size: state.population_size ?? meta?.population_size,
      run_generations: state.generations ?? meta?.generations,
      ranked_count: Array.isArray(state.ranked) ? state.ranked.length : undefined,
      history_count: history.length,
      cadence_hint: 'weekly=small GA sweep; monthly=larger GA sweep',
      contract,
      gate,
      failed_gates: failed,
      history_tail: history.slice(-3),
    },
  }]
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
  validationPackets?: Array<Record<string, unknown>>
  validationError?: string
  adaptiveParams?: Record<string, unknown>
  adaptiveError?: string
  gaOptimizerState?: Record<string, unknown> | null
  gaOptimizerError?: string
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
    ...buildEventsFromValidation({
      generatedAt: input.generatedAt,
      validationPackets: input.validationPackets,
      sourceError: input.validationError,
    }),
    ...buildEventsFromAdaptiveMeta({
      generatedAt: input.generatedAt,
      params: input.adaptiveParams,
      sourceError: input.adaptiveError,
    }),
    ...buildEventsFromGaOptimizer({
      generatedAt: input.generatedAt,
      state: input.gaOptimizerState,
      sourceError: input.gaOptimizerError,
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

function extractValidationPacketFromBacktestRow(row: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  const raw = safeJsonParse(row?.raw_results)
  const packet = raw.validation_packet
  return packet && typeof packet === 'object' ? packet as Record<string, unknown> : null
}

async function readLatestValidationPackets(env: Bindings): Promise<{
  packets: Array<Record<string, unknown>>
  error?: string
}> {
  try {
    const row = await env.DB.prepare(`
      SELECT raw_results
        FROM backtest_results
       WHERE raw_results IS NOT NULL
       ORDER BY run_date DESC, created_at DESC
       LIMIT 1
    `).first<Record<string, unknown>>()
    const packet = extractValidationPacketFromBacktestRow(row)
    return { packets: packet ? [packet] : [] }
  } catch (error) {
    return { packets: [], error: String(error) }
  }
}

async function readLinUcbLedgerSummary(env: Bindings): Promise<Record<string, unknown>> {
  try {
    const row = await env.DB.prepare(`
      SELECT COUNT(*) AS ledger_rows,
             COUNT(DISTINCT arm_id) AS arm_count,
             COALESCE(SUM(samples), 0) AS total_samples,
             MAX(updated_at) AS updated_at
        FROM meta_reward_ledger
       WHERE policy_id = 'LinUCB'
    `).first<Record<string, unknown>>()
    return {
      reward_ledger: 'meta_reward_ledger',
      reward_ledger_status: Number(row?.total_samples ?? 0) > 0 ? 'updated' : 'missing',
      ledger_rows: Number(row?.ledger_rows ?? 0),
      total_samples: Number(row?.total_samples ?? 0),
      arm_count: Number(row?.arm_count ?? 0),
      updated_at: row?.updated_at ?? null,
      context_version: 'meta-context-v2',
      source: 'd1_meta_reward_ledger',
    }
  } catch (error) {
    return {
      reward_ledger: 'meta_reward_ledger',
      reward_ledger_status: 'degraded',
      error: String(error),
      context_version: 'meta-context-v2',
      source: 'd1_meta_reward_ledger',
    }
  }
}

function mergeLinUcbLedgerEvidence(
  params: Record<string, unknown> | undefined,
  ledgerSummary: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!params) return params
  const banditContext = params.bandit_context && typeof params.bandit_context === 'object' && !Array.isArray(params.bandit_context)
    ? params.bandit_context as Record<string, unknown>
    : {}
  const existingLedger = banditContext.linucb_reward_ledger && typeof banditContext.linucb_reward_ledger === 'object'
    ? banditContext.linucb_reward_ledger as Record<string, unknown>
    : {}
  const existingSamples = Number(existingLedger.total_samples ?? existingLedger.source_rows ?? 0)
  const d1Samples = Number(ledgerSummary.total_samples ?? 0)
  if (existingSamples > 0 || d1Samples <= 0) {
    return {
      ...params,
      bandit_context: {
        ...banditContext,
        linucb_reward_ledger: existingSamples > 0 ? existingLedger : ledgerSummary,
      },
    }
  }
  return {
    ...params,
    bandit_context: {
      ...banditContext,
      linucb_reward_ledger: ledgerSummary,
    },
  }
}

export async function buildLiveObservabilityEventReport(env: Bindings, options: { date?: string; live?: boolean } = {}) {
  const date = options.date ?? twToday()
  const generatedAt = new Date().toISOString()

  const [scheduler, dataQuality, deployGate, modelPoolResult, validationResult, adaptiveResult, gaOptimizerResult, linucbLedgerSummary] = await Promise.all([
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
    readLatestValidationPackets(env),
    import('./adaptiveConfig')
      .then(({ getAdaptiveParamsForRegime }) => getAdaptiveParamsForRegime(env.KV))
      .then((params) => ({ params: params as unknown as Record<string, unknown> }))
      .catch((error: unknown) => ({ error: String(error) })),
    env.KV.get('optimizer:ga:latest', 'json')
      .then((state) => ({ state: state as Record<string, unknown> | null }))
      .catch((error: unknown) => ({ error: String(error) })),
    readLinUcbLedgerSummary(env),
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
    validationPackets: validationResult.packets,
    validationError: validationResult.error,
    adaptiveParams: 'params' in adaptiveResult ? mergeLinUcbLedgerEvidence(adaptiveResult.params, linucbLedgerSummary) : undefined,
    adaptiveError: 'error' in adaptiveResult ? adaptiveResult.error : undefined,
    gaOptimizerState: 'state' in gaOptimizerResult ? gaOptimizerResult.state : undefined,
    gaOptimizerError: 'error' in gaOptimizerResult ? gaOptimizerResult.error : undefined,
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

  return mapObservabilityAuditRows(results ?? [])
}

export async function listObservabilityAuditEventsByIds(
  env: Bindings,
  eventIds: string[],
  options: { limit?: number } = {},
): Promise<ObservabilityAuditRow[]> {
  const ids = [...new Set(eventIds.map((id) => id.trim()).filter(Boolean))].slice(0, 40)
  if (ids.length === 0) return []
  const limit = Math.max(1, Math.min(Number(options.limit ?? 200), 500))
  const placeholders = ids.map(() => '?').join(', ')
  const { results } = await env.DB.prepare(`
    SELECT event_id, date, severity, domain, source, status, title, summary,
           owner, impact, next_action, evidence, created_at
      FROM observability_events
     WHERE event_id IN (${placeholders})
     ORDER BY created_at ASC
     LIMIT ?
  `).bind(...ids, limit).all<Record<string, unknown>>()

  return mapObservabilityAuditRows(results ?? [])
}

function mapObservabilityAuditRows(rows: Record<string, unknown>[]): ObservabilityAuditRow[] {
  return rows.map((row) => ({
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
