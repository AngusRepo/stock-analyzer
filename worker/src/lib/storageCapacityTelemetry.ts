import type { Bindings } from '../types'
import { databaseForDataDomain, type DataDomain } from './dataDomainRegistry'

const D1_MAX_BYTES = 10_000_000_000

export type StorageCapacityStatus = 'healthy' | 'warning' | 'drain' | 'critical'

export type StorageCapacityRow = {
  domain: DataDomain | 'legacy'
  binding_name: string
  used_bytes: number
  max_bytes: number
  utilization_pct: number
  status: StorageCapacityStatus
}

function capacityStatus(utilizationPct: number): StorageCapacityStatus {
  if (utilizationPct >= 85) return 'critical'
  if (utilizationPct >= 75) return 'drain'
  if (utilizationPct >= 65) return 'warning'
  return 'healthy'
}

async function inspectBinding(
  domain: StorageCapacityRow['domain'],
  bindingName: string,
  db: D1Database,
): Promise<StorageCapacityRow> {
  const probe = await db.prepare('SELECT 1 AS storage_capacity_probe').all()
  const sizeAfter = Number(probe.meta?.size_after)
  if (!Number.isFinite(sizeAfter) || sizeAfter < 0) {
    throw new Error(`d1_capacity_size_unknown:${domain}:${bindingName}`)
  }
  // Worker D1 bindings expose authoritative database bytes through query
  // result metadata; prepared PRAGMA page counters are not supported.
  const usedBytes = sizeAfter
  const utilizationPct = Number(((usedBytes / D1_MAX_BYTES) * 100).toFixed(4))
  return {
    domain, binding_name: bindingName,
    used_bytes: usedBytes, max_bytes: D1_MAX_BYTES, utilization_pct: utilizationPct,
    status: capacityStatus(utilizationPct),
  }
}

export async function inspectStorageCapacityTelemetry(
  env: Pick<Bindings, 'DB'> & Partial<Bindings>,
): Promise<StorageCapacityRow[]> {
  const sources: Array<{ domain: StorageCapacityRow['domain']; binding: string; db: D1Database }> = [
    { domain: 'legacy', binding: 'DB', db: env.DB },
  ]
  const optional: Array<[DataDomain, keyof Bindings]> = [
    ['core', 'CORE_DB'], ['market', 'MARKET_DB'], ['learning', 'LEARNING_DB'],
    ['ops', 'OPS_DB'], ['execution', 'EXECUTION_DB'], ['paper', 'PAPER_DB'],
    ['research', 'RESEARCH_DB'],
  ]
  for (const [domain, binding] of optional) {
    const db = env[binding] as D1Database | undefined
    if (db) sources.push({ domain, binding: String(binding), db })
  }
  return Promise.all(
    sources.map((source) => inspectBinding(source.domain, source.binding, source.db)),
  )
}

export async function collectStorageCapacityTelemetry(
  env: Pick<Bindings, 'DB'> & Partial<Bindings>,
  observedDate: string,
): Promise<StorageCapacityRow[]> {
  const rows = await inspectStorageCapacityTelemetry(env)
  const opsDb = databaseForDataDomain(env, 'ops')
  const statements = rows.map((row) => opsDb.prepare(`
    INSERT INTO storage_capacity_daily (
      observed_date, domain, binding_name, used_bytes, max_bytes,
      utilization_pct, status, measurement_source, observed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'd1_result_meta_size_after', CURRENT_TIMESTAMP)
    ON CONFLICT(observed_date, domain, binding_name) DO UPDATE SET
      used_bytes=excluded.used_bytes, max_bytes=excluded.max_bytes,
      utilization_pct=excluded.utilization_pct, status=excluded.status,
      measurement_source=excluded.measurement_source, observed_at=CURRENT_TIMESTAMP
  `).bind(
    observedDate, row.domain, row.binding_name, row.used_bytes,
    row.max_bytes, row.utilization_pct, row.status,
  ))
  if (statements.length) await opsDb.batch(statements)
  return rows
}

export function assertCapacityBelowCritical(rows: StorageCapacityRow[]): void {
  const critical = rows.filter((row) => row.status === 'critical')
  if (critical.length) {
    throw new Error(`d1_capacity_critical:${critical.map((row) => `${row.domain}=${row.utilization_pct}%`).join(',')}`)
  }
}

export type StorageCapacityHistoryPoint = {
  observed_date: string
  used_bytes: number
}

export type StorageCapacityGrowthEstimate = {
  status: 'ready' | 'awaiting_post_cutover_observations'
  baseline_after: string | null
  observation_count: number
  required_observations: number
  daily_growth_bytes: number | null
  projected_days_to_warning_65pct: number | null
  projected_days_to_max: number | null
}

function median(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1] + sorted[middle]) / 2)
    : Math.round(sorted[middle])
}

export function buildStorageCapacityGrowthEstimate(input: {
  currentUsedBytes: number
  maxBytes?: number
  history: readonly StorageCapacityHistoryPoint[]
  baselineAfter?: string | null
  requiredObservations?: number
}): StorageCapacityGrowthEstimate {
  const maxBytes = input.maxBytes ?? D1_MAX_BYTES
  const requiredObservations = Math.max(3, input.requiredObservations ?? 7)
  const baselineAfter = String(input.baselineAfter ?? '').slice(0, 10) || null
  const byDate = new Map<string, number>()
  for (const point of input.history) {
    const observedDate = String(point.observed_date ?? '').slice(0, 10)
    const usedBytes = Number(point.used_bytes)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(observedDate) || !Number.isFinite(usedBytes)) continue
    if (baselineAfter && observedDate <= baselineAfter) continue
    byDate.set(observedDate, usedBytes)
  }
  const points = [...byDate.entries()]
    .map(([observed_date, used_bytes]) => ({ observed_date, used_bytes }))
    .sort((a, b) => a.observed_date.localeCompare(b.observed_date))
  if (points.length < requiredObservations) {
    return {
      status: 'awaiting_post_cutover_observations',
      baseline_after: baselineAfter,
      observation_count: points.length,
      required_observations: requiredObservations,
      daily_growth_bytes: null,
      projected_days_to_warning_65pct: null,
      projected_days_to_max: null,
    }
  }
  const dailyDeltas: number[] = []
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]
    const current = points[index]
    const elapsedDays = Math.round(
      (Date.parse(`${current.observed_date}T00:00:00Z`) - Date.parse(`${previous.observed_date}T00:00:00Z`))
      / 86_400_000,
    )
    if (elapsedDays > 0) dailyDeltas.push((current.used_bytes - previous.used_bytes) / elapsedDays)
  }
  const dailyGrowthBytes = median(dailyDeltas)
  const projected = (limitBytes: number) => dailyGrowthBytes != null && dailyGrowthBytes > 0
    ? Math.max(0, Math.floor((limitBytes - input.currentUsedBytes) / dailyGrowthBytes))
    : null
  return {
    status: 'ready',
    baseline_after: baselineAfter,
    observation_count: points.length,
    required_observations: requiredObservations,
    daily_growth_bytes: dailyGrowthBytes,
    projected_days_to_warning_65pct: projected(maxBytes * 0.65),
    projected_days_to_max: projected(maxBytes),
  }
}
