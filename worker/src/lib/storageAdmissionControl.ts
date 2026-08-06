import type { Bindings } from '../types'

const D1_MAX_BYTES = 10_000_000_000
const DRAIN_UTILIZATION_PCT = 75
const CRITICAL_UTILIZATION_PCT = 85

const DRAIN_BLOCKED_TASKS = new Set([
  'weekly-optuna',
  'monthly-optuna',
  'monthly-strategy-mining',
  'optuna-queue',
  'finlab-v4-backfill',
  's12-research-recovery',
  's12-replay-backfill',
  'adaptive-meta-policy-replay',
  'linucb-multiplier-replay',
  'neural-ucb-shadow',
  'neural-ts-shadow',
  'neucb-shadow',
])

const CRITICAL_BLOCKED_TASKS = new Set([
  ...DRAIN_BLOCKED_TASKS,
  'weekly-drift-retrain',
  'monthly-retrain',
  'active8-oof-weekly',
  'active8-oof-monthly',
  'retrain',
  'l4-alpha-ev-refresh',
  'allocator-ev-fusion-refresh',
  'opb-arm-prior-refresh',
  'monthly-l4-alpha-ev-refresh',
  'monthly-allocator-ev-fusion-refresh',
  'monthly-opb-arm-prior-refresh',
])

export interface StorageAdmissionDecision {
  allowed: boolean
  managed: boolean
  task: string
  utilizationPct: number | null
  status: 'healthy' | 'warning' | 'drain' | 'critical' | 'unknown'
  reason: string
}

export function isStorageAdmissionManagedTask(task: string): boolean {
  return CRITICAL_BLOCKED_TASKS.has(task)
}

export function classifyStorageAdmission(
  task: string,
  utilizationPct: number | null,
): StorageAdmissionDecision {
  const managed = isStorageAdmissionManagedTask(task)
  if (!managed) {
    return { allowed: true, managed, task, utilizationPct, status: 'healthy', reason: 'trading_or_maintenance_path_exempt' }
  }
  if (utilizationPct == null || !Number.isFinite(utilizationPct)) {
    return { allowed: false, managed, task, utilizationPct: null, status: 'unknown', reason: 'legacy_d1_capacity_unknown' }
  }
  if (utilizationPct >= CRITICAL_UTILIZATION_PCT) {
    return {
      allowed: !CRITICAL_BLOCKED_TASKS.has(task), managed, task, utilizationPct, status: 'critical',
      reason: CRITICAL_BLOCKED_TASKS.has(task) ? 'critical_blocks_high_write_producer' : 'critical_exempt',
    }
  }
  if (utilizationPct >= DRAIN_UTILIZATION_PCT) {
    return {
      allowed: !DRAIN_BLOCKED_TASKS.has(task), managed, task, utilizationPct, status: 'drain',
      reason: DRAIN_BLOCKED_TASKS.has(task) ? 'drain_blocks_expansion_or_research_write' : 'drain_allows_guarded_model_refresh',
    }
  }
  return {
    allowed: true, managed, task, utilizationPct,
    status: utilizationPct >= 65 ? 'warning' : 'healthy',
    reason: 'capacity_available',
  }
}

export async function inspectStorageAdmission(
  env: Pick<Bindings, 'DB'>,
  task: string,
): Promise<StorageAdmissionDecision> {
  if (!isStorageAdmissionManagedTask(task)) return classifyStorageAdmission(task, 0)
  try {
    const probe = await env.DB.prepare('SELECT 1 AS storage_admission_probe').all()
    const usedBytes = Number(probe.meta?.size_after)
    const utilizationPct = Number.isFinite(usedBytes) && usedBytes >= 0
      ? Number(((usedBytes / D1_MAX_BYTES) * 100).toFixed(4))
      : null
    return classifyStorageAdmission(task, utilizationPct)
  } catch {
    return classifyStorageAdmission(task, null)
  }
}
