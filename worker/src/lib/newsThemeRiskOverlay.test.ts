import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Miniflare } from 'miniflare'
import { readExternalEvidenceRiskSnapshot } from './newsThemeRiskOverlay'
import { ScreenerOverlayCapture } from './screenerOverlayCapture'

test('real D1: event 241 is not dropped, future/late-ingested/late-quality events are excluded', async () => {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("local") } }', d1Databases: ['NAV'] })
  try {
    const db = await mf.getD1Database('NAV')
    await db.prepare(`CREATE TABLE external_evidence_items(id INTEGER PRIMARY KEY,source_id TEXT,source_kind TEXT,title TEXT,
      published_at TEXT,symbols_json TEXT,allowed_use TEXT,decision_effect TEXT,source_quality_score REAL,
      entity_linking_confidence REAL,accepted INTEGER,created_at TEXT)`).run()
    await db.prepare('CREATE TABLE source_quality_metrics(source TEXT,as_of_date TEXT,freshness_status TEXT,created_at TEXT)').run()
    await db.prepare("INSERT INTO source_quality_metrics VALUES('official_rss','2026-09-09','present','2026-09-09 09:00:00')").run()
    await db.prepare("INSERT INTO source_quality_metrics VALUES('company_ir_rss','2026-09-09','present','2026-09-10 09:00:00')").run()
    const add = (id: number, source: string, symbol: string, title: string, q: number, pub: string, created: string) =>
      db.prepare('INSERT INTO external_evidence_items VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').bind(id, source, 'official', title,
        pub, JSON.stringify([symbol]), 'context', 'context', q, q, 1, created)
    const statements = Array.from({ length: 240 }, (_, i) => add(i + 1, 'official_rss', '2330', 'ordinary update', .9,
      '2026-09-09T10:00:00Z', '2026-09-09 10:01:00'))
    for (let i = 0; i < statements.length; i += 40) await db.batch(statements.slice(i, i + 40))
    await add(241, 'official_rss', '2330', 'trading_halt', .7, '2026-09-09T10:00:00Z', '2026-09-09 10:01:00').run()
    await add(242, 'official_rss', '2317', 'trading_halt', 1, '2026-09-09T13:00:00Z', '2026-09-09 13:01:00').run()
    await add(243, 'official_rss', '2317', 'trading_halt', 1, '2026-09-09T10:00:00Z', '2026-09-10 10:01:00').run()
    await add(244, 'company_ir_rss', '2317', 'trading_halt', 1, '2026-09-09T10:00:00Z', '2026-09-09 10:01:00').run()
    const old = await db.prepare("SELECT title FROM external_evidence_items WHERE symbols_json='[\"2330\"]' ORDER BY source_quality_score DESC LIMIT 240").all()
    assert.equal(old.results.length, 240)
    assert(old.results.every(row => row.title === 'ordinary update'))
    const current = await readExternalEvidenceRiskSnapshot(db, '2026-09-09', ['2330', '2317'], '2026-09-09T12:00:00Z')
    assert.equal(current.observations[0].rows.length, 241)
    assert.equal(current.overlays.get('2330')?.action, 'veto')
    assert.equal(current.overlays.has('2317'), false)
    assert.equal(current.cutoff, '2026-09-09T12:00:00.000Z')
    assert.deepEqual((await readExternalEvidenceRiskSnapshot(db, '2026-09-09', ['9999'], '2026-09-09T12:00:00Z')).observations[0].rows, [])

    let calls = 0
    const failedDb = { prepare(sql: string) { if (++calls === 2) throw new Error('second batch unavailable'); return db.prepare(sql) } } as D1Database
    const capture = new ScreenerOverlayCapture()
    const symbols = ['2330', ...Array.from({ length: 40 }, (_, i) => String(3000 + i))]
    await assert.rejects(capture.read('external_risk', symbols,
      () => readExternalEvidenceRiskSnapshot(failedDb, '2026-09-09', symbols, '2026-09-09T12:00:00Z')), /second batch unavailable/)
    const packet = capture.freeze({ signalDate: '2026-09-09', universeSymbols: symbols, formalSymbols: symbols,
      finalSeed: [], safetyExcludedSymbols: [], policy: {} })
    assert.equal(packet.observations.external_risk[0].status, 'failed')
    assert.equal(packet.observations.external_risk[0].value, undefined, 'first-batch veto cannot claim whole-source success')
  } finally { await mf.dispose() }
})
