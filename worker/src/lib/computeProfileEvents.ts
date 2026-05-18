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

async function runSafely(action: () => Promise<unknown>, label: string): Promise<void> {
  try {
    await action()
  } catch (error) {
    if (!isMissingTableError(error)) {
      console.warn(`[ComputeProfileEvents] ${label} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
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
  await runSafely(() => env.DB.prepare(`
    INSERT INTO compute_profile_events
      (event_date, provider, job_name, run_id, wall_sec, compute_sec, cpu, memory_mb,
       gpu, est_usd, rows, features, symbols, trials, cache_hit_ratio, profile_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).bind(
    event.eventDate,
    event.provider,
    event.jobName,
    event.runId,
    event.wallSec,
    event.computeSec,
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
  ).run(), 'profile event insert')
}

export async function recordWorkerTaskComputeProfile(
  env: Pick<Bindings, 'DB'>,
  input: WorkerTaskComputeProfileInput,
): Promise<void> {
  const wallSec = Math.round(Math.max(0, input.durationMs) * 1000) / 1_000_000
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
      compute_sec: wallSec,
      cpu: 1,
      status: input.status,
      chain: input.chain ?? null,
      run_date: input.runDate ?? null,
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
