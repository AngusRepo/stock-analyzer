import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DATA_DOMAINS } from './dataDomainRegistry'
import { loadTradingRestrictionBuckets, loadTradingRestrictionSet } from './tradingRestrictions'

// Both restriction tables are Market-owned; the frozen legacy copy stopped at the cutover.

class Statement {
  constructor(private readonly db: RestrictionDb, readonly sql: string) {}
  bind() { return this }
  async all<T>(): Promise<{ results: T[] }> {
    this.db.reads.push(this.sql)
    return { results: this.db.rows(this.sql) as T[] }
  }
  async first<T>(): Promise<T | null> { return ((await this.all<T>()).results[0] ?? null) }
}

class RestrictionDb {
  reads: string[] = []
  constructor(private readonly symbols: { canonical: string; governance: string }) {}
  rows(sql: string): unknown[] {
    if (sql.includes('FROM canonical_trading_restrictions') && sql.includes('MAX(source_date)')) {
      return [{ symbol: this.symbols.canonical, source: 'twse.attention', latest_source_date: '2026-11-04' }]
    }
    if (sql.includes('FROM canonical_trading_restrictions')) {
      return [{ symbol: this.symbols.canonical, restriction_type: 'attention', source: 'twse.attention' }]
    }
    if (sql.includes('FROM stock_trading_restrictions')) return [{ symbol: this.symbols.governance }]
    return []
  }
  prepare(sql: string) { return new Statement(this, sql) }
}

function env() {
  // Legacy holds a stale restriction set; Market holds the current one.
  const legacy = new RestrictionDb({ canonical: '1101', governance: '1102' })
  const market = new RestrictionDb({ canonical: '2330', governance: '2454' })
  const other = () => new RestrictionDb({ canonical: '9999', governance: '9998' }) as unknown as D1Database
  return {
    legacy, market,
    bindings: {
      DB: legacy, MARKET_DB: market,
      CORE_DB: other(), LEARNING_DB: other(), OPS_DB: other(), EXECUTION_DB: other(), PAPER_DB: other(), RESEARCH_DB: other(),
      MULTI_D1_ACTIVE_DOMAINS: DATA_DOMAINS.join(','), MULTI_D1_STRICT: 'true',
      KV: { get: async () => null },
    } as any,
  }
}

test('soft (risk-evidence) restrictions come from the Market D1, never the frozen legacy copy', async () => {
  const { legacy, market, bindings } = env()
  const set = await loadTradingRestrictionSet(bindings, '2026-11-05', { evidenceMode: 'historical_replay' })
  assert.deepEqual([...set.symbols].sort(), ['2330', '2454'])
  const buckets = await loadTradingRestrictionBuckets(bindings, '2026-11-05', { evidenceMode: 'historical_replay' })
  assert.deepEqual([...buckets.riskEvidenceSymbols].sort(), ['2330', '2454'])
  assert.equal(legacy.reads.length, 0)
  assert.ok(market.reads.some((sql) => sql.includes('FROM stock_trading_restrictions')))
})
