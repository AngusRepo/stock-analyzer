import assert from 'node:assert/strict'
import { inspectDataDomainCutoverReadiness } from './dataDomainCutoverReadiness'
import { tablesForDataDomainShadowBackfill } from './dataDomainRegistry'
import {
  DATA_DOMAIN_CONTROL_FULL_TABLE_SCHEMA_VERSION,
  DATA_DOMAIN_EXPECTED_RETURN_SEMANTIC_SCHEMA_VERSION,
  DATA_DOMAIN_ROLLING_MANIFEST_SCHEMA_VERSION,
  isDataDomainControlTable,
  isExpectedReturnSemanticControlTable,
} from './dataDomainShadowManifest'
import { dataDomainControlRevisionEvidence } from './dataDomainControlRevision'
import { buildDataDomainAggregateParitySnapshot } from './dataDomainShadowBackfill'

type MockOptions = {
  cursorRows?: Array<Record<string, unknown>>
  parityRows?: Array<Record<string, unknown>>
  cutover?: Record<string, unknown> | null
  pending?: number
  errors?: number
  revisions?: Record<string, number>
  probe?: Record<string, unknown> | null
  writerEpoch?: Record<string, unknown> | null
}

function readinessDb(options: MockOptions): D1Database {
  return {
    prepare: (sql: string) => ({
      bind: (...binds: unknown[]) => ({
        all: async () => {
          if (sql.includes('data_domain_backfill_cursors')) {
            return { results: options.cursorRows ?? [] }
          }
          if (sql.includes('data_domain_parity_checks')) {
            return { results: options.parityRows ?? [] }
          }
          return { results: [] }
        },
        first: async () => {
          if (sql.includes('data_domain_control_revisions')) {
            const revision = options.revisions?.[String(binds[0])]
            return revision === undefined ? null : { revision }
          }
          if (sql.includes('data_domain_cutovers')) return options.cutover ?? null
          if (sql.includes('data_domain_cutover_probe_receipts')) return options.probe ?? null
          if (sql.includes('data_domain_writer_epochs')) return options.writerEpoch ?? null
          if (sql.includes("status = 'error'")) return { count: options.errors ?? 0 }
          if (sql.includes('domain_projection_outbox')) return { count: options.pending ?? 0 }
          return null
        },
      }),
    }),
  } as unknown as D1Database
}

