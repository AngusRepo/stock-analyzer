import assert from 'node:assert/strict'
import test from 'node:test'
import type { Bindings } from '../types'
import { nextDataDomainIncrementalCatchupTable } from './dataDomainShadowBackfillDrain'

class OrderingStatement {
  constructor(
    private readonly db: OrderingDb,
    readonly sql: string,
    readonly values: readonly unknown[] = [],
  ) {}

  bind(...values: unknown[]): OrderingStatement {
    return new OrderingStatement(this.db, this.sql, values)
  }

  async first<T>(): Promise<T | null> {
    return this.db.first(this.sql, this.values) as T | null
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.all(this.sql) as T[] }
  }

  async run(): Promise<never> {
    this.db.writes += 1
    throw new Error(`unexpected_ordering_write:${this.sql}`)
  }
}

class OrderingDb {
  writes = 0

  constructor(
    private readonly side: 'source' | 'target',
    private readonly completedTables = ['alert_rules', 'alert_notifications'],
    private readonly deferredParent = false,
  ) {}

  prepare(sql: string): OrderingStatement {
    return new OrderingStatement(this, sql)
  }

  async batch(_statements: OrderingStatement[]): Promise<never> {
    this.writes += 1
    throw new Error('unexpected_ordering_batch')
  }

  first(sql: string, values: readonly unknown[]): unknown {
    if (/SELECT\s+status\s+FROM\s+data_domain_cutovers/i.test(sql)) {
      if (this.side !== 'source') throw new Error(`unexpected_target_cutover_query:${sql}`)
      return { status: 'legacy' }
    }
    if (/FROM\s+data_domain_parity_checks/i.test(sql)) {
      if (
        this.side === 'source'
        && this.deferredParent
        && String(values[0]).includes(':alert_rules:delete-progress')
      ) {
        return {
          evidence_json: JSON.stringify({
            phase: 'waiting_for_dependents',
            blockers: ['alert_notifications:physical_foreign_key_reference'],
          }),
        }
      }
      return null
    }
    const table = sql.match(/SELECT\s+COUNT\(\*\)\s+AS\s+row_count\s+FROM\s+"([^"]+)"/i)?.[1]
    if (table === 'alert_rules' || table === 'alert_notifications') {
      return { row_count: this.side === 'source' ? 0 : 1 }
    }
    throw new Error(`unexpected_ordering_first:${this.side}:${sql}`)
  }

  all(sql: string): unknown[] {
    if (/SELECT\s+table_name\s+FROM\s+data_domain_backfill_cursors/i.test(sql)) {
      if (this.side !== 'source') throw new Error(`unexpected_target_cursor_query:${sql}`)
      return this.completedTables.map((table_name) => ({ table_name }))
    }
    throw new Error(`unexpected_ordering_all:${this.side}:${sql}`)
  }
}

test('target-only FK reconciliation selects the child before its restricted parent', async () => {
  const source = new OrderingDb('source')
  const target = new OrderingDb('target')
  const selected = await nextDataDomainIncrementalCatchupTable({
    DB: source as unknown as D1Database,
    CORE_DB: target as unknown as D1Database,
    MULTI_D1_ACTIVE_DOMAINS: '',
    MULTI_D1_STRICT: 'false',
  } as Bindings, 'core', '2026-08-15T10:00:00.000Z', false)

  assert.equal(selected, 'alert_notifications')
  assert.equal(source.writes, 0)
  assert.equal(target.writes, 0)
})

test('deferred parent does not livelock ahead of its running FK child', async () => {
  const source = new OrderingDb('source', ['alert_rules'], true)
  const target = new OrderingDb('target', [], true)
  const selected = await nextDataDomainIncrementalCatchupTable({
    DB: source as unknown as D1Database,
    CORE_DB: target as unknown as D1Database,
    MULTI_D1_ACTIVE_DOMAINS: '',
    MULTI_D1_STRICT: 'false',
  } as Bindings, 'core', '2026-08-15T10:00:00.000Z', false)

  assert.equal(selected, 'alert_notifications')
  assert.equal(source.writes, 0)
  assert.equal(target.writes, 0)
})
