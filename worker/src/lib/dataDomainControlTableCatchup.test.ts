import assert from 'node:assert/strict'
import test from 'node:test'
import type { Bindings } from '../types'
import { nextDataDomainIncrementalCatchupTable } from './dataDomainShadowBackfillDrain'
import { DATA_DOMAIN_CONTROL_REVISION_SCHEMA_VERSION } from './dataDomainControlRevision'
import {
  DATA_DOMAIN_CONTROL_FULL_TABLE_SCHEMA_VERSION,
  DATA_DOMAIN_ROLLING_MANIFEST_SCHEMA_VERSION,
} from './dataDomainShadowManifest'

class CatchupStatement {
  constructor(
    private readonly db: CatchupDb,
    readonly sql: string,
    readonly values: readonly unknown[] = [],
  ) {}

  bind(...values: unknown[]): CatchupStatement {
    return new CatchupStatement(this.db, this.sql, values)
  }

  async first<T>(): Promise<T | null> {
    return this.db.first(this.sql, this.values) as T | null
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.all(this.sql, this.values) as T[] }
  }
}

class CatchupDb {
  readonly batches: CatchupStatement[][] = []
  readonly cursorStatuses = new Map<string, string>([
    ['model_artifact_registry', 'complete'],
    ['model_champion_pointers', 'complete'],
  ])

  constructor(
    private readonly liveRegistryRows: number,
    private readonly controlPlane: boolean,
    private readonly liveRevision = 1,
  ) {}

  prepare(sql: string): CatchupStatement {
    return new CatchupStatement(this, sql)
  }

  async batch(statements: CatchupStatement[]): Promise<unknown[]> {
    this.batches.push(statements)
    for (const statement of statements) {
      if (!/data_domain_backfill_cursors/i.test(statement.sql)) continue
      const table = statement.values.map(String).find((value) => (
        value === 'model_artifact_registry' || value === 'model_champion_pointers'
      ))
      if (table && /status='running'|VALUES\s*\([^)]*'running'/is.test(statement.sql)) {
        this.cursorStatuses.set(table, 'running')
      }
    }
    return statements.map(() => ({ success: true }))
  }

  first(sql: string, values: readonly unknown[]): unknown {
    if (/FROM\s+data_domain_cutovers/i.test(sql)) {
      return { status: 'legacy', writer_state: 'open' }
    }
    if (/FROM\s+data_domain_backfill_cursors/i.test(sql)) {
      const table = String(values[0])
      const status = this.cursorStatuses.get(table)
      const rows = table === 'model_artifact_registry' ? 244 : 0
      return status ? {
        status,
        cursor_json: null,
        rows_copied: rows,
        last_source_checksum: 'a'.repeat(64),
        last_target_checksum: 'a'.repeat(64),
      } : null
    }
    if (/FROM\s+data_domain_parity_checks/i.test(sql)) {
      const table = String(values[0])
      const rows = table === 'model_artifact_registry' ? 244 : 0
      return {
        status: 'pass',
        source_count: rows,
        target_count: rows,
        source_checksum: 'a'.repeat(64),
        target_checksum: 'a'.repeat(64),
        evidence_json: JSON.stringify({
          schema_version: DATA_DOMAIN_CONTROL_FULL_TABLE_SCHEMA_VERSION,
          parity_scope: 'resumable_full_table_manifest',
          manifest_schema_version: DATA_DOMAIN_ROLLING_MANIFEST_SCHEMA_VERSION,
          manifest_page_limit: 25,
          revision_schema_version: DATA_DOMAIN_CONTROL_REVISION_SCHEMA_VERSION,
          source_revision: 1,
          target_revision: 1,
        }),
        checked_at: '2026-08-15 10:00:00',
      }
    }
    if (/FROM\s+data_domain_control_revisions/i.test(sql)) {
      return { revision: this.liveRevision }
    }
    const countTable = sql.match(/SELECT\s+COUNT\(\*\)\s+(?:count|AS\s+row_count)\s+FROM\s+"([^"]+)"/i)?.[1]
    if (countTable === 'model_artifact_registry') return { count: this.liveRegistryRows, row_count: this.liveRegistryRows }
    if (countTable === 'model_champion_pointers') return { count: 0, row_count: 0 }
    throw new Error(`unexpected_catchup_first:${this.controlPlane}:${sql}`)
  }

  all(sql: string, _values: readonly unknown[]): unknown[] {
    if (/SELECT\s+table_name\s+FROM\s+data_domain_backfill_cursors/i.test(sql)) {
      return [...this.cursorStatuses]
        .filter(([, status]) => status === 'complete')
        .map(([table_name]) => ({ table_name }))
    }
    throw new Error(`unexpected_catchup_all:${this.controlPlane}:${sql}`)
  }
}

test('live count growth invalidates the stale parent receipt and dependent pointer only', async () => {
  const source = new CatchupDb(245, true)
  const target = new CatchupDb(245, false)
  const selected = await nextDataDomainIncrementalCatchupTable({
    DB: source as unknown as D1Database,
    LEARNING_DB: target as unknown as D1Database,
    MULTI_D1_ACTIVE_DOMAINS: '',
    MULTI_D1_STRICT: 'false',
  } as Bindings, 'learning', '2026-08-15T10:00:00.000Z', true)

  assert.equal(selected, 'model_artifact_registry')
  assert.equal(source.batches.length, 1)
  assert.equal(source.cursorStatuses.get('model_artifact_registry'), 'running')
  assert.equal(source.cursorStatuses.get('model_champion_pointers'), 'complete')
  const mutationText = source.batches[0]
    .flatMap((statement) => [statement.sql, ...statement.values.map(String)])
    .join('\n')
  assert.match(mutationText, /receipt_live_count_mismatch:244\/245/)
  assert.match(mutationText, /model_artifact_registry/)
  assert.match(mutationText, /model_champion_pointers/)
  assert.doesNotMatch(mutationText, /expected_return_artifact_payloads|model_champion_history/)
})

test('same-count source revision drift invalidates an otherwise matching receipt', async () => {
  const source = new CatchupDb(244, true, 2)
  const target = new CatchupDb(244, false, 1)
  const selected = await nextDataDomainIncrementalCatchupTable({
    DB: source as unknown as D1Database,
    LEARNING_DB: target as unknown as D1Database,
    MULTI_D1_ACTIVE_DOMAINS: '',
    MULTI_D1_STRICT: 'false',
  } as Bindings, 'learning', '2026-08-15T10:00:00.000Z', true)

  assert.equal(selected, 'model_artifact_registry')
  assert.equal(source.batches.length, 1)
  const mutationText = source.batches[0]
    .flatMap((statement) => [statement.sql, ...statement.values.map(String)])
    .join('\n')
  assert.match(mutationText, /source_revision_stale:1\/2/)
  assert.match(mutationText, /model_artifact_registry/)
  assert.match(mutationText, /model_champion_pointers/)
})
