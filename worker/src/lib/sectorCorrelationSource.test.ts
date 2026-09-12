import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { Miniflare } from 'miniflare'
import { readSectorLeaderBonusSnapshot } from './sectorCorrelationSource'
import { computeSectorLeaderBonusFromInputs, sectorLeaderBonusBatch } from './sectorCorrelation'
import { buildScreenerSeedRow } from './screenerSeedQuality'

test('real D1: original kernel parity, future-price exclusion, cold/future cache reconstruction without writes', async () => {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("local") } }', d1Databases: ['NAV'] })
  try {
    const db = await mf.getD1Database('NAV')
    await db.prepare('CREATE TABLE stocks(id INTEGER PRIMARY KEY,symbol TEXT,name TEXT,market TEXT,sector TEXT)').run()
    await db.prepare(`CREATE TABLE stock_prices(stock_id INTEGER,date TEXT,open REAL,high REAL,low REAL,close REAL,
      avg_price REAL,volume REAL,PRIMARY KEY(stock_id,date))`).run()
    await db.prepare('CREATE TABLE sector_leaders(sector TEXT,symbol TEXT,rank INTEGER,computed_at TEXT)').run()
    const symbols = ['2330', '2317', '2454', '2308']
    for (const [index, symbol] of symbols.entries()) {
      await db.prepare("INSERT INTO stocks VALUES(?,?,?,'TWSE','STALE_CORE_CLASSIFICATION')").bind(index + 1, symbol, symbol).run()
    }
    for (const [index, symbol] of symbols.slice(1).entries()) {
      await db.prepare("INSERT INTO sector_leaders VALUES('Semiconductor',?,?,'2026-09-08 10:00:00')").bind(symbol, index + 1).run()
    }
    const end = Date.parse('2026-09-09T00:00:00Z')
    const closes = new Map(symbols.map(symbol => [symbol, 100]))
    async function insertPrices(first: number, last: number, future: boolean) {
      const statements: D1PreparedStatement[] = []
      for (let i = first; i <= last; i++) {
        const date = new Date(end + i * 86400_000).toISOString().slice(0, 10)
        const ret = [.02, -.015, .01, -.005][((i % 4) + 4) % 4]
        for (const [j, symbol] of symbols.entries()) {
          const close = closes.get(symbol)! * (1 + (future && j > 0 ? -ret : ret))
          closes.set(symbol, close)
          const volume = j === 0 ? 1000 : (5 - j) * 1000000
          statements.push(db.prepare('INSERT INTO stock_prices VALUES(?,?,?,?,?,?,?,?)')
            .bind(j + 1, date, close, close + 1, close - 1, close, close, volume))
        }
      }
      for (let i = 0; i < statements.length; i += 40) await db.batch(statements.slice(i, i + 40))
    }
    await insertPrices(-69, 0, false)
    const env = { DB: db }
    const request = { signalDate: '2026-09-09', observedAt: '2026-09-09T12:00:00Z',
      candidates: [{ symbol: '2330', sector: 'Semiconductor' }],
      fullIndustryUniverse: symbols.map(symbol => ({ symbol, sector: 'Semiconductor' })), corrThreshold: .7, bonusPoints: 5 }
    const before = await readSectorLeaderBonusSnapshot(env, request)
    assert.equal(before.source_status, 'captured')
    assert.deepEqual(before.reconstructed_sectors, [])
    assert.deepEqual(before.output, await sectorLeaderBonusBatch(env, request.candidates, .7, 5),
      'same valid cache and past prices produce exactly the original kernel result')
    assert.equal(before.output.get('2330')?.bonus, 5)
    assert(Math.abs(before.output.get('2330')!.avgCorr! - 1) < 1e-12)
    const immutable = structuredClone(before)

    await insertPrices(1, 80, true)
    const contaminated = await sectorLeaderBonusBatch(env, request.candidates, .7, 5)
    assert.equal(contaminated.get('2330')?.bonus, 0)
    const bounded = await readSectorLeaderBonusSnapshot(env, request)
    assert.deepEqual(bounded.output, before.output)
    assert.equal(bounded.inputs.prices.length, 280)
    assert(bounded.inputs.prices.every(row => row.date <= request.signalDate))
    assert.deepEqual(computeSectorLeaderBonusFromInputs(before.inputs, .7, 5), before.output)
    assert.deepEqual(before, immutable, 'replay cannot mutate frozen source or depend on later inserts')
    const seedInput = { candidate: { symbol: '2330', name: 'local', sector: 'Semiconductor', industry: 'Semiconductor',
      chip_score: 20, tech_score: 18, momentum_score: 10, score: 99, reason: 'test' }, rank: 1, currentPrice: 100 }
    assert.equal(buildScreenerSeedRow({ ...seedInput, sectorBonus: contaminated.get('2330')!.bonus }).row.seedScore, 48)
    assert.equal(buildScreenerSeedRow({ ...seedInput, sectorBonus: bounded.output.get('2330')!.bonus }).row.seedScore, 53)
    // These are synthetic seed scores, not returns or NAV improvements.

    await db.prepare("UPDATE sector_leaders SET computed_at='2026-09-10T12:00:00Z'").run()
    const cacheBefore = await db.prepare('SELECT * FROM sector_leaders ORDER BY rank').all()
    const readonly = { prepare(sql: string) {
      assert(!/\b(INSERT|UPDATE|DELETE|DROP|CREATE|REPLACE)\b/i.test(sql), 'snapshot read/rebuild cannot write any cache')
      return db.prepare(sql)
    } } as D1Database
    const reconstructed = await readSectorLeaderBonusSnapshot({ DB: readonly }, request)
    assert.deepEqual(reconstructed.reconstructed_sectors, ['Semiconductor'])
    assert.deepEqual(reconstructed.inputs.leaderRows.map(row => row.symbol), ['2317', '2454', '2308'],
      'fallback ranks full FinLab industry membership, not candidate-only or stale Core industry')
    assert.deepEqual(reconstructed.output, before.output)
    assert.deepEqual((await db.prepare('SELECT * FROM sector_leaders ORDER BY rank').all()).results, cacheBefore.results)
    await db.prepare('DROP TABLE sector_leaders').run()
    const cold = await readSectorLeaderBonusSnapshot({ DB: readonly }, request)
    assert.equal(cold.cache_status, 'unavailable')
    assert.equal(cold.source_status, 'captured', 'valid original-kernel reconstruction is a real data source, not a bypass')
    assert.deepEqual(cold.output, before.output)
    const missing = await readSectorLeaderBonusSnapshot({ DB: readonly }, {
      ...request, fullIndustryUniverse: [...request.fullIndustryUniverse, { symbol: '9999', sector: 'Semiconductor' }],
    })
    assert.equal(missing.source_status, 'incomplete')
    assert(missing.issues.includes('identity_missing:9999'))
    assert(missing.issues.includes('price_history_missing:9999'), 'missing peer prices cannot masquerade as a zero-correlation observation')
    await db.prepare("INSERT INTO stocks VALUES(5,'8888','peer','TWSE','STALE_CORE_CLASSIFICATION')").run()
    const peerNoPrice = await readSectorLeaderBonusSnapshot({ DB: readonly }, { ...request,
      fullIndustryUniverse: [...request.fullIndustryUniverse, { symbol: '8888', sector: 'Semiconductor' }],
    })
    assert.equal(peerNoPrice.source_status, 'incomplete')
    assert(peerNoPrice.issues.includes('price_history_missing:8888'))
    assert(!peerNoPrice.issues.includes('identity_missing:8888'), 'price absence is distinct from missing identity')
    const failed = { prepare() { throw new Error('raw source unavailable') } } as unknown as D1Database
    await assert.rejects(readSectorLeaderBonusSnapshot({ DB: failed }, request), /raw source unavailable/,
      'cache loss may reconstruct; raw-data failure cannot turn into zero correlation')
    assert.deepEqual((await readSectorLeaderBonusSnapshot({ DB: failed }, { ...request,
      candidates: [], fullIndustryUniverse: [] })).output, new Map())
  } finally { await mf.dispose() }
})

test('actual screener uses bounded reader, limits formal output scope and seals after Core materialization', () => {
  const source = readFileSync(new URL('./marketScreener.ts', import.meta.url), 'utf8')
  assert(source.includes("atomicOverlayCapture.read('sector_bonus'"))
  assert(source.includes('readSectorLeaderBonusSnapshot(env'))
  assert(source.includes('taxonomyUniverse.map(symbol => ({ symbol, sector: taxonomyProfiles.get(symbol)?.industry ?? null }))'))
  assert(source.includes('new Map([...bonusSnapshot.output].filter(([symbol]) => finalSymbols.has(symbol)))'))
  assert(!source.includes('await sectorLeaderBonusBatch('))
  assert(source.indexOf("atomicOverlayCapture.record('core_seed_materialization'") > source.indexOf('await writeScreenerSeedBatches('))
  assert(source.indexOf('atomicShadowSource = await sealAtomicPostOverlaySource(') > source.indexOf('await writeScreenerSeedBatches('))
})
