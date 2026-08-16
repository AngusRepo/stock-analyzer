import {
  DATA_DOMAINS,
  MULTI_D1_PROJECTION_CONTRACT_GATES,
  MULTI_D1_PROJECTION_CONTRACT_READY,
  MULTI_D1_ROUTING_CONTRACT_GATES,
  MULTI_D1_STRICT_ROUTING_READY,
  tablesForDataDomainShadowBackfill,
  type DataDomain,
} from './dataDomainRegistry'
import {
  isAuthoritativeDataDomainFullTableParity,
  isDataDomainControlTable,
  isDataDomainFullTableParityFresh,
} from './dataDomainShadowManifest'
import {
  dataDomainControlRevisionBlockers,
  loadDataDomainControlRevisionPair,
} from './dataDomainControlRevision'
import {
  buildDataDomainAggregateParitySnapshot,
  type DomainAggregateParitySnapshot,
} from './dataDomainShadowBackfill'

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
  evidence_json?: string | null
}

type CutoverRow = {
  status?: string
  source_row_count?: number | string | null
  target_row_count?: number | string | null
  source_checksum?: string | null
  target_checksum?: string | null
  parity_checked_at?: string | null
}

type CutoverProbeRow = {
  source_epoch?: number | string | null
  parity_checked_at?: string | null
  read_write_readback_passed?: number | string | null
  rollback_restore_passed?: number | string | null
  status?: string | null
  checked_at?: string | null
}

type WriterEpochRow = {
  epoch?: number | string | null
  writer_state?: string | null
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
  cutover_probe_checked_at: string | null
  cutover_probe_epoch: number | null
  current_writer_epoch: number | null
  current_writer_state: string | null
}

function numeric(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

function exactParityPass(
  table: string,
  row: ParityRow | undefined,
  parityNotBefore?: string | null,
): boolean {
  return isAuthoritativeDataDomainFullTableParity(table, row)
    && isDataDomainFullTableParityFresh(table, row, parityNotBefore)
}

function aggregateParityPass(
  row: CutoverRow | null,
  expected: DomainAggregateParitySnapshot | null,
): boolean {
  return Boolean(
    row
    && expected
    && numeric(row.source_row_count) === expected.source_row_count
    && numeric(row.target_row_count) === expected.target_row_count
    && row.source_checksum === expected.source_checksum
    && row.target_checksum === expected.target_checksum
    && expected.source_checksum === expected.target_checksum
    && row.parity_checked_at,
  )
}

export type DataDomainCutoverReadinessContext = {
  upstreamTerminalReady?: boolean
  parityNotBefore?: string | null
  learningTargetDb?: D1Database
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
    const [cursorQuery, parityQuery, pending, errors, cutover, probe, writerEpoch] = await Promise.all([
      db.prepare(`
        SELECT table_name, status FROM data_domain_backfill_cursors
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
          FROM data_domain_cutovers WHERE domain=?
      `).bind(domain).first<CutoverRow>(),
      db.prepare(`
        SELECT source_epoch, parity_checked_at, read_write_readback_passed,
               rollback_restore_passed, status, checked_at
          FROM data_domain_cutover_probe_receipts
         WHERE domain=?
         ORDER BY checked_at DESC
         LIMIT 1
      `).bind(domain).first<CutoverProbeRow>(),
      db.prepare(`
        SELECT epoch, writer_state
          FROM data_domain_writer_epochs
         WHERE domain=?
      `).bind(domain).first<WriterEpochRow>(),
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
    const revisionReady = new Set<string>()
    const revisionBlockers: string[] = []
    if (domain === 'learning') {
      const controlTables = [...owned].filter(isDataDomainControlTable)
      if (!context.learningTargetDb) {
        revisionBlockers.push('control_table_revision_target_binding_missing')
      } else {
        await Promise.all(controlTables.map(async (table) => {
          try {
            const live = await loadDataDomainControlRevisionPair(
              db,
              context.learningTargetDb!,
              table,
            )
            const blockers = dataDomainControlRevisionBlockers({
              receipt: latestParity.get(table),
              live,
            })
            if (!blockers.length) revisionReady.add(table)
            else revisionBlockers.push(...blockers.map(
              (blocker) => `control_table_revision_fence:${table}:${blocker}`,
            ))
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            revisionBlockers.push(`control_table_revision_fence:${table}:${message}`)
          }
        }))
      }
    }
    const parityTables = [...owned].filter((table) => exactParityPass(
      table,
      latestParity.get(table),
      context.parityNotBefore,
    ) && (!isDataDomainControlTable(table) || revisionReady.has(table))).length
    const aggregateSnapshot = parityTables === owned.size
      ? await buildDataDomainAggregateParitySnapshot(
          [...owned],
          [...latestParity.values()].map((row) => ({
            table_name: String(row.table_name ?? ''),
            status: String(row.status ?? ''),
            source_count: row.source_count ?? null,
            target_count: row.target_count ?? null,
            source_checksum: row.source_checksum ?? null,
            target_checksum: row.target_checksum ?? null,
            evidence_json: row.evidence_json ?? null,
            checked_at: row.checked_at ?? null,
          })),
          context.parityNotBefore,
        )
      : null
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
    dataBlockers.push(...revisionBlockers.sort())
    if (!aggregateParityPass(cutover, aggregateSnapshot)) {
      dataBlockers.push('aggregate_parity_snapshot_missing_or_mismatch')
    }
    if (pendingProjectionEvents > 0) dataBlockers.push('projection_catchup_not_zero')
    if (projectionErrorEvents > 0) dataBlockers.push('projection_errors_present')
    if (!['shadow', 'read_cutover', 'write_cutover', 'complete'].includes(cutoverStatus)) {
      dataBlockers.push('shadow_state_not_ready')
    }

    const contractBlockers: string[] = []
    if (!MULTI_D1_STRICT_ROUTING_READY) contractBlockers.push('domain_access_router_not_closed')
    if (!MULTI_D1_PROJECTION_CONTRACT_READY) contractBlockers.push('projection_contract_not_closed')
    const probeEpoch = probe ? numeric(probe.source_epoch) : null
    const currentWriterEpoch = writerEpoch ? numeric(writerEpoch.epoch) : null
    if (probe?.status !== 'passed' || numeric(probe?.read_write_readback_passed) !== 1) {
      contractBlockers.push('active_read_write_readback_probe_missing')
    }
    if (probe?.status !== 'passed' || numeric(probe?.rollback_restore_passed) !== 1) {
      contractBlockers.push('rollback_restore_probe_missing')
    }
    if (
      !probe
      || !writerEpoch
      || writerEpoch.writer_state !== 'open'
      || probeEpoch !== currentWriterEpoch
      || probe.parity_checked_at !== cutover?.parity_checked_at
    ) contractBlockers.push('writer_quiescence_epoch_receipt_stale_or_missing')

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
      cutover_probe_checked_at: probe?.checked_at ?? null,
      cutover_probe_epoch: probeEpoch,
      current_writer_epoch: currentWriterEpoch,
      current_writer_state: writerEpoch?.writer_state ?? null,
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
