import assert from 'node:assert/strict'
import test from 'node:test'
import { syncForeignKeyAncestors } from './dataDomainShadowBackfill'

type TestColumn = {
  cid: number
  name: string
  type: string
  notnull: number
  pk: number
}

type TestForeignKey = {
  id: number
  seq: number
  table: string
  from: string
  to: string
}

type TestStatement = {
  sql: string
  values: unknown[]
  bind: (...values: unknown[]) => TestStatement
  all: <T>() => Promise<{ results: T[] }>
}

class TestD1 {
  readonly insertedTables: string[] = []
  readonly selectedTables: string[] = []

  constructor(
    private readonly schemas: Record<string, TestColumn[]>,
    private readonly foreignKeys: Record<string, TestForeignKey[]>,
    private readonly rows: Record<string, Record<string, unknown>[]>,
  ) {}

  prepare(sql: string): TestStatement {
    const statement: TestStatement = {
      sql,
      values: [],
      bind: (...values: unknown[]) => {
        statement.values = values
        return statement
      },
      all: async <T>() => ({ results: this.resultsFor(sql) as T[] }),
    }
    return statement
  }

  async batch(statements: TestStatement[]): Promise<unknown[]> {
    for (const statement of statements) {
      const table = statement.sql.match(/INSERT\s+INTO\s+"([^"]+)"/i)?.[1]
      if (!table) throw new Error(`unexpected_batch_statement:${statement.sql}`)
      this.insertedTables.push(table)
    }
    return []
  }

  private resultsFor(sql: string): unknown[] {
    const foreignKeyTable = sql.match(/PRAGMA\s+foreign_key_list\("([^"]+)"\)/i)?.[1]
    if (foreignKeyTable) return this.foreignKeys[foreignKeyTable] ?? []

    const tableInfoTable = sql.match(/PRAGMA\s+table_info\("([^"]+)"\)/i)?.[1]
    if (tableInfoTable) return this.schemas[tableInfoTable] ?? []

    const selectedTable = sql.match(/\bFROM\s+"([^"]+)"/i)?.[1]
    if (selectedTable) {
      this.selectedTables.push(selectedTable)
      return this.rows[selectedTable] ?? []
    }
    throw new Error(`unexpected_query:${sql}`)
  }
}

function column(name: string, pk = 0, type = 'INTEGER'): TestColumn {
  return { cid: 0, name, type, notnull: pk ? 1 : 0, pk }
}

function coreSchemas(): Record<string, TestColumn[]> {
  return {
    alert_notifications: [column('id', 1), column('rule_id')],
    alert_rules: [column('id', 1), column('user_id'), column('stock_id', 0, 'TEXT')],
    users: [column('id', 1), column('rule_id')],
    stocks: [column('id', 1, 'TEXT')],
    stock_prices: [column('id', 1)],
  }
}

function database(
  schemas: Record<string, TestColumn[]>,
  foreignKeys: Record<string, TestForeignKey[]>,
  rows: Record<string, Record<string, unknown>[]>,
): { raw: TestD1; d1: D1Database } {
  const raw = new TestD1(schemas, foreignKeys, rows)
  return { raw, d1: raw as unknown as D1Database }
}

test('syncs every same-domain FK ancestor before its child and deduplicates shared parents', async () => {
  const schemas = coreSchemas()
  const foreignKeys = {
    alert_notifications: [{ id: 0, seq: 0, table: 'alert_rules', from: 'rule_id', to: 'id' }],
    alert_rules: [
      { id: 0, seq: 0, table: 'users', from: 'user_id', to: 'id' },
      { id: 1, seq: 0, table: 'stocks', from: 'stock_id', to: 'id' },
    ],
  }
  const source = database(schemas, foreignKeys, {
    alert_rules: [{ id: 10, user_id: 1, stock_id: '2330' }],
    users: [{ id: 1, rule_id: null }],
    stocks: [{ id: '2330' }],
  })
  const target = database(schemas, foreignKeys, {})

  await syncForeignKeyAncestors(
    source.d1,
    target.d1,
    'core',
    'alert_notifications',
    [{ id: 100, rule_id: 10 }, { id: 101, rule_id: 10 }],
    ['id'],
  )

  assert.deepEqual(target.raw.insertedTables, ['users', 'stocks', 'alert_rules'])
  assert.equal(target.raw.insertedTables.includes('alert_notifications'), false)
  assert.deepEqual(source.raw.selectedTables, ['alert_rules', 'users', 'stocks'])
})

test('fails closed on a row-level FK cycle without writing either side', async () => {
  const schemas = coreSchemas()
  const foreignKeys = {
    alert_rules: [{ id: 0, seq: 0, table: 'users', from: 'user_id', to: 'id' }],
    users: [{ id: 0, seq: 0, table: 'alert_rules', from: 'rule_id', to: 'id' }],
  }
  const source = database(schemas, foreignKeys, {
    alert_rules: [{ id: 10, user_id: 1, stock_id: null }],
    users: [{ id: 1, rule_id: 10 }],
  })
  const target = database(schemas, foreignKeys, {})

  await assert.rejects(
    syncForeignKeyAncestors(
      source.d1,
      target.d1,
      'core',
      'alert_rules',
      [{ id: 10, user_id: 1, stock_id: null }],
      ['id'],
    ),
    /domain_shadow_foreign_key_cycle:alert_rules>users>alert_rules:alert_rules:\[10\]/,
  )
  assert.deepEqual(target.raw.insertedTables, [])
})

test('fails closed before reading or writing a cross-domain FK parent', async () => {
  const schemas = coreSchemas()
  const foreignKeys = {
    alert_rules: [{ id: 0, seq: 0, table: 'stock_prices', from: 'stock_id', to: 'id' }],
  }
  const source = database(schemas, foreignKeys, {
    stock_prices: [{ id: 2330 }],
  })
  const target = database(schemas, foreignKeys, {})

  await assert.rejects(
    syncForeignKeyAncestors(
      source.d1,
      target.d1,
      'core',
      'alert_rules',
      [{ id: 10, user_id: null, stock_id: 2330 }],
      ['id'],
    ),
    /domain_shadow_foreign_key_owner_mismatch:alert_rules:stock_prices/,
  )
  assert.deepEqual(source.raw.selectedTables, [])
  assert.deepEqual(target.raw.insertedTables, [])
})

test('does not mistake an acyclic same-table parent in the same batch for a cycle', async () => {
  const schemas = coreSchemas()
  const foreignKeys = {
    alert_rules: [{ id: 0, seq: 0, table: 'alert_rules', from: 'user_id', to: 'id' }],
  }
  const rows = [
    { id: 1, user_id: null, stock_id: null },
    { id: 2, user_id: 1, stock_id: null },
  ]
  const source = database(schemas, foreignKeys, { alert_rules: rows })
  const target = database(schemas, foreignKeys, {})

  await syncForeignKeyAncestors(
    source.d1,
    target.d1,
    'core',
    'alert_rules',
    rows,
    ['id'],
  )

  assert.deepEqual(target.raw.insertedTables, ['alert_rules'])
})
