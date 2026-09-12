import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Miniflare } from 'miniflare'
import { detectNewsBuzz } from './newsBuzz'
import { detectPttBuzz } from './pttBuzz'
import { detectAnueBuzz } from './anueBuzz'
import { loadRuntimeThemeSignals } from './multiSourceThemeEvidence'

test('real D1: news buzz uses bounded publication+ingestion and actual string sentiment labels', async () => {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("local") } }', d1Databases: ['NAV'] })
  try {
    const db = await mf.getD1Database('NAV')
    await db.prepare('CREATE TABLE news(id INTEGER PRIMARY KEY,title TEXT,sentiment TEXT,published_at TEXT,created_at TEXT)').run()
    const rows = [
      [1, 'chip earnings', 'positive', '2026-09-09T10:00:00Z', '2026-09-09 10:01:00'],
      [2, 'chip downgrade', 'negative', '2026-09-09T11:00:00Z', '2026-09-09 11:01:00'],
      [3, 'chip gain', 'positive', '2026-09-09T11:10:00Z', '2026-09-09 11:11:00'],
      [4, 'chip future', 'negative', '2026-09-09T13:00:00Z', '2026-09-09 13:01:00'],
      [5, 'chip late ingestion', 'negative', '2026-09-09T11:00:00Z', '2026-09-10 11:01:00'],
      [6, 'chip old', 'negative', '2026-08-09T11:00:00Z', '2026-09-09 11:01:00'],
    ]
    for (const row of rows) await db.prepare('INSERT INTO news VALUES(?,?,?,?,?)').bind(...row).run()
    const result = await detectNewsBuzz(db, { chip: ['chip'] }, { signalDate: '2026-09-09', observedAt: '2026-09-09T12:00:00Z' })
    assert.equal(result[0].mentionCount, 3)
    assert.equal(result[0].sentimentAvg, 1 / 3)
    assert.deepEqual(result[0].topPosts, ['chip gain', 'chip downgrade', 'chip earnings'])
    assert(Number.isNaN(Number('0positive') / 3), 'old += on text labels produced NaN, not neutral sentiment')
    await assert.rejects(loadRuntimeThemeSignals(db, '2026-09-09', { strict: true }), /no such table/)
    assert.deepEqual(await loadRuntimeThemeSignals(db, '2026-09-09'), [])
    await db.prepare(`CREATE TABLE theme_signals(date TEXT,concept TEXT,score REAL,sentiment_avg REAL,source TEXT,
      evidence_count INTEGER,top_titles TEXT,allowed_use TEXT,decision_effect TEXT,generated_at TEXT,created_at TEXT)`).run()
    const themeRows = [
      ['available', '2026-09-09T10:00:00Z', '2026-09-09 10:01:00'],
      ['future', '2026-09-09T13:00:00Z', '2026-09-09 13:01:00'],
      ['late-ingestion', '2026-09-09T10:00:00Z', '2026-09-10 10:01:00'],
    ]
    for (const [concept, generated, created] of themeRows) {
      await db.prepare("INSERT INTO theme_signals VALUES('2026-09-09',?,1,0,'official_rss',1,'[]','context','context',?,?)")
        .bind(concept, generated, created).run()
    }
    const themes = await loadRuntimeThemeSignals(db, '2026-09-09', { strict: true, observedAt: '2026-09-09T12:00:00Z' })
    assert.deepEqual(themes.map(row => row.concept), ['available'])
  } finally { await mf.dispose() }
})

test('strict live-feed reads distinguish HTTP/schema failure from a successful empty result without real network', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => new Response('unavailable', { status: 503 })
    await assert.rejects(detectPttBuzz({}, { strict: true }), /ptt_index_http_503/)
    await assert.rejects(detectAnueBuzz({}, { strict: true }), /anue_http_503/)
    globalThis.fetch = async () => new Response(JSON.stringify({ items: { data: [] } }), { status: 200 })
    assert.deepEqual(await detectAnueBuzz({}, { strict: true }), [])
    globalThis.fetch = async () => new Response('{}', { status: 200 })
    await assert.rejects(detectAnueBuzz({}, { strict: true }), /anue_payload_invalid/)
    globalThis.fetch = async () => new Response('<html>empty board</html>', { status: 200 })
    assert.deepEqual(await detectPttBuzz({}, { strict: true }), [])
  } finally { globalThis.fetch = originalFetch }
})
