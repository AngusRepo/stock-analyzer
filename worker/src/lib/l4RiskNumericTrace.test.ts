import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { DEFAULT_ADAPTIVE_PARAMS } from './adaptiveConfig'
import { getAvailableCash } from './dateUtils'
import { captureL4AccountContext } from './l4AccountContext'
import { l4NativeFixture } from './l4NativeFixture.testSupport'
import { storeL4PortfolioPlan } from './l4PortfolioPlan'
import { buildMarketRegimeState } from './marketRegimeState'
import { resolveCanonicalMarketRisk } from './marketRiskRuntime'
import { computePaperTotalValue, getUnsettledSettlementSummary } from './paperAccountValue'
import { runIntradayCheck } from './paperEntryTasks'
import { withPaperExecutionScope } from './paperExecutionScope'
import { checkCircuitBreakersForDomains, setupMorningPendingBuys } from './pendingBuyOrchestrator'
import { loadPendingBuySnapshot } from './pendingBuyStore'
import { checkP1Mdd } from './riskChecks/p1Mdd'
import { checkP2Accuracy } from './riskChecks/p2Accuracy'
import { checkP3MarketRisk } from './riskChecks/p3MarketRisk'
import { checkP4Breadth } from './riskChecks/p4Breadth'
import { checkP5Losses } from './riskChecks/p5Losses'
import { checkP6Momentum } from './riskChecks/p6Momentum'
import { checkP7Streak } from './riskChecks/p7Streak'
import { checkP8DailyPnl } from './riskChecks/p8DailyPnl'
import { DEFAULT_RISK_CONFIG } from './riskConfig'
import { invalidateConfigCache } from './tradingConfig'

type Fixture = ReturnType<typeof l4NativeFixture>
const signalDate = '2026-09-11'
const tradeDate = '2026-09-14'
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

function seedAccount(f: Fixture, nav: number) {
  f.sqls.paper.prepare('UPDATE paper_accounts SET cash=?,initial_cash=? WHERE id=1').run(nav, nav)
  f.sqls.paper.exec("INSERT INTO paper_accounts(id,cash,initial_cash) VALUES(7,9000000,9000000)")
  f.sqls.paper.exec("INSERT INTO paper_positions(account_id,symbol,name,shares,avg_cost) VALUES(7,'2330','decoy',77777,20)")
  for (const [date, value] of [['2026-09-09', nav], ['2026-09-10', nav], [signalDate, nav]] as const) {
    f.sqls.paper.prepare(`INSERT INTO paper_daily_snapshots
      (account_id,date,cash,positions_value,total_value,pnl,pnl_pct) VALUES(1,?,?,0,?,0,0)`).run(date, value, value)
    f.sqls.paper.prepare(`INSERT INTO paper_daily_snapshots
      (account_id,date,cash,positions_value,total_value,pnl,pnl_pct) VALUES(7,?,?,0,?,0,0)`)
      .run(date, date === signalDate ? 1 : 9000000, date === signalDate ? 1 : 9000000)
  }
  const order = f.sqls.paper.prepare(`INSERT INTO paper_orders
    (account_id,symbol,side,shares,price,commission,tax,total_cost,note,created_at)
    VALUES(?,'2330','sell',100,90,20,27,9000,?,'2026-09-10 01:00:00')`)
  for (let i = 0; i < 3; i++) order.run(1, JSON.stringify({ entry_price: 100, exit_category: 'hard_stop' }))
  // These newer winners must not displace account 1's three losses.
  for (let i = 0; i < 5; i++) order.run(7, JSON.stringify({ entry_price: 50, exit_category: 'hard_stop' }))
}

