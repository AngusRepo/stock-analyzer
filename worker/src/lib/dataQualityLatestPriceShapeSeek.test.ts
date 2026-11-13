import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { LATEST_PRICE_SHAPES_SQL, loadLatestPriceShapes, type PriceShapeRow } from './dataQualityMonitor'

// The board-lane price shape read ranked every stock_prices row of each stock up to the cutoff
// (~130k reads per run, 17.5B over 31 days). The per-stock seek must return the same latest row
// per stock, drop the same stocks, and never walk a stock's history.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const schema = read('../../domain-schemas/market.sql')

function legacySql(count: number): string {
  return `
      WITH ranked AS (
        SELECT stock_id, open, avg_price,
               ROW_NUMBER() OVER (PARTITION BY stock_id ORDER BY date DESC) AS rn
          FROM stock_prices
         WHERE date <= ?
           AND stock_id IN (${Array.from({ length: count }, () => '?').join(',')})
      )
      SELECT stock_id, open, avg_price
        FROM ranked
       WHERE rn = 1
    `
}

/** The former loadLatestPriceShapes, chunks of 90 ids and all. */
function legacyLoad(db: DatabaseSync, cutoff: string, stockIds: number[]): Map<number, PriceShapeRow> {
  const uniqueIds = [...new Set(stockIds.filter((value) => Number.isFinite(value) && value > 0))]
  const output = new Map<number, PriceShapeRow>()
  for (let offset = 0; offset < uniqueIds.length; offset += 90) {
    const chunk = uniqueIds.slice(offset, offset + 90)
    for (const row of db.prepare(legacySql(chunk.length)).all(cutoff, ...chunk) as unknown as PriceShapeRow[]) {
      output.set(Number(row.stock_id), row)
    }
  }
  return output
}

function openDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(schema.match(/CREATE TABLE IF NOT EXISTS stock_prices \([\s\S]*?\n\);/)![0])
  db.exec(read('../../domain-migrations/market/0004_legacy_schema_alignment.sql')
    .match(/ALTER TABLE stock_prices ADD COLUMN avg_price REAL;/)![0])
  for (const index of schema.matchAll(/CREATE INDEX IF NOT EXISTS \w+\s+ON stock_prices\([^;]*\);/g)) db.exec(index[0])
  return db
}

const day = (n: number) => new Date(Date.UTC(2026, 0, 1 + n)).toISOString().slice(0, 10)
const CUTOFFS = [day(-1), day(0), day(39), day(40), day(41), day(80), `${day(40)} 12:00:00`, '2026', '']

function seed(db: DatabaseSync): number[] {
  const insert = db.prepare('INSERT INTO stock_prices(stock_id, date, open, avg_price) VALUES (?, ?, ?, ?)')
  db.exec('BEGIN')
  // Insertion order differs from date order, so rowid order never decides the latest row.
  for (let stock = 1; stock <= 240; stock++) {
    const span = 20 + (stock % 61)
    const start = stock % 7
    for (let i = span; i >= 0; i -= 1) {
      const n = start + i * (1 + (stock % 3))
      const open = (stock + i) % 5 === 0 ? null : stock * 10 + i
      const avg = (stock + i) % 4 === 0 ? null : stock + i / 100
      insert.run(stock, day(n), open, avg)
    }
  }
  // Same calendar day in several TEXT shapes: the text order decides, in both readers.
  for (const [date, open] of [[day(40), 1], [`${day(40)} 00:00:00`, 2], [`${day(40)}T09:00:00`, 3], ['20260210', 4]] as const) {
    insert.run(500, date, open, open)
  }
  insert.run(501, day(100), 5, 5) // only rows after every cutoff but one: absent from the map
  insert.run(502, day(0), null, null) // a row of NULL shapes is still the latest row
  db.exec('COMMIT')
  return [...Array.from({ length: 240 }, (_, i) => i + 1), 500, 501, 502]
}

function d1(db: DatabaseSync, log: { sql: string; params: unknown[] }[]): D1Database {
  return {
    prepare(sql: string) {
      let params: unknown[] = []
      const statement = {
        bind(...values: unknown[]) { params = values; return statement },
        async all() {
          log.push({ sql, params })
          return { success: true, results: db.prepare(sql).all(...(params as never[])), meta: {} }
        },
      }
      return statement
    },
  } as unknown as D1Database
}

const sorted = (map: Map<number, PriceShapeRow>) =>
  [...map.entries()].sort(([a], [b]) => a - b).map(([id, row]) => [id, { ...row }])

