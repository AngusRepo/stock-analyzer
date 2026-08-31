import {
  DATA_DOMAINS,
  dataDomainProjectionContractReady,
  dataDomainRoutingContractReady,
  tablesForDataDomainShadowBackfill,
  type DataDomain,
} from './dataDomainRegistry'
import { isAuthoritativeDataDomainFullTableParity } from './dataDomainShadowManifest'
import { activeDataDomainShadowBackfillRunId } from './dataDomainShadowSession'

type CursorRow = {
  table_name?: string | null
  status?: string | null
  last_batch_rows?: number | string | null
  updated_at?: string | null
}

type ParityRow = {
  table_name?: string | null
  status?: string | null
  source_count?: number | string | null
  target_count?: number | string | null
  source_checksum?: string | null
  target_checksum?: string | null
  checked_at?: string | null
  evidence_json?: string | null
}

export type BackfillRetirementCutoverRow = {
  status?: string | null
  source_row_count?: number | string | null
  target_row_count?: number | string | null
  source_checksum?: string | null
  target_checksum?: string | null
  parity_checked_at?: string | null
}

type WriterEpochRow = {
  epoch?: number | string | null
  writer_state?: string | null
}

type ActiveLeaseRow = {
  lease_group?: string | null
  task_name?: string | null
  owner_id?: string | null
  lease_expires_at?: string | null
}

export type DataDomainBackfillRetirementReadiness = {
  domain: DataDomain
  eligible: boolean
  blockers: string[]
  owned_tables: number
  completed_tables: number
  zero_last_batch_tables: number
  historical_parity_tables: number
  incomplete_tables: string[]
  last_batch_not_zero_tables: string[]
  parity_blocked_tables: string[]
  pending_projection_events: number
  projection_error_events: number
  cutover_status: string
  writer_state: string | null
  writer_epoch: number | null
  frozen_aggregate_parity_exact: boolean
  frozen_aggregate_parity_checked_at: string | null
  routing_contract_ready: boolean
  projection_contract_ready: boolean
  active_backfill_run_id: string | null
}

