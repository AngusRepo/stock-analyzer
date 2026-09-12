import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { Miniflare } from 'miniflare'
import { writeScreenerSeedBatches, assertScreenerSeedWriteResults, readScreenerCoreBeforeWrite } from './screenerSeedPersistence'
import { pruneScreenerSeedRows } from './marketScreener'
import { buildScreenerSeedUpsertSql } from './screenerSeedQuality'
import { materializeScreenerCoreSeeds, screenerCoreSeedUpsertBindings } from './screenerCoreSeedMaterializer'

test('actual D1 pre-write capture retains schema, allocation identity, absent rows and original update state', async () => {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("local") } }', d1Databases: ['NAV'] })
  try {
    const db = await mf.getD1Database('NAV')
    await db.prepare('CREATE TABLE stocks(id INTEGER PRIMARY KEY,symbol TEXT UNIQUE,name TEXT,sector TEXT,market TEXT)').run()
    const schema = readFileSync(new URL('../../domain-migrations/core/0001_core_baseline.sql', import.meta.url), 'utf8')
    const table = schema.match(/CREATE TABLE IF NOT EXISTS daily_recommendations \([\s\S]*?\n\);/)![0]
    await db.prepare(table).run()
    await db.batch(['2330', '2317'].map((symbol, i) => db.prepare('INSERT INTO stocks VALUES(?,?,?,?,?)')
      .bind(i + 1, symbol, symbol, 'IC', 'TWSE')))
    const rows = materializeScreenerCoreSeeds(['2330', '2317'].map(symbol => ({ symbol, name: symbol,
      sector: 'IC', industry: 'IC', chip_score: 20, tech_score: 18, momentum_score: 10, strategy_pool_ids: ['base'] })), {
      prices: new Map([['2330', 100], ['2317', 50]]), selectionFlags: new Map(), sectorBonus: new Map(),
      breezeWatchPoints: new Map(), chipMetadata: new Map(), taxonomyPoints: new Map(), tpexSymbols: new Set(), allocationWeights: { base: 1 } })
    const first = await readScreenerCoreBeforeWrite(db, '2026-09-07', ['2330', '2317'])
    assert.equal(first.sequence, 0)
    assert.deepEqual(first.daily_rows, [])
    assert.equal(first.stock_rows.length, 2)
    await writeScreenerSeedBatches(db, [db.prepare(buildScreenerSeedUpsertSql()).bind(...screenerCoreSeedUpsertBindings('2026-09-07', rows[0]))])
    await db.prepare("UPDATE daily_recommendations SET signal='BUY',confidence=.8,ml_score=80,score=91,reason='ML owns' WHERE symbol='2330'").run()
    const captured = await readScreenerCoreBeforeWrite(db, '2026-09-07', ['2330', '2317'])
    assert.equal(captured.daily_rows.length, 1)
    assert.equal(captured.daily_rows[0].score, 91)
    assert.equal(captured.daily_rows[0].ml_score, 80)
    assert.equal(captured.sequence, 1)
    assert(captured.table_sql.includes('AUTOINCREMENT'))
    await writeScreenerSeedBatches(db, rows.map(row => db.prepare(buildScreenerSeedUpsertSql())
      .bind(...screenerCoreSeedUpsertBindings('2026-09-07', row))))
    const after = await db.prepare('SELECT symbol,score,signal FROM daily_recommendations ORDER BY symbol').all()
    assert.deepEqual(after.results, [{ symbol: '2317', score: 48, signal: null }, { symbol: '2330', score: 91, signal: 'BUY' }])
    assert.equal(captured.daily_rows.length, 1, 'captured before-state cannot mutate with the actual write')
    assert.equal(first.daily_rows.length, 0)
    const source = readFileSync(new URL('./marketScreener.ts', import.meta.url), 'utf8')
    assert(source.indexOf("atomicOverlayCapture.read('core_seed_persistence'") < source.indexOf('await writeScreenerSeedBatches('))
    assert(source.includes('.bind(...screenerCoreSeedUpsertBindings(endDate, row))'))
  } finally { await mf.dispose() }
})

