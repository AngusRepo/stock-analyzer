import assert from 'node:assert/strict'
import fs from 'node:fs'
import { prepareIndicatorRegime } from './indicatorRegimePrerequisite'
import { recomputeDailyMarketRisk } from './marketRiskMaterialization'
import { l4NativeFixture } from './l4NativeFixture.testSupport'

async function main() {
  const date = '2026-10-06'
  const valid = { date, owner: 'market-risk-quality-v1', quality_status: 'complete',
    known_score: 21, upper_score: 21, quality_checksum: 'certified', model_training: false,
    prediction_pipeline_started: false }
  let calls = 0
  const compute = async () => { calls++; return 'HMM_READY' }
  for (const changes of [{ date: '2026-10-05' }, { quality_status: 'blocked' },
    { upper_score: 45 }, { known_score: Number.NaN }, { quality_checksum: '' }]) {
    await assert.rejects(prepareIndicatorRegime({} as any, date, compute,
      async () => ({ ...valid, ...changes })), /risk_not_qualified/)
  }
  await assert.rejects(prepareIndicatorRegime({} as any, date, compute,
    async () => { throw Error('quality_write_failed') }), /quality_write_failed/)
  assert.equal(calls, 0, 'HMM cannot run on stale, blocked, uncertain or failed input writes')
  assert.equal(await prepareIndicatorRegime({} as any, date, compute,
    async () => ({ ...valid, quality_status: 'bounded' })), 'HMM_READY')

  // Reproduce the actual missing-day dependency with SQLite and the production writer.
  const root = 'C:/Users/Wei/Desktop/CloudCode/stockvision-cloudflare-v12/audits/hmm-risk-repair-20261007'
  const frozen = JSON.parse(fs.readFileSync(root + '/readonly-sources.json', 'utf8'))
  const f = l4NativeFixture(), nativeMarket = f.env.MARKET_DB, originalFetch = globalThis.fetch
  try {
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input)
      if (url.includes('%5EVIX')) return Response.json(frozen.vix)
      if (url.includes('/twse/margin-summary?run_date=' + frozen.date)) return Response.json(frozen.margin)
      throw Error('unfrozen_request:' + url)
    }) as typeof fetch
    f.env.ML_CONTROLLER_URL = 'https://frozen-controller.invalid'
    f.env.MARKET_DB = { ...nativeMarket, prepare(sql: string) {
      let args: unknown[] = []
      const base = () => nativeMarket.prepare(sql).bind(...args)
      return { bind(...values: unknown[]) { args = values; return this }, first: async () => base().first(),
        run: async () => base().run(), all: async () => {
          if (sql.includes('canonical_market_index_daily')) return { results: frozen.index }
          if (sql.includes('canonical_institutional_amount_daily') && sql.includes('daily_net')) return { results: frozen.foreign.slice(-5) }
          if (sql.includes('market_breadth') && sql.includes('LIMIT 5')) return { results: frozen.adl.slice(0, 5) }
          if (sql.includes('canonical_market_daily') && sql.includes('ROW_NUMBER')) return { results: frozen.alignment }
          if (sql.includes('market_trading_sessions') && sql.includes('LIMIT 21')) return { results: frozen.sessions }
          if (sql.includes('market_trading_sessions') && sql.includes('session_date<?')) return { results: [{ session_date: frozen.previous_session }] }
          return base().all()
        } }
    } }
    f.sqls.market.prepare('INSERT INTO market_breadth(date,advance_count,decline_count,advance_ratio,sample_size) VALUES(?,1000,700,.419,1952)').run(frozen.date)
    assert.equal(f.sqls.core.prepare('SELECT date FROM market_risk_quality_v1 WHERE date=?').get(frozen.date), undefined)
    const summary = await prepareIndicatorRegime(f.env, frozen.date, async () => {
      const row: any = f.sqls.core.prepare('SELECT r.risk_score,q.* FROM market_risk r JOIN market_risk_quality_v1 q ON r.date=q.date WHERE r.date=?').get(frozen.date)
      assert.equal(row.date, frozen.date)
      assert.equal(row.status, 'bounded')
      assert.equal(row.known_score, row.risk_score)
      assert.equal(row.upper_score, row.risk_score)
      return 'HMM_SEES_CERTIFIED_DAY_T'
    }, recomputeDailyMarketRisk)
    assert.equal(summary, 'HMM_SEES_CERTIFIED_DAY_T')
  } finally { globalThis.fetch = originalFetch; f.close() }

  const source = fs.readFileSync('src/lib/updateOrchestrator.ts', 'utf8')
  const finalizer = source.slice(source.indexOf('async function runFinalizeContinuation('), source.indexOf('async function acquireFinalizeLock('))
  assert(finalizer.indexOf('await ensureSameDateRegimeReady') < finalizer.indexOf('await refreshMatureStrategyEvidenceBeforeScreener'))
  assert(finalizer.indexOf('await refreshMatureStrategyEvidenceBeforeScreener') < finalizer.indexOf('const runAsyncScreener'))
  assert(source.includes('await prepareIndicatorRegime(env, triggerTime, () => runRegimeCompute(env, triggerTime))'))
  assert(fs.readFileSync('src/lib/mlPipelineTrigger.ts', 'utf8').includes('await recomputeDailyMarketRisk(env,twDate)'), 'Pipeline retains post-HMM factor packet refresh')
  console.log('Indicator prerequisites PASS: day-t SQLite quality before HMM, fail closed, HMM before expensive evidence, retained post-HMM packet refresh')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