function strictNonNegativeInteger(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  if (typeof value === 'string' && !/^(0|[1-9][0-9]*)$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

function numeric(value: unknown): number {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

export function isFrozenExactCutoverReceipt(
  row: BackfillRetirementCutoverRow | null | undefined,
): boolean {
  if (!row) return false
  const sourceCount = strictNonNegativeInteger(row.source_row_count)
  const targetCount = strictNonNegativeInteger(row.target_row_count)
  const sourceChecksum = String(row.source_checksum ?? '')
  const targetChecksum = String(row.target_checksum ?? '')
  return sourceCount !== null
    && targetCount !== null
    && sourceCount === targetCount
    && Boolean(sourceChecksum)
    && sourceChecksum === targetChecksum
    && Boolean(String(row.parity_checked_at ?? '').trim())
}

export function evaluateDataDomainBackfillRetirement(input: {
  domain: DataDomain
  ownedTables: readonly string[]
  cursorRows: readonly CursorRow[]
  parityRows: readonly ParityRow[]
  pendingProjectionEvents: number
  projectionErrorEvents: number
  cutover: BackfillRetirementCutoverRow | null
  writerEpoch: WriterEpochRow | null
  activeBackfillRunId: string | null
}): DataDomainBackfillRetirementReadiness {
  const owned = new Set(input.ownedTables)
  const cursorByTable = new Map<string, CursorRow>()
  for (const row of input.cursorRows) {
    const table = String(row.table_name ?? '')
    if (owned.has(table)) cursorByTable.set(table, row)
  }
  const latestParity = new Map<string, ParityRow>()
  for (const row of input.parityRows) {
    const table = String(row.table_name ?? '')
    if (owned.has(table) && !latestParity.has(table)) latestParity.set(table, row)
  }

  const completedTables = [...owned].filter((table) => cursorByTable.get(table)?.status === 'complete')
  const zeroLastBatchTables = [...owned].filter((table) => (
    strictNonNegativeInteger(cursorByTable.get(table)?.last_batch_rows) === 0
  ))
  // Full-table receipts prove the historical legacy copy that existed at cutover.
  // They intentionally have no freshness gate after cutover because the target is
  // the active writer and is expected to diverge from the frozen legacy source.
  const historicalParityTables = [...owned].filter((table) => (
    isAuthoritativeDataDomainFullTableParity(table, latestParity.get(table))
  ))
  const incompleteTables = [...owned]
    .filter((table) => cursorByTable.get(table)?.status !== 'complete')
    .sort()
  const lastBatchNotZeroTables = [...owned]
    .filter((table) => strictNonNegativeInteger(cursorByTable.get(table)?.last_batch_rows) !== 0)
    .sort()
  const parityBlockedTables = [...owned]
    .filter((table) => !isAuthoritativeDataDomainFullTableParity(table, latestParity.get(table)))
    .sort()
  const routingContractReady = dataDomainRoutingContractReady(input.domain)
  const projectionContractReady = dataDomainProjectionContractReady(input.domain)
  const frozenAggregateParityExact = isFrozenExactCutoverReceipt(input.cutover)
  const cutoverStatus = String(input.cutover?.status ?? 'missing')
  const writerState = input.writerEpoch?.writer_state ?? null
  const blockers: string[] = []
  if (cutoverStatus !== 'complete') blockers.push('cutover_not_complete')
  if (writerState !== 'cutover') blockers.push('writer_not_cutover')
  if (!routingContractReady) blockers.push('routing_contract_not_ready')
  if (!projectionContractReady) blockers.push('projection_contract_not_ready')
  if (input.pendingProjectionEvents !== 0) blockers.push('projection_pending_nonzero')
  if (input.projectionErrorEvents !== 0) blockers.push('projection_errors_present')
  if (!frozenAggregateParityExact) blockers.push('frozen_aggregate_parity_not_exact')
  if (incompleteTables.length) blockers.push('cursor_incomplete')
  if (lastBatchNotZeroTables.length) blockers.push('cursor_last_batch_not_zero')
  if (parityBlockedTables.length) blockers.push('historical_full_table_parity_not_exact')
  if (input.activeBackfillRunId) blockers.push('active_backfill_session')

  return {
    domain: input.domain,
    eligible: blockers.length === 0,
    blockers,
    owned_tables: owned.size,
    completed_tables: completedTables.length,
    zero_last_batch_tables: zeroLastBatchTables.length,
    historical_parity_tables: historicalParityTables.length,
    incomplete_tables: incompleteTables,
    last_batch_not_zero_tables: lastBatchNotZeroTables,
    parity_blocked_tables: parityBlockedTables,
    pending_projection_events: input.pendingProjectionEvents,
    projection_error_events: input.projectionErrorEvents,
    cutover_status: cutoverStatus,
    writer_state: writerState,
    writer_epoch: input.writerEpoch ? numeric(input.writerEpoch.epoch) : null,
    frozen_aggregate_parity_exact: frozenAggregateParityExact,
    frozen_aggregate_parity_checked_at: input.cutover?.parity_checked_at ?? null,
    routing_contract_ready: routingContractReady,
    projection_contract_ready: projectionContractReady,
    active_backfill_run_id: input.activeBackfillRunId,
  }
}

export async function inspectDataDomainBackfillRetirementReadiness(
  db: D1Database,
  kv: KVNamespace,
): Promise<{
  schema_version: 'data-domain-backfill-retirement-readiness-v1'
  mode: 'read_only'
  observed_at: string
  retirement_data_plane_ready: boolean
  blockers: string[]
  active_leases: ActiveLeaseRow[]
  domains: DataDomainBackfillRetirementReadiness[]
  jobs: Record<string, { domains: DataDomain[]; data_plane_ready: boolean; blockers: string[] }>
}> {
  const activeLeasesQuery = await db.prepare(`
    SELECT lease_group, task_name, owner_id, lease_expires_at
      FROM maintenance_task_leases
     WHERE lease_expires_at >= CURRENT_TIMESTAMP
       AND task_name LIKE 'data-domain-shadow-backfill:%'
     ORDER BY lease_expires_at ASC, task_name ASC
  `).all<ActiveLeaseRow>()
  const activeLeases = activeLeasesQuery.results ?? []

  const domains = await Promise.all(DATA_DOMAINS.map(async (domain) => {
    const [cursorQuery, parityQuery, pending, errors, cutover, writerEpoch, activeBackfillRunId] = await Promise.all([
      db.prepare(`
        SELECT table_name, status, last_batch_rows, updated_at
          FROM data_domain_backfill_cursors
         WHERE domain=?
      `).bind(domain).all<CursorRow>(),
      db.prepare(`
        SELECT table_name, status, source_count, target_count,
               source_checksum, target_checksum, checked_at, evidence_json
          FROM data_domain_parity_checks
         WHERE domain=? AND check_kind='full_table'
         ORDER BY checked_at DESC
      `).bind(domain).all<ParityRow>(),
      db.prepare(`
        SELECT COUNT(*) count FROM domain_projection_outbox
         WHERE (source_domain=? OR target_domain=?) AND status <> 'published'
      `).bind(domain, domain).first<{ count?: number | string }>(),
      db.prepare(`
        SELECT COUNT(*) count FROM domain_projection_outbox
         WHERE (source_domain=? OR target_domain=?) AND status = 'error'
      `).bind(domain, domain).first<{ count?: number | string }>(),
      db.prepare(`
        SELECT status, source_row_count, target_row_count,
               source_checksum, target_checksum, parity_checked_at
          FROM data_domain_cutovers
         WHERE domain=?
      `).bind(domain).first<BackfillRetirementCutoverRow>(),
      db.prepare(`
        SELECT epoch, writer_state
          FROM data_domain_writer_epochs
         WHERE domain=?
      `).bind(domain).first<WriterEpochRow>(),
      activeDataDomainShadowBackfillRunId(kv, domain),
    ])

    return evaluateDataDomainBackfillRetirement({
      domain,
      ownedTables: tablesForDataDomainShadowBackfill(domain),
      cursorRows: cursorQuery.results ?? [],
      parityRows: parityQuery.results ?? [],
      pendingProjectionEvents: numeric(pending?.count),
      projectionErrorEvents: numeric(errors?.count),
      cutover: cutover ?? null,
      writerEpoch: writerEpoch ?? null,
      activeBackfillRunId,
    })
  }))

  const globalBlockers = activeLeases.length ? ['active_backfill_lease'] : []
  const byDomain = new Map(domains.map((item) => [item.domain, item] as const))
  const jobReadiness = (jobDomains: DataDomain[]) => {
    const domainBlockers = jobDomains.flatMap((domain) => (
      (byDomain.get(domain)?.blockers ?? ['domain_evidence_missing'])
        .map((blocker) => `${domain}:${blocker}`)
    ))
    const blockers = [...globalBlockers, ...domainBlockers]
    return { domains: jobDomains, data_plane_ready: blockers.length === 0, blockers }
  }
  const allDomains = [...DATA_DOMAINS]
  const jobs = {
    'data-domain-shadow-backfill-next': jobReadiness(allDomains),
    'data-domain-shadow-backfill-ops': jobReadiness(['ops']),
    'data-domain-shadow-backfill-execution': jobReadiness(['execution']),
    'data-domain-shadow-backfill-paper': jobReadiness(['paper']),
  }
  const blockers = [
    ...globalBlockers,
    ...domains.flatMap((item) => item.blockers.map((blocker) => `${item.domain}:${blocker}`)),
  ]

  return {
    schema_version: 'data-domain-backfill-retirement-readiness-v1',
    mode: 'read_only',
    observed_at: new Date().toISOString(),
    retirement_data_plane_ready: blockers.length === 0,
    blockers,
    active_leases: activeLeases,
    domains,
    jobs,
  }
}
