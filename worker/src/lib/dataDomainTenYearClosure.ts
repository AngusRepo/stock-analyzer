import {
  DATA_DOMAINS,
  LEGACY_CONTROL_PLANE_TABLES,
  tableOwnershipMetadata,
  tablesForDataDomain,
  type DataDomain,
} from './dataDomainRegistry'
import type { DataDomainCutoverReadiness } from './dataDomainCutoverReadiness'

export type TenYearCapacityClosureReceipt = {
  observed_databases: number
  expected_databases: number
  critical_domains: readonly string[]
  drain_domains: readonly string[]
  required_archive_policies: number
  operational_archive_policies: number
  missing_archive_policy_executors: readonly string[]
  capacity_forecast_ready_domains: readonly string[]
  capacity_forecast_pending_domains: readonly string[]
  capacity_forecast_at_risk_domains: readonly string[]
  minimum_warning_runway_days: number
}

export function buildTenYearCapacityClosureReceipt(input: {
  databases: ReadonlyArray<{ domain: string; status: string }>
  archivePolicies: ReadonlyArray<{ policy_id: string; operational: boolean }>
  growthForecasts?: ReadonlyArray<{
    domain: string
    status: 'ready' | 'awaiting_post_cutover_observations'
    projected_days_to_warning_65pct: number | null
  }>
  expectedDatabases?: number
  minimumWarningRunwayDays?: number
}): TenYearCapacityClosureReceipt {
  const expectedDatabases = input.expectedDatabases ?? 8
  const minimumWarningRunwayDays = Math.max(30, input.minimumWarningRunwayDays ?? 90)
  const activeDomains = input.databases
    .map((row) => row.domain)
    .filter((domain) => domain !== 'legacy')
  const forecastByDomain = new Map((input.growthForecasts ?? []).map((row) => [row.domain, row]))
  const criticalDomains = input.databases
    .filter((row) => row.status === 'critical')
    .map((row) => row.domain)
    .sort()
  const drainDomains = input.databases
    .filter((row) => row.status === 'drain')
    .map((row) => row.domain)
    .sort()
  const missing = input.archivePolicies
    .filter((row) => !row.operational)
    .map((row) => row.policy_id)
    .sort()
  const forecastReadyDomains = activeDomains
    .filter((domain) => forecastByDomain.get(domain)?.status === 'ready')
    .sort()
  const forecastPendingDomains = activeDomains
    .filter((domain) => forecastByDomain.get(domain)?.status !== 'ready')
    .sort()
  const forecastAtRiskDomains = activeDomains
    .filter((domain) => {
      const forecast = forecastByDomain.get(domain)
      return forecast?.status === 'ready'
        && forecast.projected_days_to_warning_65pct != null
        && forecast.projected_days_to_warning_65pct < minimumWarningRunwayDays
    })
    .sort()
  return {
    observed_databases: input.databases.length,
    expected_databases: expectedDatabases,
    critical_domains: criticalDomains,
    drain_domains: drainDomains,
    required_archive_policies: input.archivePolicies.length,
    operational_archive_policies: input.archivePolicies.length - missing.length,
    missing_archive_policy_executors: missing,
    capacity_forecast_ready_domains: forecastReadyDomains,
    capacity_forecast_pending_domains: forecastPendingDomains,
    capacity_forecast_at_risk_domains: forecastAtRiskDomains,
    minimum_warning_runway_days: minimumWarningRunwayDays,
  }
}
export type TenYearDomainClosureInput = {
  activeDomains: readonly string[]
  strictRequested: boolean
  domains: readonly DataDomainCutoverReadiness[]
  capacity?: TenYearCapacityClosureReceipt | null
  unresolvedRouteTables?: Partial<Record<DataDomain, readonly string[]>>
}

