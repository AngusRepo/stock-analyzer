import assert from 'node:assert/strict'
import { inspectDataDomainCutoverReadiness } from './dataDomainCutoverReadiness'
import { tablesForDataDomainShadowBackfill } from './dataDomainRegistry'

type MockOptions = {
  cursorRows?: Array<Record<string, unknown>>
  parityRows?: Array<Record<string, unknown>>
  cutover?: Record<string, unknown> | null
  pending?: number
  errors?: number
}

function readinessDb(options: MockOptions): D1Database {
  return {
    prepare: (sql: string) => ({
      bind: (..._binds: unknown[]) => ({
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
          if (sql.includes('data_domain_cutovers')) return options.cutover ?? null
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
    ...owned.map((table_name) => ({
      table_name,
      status: 'pass',
      source_count: 1,
      target_count: 1,
      source_checksum: `checksum:${table_name}`,
      target_checksum: `checksum:${table_name}`,
      checked_at: '2026-08-06T12:00:00Z',
    })),
    {
      table_name: 'data_domain_parity_checks',
      status: 'pass',
      source_count: 99,
      target_count: 99,
      source_checksum: 'excluded',
      target_checksum: 'excluded',
      checked_at: '2026-08-06T12:00:00Z',
    },
  ]
  const completeDb = readinessDb({
    cursorRows,
    parityRows,
    cutover: {
      status: 'shadow',
      source_row_count: owned.length,
      target_row_count: owned.length,
      source_checksum: 'domain-checksum',
      target_checksum: 'domain-checksum',
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
        source_row_count: owned.length,
        target_row_count: owned.length,
        source_checksum: 'domain-checksum',
        target_checksum: 'domain-checksum',
        parity_checked_at: '2026-08-06T12:00:00Z',
      },
    }),
    'ops',
  )
  assert.equal(stalePassAfterLatestFailure.domains[0].parity_tables, owned.length - 1)
  assert(stalePassAfterLatestFailure.domains[0].data_blockers.includes(
    'full_table_parity_incomplete_or_mismatch',
  ))

  await assert.rejects(
    inspectDataDomainCutoverReadiness(completeDb, 'unknown'),
    /invalid_data_domain:unknown/,
  )
})().catch((error) => {
  throw error
})