function seedMarket(f: Fixture) {
  f.kvs.set('trading:risk_config', JSON.stringify(DEFAULT_RISK_CONFIG))
  f.kvs.set('ml:adaptive_params', JSON.stringify({ ...DEFAULT_ADAPTIVE_PARAMS, recent_accuracy_30d: .6,
    provenance: { ...DEFAULT_ADAPTIVE_PARAMS.provenance, source: 'ml-controller', fallback: false } }))
  f.sqls.core.exec("INSERT INTO market_risk(date,twii_close,risk_score,risk_level) VALUES('2026-09-11',30000,10,'green'),('2026-09-10',30000,10,'green')")
  f.sqls.market.exec("INSERT INTO market_breadth(date,advance_ratio,bull_alignment_pct) VALUES('2026-09-11',.6,60)")
  f.sqls.market.exec("INSERT INTO market_regime_factor_packets(date,schema_version,score,level,factor_json,contribution_json,source_json,freshness_json,missing_reason_json,lineage_json,generated_at) VALUES('2026-09-11','market-regime-factor-packet-v1',10,'green','[]','{}','{}','{}','{}','{}','2026-09-11T14:00:00Z')")
  f.sqls.market.exec("INSERT INTO screener_momentum_snapshots(date,candidate_count,zone,percentile_rank) VALUES('2026-09-11',100,'YELLOW',.2)")
  f.kvs.set('market_regime_state', JSON.stringify(buildMarketRegimeState({
    label: 'bull_market', runDate: signalDate, computedAt: signalDate + 'T14:00:00Z',
  })))
  f.seedRiskQuality(signalDate)
  f.sqls.core.exec("INSERT INTO stocks(id,symbol,name,market) VALUES(1,'2330','synthetic','TWSE')")
  f.sqls.market.exec("INSERT INTO stock_prices(stock_id,date,open,high,low,close,avg_price,volume) VALUES(1,'2026-09-11',20,20.5,19.5,20,20,1000000)")
  f.sqls.core.prepare(`INSERT INTO daily_recommendations
    (stock_id,symbol,name,date,rank,score,reason,signal,confidence,has_buy_signal,eligible_for_ml,eligible_for_pending_buy,alpha_allocation)
    VALUES(1,'2330','synthetic','2026-09-11',1,50,'numeric fixture','HOLD',.5,0,1,1,?)`)
    .run(JSON.stringify({ engine: 'sparse_tangent_inverse_risk', selected: false }))
}

function frozenQuotes(f: Fixture) {
  f.env.SHIOAJI_PROXY_URL = 'https://fixture.invalid'
  f.env.ML_CONTROLLER_URL = 'https://fixture.invalid'
  f.env.FINLAB_L5_MARKET_DATA_ENABLED = 'true'
  f.ports.allocateL4Private = async () => { throw new Error('numeric_fixture_must_not_call_model') }
  f.ports.fetchFrozen = async (input: RequestInfo | URL) => {
    const url = String(input), time = new Date(f.ports.nowMs).toISOString()
    const quote = { symbol: '2330', status: 'ok', source_time: time, received_at: time, confirmed_at: time,
      quote_age_ms: 0, source_age_ms: 0, lot_type: 'board_lot', volume_unit: 'lots',
      last: 20, price: 20, open: 20, high: 20.5, low: 19.5, reference_price: 20, total_volume: 100000,
      bid: 20, ask: 20, bid_prices: [20, 19.95, 19.9, 19.85, 19.8], ask_prices: [20, 20.05, 20.1, 20.15, 20.2],
      bid_volume: 10, ask_volume: 1, bid_volumes: [10, 10, 10, 10, 10], ask_volumes: [1, 0, 0, 0, 0] }
    if (url.includes('orderbooks') || url.includes('snapshots') || url.includes('/quotes')) return Response.json({ data: { '2330': quote } })
    if (url.includes('/orderbook/') || url.includes('/snapshot/')) return Response.json({ data: quote })
    if (url.includes('trend')) return Response.json({ slope_5min: .002 })
    if (url.includes('/l5-market-data')) return Response.json({ status: 'ok', quotes: {
      '2330': { ...quote, provider: 'shioaji_proxy_orderbook', ask_volumes: [1, 1, 1, 1, 1] },
    } })
    if (url.includes('twse.com.tw')) return Response.json({ stat: 'OK', data: [] })
    if (url.includes('tpex.org.tw')) return Response.json([])
    if (url.includes('/kbars/')) return Response.json({ data: [] })
    if (url.includes('taifex')) return new Response('', { status: 503 })
    throw new Error('numeric_fixture_unsealed_transport:' + url)
  }
}

function paperState(f: Fixture) {
  return sha(['paper_accounts', 'paper_positions', 'paper_orders', 'paper_settlements', 'paper_daily_snapshots']
    .map(table => f.sqls.paper.prepare(`SELECT * FROM ${table} ORDER BY id`).all()))
}