void (async () => {
  const owned = tablesForDataDomainShadowBackfill('ops')
  const cursorRows = [
    ...owned.map((table_name) => ({ table_name, status: 'complete' })),
    { table_name: 'maintenance_task_leases', status: 'complete' },
    { table_name: 'data_domain_cutovers', status: 'complete' },
  ]
  const parityRows = [
    ...owned.map((table_name, index) => ({
      table_name,
      status: 'pass',
      source_count: 1,
      target_count: 1,
      source_checksum: String(index % 10).repeat(64),
      target_checksum: String(index % 10).repeat(64),
      checked_at: '2026-08-06T12:00:00Z',
    })),
    {
      table_name: 'data_domain_parity_checks',
      status: 'pass',
      source_count: 99,
      target_count: 99,
      source_checksum: 'e'.repeat(64),
      target_checksum: 'e'.repeat(64),
      checked_at: '2026-08-06T12:00:00Z',
    },
  ]
  const opsAggregate = await buildDataDomainAggregateParitySnapshot(owned, parityRows)
  assert(opsAggregate)
  const completeDb = readinessDb({
    cursorRows,
    parityRows,
    cutover: {
      status: 'shadow',
      source_row_count: opsAggregate.source_row_count,
      target_row_count: opsAggregate.target_row_count,
      source_checksum: opsAggregate.source_checksum,
      target_checksum: opsAggregate.target_checksum,
      parity_checked_at: '2026-08-06T12:00:00Z',
    },
  })
  const complete = await inspectDataDomainCutoverReadiness(completeDb, 'ops')
  assert.equal(complete.strict_enable_allowed, false)
  assert.equal(complete.routing_contract_gates.direct_legacy_db_paths_closed, false)
  assert.equal(complete.projection_contract_gates.typed_outbox_producers_wired, false)
  assert.equal(complete.domains[0].owned_tables, owned.length)
  assert.equal(complete.domains[0].completed_tables, owned.length)
  assert.equal(complete.domains[0].parity_tables, owned.length)
  assert.equal(complete.domains[0].data_ready, true)
  assert.equal(complete.domains[0].cutover_ready, false)
  assert.deepEqual(complete.domains[0].data_blockers, [])
  assert.deepEqual(complete.domains[0].contract_blockers, [
    'domain_access_router_not_closed',
    'projection_contract_not_closed',
    'active_read_write_readback_probe_missing',
    'rollback_restore_probe_missing',
    'writer_quiescence_epoch_receipt_stale_or_missing',
  ])

  const staleAfterChain = await inspectDataDomainCutoverReadiness(
    completeDb,
    'ops',
    {
      upstreamTerminalReady: false,
      parityNotBefore: '2026-08-06T13:00:00Z',
    },
  )
  assert.equal(staleAfterChain.domains[0].data_ready, false)
  assert(staleAfterChain.domains[0].data_blockers.includes(
    'upstream_evening_chain_not_terminal_success',
  ))
  assert(staleAfterChain.domains[0].data_blockers.includes(
    'aggregate_parity_stale_after_evening_chain',
  ))


  const missingSnapshot = await inspectDataDomainCutoverReadiness(
    readinessDb({ cursorRows, parityRows, cutover: { status: 'shadow' } }),
    'ops',
  )
  assert.equal(missingSnapshot.domains[0].data_ready, false)
  assert(missingSnapshot.domains[0].data_blockers.includes(
    'aggregate_parity_snapshot_missing_or_mismatch',
  ))

  const staleAggregate = await inspectDataDomainCutoverReadiness(
    readinessDb({
      cursorRows,
      parityRows,
      cutover: {
        status: 'shadow',
        source_row_count: opsAggregate.source_row_count,
        target_row_count: opsAggregate.target_row_count,
        source_checksum: 'stale-aggregate',
        target_checksum: 'stale-aggregate',
        parity_checked_at: '2026-08-06T12:00:00Z',
      },
    }),
    'ops',
  )
  assert.equal(staleAggregate.domains[0].parity_tables, owned.length)
  assert(staleAggregate.domains[0].data_blockers.includes(
    'aggregate_parity_snapshot_missing_or_mismatch',
  ))

  const [first, ...rest] = parityRows.filter((row) => owned.includes(String(row.table_name)))
  const stalePassAfterLatestFailure = await inspectDataDomainCutoverReadiness(
    readinessDb({
      cursorRows,
      parityRows: [
        { ...first, status: 'fail', target_checksum: 'changed', checked_at: '2026-08-06T13:00:00Z' },
        first,
        ...rest,
      ],
      cutover: {
        status: 'shadow',
        source_row_count: opsAggregate.source_row_count,
        target_row_count: opsAggregate.target_row_count,
        source_checksum: opsAggregate.source_checksum,
        target_checksum: opsAggregate.target_checksum,
        parity_checked_at: '2026-08-06T12:00:00Z',
      },
    }),
    'ops',
  )
  assert.equal(stalePassAfterLatestFailure.domains[0].parity_tables, owned.length - 1)
  assert(stalePassAfterLatestFailure.domains[0].data_blockers.includes(
    'full_table_parity_incomplete_or_mismatch',
  ))

  const learningOwned = tablesForDataDomainShadowBackfill('learning')
  const controlRevisions = Object.fromEntries(
    learningOwned.filter(isDataDomainControlTable).map((table) => [table, 7]),
  )
  const learningParityRows = learningOwned.map((table_name, index) => {
    const checksum = String(index % 10).repeat(64)
    const controlEvidence = isDataDomainControlTable(table_name)
      ? {
          schema_version: DATA_DOMAIN_CONTROL_FULL_TABLE_SCHEMA_VERSION,
          parity_scope: 'resumable_full_table_manifest',
          manifest_schema_version: DATA_DOMAIN_ROLLING_MANIFEST_SCHEMA_VERSION,
          manifest_page_limit: 25,
          ...dataDomainControlRevisionEvidence({ sourceRevision: 7, targetRevision: 7 }),
          ...(isExpectedReturnSemanticControlTable(table_name) ? {
            semantic_validation_schema_version:
              DATA_DOMAIN_EXPECTED_RETURN_SEMANTIC_SCHEMA_VERSION,
            semantic_validation_status: 'pass',
            semantic_rows_scanned: 1,
            semantic_rows_applicable: 1,
            semantic_rows_validated: 1,
          } : {}),
        }
      : {}
    return {
      table_name,
      status: 'pass',
      source_count: 1,
      target_count: 1,
      source_checksum: checksum,
      target_checksum: checksum,
      checked_at: '2026-08-15T12:00:00Z',
      evidence_json: JSON.stringify(controlEvidence),
    }
  })
  const learningAggregate = await buildDataDomainAggregateParitySnapshot(
    learningOwned,
    learningParityRows,
    '2026-08-15T11:59:59Z',
  )
  assert(learningAggregate)
  const learningCutover = {
    status: 'shadow',
    source_row_count: learningAggregate.source_row_count,
    target_row_count: learningAggregate.target_row_count,
    source_checksum: learningAggregate.source_checksum,
    target_checksum: learningAggregate.target_checksum,
    parity_checked_at: '2026-08-15T12:00:00Z',
  }
  const learningReadyDb = readinessDb({
    cursorRows: learningOwned.map((table_name) => ({ table_name, status: 'complete' })),
    parityRows: learningParityRows,
    revisions: controlRevisions,
    cutover: learningCutover,
  })
  const learningReady = await inspectDataDomainCutoverReadiness(
    learningReadyDb,
    'learning',
    {
      parityNotBefore: '2026-08-15T11:59:59Z',
      learningTargetDb: readinessDb({ revisions: controlRevisions }),
    },
  )
  assert.equal(learningReady.domains[0].data_ready, true)

  const staleTargetRevision = await inspectDataDomainCutoverReadiness(
    learningReadyDb,
    'learning',
    {
      parityNotBefore: '2026-08-15T11:59:59Z',
      learningTargetDb: readinessDb({
        revisions: { ...controlRevisions, model_artifact_registry: 8 },
      }),
    },
  )
  assert.equal(staleTargetRevision.domains[0].data_ready, false)
  assert(staleTargetRevision.domains[0].data_blockers.includes(
    'control_table_revision_fence:model_artifact_registry:target_revision_stale:7/8',
  ))
  assert.equal(staleTargetRevision.domains[0].parity_tables, learningOwned.length - 1)

  await assert.rejects(
    inspectDataDomainCutoverReadiness(completeDb, 'unknown'),
    /invalid_data_domain:unknown/,
  )
})().catch((error) => {
  throw error
})
