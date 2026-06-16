import assert from 'node:assert'
import { replacePendingBuyState } from './pendingBuyStore'

class FakeKV {
  writes: Array<{ key: string; value: string }> = []
  async put(key: string, value: string) {
    this.writes.push({ key, value })
  }
}

class MissingTableStmt {
  bind() { return this }
  async run() {
    throw new Error('no such table: pending_buy_runs')
  }
  async first() {
    throw new Error('no such table: pending_buy_runs')
  }
  async all() {
    throw new Error('no such table: pending_buy_runs')
  }
}

class MissingTableDB {
  prepare() { return new MissingTableStmt() }
}

class InvalidRunIdStmt {
  constructor(private sql: string) {}
  bind() { return this }
  async run() {
    return {}
  }
  async first() {
    if (this.sql.includes('INSERT INTO pending_buy_runs')) return { id: 0 }
    return null
  }
  async all() {
    return { results: [] }
  }
}

class InvalidRunIdDB {
  prepare(sql: string) { return new InvalidRunIdStmt(sql) }
}

function envFor(db: unknown, kv: FakeKV) {
  return { DB: db, KV: kv } as any
}

async function run(): Promise<void> {
  {
    const kv = new FakeKV()
    await assert.rejects(
      () => replacePendingBuyState(envFor(new MissingTableDB(), kv), {
        tradeDate: '2026-06-16',
        status: 'empty',
        pendingBuys: [],
      }),
      /no such table/,
      'missing pending-buy D1 tables must fail instead of falling back to KV',
    )
    assert.equal(kv.writes.length, 0, 'KV must not be written after D1 source-of-truth failure')
  }

  {
    const kv = new FakeKV()
    await assert.rejects(
      () => replacePendingBuyState(envFor(new InvalidRunIdDB(), kv), {
        tradeDate: '2026-06-16',
        status: 'empty',
        pendingBuys: [],
      }),
      /pending_buy_runs insert did not return id/,
      'pending-buy run id must be durable even for empty runs',
    )
    assert.equal(kv.writes.length, 0, 'KV must not be written when D1 run id is missing')
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