test('L4 target traverses real risk, pending and Paper fill owners without multiplying caps or mixing private stores', async () => {
  const fixtures = [l4NativeFixture(), l4NativeFixture()]
  const traces = []
  try {
    for (const [i, f] of fixtures.entries()) {
      seedAccount(f, (i + 1) * 1_000_000)
      seedMarket(f)
      frozenQuotes(f)
    }
    for (const [i, f] of fixtures.entries()) {
      const nav = (i + 1) * 1_000_000, other = fixtures[1 - i]
      const otherBefore = paperState(other)
      const l3 = { artifact_id: 'numeric-l3', cohort_id: 'numeric-cohort',
        payload_checksum: 'a'.repeat(64), base_artifact_set_checksum: 'b'.repeat(64) }
      f.sqls.learning.exec('CREATE TABLE active8_ensemble_pointer_v1(singleton_id INTEGER PRIMARY KEY,artifact_id TEXT,cohort_id TEXT,payload_checksum TEXT,base_artifact_set_checksum TEXT)')
      f.sqls.learning.prepare('INSERT INTO active8_ensemble_pointer_v1 VALUES(1,?,?,?,?)').run(...Object.values(l3))
      f.cfg.l4Distribution = { scope: 'private_research', constraints: {
        exposure_cap: .8, name_cap: .25, min_weight: .03, max_positions: 5,
      }, artifact: { schema_version: 'l4-distribution-v1', feature_schema: 'full-l3-30-all-available-signals-v3',
        model_checksum: 'c'.repeat(64), l3_identity: l3 } } as any
      f.kvs.set('trading:config', JSON.stringify(f.cfg))
      invalidateConfigCache()
      const trace = await withPaperExecutionScope(f.ports, async () => {
        assert.equal(f.cfg.circuit.maxPositionPct, .08)
        const defaults = { halt: false, maxPositionPct: .08, buyConfThreshold: .6, sellConfThreshold: .4 }
        const deps = { defaults, effectiveBuy: .6, effectiveSell: .4 }
        const market = await resolveCanonicalMarketRisk({ core: f.env.CORE_DB, market: f.env.MARKET_DB }, f.env.KV, DEFAULT_RISK_CONFIG)
        const layers = await Promise.all([
          checkP1Mdd(f.env.PAPER_DB, f.cfg, deps), checkP2Accuracy(f.env.LEARNING_DB, f.env.KV, f.cfg, deps),
          checkP3MarketRisk(market, f.cfg, deps), checkP4Breadth(market, f.cfg, deps),
          checkP5Losses(f.env.PAPER_DB, deps), checkP6Momentum(f.env.MARKET_DB, deps),
          checkP7Streak(f.env.LEARNING_DB, f.cfg, deps), checkP8DailyPnl(f.env.PAPER_DB, DEFAULT_RISK_CONFIG, deps),
        ])
        assert.deepEqual(layers.map(layer => layer?.maxPositionPct ?? null), [null, null, null, null, .04, .08 * .7, null, null])
        const circuit = await checkCircuitBreakersForDomains(f.env, f.cfg, f.env.KV)
        assert.equal(circuit.halt, false)
        assert.equal(circuit.maxPositionPct, .04)
        assert.deepEqual(circuit.triggeredLayers, ['P5', 'P6'])
        const account = await captureL4AccountContext(f.env, signalDate)
        assert.equal(account.nav, nav)
        assert.equal(account.available_cash, nav)
        assert.equal(account.risk_limits.name_cap, .125)
        assert.deepEqual(account.holdings, [])
        const raw = { execution_scope: 'private_research', schema_version: 'l4-portfolio-plan-v1', owner: 'l4_distribution',
          parent_plan_id: null, account_anchor: account.account_anchor, account_checksum: sha(account),
          policy_identity: 'd'.repeat(64), model_checksum: 'c'.repeat(64), l3_identity: l3,
          hmm_lineage: circuit.marketRiskHmmLineage, signal_date: signalDate, account_id: 1,
          nav_at_decision: nav, weights: { '2330': .12 }, targets: {
            '2330': { weight: .12, current_weight: 0, locked: false, expected_return_gross: .02 },
          }, constraints: { exposure_cap: account.risk_limits.exposure_cap, name_cap: account.risk_limits.name_cap,
            min_weight: .03, max_positions: 5 },
          proof: { within_tolerance: true, absolute_objective_gap: 0, tolerance: 1e-8, evaluated_candidate_count: 1, preselection: false },
          opb: { enabled: false, status: 'fixed_policy', arm_id: 'base' } }
        const canonical_payload = JSON.stringify(raw), plan = { ...raw, plan_id: sha(raw) }
        await storeL4PortfolioPlan(f.env, { plan, canonical_payload, allocation_snapshot_id: 'e'.repeat(64) })
        f.sqls.core.prepare('UPDATE daily_recommendations SET alpha_allocation=? WHERE symbol=? AND date=?')
          .run(JSON.stringify({ engine: 'sparse_tangent_inverse_risk', selected: true,
            allocation_weight: .12, plan_id: plan.plan_id, hmm_lineage: circuit.marketRiskHmmLineage }), '2330', signalDate)
        f.sqls.paper.prepare('UPDATE l4_portfolio_plans_v1 SET created_at=? WHERE plan_id=?').run(tradeDate + ' 00:00:00', plan.plan_id)
        await setupMorningPendingBuys(f.env)
        const pending = await loadPendingBuySnapshot(f.env, tradeDate, { allowFallbackRecent: false })
        assert.equal(pending.pendingBuys.length, 1)
        assert.equal(pending.pendingBuys[0].kelly_pct, null)
        assert.ok(pending.pendingBuys[0].watch_points.includes('l4_plan:' + plan.plan_id))
        return { account, circuit, layers, plan_id: plan.plan_id, pending: pending.pendingBuys[0] }
      })
      f.ports.nowMs = Date.parse(tradeDate + 'T01:45:00Z')
      const result = await withPaperExecutionScope(f.ports, () => runIntradayCheck(f.env))
      assert.equal(result.production_effect, false)
      const buys = f.sqls.paper.prepare("SELECT * FROM paper_orders WHERE account_id=1 AND side='buy'").all()
      assert.equal(buys.length, 1)
      const order = buys[0], note = JSON.parse(String(order.note))
      assert.equal(note.l4_plan_id, trace.result.plan_id)
      assert.equal(note.l4_sparse_allocation_weight, .12)
      assert.equal(note.sizing_mode, 'l4_sparse_weight')
      assert.equal(note.allocation_target_position, nav * .12)
      assert.equal(note.allocation_budget_cap, nav * .12)
      assert.equal(note.order_intent.riskContext.sizingAuthorization.authorizedValue, nav * .12)
      assert.equal(note.order_intent.riskContext.sizingAuthorization.portfolioValue, nav)
      assert.equal(note.requested_shares, nav * .12 / 20)
      assert.equal(order.shares, 1000)
      assert.equal(order.price, 20)
      assert.equal(order.commission, 28)
      assert.equal(note.partial_fill, true)
      const settlement = await getUnsettledSettlementSummary(f.env.PAPER_DB, 1)
      assert.equal(settlement.unsettledBuyAmount, 20028)
      assert.equal(await getAvailableCash(f.env.PAPER_DB, 1), nav - 20028)
      const shares = Number(f.sqls.paper.prepare("SELECT shares FROM paper_positions WHERE account_id=1 AND symbol='2330'").get()?.shares)
      assert.equal(shares, 1000)
      const afterNav = computePaperTotalValue({ settledCash: nav, positionsValue: shares * 20,
        netUnsettledSettlement: settlement.netUnsettledSettlement })
      assert.equal(afterNav, nav - 28)
      assert.equal(f.sqls.paper.prepare("SELECT shares FROM paper_positions WHERE account_id=7 AND symbol='2330'").get()?.shares, 77777)
      assert.equal(paperState(other), otherBefore, 'the other private store must remain unchanged')
      traces.push({ store: i, fixture_only: true, ...trace.result, order, settlement,
        nav_after: afterNav, state_checksum: paperState(f), production_effect: false })
    }
    console.log('A3_NUMERIC_TRACE ' + JSON.stringify(traces))
  } finally {
    fixtures.forEach(f => f.close())
    invalidateConfigCache()
  }
})
