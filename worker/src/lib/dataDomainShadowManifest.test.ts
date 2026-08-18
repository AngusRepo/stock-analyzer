import assert from 'node:assert/strict'
import {
  boundedDataDomainTableManifest,
  canonicalRows,
  checksumRollingManifest,
  checksumRows,
  dataDomainManifestPageLimit,
  DATA_DOMAIN_CONTROL_FULL_TABLE_SCHEMA_VERSION,
  DATA_DOMAIN_ROLLING_MANIFEST_SCHEMA_VERSION,
  isAuthoritativeDataDomainFullTableParity,
  isDataDomainFullTableParityFresh,
} from './dataDomainShadowManifest'
import { dataDomainControlRevisionEvidence } from './dataDomainControlRevision'

type TestRow = { id: number; payload: string | null }

function tableDb(rows: TestRow[], observedLimits: number[], observedSql: string[]): D1Database {
  return {
    prepare: (sql: string) => ({
      bind: (...binds: unknown[]) => ({
        all: async () => {
          observedSql.push(sql)
          assert.match(sql, /LIMIT \?/)
          const limit = Number(binds.at(-1))
          observedLimits.push(limit)
          const cursor = binds.length > 1 ? Number(binds[0]) : Number.NEGATIVE_INFINITY
          return { results: rows.filter((row) => row.id > cursor).slice(0, limit) }
        },
      }),
    }),
  } as unknown as D1Database
}

function controlReceipt(now: string) {
  const checksum = 'a'.repeat(64)
  return {
    status: 'pass',
    source_count: 244,
    target_count: 244,
    source_checksum: checksum,
    target_checksum: checksum,
    evidence_json: JSON.stringify({
      schema_version: DATA_DOMAIN_CONTROL_FULL_TABLE_SCHEMA_VERSION,
      parity_scope: 'resumable_full_table_manifest',
      manifest_schema_version: DATA_DOMAIN_ROLLING_MANIFEST_SCHEMA_VERSION,
      manifest_page_limit: 25,
      ...dataDomainControlRevisionEvidence({ sourceRevision: 7, targetRevision: 11 }),
    }),
    checked_at: now,
  }
}

