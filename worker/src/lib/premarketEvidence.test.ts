import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { l4NativeFixture } from './l4NativeFixture.testSupport'
import { runPremarketEvidenceStage } from './premarketEvidenceStage'
import { filterNewsEvidence, NEWS_FEATURES } from './newsEvidence'
import { runDailyNewsAnalysis, parseReportJson, formatNewsDebateContext, readCurrentNewsReport, isReadyNight, buildPrompts } from './newsAnalyst'
import { isReadyUSSignal } from './usLeading'
import { callLLM } from './debateTrader'
import { withPaperExecutionScope } from './paperExecutionScope'
import { schedulerJobAccounting } from './schedulerManifestGovernance'

const at = '2026-10-01T00:00:00Z'
const row = { id: 'news:1', title: 'Semiconductor orders weaken', summary: 'Supplier reports lower orders',
  url: 'https://example.com/a', source: 'fixture', published_at: '2026-09-30T20:00:00Z', observed_at: at }
const valid = { bias: 'negative', confidence: .7, key_factors: ['Orders weakened [news:1]'],
  sector_bias: { semiconductor: -.3 }, sector_evidence: { semiconductor: ['news:1'] }, risk_factors: ['Demand risk [news:1]'], summary: 'Fixture report',
  assessments: [{ evidence_ids: ['news:1'], features: Object.fromEntries(NEWS_FEATURES.map(k => [k, null])), rationale: 'Reported demand decline' }] }

test('headline cutoff, first-seen, freshness and duplicate guards', () => {
  assert.equal(filterNewsEvidence([row, { ...row, id: 'duplicate' }, { ...row, id: 'future', title: 'future', url: 'https://example.com/b', published_at: '2026-10-02T00:00:00Z' },
    { ...row, title: 'late', url: 'https://example.com/c', observed_at: '2026-10-02T00:00:00Z' }, { ...row, url: 'https://', title: 'invalid' }], at).length, 1)
})
test('strict output rejects unknown evidence, invalid features and fake neutral fallback', () => {
  assert.ok(parseReportJson(JSON.stringify(valid), [row]))
  for (const bad of [{ ...valid, confidence: '0.8' }, { ...valid, key_factors: [] },
    { ...valid, risk_factors: ['invented CPI release'] }, { ...valid, sector_bias: { semiconductor: 9 } },
    { ...valid, assessments: [{ ...valid.assessments[0], evidence_ids: ['made-up'] }] },
    { ...valid, assessments: [{ ...valid.assessments[0], features: { sentiment: 1 } }] },
    { ...valid, assessments: [{ ...valid.assessments[0], features: { ...valid.assessments[0].features, sentiment: 3 } }] }])
    assert.equal(parseReportJson(JSON.stringify(bad), [row]), null)
  assert.equal(parseReportJson('{"bias":"neutral","confidence":0.3}', []), null)
  const rendered = formatNewsDebateContext({ ...valid, date: '2026-10-01', source: 'fixture', evidence: [row] } as any)
  for (const expected of ['sector_bias', 'risk_factors', 'news:1', 'https://example.com/a']) assert.ok(rendered.includes(expected))
})
test('full macro factors use explicit HY percent-to-bps conversion', () => {
  const prompt = buildPrompts('2026-10-01', { evidence: [row], cutoff: at,
    us_signal: { tsm_return: .02, dxy_return: -.01, hy_spread: 3.08, hy_spread_chg: .02, sox_close: 5000, sox_ma5: 4900 } })
  for (const factor of ['308.0 bps', '2.0 bps', 'TSM ADR', 'DXY', 'MA5']) assert.ok(prompt.user.includes(factor))
})
test('US and night freshness rejects missing source times', () => {
  const signal = { date: '2026-10-01', sox_close: 1, gspc_close: 1, vix_close: 1, source_times: { sox: at, gspc: at, vix: at } }
  assert.ok(isReadyUSSignal(signal, signal.date, Date.parse(at)))
  assert.equal(isReadyUSSignal({ ...signal, source_times: {} }, signal.date, Date.parse(at)), false)
  assert.equal(isReadyUSSignal(signal, signal.date, Date.parse(at) + 97 * 3600_000), false)
  assert.ok(isReadyNight({ lastPrice: 100, changePct: 0, changePoints: 0, date: '20261001', time: '050000' }, Date.parse(at)))
  assert.equal(isReadyNight({ lastPrice: 100, changePct: 0, changePoints: 0, date: '20260901', time: '050000' }, Date.parse(at)), false)
})
test('legacy parse-failed KV report is missing, never successful evidence', async () => {
  const kv = { get: async () => ({ date: '2026-10-01', bias: 'neutral', confidence: .3, source: 'gemini_api:parse_failed' }) } as any
  assert.equal(await readCurrentNewsReport(kv, '2026-10-01'), null)
})
test('SQLite stage serializes parallel calls, caches success and fences stale owners', async () => {
  const f = l4NativeFixture(); let cached: string | null = null, calls = 0
  try {
    const run = () => runPremarketEvidenceStage(f.env, '2026-09-14', 'test', async () => cached, async guard => {
      calls++; await guard(); await new Promise(resolve => setTimeout(resolve, 10)); cached = 'ready'; return cached
    })
    const results = await Promise.allSettled([run(), run()])
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
    assert.equal(calls, 1); assert.equal(await run(), 'ready'); assert.equal(calls, 1)
    await assert.rejects(runPremarketEvidenceStage(f.env, '2026-09-14', 'stale', async () => null, async guard => {
      f.ports.nowMs += 601_000; await guard(); return 'should-not-publish'
    }), /lease_lost/)
  } finally { f.close() }
})
test('SQLite stage limits failed attempts across restarts and cooldowns', async () => {
  const f = l4NativeFixture(); let calls = 0
  const run = () => runPremarketEvidenceStage(f.env, '2026-09-14', 'retry', async () => null, async () => { calls++; throw new Error('bad JSON') })
  try {
    await assert.rejects(run(), /bad JSON/)
    await assert.rejects(run(), /premarket_wait/); assert.equal(calls, 1)
    f.ports.nowMs += 601_000; await assert.rejects(run(), /bad JSON/)
    f.ports.nowMs += 601_000; await assert.rejects(run(), /premarket_exhausted/)
    f.ports.nowMs += 601_000; await assert.rejects(run(), /error:attempt=3/)
    assert.equal(calls, 3)
  } finally { f.close() }
})
test('LLM joins text parts, enables JSON mode and rejects truncated output', async () => {
  const f = l4NativeFixture(); let finish = 'STOP'
  f.env.GEMINI_API_KEY = 'fixture-not-a-secret'
  f.ports.fetchFrozen = async (_input: any, init: any) => {
    const body = JSON.parse(init.body)
    assert.equal(body.generationConfig.maxOutputTokens, 2048)
    assert.equal(body.generationConfig.responseMimeType, 'application/json')
    return Response.json({ candidates: [{ finishReason: finish, content: { parts: [{ text: '{' }, { thought: true, text: 'private reasoning' }, { text: '}' }] } }] })
  }
  try {
    const run = () => withPaperExecutionScope(f.ports, () => callLLM(f.env, 'fixture', 'fixture', .2, { maxTokens: 2048, json: true }))
    assert.equal((await run()).result.text, '{}')
    finish = 'MAX_TOKENS'; await assert.rejects(run(), /All LLM layers unavailable/)
  } finally { f.close() }
})
test('paused briefing, watchdog ownership and entry-only readiness gate', () => {
  assert.equal(schedulerJobAccounting('morning-briefing').desiredState, 'PAUSED')
  const source = readFileSync(new URL('./pendingBuyOrchestrator.ts', import.meta.url), 'utf8')
  assert.ok(source.indexOf('premarket_evidence_wait:') < source.indexOf('const candidates: BatchDebateCandidate[]'))
  const exits = readFileSync(new URL('./paperExitTasks.ts', import.meta.url), 'utf8')
  assert.ok(!exits.includes('readCurrentNewsReport') && !exits.includes('premarket_evidence_wait'))
})

