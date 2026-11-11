import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { updateScreenerWatchlist } from './marketScreener'

// Q03-SCR: the screener watchlist upsert must not overwrite stocks.sector for a candidate the
// FinLab owner has not classified (that value may be a Q03 fallback written by the projection).
function d1() {
  const sql = new DatabaseSync(':memory:')
  sql.exec(`CREATE TABLE stocks (id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    market TEXT NOT NULL DEFAULT 'TWSE', sector TEXT, in_current_watchlist INTEGER NOT NULL DEFAULT 1,
    added_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    source TEXT, pinned INTEGER DEFAULT 0)`)
  const prepare = (query: string) => {
    let params: any[] = []
    return { query, get params() { return params }, bind(...v: any[]) { params = v; return this },
      async all() { return { results: sql.prepare(query).all(...params), success: true } },
      async run() { sql.prepare(query).run(...params); return { success: true } } }
  }
  const db = { prepare, async batch(statements: any[]) {
    return statements.map(s => { sql.prepare(s.query).run(...s.params); return { success: true } })
  } } as unknown as D1Database
  return { sql, db }
}

const PLACEHOLDER = '?嗡?' // the screener's no-owner sector literal (marketScreener.ts taxonomyDisplay fallback)
const sectorOf = (sql: DatabaseSync, symbol: string) =>
  (sql.prepare('SELECT sector FROM stocks WHERE symbol=?').get(symbol) as { sector: string | null } | undefined)?.sector

test('a candidate without an owner industry keeps the projected sector', async () => {
  const { sql, db } = d1()
  sql.prepare("INSERT INTO stocks (symbol, name, sector, source, in_current_watchlist) VALUES ('3718','A','半導體業',NULL,0)").run()
  sql.prepare("INSERT INTO stocks (symbol, name, sector, source, in_current_watchlist) VALUES ('NVDA','N','unclassified','manual',0)").run()
  sql.prepare("INSERT INTO stocks (symbol, name, sector, source, in_current_watchlist, pinned) VALUES ('7934','B','電子零組件業','manual',0,1)").run()
  const owner = new Set(['2330'])
  await updateScreenerWatchlist(db, [
    { symbol: '3718', name: 'A', sector: PLACEHOLDER } as any,
    { symbol: 'NVDA', name: 'N', sector: PLACEHOLDER } as any,
    { symbol: '7934', name: 'B', sector: PLACEHOLDER } as any,
    { symbol: '2330', name: 'TSMC', sector: '半導體業' } as any,
  ], new Set(['3718']), symbol => owner.has(symbol))
  assert.equal(sectorOf(sql, '3718'), '半導體業')
  assert.equal(sectorOf(sql, 'NVDA'), 'unclassified')
  assert.equal(sectorOf(sql, '7934'), '電子零組件業')
  assert.equal(sectorOf(sql, '2330'), '半導體業')
  const rows = sql.prepare('SELECT symbol, market, source, in_current_watchlist w FROM stocks ORDER BY symbol').all()
  assert.deepEqual(rows.map((r: any) => [r.symbol, r.market, r.source, r.w]), [
    ['2330', 'TWSE', 'screener', 1], ['3718', 'OTC', 'screener', 1], ['7934', 'TWSE', 'manual', 1], ['NVDA', 'TWSE', 'screener', 1]])
})

test('an owner-classified candidate still writes its owner industry (unchanged behaviour)', async () => {
  const { sql, db } = d1()
  sql.prepare("INSERT INTO stocks (symbol, name, sector, source) VALUES ('2330','TSMC','old','screener')").run()
  await updateScreenerWatchlist(db, [{ symbol: '2330', name: 'TSMC', sector: '半導體業' } as any], new Set(), () => true)
  assert.equal(sectorOf(sql, '2330'), '半導體業')
})

test('a new unclassified candidate is inserted with a NULL sector instead of the placeholder', async () => {
  const { sql, db } = d1()
  await updateScreenerWatchlist(db, [{ symbol: '9999', name: 'New', sector: PLACEHOLDER } as any], new Set(), () => false)
  assert.equal(sectorOf(sql, '9999'), null)
})

test('the screener passes the FinLab owner industry as the predicate', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('./marketScreener.ts', import.meta.url), 'utf8')
  assert(source.includes("(symbol) => Boolean(taxonomyProfiles.get(symbol)?.industry || industryMap.get(symbol)))"))
  assert(source.includes('hasOwnerIndustry(c.symbol) ? c.sector : null'))
})
