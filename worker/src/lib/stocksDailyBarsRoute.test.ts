import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { Hono } from 'hono'
import { stocks } from '../routes/stocks'

// 交易室盤前 K 線一次查多檔：查詢次數固定 2 次、兩段都走索引，不回到逐檔 LIKE 全表掃。
function sqliteD1(sql: DatabaseSync, seen: string[]): D1Database {
  return {
    prepare(query: string) {
      seen.push(query)
      let args: unknown[] = []
      const stmt = {
        bind(...values: unknown[]) { args = values; return stmt },
        async all() { return { results: sql.prepare(query).all(...(args as any[])) } },
        async first() { return sql.prepare(query).get(...(args as any[])) ?? null },
      }
      return stmt
    },
  } as unknown as D1Database
}

function openDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(readFileSync('domain-schemas/core.sql', 'utf8'))
  db.exec(readFileSync('domain-schemas/market.sql', 'utf8'))
  return db
}

function isoDaysAgo(n: number): string {
  return new Date(Date.now() - n * 86400000).toISOString().split('T')[0]
}

test('daily-bars returns the last bars per symbol with two indexed queries', async () => {
  const db = openDb()
  db.prepare("INSERT INTO stocks(id, symbol, name) VALUES (1, '2330', 'A'), (2, '2317', 'B'), (3, '2454', 'C')").run()
  const price = db.prepare('INSERT INTO stock_prices(stock_id, date, open, high, low, close) VALUES (?, ?, ?, ?, ?, ?)')
  for (let d = 40; d >= 0; d--) price.run(1, isoDaysAgo(d), 100 + d, 102 + d, 99 + d, 101 + d)
  for (let d = 5; d >= 0; d--) price.run(2, isoDaysAgo(d), 50, 51, 49, 50.5)
  price.run(2, isoDaysAgo(90), 1, 1, 1, 1) // 視窗外不回傳
  const seen: string[] = []
  const app = new Hono().route('/stocks', stocks as any)
  const res = await app.request('/stocks/daily-bars?symbols=2330,2317,9999,2330&limit=20', {}, { DB: sqliteD1(db, seen) } as any)
  assert.equal(res.status, 200)
  const body = await res.json() as { bars: Record<string, Array<{ date: string; open: number; close: number }>> }
  assert.deepEqual(Object.keys(body.bars).sort(), ['2317', '2330', '9999'])
  assert.equal(body.bars['2330'].length, 20)
  assert.equal(body.bars['2330'].at(-1)!.date, isoDaysAgo(0))
  assert.ok(body.bars['2330'][0].date < body.bars['2330'][19].date)
  assert.equal(body.bars['2317'].length, 6)
  assert.deepEqual(body.bars['9999'], [])

  assert.equal(seen.length, 2)
  assert.ok(seen.every((q) => !/LIKE/i.test(q)))
  const plans = seen.map((q) => db.prepare(`EXPLAIN QUERY PLAN ${q}`).all(...(q.includes('stock_prices') ? [1, 2, '2026-01-01'] : ['2330', '2317', '9999'])).map((r: any) => r.detail).join(' | '))
  assert.match(plans[0], /SEARCH stocks USING (COVERING )?INDEX/)
  assert.match(plans[1], /SEARCH stock_prices USING (COVERING )?INDEX idx_prices_stock_date/)
  for (const p of plans) assert.doesNotMatch(p, /\bSCAN\b/)
})

test('daily-bars rejects empty and oversized symbol lists before touching D1', async () => {
  const seen: string[] = []
  const app = new Hono().route('/stocks', stocks as any)
  const env = { DB: sqliteD1(openDb(), seen) } as any
  assert.equal((await app.request('/stocks/daily-bars?symbols=', {}, env)).status, 400)
  assert.equal((await app.request('/stocks/daily-bars?symbols=%27%3B--', {}, env)).status, 400)
  const many = Array.from({ length: 31 }, (_, i) => String(1000 + i)).join(',')
  assert.equal((await app.request(`/stocks/daily-bars?symbols=${many}`, {}, env)).status, 400)
  assert.equal(seen.length, 0)
})
