import assert from 'node:assert/strict'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { MOMENTUM_POOL_DEFINITION, assessZone, loadOversoldHistory, writeMomentumSnapshot } from './momentumZone'

// Wei 10/29 Q3: the percentile compares only snapshots of the same candidate-pool definition.
const sql = new DatabaseSync(':memory:')
for (const file of ['0002_runtime_owned_tables.sql', '0011_momentum_pool_definition.sql']) {
  sql.exec(fs.readFileSync(new URL(`../../domain-migrations/market/${file}`, import.meta.url), 'utf8'))
}
const statement = (query: string, args: any[] = []): any => ({
  bind: (...values: any[]) => statement(query, values),
  all: async () => ({ results: sql.prepare(query).all(...args) }),
  first: async () => sql.prepare(query).get(...args) ?? null,
  run: async () => sql.prepare(query).run(...args),
})
const db = { prepare: (query: string) => statement(query) } as any

const insert = sql.prepare(`INSERT INTO screener_momentum_snapshots
  (date, candidate_count, pct_oversold, zone, pool_definition) VALUES (?, ?, ?, 'GREEN', ?)`)
const dates = Array.from({ length: 80 }, (_, i) => new Date(Date.UTC(2026, 5, 1) + i * 86_400_000).toISOString().slice(0, 10))
dates.forEach((date, i) => insert.run(date, i < 40 ? 25 : 640, i < 40 ? 0.9 : 0.2 + i / 1000, i < 40 ? null : MOMENTUM_POOL_DEFINITION))

async function main() {
  const today = '2026-09-01'
  const history = await loadOversoldHistory(db, today)
  assert.equal(history.length, 40, 'NULL (pre-backfill) and other pools are excluded')
  assert(history.every((value) => value < 0.5), 'only the current pool definition contributes')
  assert.equal((await loadOversoldHistory(db, today, 'other-pool')).length, 0)
  assert.equal(assessZone(0.3, history).zone, 'GREEN', 'fewer than MIN_HISTORY comparable rows stay GREEN')

  await writeMomentumSnapshot(db, today, {
    avg_5d_return: 0, pct_oversold: 0.3, pct_overbought: 0, avg_dist_from_high: 0, breadth_score: 0, candidate_count: 600,
  }, assessZone(0.3, history))
  const row = sql.prepare('SELECT pool_definition, candidate_count FROM screener_momentum_snapshots WHERE date=?').get(today) as any
  assert.equal(row.pool_definition, MOMENTUM_POOL_DEFINITION)
  sql.prepare("UPDATE screener_momentum_snapshots SET pool_definition='old' WHERE date=?").run(today)
  await writeMomentumSnapshot(db, today, {
    avg_5d_return: 0, pct_oversold: 0.3, pct_overbought: 0, avg_dist_from_high: 0, breadth_score: 0, candidate_count: 610,
  }, assessZone(0.3, history))
  assert.equal((sql.prepare('SELECT pool_definition FROM screener_momentum_snapshots WHERE date=?').get(today) as any).pool_definition,
    MOMENTUM_POOL_DEFINITION, 'a rewrite carries the current definition')
  console.log('momentum zone pool definition tests passed')
}
main().catch((error) => { console.error(error); process.exit(1) })
