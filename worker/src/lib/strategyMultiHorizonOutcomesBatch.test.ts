import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { persistOutcomes } from './strategyMultiHorizonOutcomes'

async function main(): Promise<void> {
const sqlite = new DatabaseSync(':memory:')
sqlite.exec(`
  CREATE TABLE canonical_selection_outcomes_v1 (
    signal_date TEXT NOT NULL,
    symbol TEXT NOT NULL,
    producer_run_id TEXT NOT NULL,
    horizon_days INTEGER NOT NULL,
    label_schema_version TEXT NOT NULL,
    market_segment TEXT,
    sector TEXT,
    entry_date TEXT NOT NULL,
    exit_date TEXT NOT NULL,
    outcome_known_date TEXT NOT NULL,
    gross_return REAL NOT NULL,
    transaction_cost_bps REAL NOT NULL,
    absolute_return_net REAL NOT NULL,
    benchmark_return_net REAL NOT NULL,
    benchmark_scope TEXT NOT NULL,
    residual_return_net REAL NOT NULL,
    cross_section_rank REAL NOT NULL,
    adjustment_source TEXT NOT NULL,
    reference_contract_version TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(signal_date, symbol, producer_run_id, horizon_days, label_schema_version)
  )
`)

type Statement = { sql: string; args: unknown[] }
const batches: number[] = []
const db = {
  prepare(sql: string) {
    return { bind(...args: unknown[]): Statement { return { sql, args } } }
  },
  async batch(statements: Statement[]) {
    batches.push(statements.length)
    for (const statement of statements) sqlite.prepare(statement.sql).run(...statement.args as [])
    return []
  },
} as unknown as D1Database

const rows = Array.from({ length: 105 }, (_, index) => ({
  reference: {
    signal_date: '2026-09-15',
    symbol: `台股-${index}`,
    producer_run_id: 'canonical-run',
    stock_id: index + 1,
    market_segment: null,
    sector: '電子',
    feature_contract_version: 'selection-v1',
  },
  horizonDays: 5,
  entryDate: '2026-09-16',
  exitDate: '2026-09-22',
  grossReturn: 0.1 + index / 10000,
  absoluteReturnNet: 0.0982 + index / 10000,
  benchmarkReturnNet: 0.03,
  benchmarkScope: 'sector' as const,
  residualReturnNet: 0.0682 + index / 10000,
  crossSectionRank: index / 104,
}))

assert.equal(await persistOutcomes(db, rows, 18), 105)
assert.deepEqual(batches, [2])
assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM canonical_selection_outcomes_v1').get()?.n, 105)
const first = sqlite.prepare("SELECT symbol, market_segment, sector, outcome_known_date, gross_return, transaction_cost_bps, reference_contract_version FROM canonical_selection_outcomes_v1 WHERE symbol='台股-0'").get()
assert.deepEqual({ ...first }, {
  symbol: '台股-0',
  market_segment: null,
  sector: '電子',
  outcome_known_date: '2026-09-22',
  gross_return: 0.1,
  transaction_cost_bps: 18,
  reference_contract_version: 'selection-v1',
})

rows[0].grossReturn = 0.2
assert.equal(await persistOutcomes(db, rows, 18), 105)
assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM canonical_selection_outcomes_v1').get()?.n, 105)
assert.equal(sqlite.prepare("SELECT gross_return FROM canonical_selection_outcomes_v1 WHERE symbol='台股-0'").get()?.gross_return, 0.2)
sqlite.close()
console.log('strategy multi-horizon outcome JSON batch tests passed')
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