test('UNIQUE(stock_id, date) rules out a same-date tie for either reader to break', () => {
  const db = openDb()
  try {
    db.prepare('INSERT INTO stock_prices(stock_id, date, open) VALUES (7, ?, 1)').run(day(3))
    assert.throws(() => db.prepare('INSERT INTO stock_prices(stock_id, date, open) VALUES (7, ?, 2)').run(day(3)), /UNIQUE/)
  } finally {
    db.close()
  }
})

test('the per-stock seek returns the same latest price shapes as the ROW_NUMBER ranking', async () => {
  const db = openDb()
  try {
    const ids = seed(db)
    const idSets: number[][] = [
      ids,
      [500, 501, 502, 503, 999_999],
      // duplicates, invalid and non-integer ids, and more than one legacy chunk of 90
      [3, 3, 0, -4, Number.NaN, Number.POSITIVE_INFINITY, 2.5, 1e21, ...ids.slice(0, 150), 7, 500, 500],
      [0, -1, Number.NaN],
      [],
    ]
    const fullSizes = new Set<number>()
    for (const cutoff of CUTOFFS) {
      fullSizes.add(legacyLoad(db, cutoff, ids).size)
      for (const set of idSets) {
        const log: { sql: string; params: unknown[] }[] = []
        const seek = await loadLatestPriceShapes(d1(db, log), cutoff, set)
        const legacy = legacyLoad(db, cutoff, set)
        assert.deepEqual(sorted(seek), sorted(legacy), `${cutoff} ${set.length}`)
        assert.ok(log.length <= 1, 'one statement per call, whatever the id count')
      }
      // Raw rows match too (before the Map), for the full id list in one statement.
      const raw = (rows: unknown[]) => (rows as PriceShapeRow[]).map((row) => ({ ...row }))
        .sort((a, b) => Number(a.stock_id) - Number(b.stock_id))
      assert.deepEqual(
        raw(db.prepare(LATEST_PRICE_SHAPES_SQL).all(JSON.stringify(ids), cutoff)),
        raw(db.prepare(legacySql(ids.length)).all(cutoff, ...ids)),
        cutoff,
      )
    }
    assert.ok(fullSizes.has(0) && fullSizes.size >= 4, `cutoffs cover empty and partial maps: ${[...fullSizes]}`)
    const at40 = await loadLatestPriceShapes(d1(db, []), `${day(40)} 12:00:00`, [500, 501, 502])
    assert.equal(at40.get(500)?.open, 2, "text order: ' 00:00:00' sorts below the cutoff, 'T09:00:00' above it")
    assert.equal(at40.has(501), false, 'no row on or before the cutoff')
    assert.deepEqual({ ...at40.get(502) }, { stock_id: 502, open: null, avg_price: null })
  } finally {
    db.close()
  }
})

test('the seek binds one JSON id list and skips the read when no id is valid', async () => {
  const db = openDb()
  try {
    const log: { sql: string; params: unknown[] }[] = []
    await loadLatestPriceShapes(d1(db, log), day(5), [4, 4, 0, Number.NaN, 9])
    assert.deepEqual(log.map((entry) => entry.params), [['[4,9]', day(5)]])
    assert.equal(log[0].sql, LATEST_PRICE_SHAPES_SQL, 'the loader runs the plan-pinned seek SQL')
    await loadLatestPriceShapes(d1(db, log), day(5), [0, -2, Number.NaN])
    assert.equal(log.length, 1)
  } finally {
    db.close()
  }
})

test('each id is one backward seek on (stock_id, date) plus one rowid lookup', () => {
  const db = openDb()
  try {
    seed(db)
    db.exec('ANALYZE')
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${LATEST_PRICE_SHAPES_SQL}`).all('[1,2,3]', day(40))
      .map((row) => String(row.detail))
    const text = plan.join(' | ')
    assert.match(text, /^SCAN ids VIRTUAL TABLE/, text)
    assert.ok(plan.includes('SEARCH sp USING INTEGER PRIMARY KEY (rowid=?)'), text)
    assert.ok(plan.some((detail) =>
      /^SEARCH latest USING COVERING INDEX (idx_prices_stock_date|sqlite_autoindex_stock_prices_1) \(stock_id=\? AND date<\?\)$/
        .test(detail)), text)
    assert.ok(!plan.some((detail) => /^SCAN (sp|latest|stock_prices)\b|TEMP B-TREE/.test(detail)), text)
  } finally {
    db.close()
  }
})
