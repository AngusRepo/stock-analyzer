import {
  DATA_DOMAINS,
  MULTI_D1_PROJECTION_CONTRACT_GATES,
  MULTI_D1_PROJECTION_CONTRACT_READY,
  MULTI_D1_ROUTING_CONTRACT_GATES,
  MULTI_D1_STRICT_ROUTING_READY,
  tablesForDataDomainShadowBackfill,
  type DataDomain,
} from './dataDomainRegistry'

type CursorRow = {
  table_name?: string
  status?: string
}

type ParityRow = {
  table_name?: string
  status?: string
  source_count?: number | string | null
  target_count?: number | string | null
  source_checksum?: string | null
  target_checksum?: string | null
  checked_at?: string | null
}

type CutoverRow = {
  status?: string
  source_row_count?: number | string | null
  target_row_count?: number | string | null
  source_checksum?: string | null
  target_checksum?: string | null
  parity_checked_at?: string | null
}

export type DataDomainCutoverReadiness = {
  domain: DataDomain
  data_ready: boolean
  cutover_ready: boolean
  blockers: string[]
  data_blockers: string[]
  contract_blockers: string[]
  owned_tables: number
  completed_tables: number
  parity_tables: number
  pending_projection_events: number
  projection_error_events: number
  cutover_status: string
  aggregate_parity_checked_at: string | null
  required_parity_not_before: string | null
  routing_contract_ready: boolean
  projection_contract_ready: boolean
}

function numeric(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

function exactParityPass(row: ParityRow | undefined): boolean {
  return Boolean(
    row
    && row.status === 'pass'
    && numeric(row.source_count) === numeric(row.target_count)
    && String(row.source_checksum ?? '').length > 0
    && row.source_checksum === row.target_checksum,
  )
}

function aggregateParityPass(row: CutoverRow | null): boolean {
  return Boolean(
    row
    && numeric(row.source_row_count) === numeric(row.target_row_count)
    && String(row.source_checksum ?? '').length > 0
    && row.source_checksum === row.target_checksum
    && row.parity_checked_at,
  )
}

export type DataDomainCutoverReadinessContext = {
  upstreamTerminalReady?: boolean
  parityNotBefore?: string | null
}

export async function inspectDataDomainCutoverReadiness(
  db: D1Database,
  requestedDomain?: string | null,
  context: DataDomainCutoverReadinessContext = {},
): Promise<{
  schema_version: 'data-domain-cutover-readiness-v2'
  strict_enable_allowed: boolean
  routing_contract_gates: typeof MULTI_D1_ROUTING_CONTRACT_GATES
  projection_contract_gates: typeof MULTI_D1_PROJECTION_CONTRACT_GATES
  domains: DataDomainCutoverReadiness[]
}> {
  const normalized = String(requestedDomain ?? '').trim().toLowerCase()
  const domains = normalized
    ? DATA_DOMAINS.filter((domain) => domain === normalized)
    : [...DATA_DOMAINS]
  if (!domains.length) throw new Error(`invalid_data_domain:${normalized}`)

  const results: DataDomainCutoverReadiness[] = []
  for (const domain of domains) {
    const owned = new Set(tablesForDataDomainShadowBackfill(domain))
    const [cursorQuery, parityQuery, pending, errors, cutover] = await Promise.all([
      db.prepare(`
        SELECT table_name, status FROM data_domain_backfill_cursors
         WHERE domain=?
      `).bind(domain).all<CursorRow>(),
      db.prepare(`
        SELECT table_name, status, source_count, target_count,
               source_checksum, target_checksum, checked_at
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
          FROM data_domain_cutovers WHERE domain=?
      `).bind(domain).first<CutoverRow>(),
    ])

    const completed = new Set(
      (cursorQuery.results ?? [])
        .filter((row) => row.status === 'complete' && owned.has(String(row.table_name ?? '')))
        .map((row) => String(row.table_name)),
    )
    const latestParity = new Map<string, ParityRow>()
    for (const row of parityQuery.results ?? []) {
      const table = String(row.table_name ?? '')
      if (owned.has(table) && !latestParity.has(table)) latestParity.set(table, row)
    }
    const parityTables = [...owned].filter((table) => exactParityPass(latestParity.get(table))).length
    const pendingProjectionEvents = numeric(pending?.count)
    const projectionErrorEvents = numeric(errors?.count)
    const cutoverStatus = String(cutover?.status ?? 'legacy')
    const dataBlockers: string[] = []
    if (context.upstreamTerminalReady === false) {
      dataBlockers.push('upstream_evening_chain_not_terminal_success')
    }
    const parityNotBeforeMs = Date.parse(String(context.parityNotBefore ?? ''))
    const parityCheckedAtMs = Date.parse(String(cutover?.parity_checked_at ?? ''))
    if (Number.isFinite(parityNotBeforeMs) && (!Number.isFinite(parityCheckedAtMs) || parityCheckedAtMs < parityNotBeforeMs)) {
      dataBlockers.push('aggregate_parity_stale_after_evening_chain')
    }
    if (completed.size !== owned.size) dataBlockers.push('initial_copy_incomplete')
    if (parityTables !== owned.size) dataBlockers.push('full_table_parity_incomplete_or_mismatch')
    if (!aggregateParityPass(cutover)) dataBlockers.push('aggregate_parity_snapshot_missing_or_mismatch')
    if (pendingProjectionEvents > 0) dataBlockers.push('projection_catchup_not_zero')
    if (projectionErrorEvents > 0) dataBlockers.push('projection_errors_present')
    if (!['shadow', 'read_cutover', 'write_cutover', 'complete'].includes(cutoverStatus)) {
      dataBlockers.push('shadow_state_not_ready')
    }

    const contractBlockers: string[] = []
    if (!MULTI_D1_STRICT_ROUTING_READY) contractBlockers.push('domain_access_router_not_closed')
    if (!MULTI_D1_PROJECTION_CONTRACT_READY) contractBlockers.push('projection_contract_not_closed')

    results.push({
      domain,
      data_ready: dataBlockers.length === 0,
      cutover_ready: dataBlockers.length === 0 && contractBlockers.length === 0,
      blockers: [...dataBlockers, ...contractBlockers],
      data_blockers: dataBlockers,
      contract_blockers: contractBlockers,
      owned_tables: owned.size,
      completed_tables: completed.size,
      parity_tables: parityTables,
      pending_projection_events: pendingProjectionEvents,
      projection_error_events: projectionErrorEvents,
      cutover_status: cutoverStatus,
      aggregate_parity_checked_at: cutover?.parity_checked_at ?? null,
      required_parity_not_before: context.parityNotBefore ?? null,
      routing_contract_ready: MULTI_D1_STRICT_ROUTING_READY,
      projection_contract_ready: MULTI_D1_PROJECTION_CONTRACT_READY,
    })
  }

  return {
    schema_version: 'data-domain-cutover-readiness-v2',
    strict_enable_allowed: results.length === DATA_DOMAINS.length
      && results.every((item) => item.cutover_ready),
    routing_contract_gates: MULTI_D1_ROUTING_CONTRACT_GATES,
    projection_contract_gates: MULTI_D1_PROJECTION_CONTRACT_GATES,
    domains: results,
  }
}
