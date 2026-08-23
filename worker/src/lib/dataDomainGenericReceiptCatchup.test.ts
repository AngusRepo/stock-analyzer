import assert from 'node:assert/strict'
import test from 'node:test'
import type { Bindings } from '../types'
import { nextDataDomainIncrementalCatchupTable } from './dataDomainShadowBackfillDrain'

class ReceiptStatement {
  constructor(
    private readonly db: ReceiptDb,
    readonly sql: string,
    readonly values: readonly unknown[] = [],
  ) {}

  bind(...values: unknown[]): ReceiptStatement {
    return new ReceiptStatement(this.db, this.sql, values)
  }

  async first<T>(): Promise<T | null> {
    return this.db.first(this.sql) as T | null
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.all(this.sql) as T[] }
  }

  async run(): Promise<never> {
    this.db.writes += 1
    throw new Error(`unexpected_receipt_write:${this.sql}`)
  }
}

class ReceiptDb {
  writes = 0
  readonly mutationText: string[] = []

  constructor(
    private readonly side: 'source' | 'target',
    private readonly receiptStatus: 'pass' | 'blocked' = 'blocked',
    private readonly checkedAt = '2026-08-15 10:00:00',
  ) {}

  prepare(sql: string): ReceiptStatement {
    return new ReceiptStatement(this, sql)
  }

  async batch(statements: ReceiptStatement[]): Promise<unknown[]> {
    this.writes += 1
    this.mutationText.push(...statements.flatMap((statement) => [
      statement.sql,
      ...statement.values.map(String),
    ]))
    return statements.map(() => ({ success: true }))
  }

  first(sql: string): unknown {
    if (/FROM\s+data_domain_cutovers/i.test(sql)) {
      if (this.side !== 'source') throw new Error(`unexpected_target_cutover:${sql}`)
      return { status: 'legacy', writer_state: 'open' }
    }
    if (/SELECT\s+COUNT\(\*\)\s+AS\s+row_count\s+FROM\s+"users"/i.test(sql)) {
      return { row_count: 1 }
    }
    if (/FROM\s+data_domain_parity_checks/i.test(sql)) {
      if (this.side !== 'source') throw new Error(`unexpected_target_parity:${sql}`)
      return {
        status: this.receiptStatus,
        source_count: this.receiptStatus === 'pass' ? 1 : null,
        target_count: this.receiptStatus === 'pass' ? 1 : null,
        source_checksum: this.receiptStatus === 'pass' ? 'a'.repeat(64) : null,
        target_checksum: this.receiptStatus === 'pass' ? 'a'.repeat(64) : null,
        checked_at: this.checkedAt,
      }
    }
    throw new Error(`unexpected_receipt_first:${this.side}:${sql}`)
  }

  all(sql: string): unknown[] {
    if (/SELECT\s+table_name\s+FROM\s+data_domain_backfill_cursors/i.test(sql)) {
      if (this.side !== 'source') throw new Error(`unexpected_target_cursor:${sql}`)
      return [{ table_name: 'users' }]
    }
    if (/PRAGMA\s+table_info\("users"\)/i.test(sql)) return []
    throw new Error(`unexpected_receipt_all:${this.side}:${sql}`)
  }
}

test('completed generic parent with blocked receipt is selected for parity-only refresh', async () => {
  const source = new ReceiptDb('source')
  const target = new ReceiptDb('target')
  const selected = await nextDataDomainIncrementalCatchupTable({
    DB: source as unknown as D1Database,
    CORE_DB: target as unknown as D1Database,
    MULTI_D1_ACTIVE_DOMAINS: '',
    MULTI_D1_STRICT: 'false',
  } as Bindings, 'core', '2026-08-15T10:00:00.000Z', true)

  assert.equal(selected, 'users')
  assert.equal(source.writes, 0)
  assert.equal(target.writes, 0)
})

test('same-count generic table with a pre-session receipt is invalidated for parity-only refresh', async () => {
  const source = new ReceiptDb('source', 'pass', '2026-08-15 09:59:59')
  const target = new ReceiptDb('target', 'pass', '2026-08-15 09:59:59')
  const selected = await nextDataDomainIncrementalCatchupTable({
    DB: source as unknown as D1Database,
    CORE_DB: target as unknown as D1Database,
    MULTI_D1_ACTIVE_DOMAINS: '',
    MULTI_D1_STRICT: 'false',
  } as Bindings, 'core', '2026-08-15T10:00:00.000Z', true)

  assert.equal(selected, 'users')
  assert.equal(source.writes, 1)
  assert.equal(target.writes, 0)
  assert.match(source.mutationText.join('\n'), /generic_receipt_refresh:session_watermark_stale/)
  assert.match(source.mutationText.join('\n'), /status='blocked'/)
  assert.match(source.mutationText.join('\n'), /status='legacy'/)
})

test('same-count generic table with a current-session receipt remains complete', async () => {
  const source = new ReceiptDb('source', 'pass', '2026-08-15 10:00:00')
  const target = new ReceiptDb('target', 'pass', '2026-08-15 10:00:00')
  const selected = await nextDataDomainIncrementalCatchupTable({
    DB: source as unknown as D1Database,
    CORE_DB: target as unknown as D1Database,
    MULTI_D1_ACTIVE_DOMAINS: '',
    MULTI_D1_STRICT: 'false',
  } as Bindings, 'core', '2026-08-15T10:00:00.000Z', true)

  assert.equal(selected, null)
  assert.equal(source.writes, 0)
  assert.equal(target.writes, 0)
})