test('real D1: second-batch failure retries idempotently and preserves existing ML-owned columns', async () => {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("local") } }', d1Databases: ['NAV'] })
  try {
    const db = await mf.getD1Database('NAV')
    await db.prepare('CREATE TABLE stocks(id INTEGER PRIMARY KEY,symbol TEXT UNIQUE)').run()
    await db.prepare(`CREATE TABLE daily_recommendations(date TEXT,stock_id INTEGER NOT NULL,symbol TEXT,name TEXT,sector TEXT,
      rank INTEGER,score REAL,chip_score REAL,tech_score REAL,momentum_score REAL,ml_score REAL,current_price REAL,
      reason TEXT,watch_points TEXT,score_components TEXT,has_buy_signal INTEGER,industry TEXT,market_segment TEXT,
      recommendation_lane TEXT,eligible_for_ml INTEGER,eligible_for_pending_buy INTEGER,signal TEXT,confidence REAL,
      UNIQUE(date,stock_id))`).run()
    const rows = Array.from({ length: 51 }, (_, i) => String(2000 + i))
    await db.batch(rows.map((symbol, i) => db.prepare('INSERT INTO stocks VALUES(?,?)').bind(i + 1, symbol)))
    const materialized = materializeScreenerCoreSeeds(rows.map(symbol => ({ symbol, name: symbol, sector: 'Semiconductor', industry: 'Semiconductor',
      chip_score: 20, tech_score: 18, momentum_score: 10, reason: 'frozen source', strategy_pool_ids: ['base'] })), {
      prices: new Map(rows.map(symbol => [symbol, 100])), sectorBonus: new Map(rows.map(symbol => [symbol, { bonus: 5, avgCorr: .9 }])),
      selectionFlags: new Map(), breezeWatchPoints: new Map(), chipMetadata: new Map(), taxonomyPoints: new Map(),
      tpexSymbols: new Set(), allocationWeights: { base: 1 } })
    const statements = materialized.map(({ seed, watchPoints, marketSegment, eligibleForPendingBuy }) => {
      const symbol = seed.row.symbol
      return db.prepare(buildScreenerSeedUpsertSql()).bind('2026-09-09', symbol, symbol, seed.row.name, seed.row.sector,
        seed.rank, seed.row.seedScore, seed.row.chipScore, seed.row.techScore, seed.row.momentumScore, seed.row.currentPrice,
        seed.row.reason, JSON.stringify(watchPoints), seed.row.scoreComponents, seed.row.industry, marketSegment, 'tradable', 1, eligibleForPendingBuy ? 1 : 0)
    })
    await assert.rejects(writeScreenerSeedBatches(db, [...statements.slice(0, 50), db.prepare('INSERT INTO missing_table VALUES(1)')]), /no such table/)
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM daily_recommendations').first<{ n: number }>())!.n, 50)
    await db.prepare("UPDATE daily_recommendations SET ml_score=88,score=91,rank=3,signal='BUY',confidence=.8,reason='ML owns this' WHERE symbol='2000'").run()
    await writeScreenerSeedBatches(db, statements)
    await writeScreenerSeedBatches(db, statements)
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM daily_recommendations').first<{ n: number }>())!.n, 51)
    const enriched = await db.prepare("SELECT score,ml_score,rank,reason FROM daily_recommendations WHERE symbol='2000'").first()
    assert.deepEqual(enriched, { score: 91, ml_score: 88, rank: 3, reason: 'ML owns this' })
    assert.equal((await db.prepare("SELECT score FROM daily_recommendations WHERE symbol='2050'").first<{ score: number }>())!.score, 53)
    assert.equal(await pruneScreenerSeedRows(db, '2026-09-09', rows.slice(0, 50)), 1)
    assert.equal(await pruneScreenerSeedRows(db, '2026-09-09', []), 50)
  } finally { await mf.dispose() }
})

test('failed/short acknowledgement and prune read failures cannot become canonical success', async () => {
  assert.throws(() => assertScreenerSeedWriteResults([{ success: false }], 1), /not_acknowledged/)
  assert.throws(() => assertScreenerSeedWriteResults([], 1), /not_acknowledged/)
  const db = { async batch() { return [{ success: false }] }, prepare() { return { bind() { return this },
    async all() { return { success: false, results: [] } }, async run() { return { success: false } } } } } as unknown as D1Database
  // Original unvalidated await resolved successfully; the actual new owner rejects it.
  await db.batch([{} as D1PreparedStatement])
  await assert.rejects(writeScreenerSeedBatches(db, [{} as D1PreparedStatement]), /not_acknowledged/)
  await assert.rejects(pruneScreenerSeedRows(db, '2026-09-09', ['2330']), /prune_read_failed/)
  await assert.rejects(pruneScreenerSeedRows(db, '2026-09-09', []), /not_acknowledged/)
  const source = readFileSync(new URL('./marketScreener.ts', import.meta.url), 'utf8')
  const failure = source.indexOf("throw new Error('screener_seed_persistence_failed'")
  assert(failure > source.indexOf('await writeScreenerSeedBatches('))
  assert(failure < source.indexOf('atomicShadowSource = await sealAtomicPostOverlaySource('))
})
