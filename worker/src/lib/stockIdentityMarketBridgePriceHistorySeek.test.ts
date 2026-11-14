import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import type { Bindings } from '../types'
import {
  loadAverageMarketVolumeBySymbols,
  loadCoreStockIdentitiesBySymbols,
  loadMarketPriceHistoryBySymbols,
  loadPreviousMarketCloseBySymbols,
  marketPriceHistorySql,
  type MarketPriceBridgeRow,
  type MarketPriceHistoryDateBound,
} from './stockIdentityMarketBridge'

// loadMarketPriceHistoryBySymbols ranked every stock_prices row of each id up to the cutoff (its
// whole history without one) to keep `rowsPerSymbol` rows: ~57M reads over 7 days, 174M over 31.
// The per-id seek must return the same rows in the same order and never walk a stock's history.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const schema = read('../../domain-schemas/market.sql')

type Options = Parameters<typeof loadMarketPriceHistoryBySymbols>[2]

/** The former loadMarketPriceHistoryBySymbols, verbatim apart from the env plumbing. */
async function legacyLoad(
  env: Pick<Bindings, 'DB'> & Partial<Bindings>,
  db: DatabaseSync,
  symbols: readonly string[],
  options: NonNullable<Options> = {},
): Promise<MarketPriceBridgeRow[]> {
  const identities = await loadCoreStockIdentitiesBySymbols(env, symbols, options)
  const byId = new Map([...identities.values()].map((row) => [Number(row.id), row.symbol]))
  const ids = [...byId.keys()]
  const rows: MarketPriceBridgeRow[] = []
  const perSymbol = Math.max(1, Math.min(500, Math.floor(options.rowsPerSymbol ?? 120)))
  for (let offset = 0; offset < ids.length; offset += 36) {
    const chunk = ids.slice(offset, offset + 36)
    const marks = chunk.map(() => '?').join(',')
    const dateClause = options.beforeDate
      ? 'AND date < ?'
      : options.onOrBeforeDate
        ? 'AND date <= ?'
        : ''
    const dateBinds = options.beforeDate
      ? [options.beforeDate]
      : options.onOrBeforeDate
        ? [options.onOrBeforeDate]
        : []
    const results = db.prepare(`
      SELECT stock_id, date, open, high, low, close, avg_price, volume
        FROM (
          SELECT stock_id, date, open, high, low, close, avg_price, volume,
                 ROW_NUMBER() OVER (PARTITION BY stock_id ORDER BY date DESC) AS rn
            FROM stock_prices
           WHERE stock_id IN (${marks})
             ${dateClause}
        )
       WHERE rn <= ?
       ORDER BY stock_id, date DESC
    `).all(...chunk, ...dateBinds, perSymbol as never) as unknown as Omit<MarketPriceBridgeRow, 'symbol'>[]
    for (const row of results ?? []) {
      const symbol = byId.get(Number(row.stock_id))
      if (symbol) rows.push({ ...row, stock_id: Number(row.stock_id), symbol })
    }
  }
  return rows
}

function openDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(schema.match(/CREATE TABLE IF NOT EXISTS stock_prices \([\s\S]*?\n\);/)![0])
  db.exec(read('../../domain-migrations/market/0004_legacy_schema_alignment.sql')
    .match(/ALTER TABLE stock_prices ADD COLUMN avg_price REAL;/)![0])
  for (const index of schema.matchAll(/CREATE INDEX IF NOT EXISTS \w+\s+ON stock_prices\([^;]*\);/g)) db.exec(index[0])
  // The identity read (core domain) shares the legacy DB binding in this fixture.
  db.exec(`CREATE TABLE stocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    market TEXT, listing_market TEXT, sector TEXT)`)
  return db
}

type Call = { sql: string; params: unknown[] }

