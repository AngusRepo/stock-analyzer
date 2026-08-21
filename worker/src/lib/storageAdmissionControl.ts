import type { Bindings } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'

const D1_MAX_BYTES = 10_000_000_000
const DRAIN_UTILIZATION_PCT = 75
const CRITICAL_UTILIZATION_PCT = 85

const DRAIN_BLOCKED_TASKS = new Set([
  'weekly-optuna',
  'weekly-backtest',
  'monte-carlo',
  'pbo',
  'allocator-ev-feature-snapshot-backfill',
  'selection-reference-repair',
  'selection-reference-identity-repair',
  's12-smcvwap-calibration',
  'legacy-evidence-migration',
  'legacy-strategy-evidence-migration',
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
  'strategy-learning',
  'strategy-learning-finalize',
  'external-evidence',
  'active8-oof-lifecycle',
  'active8-oof-daily',
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

const LEARNING_OWNER_CAPACITY_TASKS = new Set([
  'weekly-backtest',
  'monte-carlo',
  'pbo',
  'allocator-ev-feature-snapshot-backfill',
  'selection-reference-repair',
  'selection-reference-identity-repair',
  's12-smcvwap-calibration',
  'legacy-strategy-evidence-migration',
  's12-research-recovery',
  's12-replay-backfill',
  'adaptive-meta-policy-replay',
  'linucb-multiplier-replay',
  'neural-ucb-shadow',
  'neural-ts-shadow',
  'neucb-shadow',
  'weekly-drift-retrain',
  'strategy-learning',
  'strategy-learning-finalize',
  'active8-oof-lifecycle',
  'active8-oof-daily',
  'active8-oof-weekly',
  'active8-oof-monthly',
  'monthly-retrain',
  'retrain',
  'l4-alpha-ev-refresh',
  'allocator-ev-fusion-refresh',
  'opb-arm-prior-refresh',
  'monthly-l4-alpha-ev-refresh',
  'monthly-allocator-ev-fusion-refresh',
  'monthly-opb-arm-prior-refresh',
])

export function storageAdmissionOwner(task: string): 'legacy' | 'learning' {
  return LEARNING_OWNER_CAPACITY_TASKS.has(task) ? 'learning' : 'legacy'
}

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
  if (utilizationPct == null || !Number.isFinite(utilizationPct)) {
    return {
      allowed: !managed,
      managed,
      task,
      utilizationPct: null,
      status: 'unknown',
      reason: managed ? 'legacy_d1_capacity_unknown' : 'legacy_d1_capacity_unknown_exempt',
    }
  }
  if (utilizationPct >= CRITICAL_UTILIZATION_PCT) {
    return {
      allowed: !managed,
      managed,
      task,
      utilizationPct,
      status: 'critical',
      reason: managed ? 'critical_blocks_high_write_producer' : 'critical_exempt_trading_or_capacity_reducing_path',
    }
  }
  if (utilizationPct >= DRAIN_UTILIZATION_PCT) {
    const drainBlocked = DRAIN_BLOCKED_TASKS.has(task)
    return {
      allowed: !drainBlocked,
      managed,
      task,
      utilizationPct,
      status: 'drain',
      reason: drainBlocked
        ? 'drain_blocks_expansion_or_research_write'
        : managed
          ? 'drain_allows_guarded_model_refresh'
          : 'drain_exempt_trading_or_capacity_reducing_path',
    }
  }
  return {
    allowed: true,
    managed,
    task,
    utilizationPct,
    status: utilizationPct >= 65 ? 'warning' : 'healthy',
    reason: managed ? 'capacity_available' : 'capacity_available_exempt',
  }
}

export async function inspectStorageAdmission(
  env: Pick<Bindings, 'DB'> & Partial<Bindings>,
  task: string,
): Promise<StorageAdmissionDecision> {
  try {
    const db = storageAdmissionOwner(task) === 'learning'
      ? databaseForDataDomain(env, 'learning')
      : env.DB
    const probe = await db.prepare('SELECT 1 AS storage_admission_probe').all()
    const usedBytes = Number(probe.meta?.size_after)
    const utilizationPct = Number.isFinite(usedBytes) && usedBytes >= 0
      ? Number(((usedBytes / D1_MAX_BYTES) * 100).toFixed(4))
      : null
    return classifyStorageAdmission(task, utilizationPct)
  } catch {
    return classifyStorageAdmission(task, null)
  }
}
