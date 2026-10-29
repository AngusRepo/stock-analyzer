import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import {
  auditFinLabTaxonomyOwner,
  loadPrimaryFinLabIndustries,
  sectorFallbackOrder,
  syncFinLabIndustryProjection,
} from './finlabTaxonomy'

const schema = (domain: string) => readFileSync(new URL(`../../domain-schemas/${domain}.sql`, import.meta.url), 'utf8')

/** A D1 stand-in over sqlite with the repo's core and market schemas (one legacy DB, as without MULTI_D1). */
function fakeD1(faults = { insert: false, candidates: false }) {
  const db = new DatabaseSync(':memory:')
  db.exec(schema('market'))
  db.exec(schema('core'))
  const prepare = (sql: string) => {
    let binds: any[] = []
    const statement = {
      bind(...values: any[]) { binds = values; return statement },
      async all() {
        if (faults.candidates && binds[0] === 'industry_fallback') throw new Error('D1_ERROR: read failed')
        return { results: db.prepare(sql).all(...binds) }
      },
      async first() { return db.prepare(sql).get(...binds) ?? null },
      async run() { statement.exec(); return { success: true } },
      exec() {
        if (faults.insert && /INSERT INTO finlab_taxonomy_tags/.test(sql)) throw new Error('D1_ERROR: write failed')
        db.prepare(sql).run(...binds)
      },
    }
    return statement
  }
  const d1 = {
    prepare,
    async batch(statements: ReturnType<typeof prepare>[]) {
      db.exec('BEGIN')
      try {
        for (const statement of statements) statement.exec()
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      return statements.map(() => ({ success: true }))
    },
  }
  return { db, d1 }
}

function seed(db: DatabaseSync) {
  const tag = db.prepare(`INSERT INTO finlab_taxonomy_tags (symbol, tag, tag_type, source, lineage_json, as_of_date)
    VALUES (?, ?, ?, ?, '{}', '2026-10-28')`)
  tag.run('2330', '半導體業', 'industry', 'finlab.security_categories')
  tag.run('0050', 'domestic_etf', 'industry', 'finlab.security_categories')
  tag.run('2330', 'AI', 'industry_theme', 'finlab.security_industry_themes')
  tag.run('2330', 'AI 晶片', 'subindustry', 'finlab.security_industry_themes')
  // Fallback candidates mirrored by the materializer.
  tag.run('2330', '半導體業', 'industry_fallback', 'finlab.company_basic_info')
  tag.run('3718', '電子零組件業', 'industry_fallback', 'finlab.company_basic_info')
  tag.run('7934', '生技醫療業', 'industry_fallback', 'finlab.company_basic_info')
  tag.run('7934', 'etf', 'industry_fallback', 'finlab.tw_etf_basic_info')
  tag.run('00999', 'etf', 'industry_fallback', 'finlab.tw_etf_basic_info')
  const stock = db.prepare('INSERT INTO stocks (symbol, name, market, sector, delisted_date) VALUES (?, ?, ?, ?, ?)')
  stock.run('2330', 'TSMC', 'TWSE', '半導體業', null)
  stock.run('0050', 'ETF 50', 'TWSE', 'domestic_etf', null)
  stock.run('3718', 'New OTC', 'OTC', '其他', null)
  stock.run('7934', 'New ROTC', 'OTC', null, null)
  stock.run('00999', 'New ETF', 'TWSE', null, null)
  stock.run('NVDA', 'NVIDIA', 'US', null, null)
  stock.run('1230', 'Delisted', 'TWSE', null, '2001-11-01')
}

function env(d1: any, extra: Record<string, unknown> = {}) {
  const deleted: string[] = []
  return { deleted, env: { DB: d1, KV: { delete: async (key: string) => { deleted.push(key) } }, ...extra } as any }
}

const sectors = (db: DatabaseSync) => Object.fromEntries(
  (db.prepare('SELECT symbol, sector FROM stocks ORDER BY symbol').all() as any[]).map((row) => [row.symbol, row.sector]))
const provenance = (db: DatabaseSync) => (db.prepare(
  "SELECT symbol, tag, source, lineage_json FROM finlab_taxonomy_tags WHERE tag_type='sector_provenance' ORDER BY symbol",
).all() as any[]).map((row) => [row.symbol, row.tag, row.source, JSON.parse(row.lineage_json).sector_source])

test('Q03: unclassified listed stocks take the configured fallback tier and record its provenance', async () => {
  const { db, d1 } = fakeD1()
  seed(db)
  const { env: e, deleted } = env(d1)
  const result = await syncFinLabIndustryProjection(e)
  assert.deepEqual(sectors(db), {
    '0050': 'domestic_etf', '00999': 'etf', '1230': null, '2330': '半導體業',
    '3718': '電子零組件業', '7934': '生技醫療業', NVDA: 'unclassified',
  })
  assert.deepEqual(provenance(db), [
    ['00999', 'etf', 'sector_fallback.etf_basic_info', 'finlab.tw_etf_basic_info'],
    ['3718', '電子零組件業', 'sector_fallback.company_basic_info', 'finlab.company_basic_info'],
    ['7934', '生技醫療業', 'sector_fallback.company_basic_info', 'finlab.company_basic_info'],
    ['NVDA', 'unclassified', 'sector_fallback.unclassified', 'unclassified'],
  ])
  assert.deepEqual(result.fallback, {
    order: ['company_basic_info', 'etf_basic_info', 'unclassified'], projected: 4, recorded: true,
    by_tier: { company_basic_info: 2, etf_basic_info: 1, unclassified: 1 },
  })
  assert.equal(result.updated, 4)
  assert.equal(result.cleared, 0)
  assert.ok(deleted.includes('screener:sector-map'))

  // Owner-filtered readers (screener, L3 sector encoding, owner audit) never see the new tag types.
  assert.deepEqual([...(await loadPrimaryFinLabIndustries(e)).keys()].sort(), ['0050', '2330'])
  assert.equal((await auditFinLabTaxonomyOwner(e)).unexpected_finlab_rows, 0)

  // A rerun with nothing new writes nothing.
  const again = await syncFinLabIndustryProjection(e)
  assert.equal(again.updated, 0)
  assert.equal(provenance(db).length, 4)

  // The owner classifies 3718 later: the owner wins and its provenance row is retired.
  db.prepare(`INSERT INTO finlab_taxonomy_tags (symbol, tag, tag_type, source, lineage_json, as_of_date)
    VALUES ('3718', '光電業', 'industry', 'finlab.security_categories', '{}', '2026-10-29')`).run()
  await syncFinLabIndustryProjection(e)
  assert.equal(sectors(db)['3718'], '光電業')
  assert.deepEqual(provenance(db).map((row) => row[0]), ['00999', '7934', 'NVDA'])
})

test('Q03: the order and the switch come from FINLAB_SECTOR_FALLBACK_ORDER', async () => {
  assert.deepEqual(sectorFallbackOrder({} as any), ['company_basic_info', 'etf_basic_info', 'unclassified'])
  assert.deepEqual(sectorFallbackOrder({ FINLAB_SECTOR_FALLBACK_ORDER: 'OFF' } as any), [])
  assert.deepEqual(sectorFallbackOrder({ FINLAB_SECTOR_FALLBACK_ORDER: 'etf_basic_info, bogus,company_basic_info' } as any),
    ['etf_basic_info', 'company_basic_info'])

  const { db, d1 } = fakeD1()
  seed(db)
  await syncFinLabIndustryProjection(env(d1, { FINLAB_SECTOR_FALLBACK_ORDER: 'etf_basic_info,company_basic_info' }).env)
  assert.equal(sectors(db)['7934'], 'etf', 'the ETF tier is tried first')
  assert.equal(sectors(db).NVDA, null, 'no unclassified tier configured')

  // Switching off restores owner-only sectors and retires every provenance row.
  const off = await syncFinLabIndustryProjection(env(d1, { FINLAB_SECTOR_FALLBACK_ORDER: 'off' }).env)
  assert.deepEqual(sectors(db), {
    '0050': 'domestic_etf', '00999': null, '1230': null, '2330': '半導體業', '3718': null, '7934': null, NVDA: null,
  })
  assert.deepEqual(provenance(db), [])
  assert.deepEqual(off.fallback, { order: [], projected: 0, by_tier: {}, recorded: true })
})

test('Q03: a failed run holds the last recorded fallback and never lands an unrecorded one', async () => {
  const faults = { insert: false, candidates: false }
  const { db, d1 } = fakeD1(faults)
  seed(db)
  // Before any recorded run, a failure keeps the stock owner-only, as before Q03.
  faults.insert = true
  const first = await syncFinLabIndustryProjection(env(d1).env)
  assert.deepEqual(first.fallback, { order: ['company_basic_info', 'etf_basic_info', 'unclassified'], projected: 0,
    by_tier: {}, recorded: false })
  assert.equal(sectors(db)['7934'], null)
  assert.deepEqual(provenance(db), [])

  faults.insert = false
  await syncFinLabIndustryProjection(env(d1).env)
  assert.equal(sectors(db)['7934'], '生技醫療業')

  // Unreadable candidates do not demote 7934 to unclassified; the recorded sectors hold.
  faults.candidates = true
  const held = await syncFinLabIndustryProjection(env(d1).env)
  assert.equal(held.fallback.recorded, false)
  assert.equal(held.updated, 0)
  assert.equal(sectors(db)['7934'], '生技醫療業')
  assert.equal(sectors(db).NVDA, 'unclassified')

  // A failed provenance write holds too, even when the candidates changed.
  faults.candidates = false
  faults.insert = true
  db.prepare("UPDATE finlab_taxonomy_tags SET tag='醫療器材業' WHERE symbol='7934' AND source='finlab.company_basic_info'").run()
  await syncFinLabIndustryProjection(env(d1).env)
  assert.equal(sectors(db)['7934'], '生技醫療業')
  assert.equal(provenance(db).find((row) => row[0] === '7934')?.[1], '生技醫療業', 'stocks.sector matches its record')
  faults.insert = false
  await syncFinLabIndustryProjection(env(d1).env)
  assert.equal(sectors(db)['7934'], '醫療器材業')
  assert.equal(provenance(db).find((row) => row[0] === '7934')?.[1], '醫療器材業')
})