function d1(db: DatabaseSync, log: Call[]): D1Database {
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

const day = (n: number) => new Date(Date.UTC(2026, 0, 1 + n)).toISOString().slice(0, 10)

/** Symbols the callers could pass, mapped to stock ids by the unchanged identity read. */
function seed(db: DatabaseSync): string[] {
  const stock = db.prepare('INSERT INTO stocks(id, symbol, name, market) VALUES (?, ?, ?, ?)')
  const price = db.prepare(`INSERT INTO stock_prices(stock_id, date, open, high, low, close, avg_price, volume)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
  db.exec('BEGIN')
  const symbols: string[] = []
  // 90 symbols: more than two chunks of 36. Ids are not in symbol order, so chunk order and the
  // per-chunk ORDER BY stock_id both matter.
  for (let k = 1; k <= 90; k++) {
    const id = ((k * 37) % 97) + 1
    const symbol = String(1000 + k)
    stock.run(id, symbol, `S${k}`, k % 2 ? 'TWSE' : 'OTC')
    symbols.push(symbol)
    if (k % 11 === 0) continue // listed, never priced
    const span = k % 9 === 0 ? 1 + (k % 4) : 20 + (k % 61) // a few short histories (< N rows)
    const start = k % 7
    // Insertion order differs from date order, so rowid order never decides the newest rows.
    for (let i = span; i >= 0; i -= 1) {
      const n = start + i * (1 + (k % 3))
      const open = (k + i) % 5 === 0 ? null : k * 10 + i
      price.run(id, day(n), open, open == null ? null : open + 1, open == null ? null : open - 1,
        (k + i) % 6 === 0 ? null : k + i / 10, (k + i) % 4 === 0 ? null : k + i / 100, (k + i) % 3 === 0 ? null : 1000 * k + i)
    }
  }
  // Same calendar day in several TEXT shapes: the text order decides, in both readers.
  stock.run(200, '9500', 'shapes', 'TWSE')
  for (const [date, open] of [[day(40), 1], [`${day(40)} 00:00:00`, 2], [`${day(40)}T09:00:00`, 3], ['20260210', 4]] as const) {
    price.run(200, date, open, open, open, open, open, open)
  }
  stock.run(201, '9501', 'late only', 'OTC')
  price.run(201, day(100), 5, 5, 5, 5, 5, 5) // after every cutoff but one
  stock.run(202, '9502', 'null row', 'TWSE')
  price.run(202, day(0), null, null, null, null, null, null) // an all-NULL row is still a row
  price.run(999, day(5), 1, 1, 1, 1, 1, 1) // priced id with no identity: never requested
  db.exec('COMMIT')
  return [...symbols, '9500', '9501', '9502']
}

const CUTOFFS = [day(-1), day(0), day(39), day(40), day(41), day(80), day(200), `${day(40)} 12:00:00`, '2026']
const COUNTS: (number | undefined)[] = [undefined, 1, 2, 3, 5, 60, 65, 121, 260, 500, 0, -3, 2.7, 1e6, Number.NaN]

test('UNIQUE(stock_id, date) rules out a same-date tie for either reader to break', () => {
  const db = openDb()
  try {
    db.prepare('INSERT INTO stock_prices(stock_id, date, open) VALUES (7, ?, 1)').run(day(3))
    assert.throws(() => db.prepare('INSERT INTO stock_prices(stock_id, date, open) VALUES (7, ?, 2)').run(day(3)), /UNIQUE/)
  } finally {
    db.close()
  }
})

test('the per-id seek returns the same rows, in the same order, as the ROW_NUMBER ranking', async () => {
  const db = openDb()
  try {
    const all = seed(db)
    const env = { DB: d1(db, []) } as unknown as Pick<Bindings, 'DB'> & Partial<Bindings>
    const symbolSets: string[][] = [
      all,
      ['9500', '9501', '9502', 'NOPE', '9999'],
      // duplicates, padding, blanks and unknown symbols, in a non-sorted order
      [' 1003 ', '1003', '', '   ', '1077', 'ZZZ', '1002', '1077', ...all.slice(10, 60).reverse()],
      ['NOPE'],
      [],
    ]
    const dateOptions: NonNullable<Options>[] = [
      {},
      ...CUTOFFS.map((cutoff) => ({ beforeDate: cutoff })),
      ...CUTOFFS.map((cutoff) => ({ onOrBeforeDate: cutoff })),
      { beforeDate: day(40), onOrBeforeDate: day(80) }, // beforeDate wins
      { beforeDate: '', onOrBeforeDate: day(40) }, // empty beforeDate falls through
      { beforeDate: '', onOrBeforeDate: '' }, // no bound at all
    ]
    let compared = 0
    let partial = 0
    for (const dates of dateOptions) {
      for (const rowsPerSymbol of COUNTS) {
        for (const symbols of symbolSets) {
          const options = { ...dates, rowsPerSymbol, requireQuerySuccess: compared % 2 === 0 }
          const seek = await loadMarketPriceHistoryBySymbols(env, symbols, options)
          const legacy = await legacyLoad(env, db, symbols, options)
          assert.deepEqual(seek.map((row) => ({ ...row })), legacy.map((row) => ({ ...row })),
            JSON.stringify({ ...options, symbols: symbols.length }))
          compared += 1
          if (legacy.length > 0 && symbols === all) {
            const ids = new Set(legacy.map((row) => row.stock_id))
            if (ids.size < 90) partial += 1
          }
        }
      }
    }
    assert.ok(compared > 1000, `compared ${compared} cases`)
    assert.ok(partial > 0, 'some cutoffs leave stocks with no row')
    const shapes = await loadMarketPriceHistoryBySymbols(env, ['9500', '9501', '9502'],
      { onOrBeforeDate: `${day(40)} 12:00:00`, rowsPerSymbol: 3 })
    assert.deepEqual(shapes.map((row) => [row.symbol, row.date]), [
      ['9500', `${day(40)} 00:00:00`], ['9500', day(40)], ['9502', day(0)],
    ], "text order: ' 00:00:00' sorts below the cutoff, 'T09:00:00' and '20260210' above it; 9501 has no row")
  } finally {
    db.close()
  }
})

test('the wrappers built on the history read return the same maps', async () => {
  const db = openDb()
  try {
    const all = seed(db)
    const env = { DB: d1(db, []) } as unknown as Pick<Bindings, 'DB'> & Partial<Bindings>
    for (const cutoff of [undefined, ...CUTOFFS]) {
      const previous = await loadPreviousMarketCloseBySymbols(env, all, cutoff)
      const legacyPrevious = new Map<string, { close: number; volume: number | null; date: string }>()
      for (const row of await legacyLoad(env, db, all, { beforeDate: cutoff, rowsPerSymbol: 1 })) {
        const close = Number(row.close)
        if (Number.isFinite(close)) legacyPrevious.set(row.symbol, { close, volume: row.volume, date: row.date })
      }
      assert.deepEqual([...previous], [...legacyPrevious], String(cutoff))
      for (const lookback of [1, 5, 20, 1000]) {
        const average = await loadAverageMarketVolumeBySymbols(env, all, cutoff, lookback)
        const totals = new Map<string, { total: number; count: number }>()
        for (const row of await legacyLoad(env, db, all, { beforeDate: cutoff, rowsPerSymbol: Math.min(260, lookback) })) {
          const volume = Number(row.volume)
          if (!Number.isFinite(volume)) continue
          const current = totals.get(row.symbol) ?? { total: 0, count: 0 }
          current.total += volume
          current.count += 1
          totals.set(row.symbol, current)
        }
        assert.deepEqual([...average], [...totals].map(([symbol, value]) => [symbol, value.total / Math.max(1, value.count)]),
          `${cutoff} ${lookback}`)
      }
    }
  } finally {
    db.close()
  }
})

test('each chunk of up to 36 ids is one statement with a JSON id list, cutoff and count', async () => {
  const db = openDb()
  try {
    const all = seed(db)
    const log: Call[] = []
    const env = { DB: d1(db, log) } as unknown as Pick<Bindings, 'DB'> & Partial<Bindings>
    await loadMarketPriceHistoryBySymbols(env, all, { beforeDate: day(30), rowsPerSymbol: 2 })
    const priceCalls = log.filter((call) => call.sql.includes('stock_prices'))
    assert.equal(priceCalls.length, 3, '93 ids -> chunks of 36, 36, 21')
    for (const call of priceCalls) {
      assert.equal(call.sql, marketPriceHistorySql('before'))
      assert.equal(call.params.length, 3)
      const ids = JSON.parse(String(call.params[0])) as number[]
      assert.ok(ids.length <= 36 && ids.every(Number.isSafeInteger))
      assert.deepEqual(call.params.slice(1), [day(30), 2])
    }
    log.length = 0
    await loadMarketPriceHistoryBySymbols(env, ['1001'], { rowsPerSymbol: 1 })
    assert.deepEqual(log.at(-1)?.params, ['[38]', 1], 'no cutoff: JSON ids and count only')
    log.length = 0
    assert.deepEqual(await loadMarketPriceHistoryBySymbols(env, ['NOPE', ''], {}), [])
    assert.equal(log.filter((call) => call.sql.includes('stock_prices')).length, 0, 'no ids, no price read')
    log.length = 0
    assert.deepEqual(await loadMarketPriceHistoryBySymbols(env, ['1001'], { rowsPerSymbol: Number.NaN }), [])
    assert.equal(log.filter((call) => call.sql.includes('stock_prices')).length, 0, 'NaN count: no rank matched before either')
  } finally {
    db.close()
  }
})

test('each id is one bounded backward seek on (stock_id, date); stock_prices is never scanned or sorted', () => {
  const db = openDb()
  try {
    seed(db)
    db.exec('ANALYZE')
    const binds: Record<MarketPriceHistoryDateBound, unknown[]> = {
      before: ['[1,2,3]', day(40), 5],
      on_or_before: ['[1,2,3]', day(40), 5],
      none: ['[1,2,3]', 5],
    }
    for (const bound of Object.keys(binds) as MarketPriceHistoryDateBound[]) {
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${marketPriceHistorySql(bound)}`).all(...(binds[bound] as never[]))
        .map((row) => ({ parent: Number(row.parent), detail: String(row.detail) }))
      const text = plan.map((row) => row.detail).join(' | ')
      assert.match(text, /^SCAN ids VIRTUAL TABLE/, text)
      assert.ok(plan.some((row) => row.detail === 'SEARCH sp USING INTEGER PRIMARY KEY (rowid=?)'), text)
      assert.ok(plan.some((row) => row.detail === 'CORRELATED LIST SUBQUERY 1'), text)
      const seek = bound === 'none' ? '\\(stock_id=\\?\\)' : '\\(stock_id=\\? AND date<\\?\\)'
      assert.ok(plan.some((row) => new RegExp(
        `^SEARCH recent USING COVERING INDEX (idx_prices_stock_date|sqlite_autoindex_stock_prices_1) ${seek}$`,
      ).test(row.detail)), text)
      assert.ok(!plan.some((row) => /^SCAN (sp|recent|stock_prices)\b/.test(row.detail)), text)
      // The only sorter is the final ORDER BY over the returned rows (<= 36 ids x LIMIT); the
      // per-id subquery reads (stock_id, date) backwards and stops at LIMIT, with no sort.
      const sorters = plan.filter((row) => /TEMP B-TREE/.test(row.detail))
      assert.deepEqual(sorters.map((row) => [row.parent, row.detail]), [[0, 'USE TEMP B-TREE FOR ORDER BY']], text)
    }
  } finally {
    db.close()
  }
})
