import type { Bindings } from '../types'
import type { StorageHealthResult } from './artifactLifecycle'
import { databaseForDataDomain } from './dataDomainRegistry'
import { writeSystemLog } from './notify'

export type StorageHealthSeverity = 'healthy' | 'warning' | 'unhealthy'

export type StorageHealthClassification = {
  severity: StorageHealthSeverity
  /** Live capacity domains in the drain band (75–90%) that made `healthy` false. */
  drain_domains: string[]
  /** Domains whose runway to 90% is under the alert days (only when the result reports runway). */
  runway_alert_domains: string[]
}

/** Every non-capacity gate of `healthy` in runStorageHealthCheck (artifactLifecycle.ts). The
 * storageHealthSeverity test pins that expression, so a new gate there fails until it is added here. */
function nonCapacityGatesPass(result: StorageHealthResult): boolean {
  return result.integrity_blocked === 0 && result.cleanup_backlog_over_24h === 0 && result.dlq_pending === 0
    && result.allocator_ev_snapshot_rows > 0 && result.allocator_ev_snapshot_dates > 0
    && result.allocator_snapshot_incomplete_runs === 0 && result.allocator_snapshot_staging_orphans === 0
    && result.artifact_hard_ref_drift === 0 && result.artifact_true_orphan_references === 0
    && result.domain_schema.every((row) => row.ready)
    && (result.expected_lineage_date == null || (result.canonical_execution_lineage_ready && result.paper_shadow_lineage_ready))
    && (!result.legacy_retention_stalled || result.legacy_capacity_role === 'frozen_rollback_source')
    && result.capacity_error == null && result.capacity_domains.length > 0
}

/**
 * D7a A-2 (Wei 10/28): a live domain in the drain band is a warning, not an unhealthy storage
 * check. `healthy` and producer admission are unchanged; only the scheduler outcome differs.
 * Anything else that fails `healthy` (including a non-exempt domain at >= 90%) stays unhealthy.
 */
export function classifyStorageHealth(result: StorageHealthResult): StorageHealthClassification {
  // Runway fields arrive with the D7a observation change; older results simply have none.
  const runwayAlert = (result as { capacity_runway_alert_domains?: unknown }).capacity_runway_alert_domains
  const runway_alert_domains = Array.isArray(runwayAlert) ? runwayAlert.map(String) : []
  if (result.healthy) {
    return { severity: runway_alert_domains.length ? 'warning' : 'healthy', drain_domains: [], runway_alert_domains }
  }
  const frozenLegacy = result.legacy_capacity_role === 'frozen_rollback_source'
  const judged = result.capacity_domains.filter((row) => !(row.domain === 'legacy' && frozenLegacy))
  const critical = judged.some((row) => row.status === 'critical')
  const drain_domains = [...new Set(judged.filter((row) => row.status === 'drain').map((row) => row.domain))]
  const drainOnly = !critical && drain_domains.length > 0
    && result.blocking_capacity_domains.length > 0
    && result.blocking_capacity_domains.every((domain) => drain_domains.includes(domain))
  return {
    severity: drainOnly && nonCapacityGatesPass(result) ? 'warning' : 'unhealthy',
    drain_domains,
    runway_alert_domains,
  }
}

/**
 * Scheduler outcome for a storage health result: null when unhealthy (the caller fails the run),
 * otherwise a summary prefix. A warning is written to the ops system log and console.warn.
 */
export async function reportStorageHealthSeverity(
  env: Pick<Bindings, 'DB'> & Partial<Bindings>,
  task: string,
  result: StorageHealthResult,
): Promise<string | null> {
  const health = classifyStorageHealth(result)
  if (health.severity === 'unhealthy') return null
  if (health.severity === 'healthy') return ''
  const parts = [
    health.drain_domains.length ? `capacity_drain=${health.drain_domains.join(',')}` : '',
    health.runway_alert_domains.length ? `capacity_runway_alert=${health.runway_alert_domains.join(',')}` : '',
  ].filter(Boolean)
  const message = `storage health warning ${parts.join(' ')}`
  console.warn(`[${task}] ${message}`)
  await writeSystemLog(databaseForDataDomain(env, 'ops'), 'warn', task, message, {
    drain_domains: health.drain_domains,
    runway_alert_domains: health.runway_alert_domains,
    capacity_domains: result.capacity_domains,
  })
  return `warning ${parts.join(' ')} `
}

export type StorageCapacityRunwayJudgement = {
  domain: string
  role: 'live' | 'frozen_rollback_source'
  judged: boolean
  days_to_90pct: number | null
  alert: boolean
}

export type StorageCapacityRunwaySummary = {
  alert_days: number
  alert_domains: string[]
  domains: StorageCapacityRunwayJudgement[]
}

/**
 * M4: per-database days to the 90% line for storage-capacity-report. The alert
 * decision has one owner, runStorageHealthCheck (capacity_runway_alert_domains:
 * live domains under STORAGE_CAPACITY_RUNWAY_ALERT_DAYS, the frozen legacy
 * rollback source never judged); this only labels each row with it, so the
 * report cannot disagree with the health check or repeat its runway rows.
 */
export function summarizeStorageCapacityRunway(
  health: Pick<StorageHealthResult,
    'capacity_runway' | 'capacity_runway_alert_days' | 'capacity_runway_alert_domains' | 'legacy_capacity_role'>,
): StorageCapacityRunwaySummary {
  const alertDomains = new Set(health.capacity_runway_alert_domains ?? [])
  const legacyFrozen = health.legacy_capacity_role === 'frozen_rollback_source'
  const domains = (health.capacity_runway ?? []).map((row): StorageCapacityRunwayJudgement => {
    const frozen = row.domain === 'legacy' && legacyFrozen
    return {
      domain: row.domain,
      role: frozen ? 'frozen_rollback_source' : 'live',
      judged: !frozen,
      days_to_90pct: row.projected_days_to_critical_90pct,
      alert: !frozen && alertDomains.has(row.domain),
    }
  })
  return {
    alert_days: health.capacity_runway_alert_days,
    alert_domains: domains.filter((row) => row.alert).map((row) => row.domain),
    domains,
  }
}

/**
 * Summary prefix for storage-capacity-report. The system-log warning for the
 * same runway alert is written once, by storage-health-check through
 * reportStorageHealthSeverity (its runway_alert_domains), not again here.
 */
export function capacityRunwayWarningPrefix(summary: StorageCapacityRunwaySummary): string {
  return summary.alert_domains.length ? `warning capacity_runway_alert=${summary.alert_domains.join(',')} ` : ''
}
