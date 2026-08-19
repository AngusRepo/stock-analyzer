import {
  DATA_DOMAINS,
  LEGACY_CONTROL_PLANE_TABLES,
  tableOwnershipMetadata,
  tablesForDataDomain,
  type DataDomain,
} from './dataDomainRegistry'
import type { DataDomainCutoverReadiness } from './dataDomainCutoverReadiness'

export type TenYearDomainClosureInput = {
  activeDomains: readonly string[]
  strictRequested: boolean
  domains: readonly DataDomainCutoverReadiness[]
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
  if (domainReceipts.some((item) => !item.complete)) globalBlockers.push('seven_domain_cutover_incomplete')
  const complete = globalBlockers.length === 0
  return {
    schema_version: 'data-domain-ten-year-closure-v1' as const,
    complete,
    claim_allowed: complete,
    status: complete ? 'complete' as const : 'in_progress' as const,
    completed_domains: domainReceipts.filter((item) => item.complete).length,
    required_domains: DATA_DOMAINS.length,
    legacy_role: complete ? 'control_plane_and_time_travel_rollback_source' as const : 'mixed_runtime_source_do_not_delete' as const,
    blockers: globalBlockers,
    domains: domainReceipts,
  }
}