export function buildDataDomainTenYearClosure(input: TenYearDomainClosureInput) {
  const active = new Set(input.activeDomains)
  const byDomain = new Map(input.domains.map((item) => [item.domain, item]))
  const domainReceipts = DATA_DOMAINS.map((domain) => {
    const item = byDomain.get(domain)
    const blockers: string[] = []
    const unresolvedRouteTables = [
      ...(input.unresolvedRouteTables?.[domain] ?? item?.unresolved_route_tables ?? tablesForDataDomain(domain).filter((table) => (
        !LEGACY_CONTROL_PLANE_TABLES.has(table)
        && tableOwnershipMetadata(table)?.route_ready !== true
      ))),
    ].sort()
    if (unresolvedRouteTables.length) {
      blockers.push(`domain_table_routes_not_closed:${unresolvedRouteTables.length}`)
    }
    if (!active.has(domain)) blockers.push('runtime_route_not_active')
    if (!item) blockers.push('readiness_receipt_missing')
    const finalized = item?.cutover_status === 'complete' && item.current_writer_state === 'cutover'
    if (item && !item.cutover_ready) {
      // Once the CAS receipt is finalized, the domain DB is the writer authority.
      // Legacy parity is a cutover-time proof and is expected to drift afterward.
      blockers.push(...(finalized ? item.contract_blockers : item.blockers))
    }
    if (item?.cutover_status !== 'complete') blockers.push('cutover_status_not_complete')
    if (item?.current_writer_state !== 'cutover') blockers.push('writer_state_not_cutover')
    if (Number(item?.pending_projection_events ?? 0) !== 0) blockers.push('projection_pending_not_zero')
    if (Number(item?.projection_error_events ?? 0) !== 0) blockers.push('projection_errors_not_zero')
    return {
      domain,
      complete: blockers.length === 0,
      blockers: [...new Set(blockers)],
      cutover_status: item?.cutover_status ?? 'missing',
      writer_state: item?.current_writer_state ?? 'missing',
      unresolved_route_tables: unresolvedRouteTables,
    }
  })
  const globalBlockers: string[] = []
  if (!input.strictRequested) globalBlockers.push('multi_d1_strict_not_enabled')
  if (active.size !== DATA_DOMAINS.length || DATA_DOMAINS.some((domain) => !active.has(domain))) {
    globalBlockers.push('seven_domain_runtime_route_incomplete')
  }
  const capacity = input.capacity ?? null
  const allActiveDomainsClosed = input.strictRequested
    && active.size === DATA_DOMAINS.length
    && DATA_DOMAINS.every((domain) => active.has(domain))
    && domainReceipts.every((item) => item.complete)
  const acceptedFrozenRollbackDomains = capacity?.critical_domains
    .filter((domain) => domain === 'legacy' && allActiveDomainsClosed) ?? []
  const blockingCriticalDomains = capacity?.critical_domains
    .filter((domain) => !acceptedFrozenRollbackDomains.includes(domain)) ?? []
  if (!capacity) globalBlockers.push('ten_year_capacity_receipt_missing')
  if (capacity && capacity.observed_databases !== capacity.expected_databases) {
    globalBlockers.push('d1_capacity_inventory_incomplete')
  }
  if (capacity && capacity.required_archive_policies === 0) {
    globalBlockers.push('retention_archive_policies_missing')
  }
  if (blockingCriticalDomains.length) globalBlockers.push('d1_capacity_critical')
  if (capacity?.drain_domains.length) globalBlockers.push('d1_capacity_drain_required')
  if (
    capacity
    && (capacity.missing_archive_policy_executors.length > 0
      || capacity.operational_archive_policies !== capacity.required_archive_policies)
  ) {
    globalBlockers.push('retention_archive_executors_incomplete')
  }
  if (domainReceipts.some((item) => !item.complete)) globalBlockers.push('seven_domain_cutover_incomplete')
  const retentionArchitectureComplete = globalBlockers.length === 0
  if (capacity?.capacity_forecast_pending_domains.length) {
    globalBlockers.push('ten_year_capacity_stable_baseline_pending')
  }
  if (capacity?.capacity_forecast_at_risk_domains.length) {
    globalBlockers.push('ten_year_capacity_warning_runway_insufficient')
  }
  const complete = globalBlockers.length === 0
  return {
    schema_version: 'data-domain-ten-year-closure-v2' as const,
    complete,
    claim_allowed: complete,
    status: complete ? 'complete' as const : 'in_progress' as const,
    routing_cutover_complete: allActiveDomainsClosed,
    retention_architecture_complete: retentionArchitectureComplete,
    capacity_forecast_complete: capacity != null
      && capacity.capacity_forecast_pending_domains.length === 0
      && capacity.capacity_forecast_at_risk_domains.length === 0,
    completed_domains: domainReceipts.filter((item) => item.complete).length,
    required_domains: DATA_DOMAINS.length,
    legacy_role: allActiveDomainsClosed ? 'control_plane_and_time_travel_rollback_source' as const : 'mixed_runtime_source_do_not_delete' as const,
    blockers: globalBlockers,
    domains: domainReceipts,
    capacity,
    capacity_classification: {
      blocking_critical_domains: blockingCriticalDomains,
      accepted_frozen_rollback_domains: acceptedFrozenRollbackDomains,
    },
  }
}