test('news producer retries bad JSON without writing neutral KV, then publishes and reuses valid evidence', async () => {
  const f = l4NativeFixture(), originalFetch = globalThis.fetch
  const now = new Date(), date = new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
  f.ports.nowMs = now.getTime(); f.env.GEMINI_API_KEY = 'fixture-only'
  f.kvs.set(`us:leading:${date}`, JSON.stringify({ date, sox_close: 5000, gspc_close: 5000, vix_close: 20,
    source_times: { sox: now.toISOString(), gspc: now.toISOString(), vix: now.toISOString() } }))
  f.sqls.market.prepare('INSERT INTO news(id,stock_id,title,summary,url,source,published_at) VALUES(1,1,?,?,?,?,?)')
    .run(row.title, row.summary, row.url, row.source, now.toISOString())
  const tw = new Date(now.getTime() + 8 * 3600_000 - 60_000).toISOString()
  let calls = 0, good = false
  globalThis.fetch = async () => new Response('<rss/>')
  f.ports.fetchFrozen = async (input: any) => {
    if (String(input).includes('yahoo.com')) return new Response('<rss/>')
    if (String(input).includes('taifex')) return Response.json({ RtData: { QuoteList: [{ SymbolID: 'TXF202610-M', CLastPrice: '20000', CRefPrice: '20000', CDate: tw.slice(0, 10).replaceAll('-', ''), CTime: tw.slice(11, 19).replaceAll(':', '') }] } })
    if (String(input).includes('generativelanguage')) { calls++; return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: good ? JSON.stringify(valid) : 'not JSON' }] } }] }) }
    throw new Error('unexpected test network')
  }
  const run = () => withPaperExecutionScope(f.ports, () => runDailyNewsAnalysis(f.env))
  try {
    await assert.rejects(run(), /invalid_output/)
    assert.equal(f.kvs.has(`market:news_analyst:${date}`), false)
    await assert.rejects(run(), /premarket_wait/); assert.equal(calls, 2)
    const failure = JSON.parse(f.kvs.get(`market:news_analyst_failure:${date}`)!)
    assert.equal(failure.error, 'json_object_missing')
    assert.equal(failure.attempt, 1)
    assert.ok(f.artifacts.has(failure.key))
    f.ports.nowMs += 601_000; good = true
    assert.equal((await run()).result.status, 'ready')
    const published = (await withPaperExecutionScope(f.ports, () => readCurrentNewsReport(f.env.KV, date))).result
    assert.ok(published?.evidence_receipt?.sha256)
    assert.ok(f.artifacts.has(published.evidence_receipt.key))
    await run(); assert.equal(calls, 3)
  } finally { globalThis.fetch = originalFetch; f.close() }
})
test('expired third producer attempt becomes terminal error without another API call', async () => {
  const f = l4NativeFixture()
  try {
    f.sqls.ops.exec("INSERT INTO pipeline_stage_runs(business_date,stage,canonical_run_id,status,attempt_count,lease_expires_at) VALUES('2026-09-14','premarket_v2:crash','crash','running',3,'2026-09-13 00:00:00')")
    await assert.rejects(runPremarketEvidenceStage(f.env, '2026-09-14', 'crash', async () => null, async () => { throw new Error('must-not-call') }), /error:attempt=3/)
  } finally { f.close() }
})

