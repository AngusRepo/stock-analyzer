import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Miniflare } from 'miniflare'
import { readScreenerNewsSentiment, readScreenerForeignFlow } from './screenerOverlayReads'
import { loadCoreStockIdentitiesBySymbols, loadMarketPriceHistoryBySymbols } from './stockIdentityMarketBridge'
import { loadSelectionHistoryFlags } from './marketScreener'

test('explicit failed D1 responses cannot masquerade as empty successfully captured observations', async () => {
  const failed = { success: false, results: [] }
  const db = { prepare() { return { bind() { return this }, async all() { return failed } } } } as unknown as D1Database
  const env = { DB: db }
  await assert.rejects(readScreenerNewsSentiment(db, [1], '2026-09-09', '2026-09-09T12:00:00Z'), /news_query_failed/)
  await assert.rejects(readScreenerForeignFlow(db, '2026-09-09'), /foreign_query_failed/)
  await assert.rejects(loadSelectionHistoryFlags(db, ['2330'], '2026-09-09'), /selection_history_query_failed/)
  await assert.rejects(loadCoreStockIdentitiesBySymbols(env, ['2330'], { requireQuerySuccess: true }), /identity_query_failed/)
  const priceDb = { prepare(sql: string) { return { bind() { return this }, async all() {
    return sql.includes('FROM stocks') ? { success: true, results: [{ id: 1, symbol: '2330' }] } : failed
  } } } } as unknown as D1Database
  await assert.rejects(loadMarketPriceHistoryBySymbols({ DB: priceDb }, ['2330'],
    { onOrBeforeDate: '2026-09-09', requireQuerySuccess: true }), /price_history_query_failed/)
})

test('real local D1 news excludes future publication and late ingestion at the sealed cutoff', async () => {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("local") } }', d1Databases: ['NAV'] })
  try {
    const db = await mf.getD1Database('NAV')
    await db.prepare('CREATE TABLE news(stock_id INTEGER,sentiment TEXT,published_at TEXT,created_at TEXT)').run()
    const rows = [
      [1, 'positive', '2026-09-08T10:00:00Z', '2026-09-08 10:00:01'],
      [1, 'positive', '2026-09-08T23:30:00Z', '2026-09-08 23:31:00'],
      [1, 'negative', '2026-08-31T10:00:00Z', '2026-08-31 10:00:01'],
      [1, 'negative', '2026-09-09T15:00:00Z', '2026-09-09 15:00:01'],
      [1, 'negative', '2026-09-08T10:00:00Z', '2026-09-10 10:00:00'],
      [1, 'negative', '2026-09-09T16:00:00Z', '2026-09-09 16:00:00'],
      [2, 'negative', '2026-09-08T10:00:00Z', '2026-09-08 10:00:01'],
    ]
    for (const row of rows) await db.prepare('INSERT INTO news VALUES(?,?,?,?)').bind(...row).run()
    const current = await readScreenerNewsSentiment(db, [1], '2026-09-09', '2026-09-09T12:00:00Z')
    assert.deepEqual(current, [{ stock_id: 1, sentiment: 'positive', cnt: 2 }])
    const historical = await readScreenerNewsSentiment(db, [1], '2026-09-09', '2026-09-12T12:00:00Z')
    assert.deepEqual(historical, [
      { stock_id: 1, sentiment: 'negative', cnt: 1 },
      { stock_id: 1, sentiment: 'positive', cnt: 2 },
    ])
    // Original unbounded query shape includes the future and late-ingested news.
    const old = await db.prepare("SELECT COUNT(*) AS n FROM news WHERE stock_id=1 AND published_at>=date(?,'-7 days')")
      .bind('2026-09-09').first<{ n: number }>()
    assert.equal(old?.n, 5)
    assert.deepEqual(await readScreenerNewsSentiment(db, [], '2026-09-09', '2026-09-09T12:00:00Z'), [])
    await assert.rejects(readScreenerNewsSentiment(db, [1], '2026-02-30', '2026-09-09T12:00:00Z'), /signal_date_invalid/)
    await assert.rejects(readScreenerNewsSentiment(db, [1], '2026-09-09', '2026-09-09 12:00:00'), /observation_time_invalid/)
  } finally { await mf.dispose() }
})

test('real local D1 foreign flow cannot borrow future days to change regime or satisfy source coverage', async () => {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("local") } }', d1Databases: ['NAV'] })
  try {
    const db = await mf.getD1Database('NAV')
    for (const table of ['canonical_chip_daily', 'chip_data']) {
      await db.prepare(`CREATE TABLE ${table}(date TEXT,foreign_net REAL)`).run()
      for (let i = 20; i < 30; i++) await db.prepare(`INSERT INTO ${table} VALUES(?,1)`).bind(`2026-08-${i}`).run()
    }
    for (let i = 10; i < 30; i++) await db.prepare('INSERT INTO canonical_chip_daily VALUES(?,-100)').bind(`2026-09-${i}`).run()
    await db.prepare("INSERT INTO canonical_chip_daily VALUES('2026-07-01',-100)").run()
    const current = await readScreenerForeignFlow(db, '2026-09-09')
    assert.equal(current.source, 'canonical_chip_daily')
    assert.equal(current.rows.length, 10)
    assert(current.rows.every(r => r.total_foreign_net === 1 && r.date <= '2026-09-09'))
    const old = await db.prepare("SELECT date,SUM(foreign_net) AS total_foreign_net FROM canonical_chip_daily WHERE date>=date(?,'-40 days') GROUP BY date")
      .bind('2026-09-09').all<{ date: string; total_foreign_net: number }>()
    assert.equal(old.results.length, 30)
    assert.equal(old.results.filter(r => r.total_foreign_net > 0).length / old.results.length, 1 / 3)
    await db.prepare("DELETE FROM canonical_chip_daily WHERE date BETWEEN '2026-08-25' AND '2026-08-29'").run()
    const fallback = await readScreenerForeignFlow(db, '2026-09-09')
    assert.equal(fallback.source, 'legacy.chip_data')
    assert.equal(fallback.rows.length, 10)
    assert(fallback.rows.every(r => r.date <= '2026-09-09'))
    await db.prepare('DROP TABLE canonical_chip_daily').run()
    assert.deepEqual(await readScreenerForeignFlow(db, '2026-09-09'), fallback)
  } finally { await mf.dispose() }
})