void (async () => {
  for (const table of [
    'model_artifact_registry',
    'expected_return_artifact_payloads',
    'model_champion_history',
    'model_champion_pointers',
  ]) {
    assert.equal(dataDomainManifestPageLimit(table, 500), 25)
  }

  assert.equal(dataDomainManifestPageLimit('allocator_ev_feature_snapshots', 400), 10)
  assert.equal(dataDomainManifestPageLimit('s12_replay_trade_outcomes', 4000), 500)
  assert.equal(dataDomainManifestPageLimit('s12_structure_snapshots', 4000), 100)
  assert.equal(dataDomainManifestPageLimit('meta_reward_ledger', 4000), 100)
  assert.equal(dataDomainManifestPageLimit('meta_shadow_decisions', 4000), 100)

  const rows: TestRow[] = Array.from({ length: 61 }, (_, index) => ({
    id: index + 1,
    payload: index % 5 === 0 ? null : index === 7 ? '  原始 JSON 空白 ✓  ' : `row-${index + 1}`,
  }))
  const canonicalLimits: number[] = []
  const canonicalSql: string[] = []
  const canonical = await boundedDataDomainTableManifest({
    db: tableDb(rows, canonicalLimits, canonicalSql),
    table: 'model_artifact_registry',
    columns: ['id', 'payload'],
    primaryKeys: ['id'],
    pageLimit: 500,
    mode: 'canonical',
  })
  assert.equal(canonical.rowCount, rows.length)
  assert.equal(canonical.checksum, await checksumRows(rows, ['id', 'payload']))
  assert.equal(canonicalRows(rows, ['id', 'payload']), JSON.stringify(rows))
  assert(canonicalLimits.every((limit) => limit <= 25))
  assert(canonicalSql.every((sql) => /ORDER BY[\s\S]+LIMIT \?/.test(sql)))

  const empty = await boundedDataDomainTableManifest({
    db: tableDb([], [], []),
    table: 'model_champion_history',
    columns: ['id', 'payload'],
    primaryKeys: ['id'],
    pageLimit: 500,
    mode: 'rolling',
  })
  assert.equal(
    empty.checksum,
    await checksumRollingManifest(null, await checksumRows([], ['id', 'payload']), 0),
  )
  assert.match(String(empty.checksum), /^[a-f0-9]{64}$/)

  const largeRows: TestRow[] = Array.from({ length: 7320 }, (_, index) => ({
    id: index + 1,
    payload: `payload-${index + 1}`,
  }))
  const largeLimits: number[] = []
  const large = await boundedDataDomainTableManifest({
    db: tableDb(largeRows, largeLimits, []),
    table: 'model_artifact_registry',
    columns: ['id', 'payload'],
    primaryKeys: ['id'],
    pageLimit: 4000,
    mode: 'rolling',
  })
  assert.equal(large.rowCount, 7320)
  assert.match(String(large.checksum), /^[a-f0-9]{64}$/)
  assert(largeLimits.every((limit) => limit === 25))
  assert(largeLimits.length >= Math.ceil(7320 / 25))

  const genericRows = rows.slice(0, 40)
  const generic20 = await boundedDataDomainTableManifest({
    db: tableDb(genericRows, [], []),
    table: 'generic_table',
    columns: ['id', 'payload'],
    primaryKeys: ['id'],
    pageLimit: 20,
    mode: 'rolling',
  })
  const generic25 = await boundedDataDomainTableManifest({
    db: tableDb(genericRows, [], []),
    table: 'generic_table',
    columns: ['id', 'payload'],
    primaryKeys: ['id'],
    pageLimit: 25,
    mode: 'rolling',
  })
  assert.notEqual(generic20.checksum, generic25.checksum)

  const valid = controlReceipt('2026-08-15T10:00:00Z')
  assert.equal(isAuthoritativeDataDomainFullTableParity(
    'model_artifact_registry', valid,
  ), true)
  assert.equal(isAuthoritativeDataDomainFullTableParity(
    'model_artifact_registry',
    { ...valid, source_count: 1.5, target_count: 1.5 },
  ), false)
  assert.equal(isAuthoritativeDataDomainFullTableParity(
    'model_artifact_registry',
    { ...valid, source_count: -1, target_count: -1 },
  ), false)
  assert.equal(isAuthoritativeDataDomainFullTableParity(
    'model_artifact_registry',
    { ...valid, source_checksum: 'A'.repeat(64), target_checksum: 'A'.repeat(64) },
  ), false)
  assert.equal(isDataDomainFullTableParityFresh(
    'model_artifact_registry',
    { ...valid, checked_at: '2026-08-15 10:00:00' },
    '2026-08-15T09:59:59Z',
  ), true)
  assert.equal(isDataDomainFullTableParityFresh(
    'model_artifact_registry',
    valid,
    '2026-08-15T10:00:01Z',
  ), false)
  assert.equal(isDataDomainFullTableParityFresh(
    'model_artifact_registry',
    valid,
    null,
  ), false)
  assert.equal(isDataDomainFullTableParityFresh(
    'generic_table',
    { ...valid, checked_at: '2026-08-15T10:00:00Z' },
    '2026-08-15T09:59:59Z',
  ), true)
  assert.equal(isDataDomainFullTableParityFresh(
    'generic_table',
    { ...valid, checked_at: '2026-08-15T10:00:00Z' },
    '2026-08-15T10:00:01Z',
  ), false)
  assert.equal(isDataDomainFullTableParityFresh(
    'generic_table',
    valid,
    null,
  ), true)
  assert.equal(isAuthoritativeDataDomainFullTableParity(
    'model_artifact_registry',
    { ...valid, evidence_json: JSON.stringify({ parity_scope: 'full_table_checksum' }) },
  ), false)
  assert.equal(isAuthoritativeDataDomainFullTableParity(
    'model_artifact_registry',
    {
      ...valid,
      evidence_json: JSON.stringify({
        ...JSON.parse(valid.evidence_json),
        source_revision: -1,
      }),
    },
  ), false)

  console.log('data domain shadow manifest tests passed')
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