test('news producer repairs once with same evidence, then caches valid output', async () => {
  const f = l4NativeFixture(), originalFetch = globalThis.fetch
  const now = new Date(), date = new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
  f.ports.nowMs = now.getTime(); f.env.GEMINI_API_KEY = 'fixture-only'
  f.kvs.set(`us:leading:${date}`, JSON.stringify({ date, sox_close: 5000, gspc_close: 5000, vix_close: 20,
    source_times: { sox: now.toISOString(), gspc: now.toISOString(), vix: now.toISOString() } }))
  f.sqls.market.prepare('INSERT INTO news(id,stock_id,title,summary,url,source,published_at) VALUES(1,1,?,?,?,?,?)')
    .run(row.title, row.summary, row.url, row.source, now.toISOString())
  const tw = new Date(now.getTime() + 8 * 3600_000 - 60_000).toISOString()
  let calls = 0
  globalThis.fetch = async () => new Response('<rss/>')
  f.ports.fetchFrozen = async (input: any, init: any) => {
    if (String(input).includes('yahoo.com')) return new Response('<rss/>')
    if (String(input).includes('taifex')) return Response.json({ RtData: { QuoteList: [{ SymbolID: 'TXF202610-M', CLastPrice: '20000', CRefPrice: '20000', CDate: tw.slice(0, 10).replaceAll('-', ''), CTime: tw.slice(11, 19).replaceAll(':', '') }] } })
    if (String(input).includes('generativelanguage')) { calls++; const body = JSON.parse(init.body); if (calls === 2) { assert.ok(JSON.stringify(body).includes('json_object_missing')); assert.ok(JSON.stringify(body).includes(row.title)); assert.equal(f.kvs.has(`market:news_analyst:${date}`), false) }; return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: calls === 2 ? JSON.stringify(valid) : 'not JSON' }] } }] }) }
    throw new Error('unexpected test network')
  }
  const run = () => withPaperExecutionScope(f.ports, () => runDailyNewsAnalysis(f.env))
  try {
    assert.equal((await run()).result.status, 'ready')
    const published = (await withPaperExecutionScope(f.ports, () => readCurrentNewsReport(f.env.KV, date))).result
    assert.ok(published?.evidence_receipt?.sha256)
    assert.ok(f.artifacts.has(published.evidence_receipt.key))
    await run(); assert.equal(calls, 2)
  } finally { globalThis.fetch = originalFetch; f.close() }
})

test('news parser identifies actionable citation and assessment failures', () => {
  for (const [bad, expected] of [
    [{ ...valid, key_factors: ['Orders [news:1, macro]'] }, 'key_factors[0].citation_missing_unknown_or_combined'],
    [{ ...valid, assessments: [{ ...valid.assessments[0], evidence_ids: ['macro'] }] }, 'assessments[0].evidence_ids_unknown'],
    [{ ...valid, assessments: [{ ...valid.assessments[0], rationale: 'x'.repeat(201) }] }, 'assessments[0].rationale_1_to_200_required'],
  ] as const) {
    let reason = ''
    assert.equal(parseReportJson(JSON.stringify(bad), [row], error => { reason = error }), null)
    assert.equal(reason, expected)
  }
})
