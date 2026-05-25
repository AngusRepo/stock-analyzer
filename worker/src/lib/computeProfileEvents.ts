import type { Bindings } from '../types'

export interface ComputeProfileEventInput {
  eventDate?: string | null
  provider?: string | null
  jobName?: string | null
  runId?: string | null
  profile: Record<string, unknown>
}

export interface NormalizedComputeProfileEvent {
  eventDate: string
  provider: string
  jobName: string
  runId: string | null
  wallSec: number | null
  computeSec: number | null
  awaitSec: number | null
  computeOwner: string | null
  remoteFunction: string | null
  cpu: number | null
  memoryMb: number | null
  gpu: string | null
  estUsd: number | null
  rows: number | null
  features: number | null
  symbols: number | null
  trials: number | null
  cacheHitRatio: number | null
  profileJson: string
}

export interface NormalizedComputeEfficiencyReportEvent {
  reportDate: string
  jobName: string
  decision: string
  baselineProfileJson: string
  optimizedProfileJson: string
  qualityJson: string
  efficiencyJson: string
  reportJson: string
}

export interface WorkerTaskComputeProfileInput {
  task: string
  status: string
  durationMs: number
  runDate?: string | null
  runId?: string | null
  chain?: string | null
}

export interface SchedulerCallbackComputeProfileInput {
  task: string
  status: string
  durationMs: number
  runDate?: string | null
  runId?: string | null
  metadata?: Record<string, unknown> | null
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function nullableInteger(value: unknown): number | null {
  const numeric = nullableNumber(value)
  return numeric == null ? null : Math.trunc(numeric)
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function statusShouldEmitComputeProfile(status: string): boolean {
  return status !== 'triggered' && status !== 'running'
}

function normalizeCallbackProvider(task: string, metadata: Record<string, unknown>): string {
  const raw = String(metadata.provider ?? metadata.executor ?? metadata.compute_provider ?? '').trim().toLowerCase()
  if (raw === 'modal' || raw === 'modal_spawn' || raw.startsWith('modal_')) return 'modal'
  if (raw.includes('cloud_run') || raw === 'gcp') return 'gcp_cloud_run'

  const owner = String(metadata.compute_owner ?? '').trim().toLowerCase()
  if (owner.includes('modal')) return 'modal'
  if (owner.includes('cloud_run') || owner.includes('gcp')) return 'gcp_cloud_run'

  if (task === 'pipeline' || task === 'verify-v2') return 'gcp_cloud_run'
  return 'scheduler_callback'
}

function secondsFromMs(durationMs: number): number {
  return Math.round(Math.max(0, durationMs) * 1000) / 1_000_000
}

function encodeJson(value: unknown): string {
  return JSON.stringify(value ?? null)
}

function dateFrom(value: unknown): string {
  if (typeof value === 'string' && value.length >= 10) return value.slice(0, 10)
  return new Date().toISOString().slice(0, 10)
}

function isMissingTableError(error: unknown): boolean {
  return /no such table/i.test(String(error))
}

function isMissingOptionalProfileColumnError(error: unknown): boolean {
  const message = String(error)
  return (
    /no such column/i.test(message) ||
    /has no column named/i.test(message) ||
    /table compute_profile_events has no column/i.test(message)
  )
}

async function runSafely(action: () => Promise<unknown>, label: string): Promise<void> {
  try {
    await action()
  } catch (error) {
    if (!isMissingTableError(error)) {
      console.warn(`[ComputeProfileEvents] ${label} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

function computeProfileInsertSql(includeWaitColumns: boolean): string {
  const waitColumns = includeWaitColumns ? ' await_sec, compute_owner, remote_function,' : ''
  const waitPlaceholders = includeWaitColumns ? ' ?, ?, ?,' : ''
  return `
    INSERT INTO compute_profile_events
      (event_date, provider, job_name, run_id, wall_sec, compute_sec,${waitColumns} cpu, memory_mb,
       gpu, est_usd, rows, features, symbols, trials, cache_hit_ratio, profile_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?,${waitPlaceholders} ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `
}

function computeProfileInsertParams(
  event: NormalizedComputeProfileEvent,
  includeWaitColumns: boolean,
): unknown[] {
  const base = [
    event.eventDate,
    event.provider,
    event.jobName,
    event.runId,
    event.wallSec,
    event.computeSec,
  ]
  if (includeWaitColumns) {
    base.push(event.awaitSec, event.computeOwner, event.remoteFunction)
  }
  base.push(
    event.cpu,
    event.memoryMb,
    event.gpu,
    event.estUsd,
    event.rows,
    event.features,
    event.symbols,
    event.trials,
    event.cacheHitRatio,
    event.profileJson,
  )
  return base
}

async function insertComputeProfileEvent(
  env: Pick<Bindings, 'DB'>,
  event: NormalizedComputeProfileEvent,
  includeWaitColumns: boolean,
): Promise<void> {
  await env.DB.prepare(computeProfileInsertSql(includeWaitColumns))
    .bind(...computeProfileInsertParams(event, includeWaitColumns))
    .run()
}

export function normalizeComputeProfileEvent(input: ComputeProfileEventInput): NormalizedComputeProfileEvent {
  const profile = input.profile ?? {}
  return {
    eventDate: dateFrom(input.eventDate ?? profile.event_date ?? profile.date ?? profile.generated_at),
    provider: String(input.provider ?? profile.provider ?? 'unknown'),
    jobName: String(input.jobName ?? profile.job_name ?? profile.function_name ?? profile.name ?? 'unknown'),
    runId: stringOrNull(input.runId ?? profile.run_id),
    wallSec: nullableNumber(profile.wall_sec ?? profile.duration_sec ?? profile.elapsed_sec),
    computeSec: nullableNumber(profile.compute_sec),
    awaitSec: nullableNumber(profile.await_sec ?? profile.orchestration_await_sec ?? profile.remote_wait_sec),
    computeOwner: stringOrNull(profile.compute_owner ?? profile.provider),
    remoteFunction: stringOrNull(profile.remote_function ?? profile.function_name),
    cpu: nullableNumber(profile.cpu),
    memoryMb: nullableInteger(profile.memory_mb ?? profile.memoryMiB ?? profile.memory),
    gpu: stringOrNull(profile.gpu),
    estUsd: nullableNumber(profile.est_usd),
    rows: nullableInteger(profile.rows),
    features: nullableInteger(profile.features),
    symbols: nullableInteger(profile.symbols),
    trials: nullableInteger(profile.trials),
    cacheHitRatio: nullableNumber(profile.cache_hit_ratio),
    profileJson: encodeJson(profile),
  }
}

export function normalizeComputeEfficiencyReportEvent(
  report: Record<string, unknown>,
): NormalizedComputeEfficiencyReportEvent {
  return {
    reportDate: dateFrom(report.generated_at),
    jobName: String(report.job_name ?? 'unknown'),
    decision: String(report.decision ?? 'unknown'),
    baselineProfileJson: encodeJson(report.baseline),
    optimizedProfileJson: encodeJson(report.optimized),
    qualityJson: encodeJson(report.quality),
    efficiencyJson: encodeJson(report.efficiency),
    reportJson: encodeJson(report),
  }
}

export async function recordComputeProfileEvent(
  env: Pick<Bindings, 'DB'>,
  input: ComputeProfileEventInput,
): Promise<void> {
  const event = normalizeComputeProfileEvent(input)
  try {
    await insertComputeProfileEvent(env, event, true)
  } catch (error) {
    if (!isMissingOptionalProfileColumnError(error)) {
      if (!isMissingTableError(error)) {
        console.warn(`[ComputeProfileEvents] profile event insert failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      return
    }
    await runSafely(() => insertComputeProfileEvent(env, event, false), 'profile event insert legacy columns')
  }
}

export async function recordWorkerTaskComputeProfile(
  env: Pick<Bindings, 'DB'>,
  input: WorkerTaskComputeProfileInput,
): Promise<void> {
  const wallSec = secondsFromMs(input.durationMs)
  const isDispatchOnly = input.status === 'triggered' || input.status === 'running'
  await recordComputeProfileEvent(env, {
    eventDate: input.runDate ?? undefined,
    provider: 'cloudflare_worker',
    jobName: input.task,
    runId: input.runId ?? null,
    profile: {
      provider: 'cloudflare_worker',
      job_name: input.task,
      run_id: input.runId ?? null,
      wall_sec: wallSec,
      compute_sec: isDispatchOnly ? 0 : wallSec,
      await_sec: isDispatchOnly ? wallSec : null,
      compute_owner: isDispatchOnly ? 'orchestration_dispatch' : 'cloudflare_worker',
      remote_function: input.task,
      cpu: 1,
      status: input.status,
      chain: input.chain ?? null,
      run_date: input.runDate ?? null,
    },
  })
}

export async function recordSchedulerCallbackComputeProfile(
  env: Pick<Bindings, 'DB'>,
  input: SchedulerCallbackComputeProfileInput,
): Promise<void> {
  if (!statusShouldEmitComputeProfile(input.status)) return
  const metadata = input.metadata ?? {}
  const wallSec = secondsFromMs(input.durationMs)
  const provider = normalizeCallbackProvider(input.task, metadata)
  const jobName = stringOrNull(metadata.job_name ?? metadata.jobName ?? metadata.remote_function) ?? input.task
  const numericCpu = nullableNumber(metadata.cpu)
  const computeSec = nullableNumber(metadata.compute_sec) ?? (numericCpu == null ? undefined : wallSec * Math.max(numericCpu, 1))
  await recordComputeProfileEvent(env, {
    eventDate: input.runDate ?? undefined,
    provider,
    jobName,
    runId: input.runId ?? null,
    profile: {
      provider,
      job_name: jobName,
      scheduler_task: input.task,
      run_id: input.runId ?? null,
      run_date: input.runDate ?? null,
      status: input.status,
      wall_sec: wallSec,
      compute_sec: computeSec,
      await_sec: nullableNumber(metadata.await_sec ?? metadata.orchestration_await_sec ?? metadata.remote_wait_sec),
      compute_owner: stringOrNull(metadata.compute_owner) ?? provider,
      remote_function: stringOrNull(metadata.remote_function ?? metadata.function_name) ?? jobName,
      cpu: numericCpu,
      memory_mb: nullableInteger(metadata.memory_mb ?? metadata.memoryMiB ?? metadata.memory),
      metadata,
    },
  })
}

export async function recordComputeEfficiencyReportEvent(
  env: Pick<Bindings, 'DB'>,
  report: Record<string, unknown>,
): Promise<void> {
  const event = normalizeComputeEfficiencyReportEvent(report)
  await runSafely(() => env.DB.prepare(`
    INSERT INTO compute_efficiency_reports
      (report_date, job_name, decision, baseline_profile_json, optimized_profile_json,
       quality_json, efficiency_json, report_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).bind(
    event.reportDate,
    event.jobName,
    event.decision,
    event.baselineProfileJson,
    event.optimizedProfileJson,
    event.qualityJson,
    event.efficiencyJson,
    event.reportJson,
  ).run(), 'efficiency report insert')
}
