// NEW-1030-12: behaviour tests for three entry wirings that were only pinned as source strings:
// the AUD-5 lot relock, the R14 late authorization of a latched second breakout, and the
// intraday_nav_marks_missing buy block. Each runs the real runIntradayCheck over the native fixture.
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { hmmLineage } from './hmmLifecycle'
import { finalizeSinglePlan } from './premarketSinglePlan'
import { SWING_POLICY_VERSION } from './paperSwingPolicy'
import { runIntradayCheck } from './paperEntryTasks'
import { createSwingEntryAssessor } from './paperSwingAssessment'
import { RISK_CONFIG_FIXTURE } from './riskConfig.testSupport'
import { DEFAULT_ADAPTIVE_PARAMS } from './adaptiveConfig'
import { l4NativeFixture } from './l4NativeFixture.testSupport'
import { buildMarketRegimeState } from './marketRegimeState'
import { captureL4AccountContext } from './l4AccountContext'
import { setupMorningPendingBuys } from './pendingBuyOrchestrator'
import { withPaperExecutionScope } from './paperExecutionScope'
import { storeL4PortfolioPlan } from './l4PortfolioPlan'
import { loadPendingBuySnapshot } from './pendingBuyStore'
import { readSecondBreakout } from './paperSecondBreakoutState'
import { SECOND_BREAKOUT_POLICY } from './paperSecondBreakout'

const skip = process.env.NAV_TEST_PYTHON ? false : 'NAV_TEST_PYTHON unset: needs an interpreter with ml-controller deps'
type Options = {
  signalDate?: string; tradeDate?: string; cash?: number
  boardAsk?: number; oddAsk?: number; oddBookDown?: boolean
  held?: { symbol: string; shares: number; previousClose: number | null }
}

async function nativeEntry(opts: Options = {}) {
  const S = opts.signalDate ?? '2026-09-11', T = opts.tradeDate ?? '2026-09-14'
  const f = l4NativeFixture()
  f.ports.nowMs = Date.parse(T + 'T00:00:00Z')
  f.sqls.ops.prepare("INSERT OR IGNORE INTO pipeline_stage_runs(business_date,stage,canonical_run_id,status) VALUES(?,'pipeline_execution',?,'success'),(?,'pipeline_execution',?,'success')")
    .run(S, 'fixture-' + S, T, 'fixture-' + T)
  f.env.PAPER_DAILY_PLAN_OWNER = 'premarket_once_v1'
  f.env.PAPER_INTRADAY_ENTRY_OWNER = SWING_POLICY_VERSION
  f.sqls.paper.exec(fs.readFileSync(new URL('../../domain-migrations/paper/0007_daily_plan_reviews.sql', import.meta.url), 'utf8'))
  f.ports.allocateL4Private = async () => { throw new Error('fixture_plan_already_supplied') }
  f.env.SHIOAJI_PROXY_URL = 'https://fixture.invalid'
  f.env.ML_CONTROLLER_URL = 'https://fixture.invalid'
  f.env.FINLAB_L5_MARKET_DATA_ENABLED = 'true'
  let heldReads = 0
  f.ports.fetchFrozen = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const time = new Date(f.ports.nowMs).toISOString()
    if (url.includes('/orderbook/watchlist')) return Response.json({ status: 'ok', symbols: ['2330'], lot_type: 'odd_lot' })
    const quote: any = { symbol: '2330', status: 'ok', source_time: time, received_at: time, confirmed_at: time,
      quote_age_ms: 0, source_age_ms: 0, lot_type: 'board_lot', volume_unit: 'lots',
      last: 20, price: 20, open: 20, high: 20.5, low: 19.5, reference_price: 20, total_volume: 100000,
      bid: 19.95, ask: 20, bid_prices: [19.95, 19.9, 19.85, 19.8, 19.75], ask_prices: [20, 20.05, 20.1, 20.15, 20.2],
      bid_volume: 10, ask_volume: 1, bid_volumes: [10, 10, 10, 10, 10], ask_volumes: [1, 1, 1, 1, 1] }
    // The board book passes L5 quality, so no odd-lot book is read before sizing.
    const odd = url.includes('lot_type=odd_lot') || String(init?.body ?? '').includes('odd_lot')
    if (!odd && opts.boardAsk != null) Object.assign(quote, { ask: opts.boardAsk,
      ask_prices: [0, 1, 2, 3, 4].map(i => Math.round((opts.boardAsk! + i * .05) * 100) / 100) })
    if (odd) {
      if (opts.oddBookDown && url.includes('orderbook')) return new Response('odd lot unavailable', { status: 503 })
      Object.assign(quote, { lot_type: 'odd_lot', volume_unit: 'shares', bid_volume: 10000, ask_volume: 31,
        bid_volumes: [10000, 10000, 10000, 10000, 10000], ask_volumes: [31, 0, 0, 0, 0] })
      if (opts.oddAsk != null) Object.assign(quote, { ask: opts.oddAsk, bid: opts.oddAsk - .05,
        ask_prices: [0, 1, 2, 3, 4].map(i => Math.round((opts.oddAsk! + i * .05) * 100) / 100),
        bid_prices: [1, 2, 3, 4, 5].map(i => Math.round((opts.oddAsk! - i * .05) * 100) / 100) })
    }
    if (url.includes('orderbooks') || url.includes('snapshots') || url.includes('/quotes')) {
      const data: Record<string, any> = { '2330': quote }
      // The holding is quoted once (the exit poll's read) and is gone when the NAV is marked.
      if (opts.held && String(init?.body ?? url).includes(opts.held.symbol) && ++heldReads === 1)
        data[opts.held.symbol] = { ...quote, symbol: opts.held.symbol, last: 10, price: 10, open: 10, high: 10, low: 10, reference_price: 10,
          bid: 10, ask: 10.05, bid_prices: [10, 9.99, 9.98, 9.97, 9.96], ask_prices: [10.05, 10.1, 10.15, 10.2, 10.25] }
      return Response.json({ data })
    }
    if (url.includes('/orderbook/')) return Response.json({ data: quote })
    if (url.includes('trend')) return Response.json({ slope_5min: .002 })
    if (url.includes('/snapshot/')) return Response.json({ data: quote })
    if (url.includes('/l5-market-data'))
      return Response.json({ status: 'ok', quotes: { '2330': { ...quote, provider: 'shioaji_proxy_orderbook', ask_volumes: [1, 1, 1, 1, 1] } } })
    if (url.includes('twse.com.tw')) return Response.json({ stat: 'OK', data: [] })
    if (url.includes('tpex.org.tw')) return Response.json([])
    if (url.includes('/kbars/')) {
      const px = url.includes('/0050') ? 100 : 20
      const open = Date.parse(T + 'T09:00:00+08:00')
      const close = (i: number) => px + (px === 20 ? (i >= 20 ? .1 : i >= 15 ? -.01 : 0) : 0)
      return Response.json({ status: 'ok', source: 'streaming_tick_accumulator', completed_only: true,
        data: Array.from({ length: 25 }, (_, i) => ({ ts: new Date(open + i * 60000).toISOString(),
          open: close(i), high: close(i), low: close(i), close: close(i), volume: 100 })) })
    }
    if (url.includes('taifex')) return new Response('', { status: 503 })
    throw new Error('unseeded_native_source:' + url)
  }
  if (opts.cash != null) {
    f.sqls.paper.prepare('UPDATE paper_accounts SET cash=?,initial_cash=? WHERE id=1').run(opts.cash, opts.cash)
    f.cfg.position.minPositionValue = 1000
  }
  f.kvs.set('trading:risk_config', JSON.stringify(RISK_CONFIG_FIXTURE))
  f.kvs.set('ml:adaptive_params', JSON.stringify({ ...DEFAULT_ADAPTIVE_PARAMS, recent_accuracy_30d: .6,
    provenance: { ...DEFAULT_ADAPTIVE_PARAMS.provenance, source: 'ml-controller', fallback: false } }))
  const dates: string[] = []
  for (let ms = Date.parse(S + 'T00:00:00Z'); dates.length < 60; ms -= 86400000)
    if (![0, 6].includes(new Date(ms).getUTCDay())) dates.unshift(new Date(ms).toISOString().slice(0, 10))
  f.sqls.core.prepare("INSERT INTO market_risk(date,twii_close,risk_score,risk_level) VALUES(?,30000,10,'green'),(?,30000,10,'green')").run(S, dates.at(-2)!)
  f.sqls.market.prepare('INSERT INTO market_breadth(date,advance_ratio,bull_alignment_pct) VALUES(?,.6,60)').run(S)
  f.sqls.market.prepare("INSERT INTO market_regime_factor_packets(date,schema_version,score,level,factor_json,contribution_json,source_json,freshness_json,missing_reason_json,lineage_json,generated_at) VALUES(?,'market-regime-factor-packet-v1',10,'green','[]','{}','{}','{}','{}','{}',?)")
    .run(S, S + 'T14:00:00Z')
  f.kvs.set('market_regime_state', JSON.stringify(buildMarketRegimeState({ label: 'bull_market', runDate: S, computedAt: S + 'T14:00:00Z' })))
  f.seedRiskQuality(S)
  f.sqls.learning.exec('CREATE TABLE active8_ensemble_pointer_v1(singleton_id INTEGER PRIMARY KEY,artifact_id TEXT,cohort_id TEXT,payload_checksum TEXT,base_artifact_set_checksum TEXT)')
  const l3 = { artifact_id: 'l3-fixture', cohort_id: 'cohort-fixture', payload_checksum: 'a'.repeat(64), base_artifact_set_checksum: 'b'.repeat(64) }
  f.sqls.learning.prepare('INSERT INTO active8_ensemble_pointer_v1(singleton_id,artifact_id,cohort_id,payload_checksum,base_artifact_set_checksum) VALUES(1,?,?,?,?)').run(...Object.values(l3))
  f.cfg.l4Distribution = { scope: 'private_research', constraints: { exposure_cap: .8, name_cap: .08, min_weight: .03, max_positions: 5 },
    artifact: { schema_version: 'l4-distribution-v1', feature_schema: 'full-l3-30-all-available-signals-v3', model_checksum: 'c'.repeat(64), l3_identity: l3 } } as any
  f.kvs.set('trading:config', JSON.stringify(f.cfg))
  f.sqls.core.exec("INSERT INTO stocks(id,symbol,name,market) VALUES(1,'2330','fixture','TWSE'),(2,'0050','benchmark','TWSE')")
  for (const d of dates) f.sqls.market.prepare('INSERT INTO stock_prices(stock_id,date,close) VALUES(2,?,?)').run(d, d === dates.at(-1) ? 100 : 98)
  f.sqls.market.prepare('INSERT INTO stock_prices(stock_id,date,open,high,low,close,avg_price,volume) VALUES(1,?,20,20.5,19.5,20,20,1000000)').run(S)
  const account = (await withPaperExecutionScope(f.ports, () => captureL4AccountContext(f.env, S))).result
  assert.equal(account.risk_limits.buys_halted, false)
  f.sqls.core.prepare(`INSERT INTO daily_recommendations(stock_id,symbol,name,date,rank,score,reason,signal,confidence,has_buy_signal,eligible_for_ml,eligible_for_pending_buy,alpha_allocation)
    VALUES(1,'2330','fixture',?,1,50,'synthetic fixture','HOLD',.5,0,1,1,?)`)
    .run(S, JSON.stringify({ engine: 'sparse_tangent_inverse_risk', selected: false, hmm_lineage: hmmLineage(JSON.parse(f.kvs.get('market_regime_state')!)) }))
  const script = fileURLToPath(new URL('../../../ml-controller/tests/l4_native_chain_allocator.py', import.meta.url))
  const allocated = spawnSync(process.env.NAV_TEST_PYTHON!, ['-B', script], { input: JSON.stringify({ account, identity: l3,
    hmm_lineage: hmmLineage(JSON.parse(f.kvs.get('market_regime_state')!)), reward_ledger: [],
    constraints: { ...f.cfg.l4Distribution!.constraints, buy_cost: .001425, sell_cost: .004425, name_cap: .08 } }), encoding: 'utf8' })
  assert.equal(allocated.status, 0, allocated.stderr)
  const parsed = JSON.parse(allocated.stdout.split('\n').find(line => line.startsWith('{"policy"'))!)
  f.cfg.l4Distribution = parsed.policy
  f.kvs.set('trading:config', JSON.stringify(f.cfg))
  const plan = parsed.envelope.plan
  await withPaperExecutionScope(f.ports, () => storeL4PortfolioPlan(f.env, parsed.envelope))
  await withPaperExecutionScope(f.ports, () => setupMorningPendingBuys(f.env))
  const pending = (await withPaperExecutionScope(f.ports, () => loadPendingBuySnapshot(f.env, T, { allowFallbackRecent: false }))).result.pendingBuys
  assert.deepEqual(pending.map(p => p.symbol), ['2330'])
  await withPaperExecutionScope(f.ports, async () => {
    assert.equal((await finalizeSinglePlan(f.env, T, { plan_id: plan.plan_id, signal_date: S, context_hash: 'f'.repeat(64) })).ready, true)
  })
  if (opts.held) {
    // A holding the sealed plan never saw: booked into the account after the seal (the account capture and the
    // allocator need marks and risk history for every holding, so it cannot exist before). It is quoted only
    // on its first read (the exit poll), so the NAV valuation finds no live quote for it.
    f.sqls.core.prepare("INSERT INTO stocks(id,symbol,name,market) VALUES(3,?,'held','TWSE')").run(opts.held.symbol)
    if (opts.held.previousClose != null)
      f.sqls.market.prepare('INSERT INTO stock_prices(stock_id,date,open,high,low,close,avg_price,volume) VALUES(3,?,?,?,?,?,?,1000000)')
        .run(S, opts.held.previousClose, opts.held.previousClose, opts.held.previousClose, opts.held.previousClose, opts.held.previousClose)
    f.sqls.paper.prepare("INSERT INTO paper_positions(account_id,symbol,name,shares,avg_cost,entry_price,entry_date) VALUES(1,?,'held',?,10,10,?)")
      .run(opts.held.symbol, opts.held.shares, T)
  }
  const at = (clock: string) => { f.ports.nowMs = Date.parse(`${T}T${clock}+08:00`) }
  const run = () => withPaperExecutionScope(f.ports, () => runIntradayCheck(f.env))
  const rows = (query: string, ...args: any[]) => f.sqls.paper.prepare(query).all(...args) as any[]
  const buys = () => rows("SELECT symbol,shares,price,note FROM paper_orders WHERE side='buy' ORDER BY id")
  const events = (symbol = '2330') => rows('SELECT event_type,status,reason,detail_json,source FROM paper_execution_events WHERE symbol=? ORDER BY id', symbol)
  return { f, T, S, plan, pending: pending[0], at, run, buys, events }
}

// 250,000 NAV x 8% name cap = 20,000: one board lot at the 20 entry price, so the board book is checked.
// The board ask of 20.05 then sizes the order to an odd lot (20,000 < 20,050), which must relock. The odd-lot
// book asks 19.95, so a fill kept from the board book is visible.
const RELOCK = { cash: 250_000, boardAsk: 20.05, oddAsk: 19.95 }

test('AUD-5 relock: a board-lot check sized to an odd lot is priced and filled on the odd-lot book', { skip }, async () => {
  const x = await nativeEntry(RELOCK)
  try {
    x.at('09:25:00')
    await x.run()
    const [buy, ...rest] = x.buys()
    assert.ok(buy, JSON.stringify(x.events().map(e => [e.status, e.reason])))
    assert.equal(rest.length, 0)
    // Filled on the odd-lot book's 19.95 ask, and the relock prices the order at that book's one-tick-slipped
    // 20.00 rather than the board book's 20.05. Shares stay at the 997 already authorized at the board price:
    // the 20.05 limit caps any relocked fill at or below the board fill, so the relocked size never shrinks here.
    assert.equal(buy.price, 19.95)
    assert.equal(buy.shares, 31, 'odd-lot top-of-book volume')
    // The order records the relocked book's quote, not the board book it was first checked on.
    const note = JSON.parse(buy.note)
    assert.equal(note.quote_ask, 19.95)
    assert.equal(note.quote_ask_volume, 31)
    const relocked = x.events().filter(e => e.status === 'entry_lot_relocked')
    assert.equal(relocked.length, 1, JSON.stringify(x.events().map(e => [e.status, e.reason])))
    assert.equal(relocked[0].reason, 'lot_type=odd_lot')
    assert.match(relocked[0].detail_json, /^\{"detail":"fill=20;shares=997"\}$/)
  } finally { x.f.close() }
})

test('AUD-5 relock counter: an unavailable odd-lot book blocks the entry, never a board-lot fill', { skip }, async () => {
  const x = await nativeEntry({ ...RELOCK, oddBookDown: true })
  try {
    x.at('09:25:00')
    await x.run()
    assert.deepEqual(x.buys(), [])
    assert.ok(!x.events().some(e => e.status === 'entry_lot_relocked'))
    const blocked = x.events().filter(e => e.reason === 'l4_odd_lot_book_not_ready' && e.status === 'quote_unavailable')
    assert.equal(blocked.length, 1, JSON.stringify(x.events().map(e => [e.status, e.reason])))
    assert.equal(x.f.sqls.paper.prepare('SELECT COUNT(*) n FROM paper_positions').get()?.n, 0)
  } finally { x.f.close() }
})

test('intraday_nav_marks_missing: a holding with no live quote and no previous-session close blocks the new buy', { skip }, async () => {
  const x = await nativeEntry({ held: { symbol: '3374', shares: 1000, previousClose: null } })
  try {
    x.at('09:25:00')
    await x.run()
    assert.deepEqual(x.buys(), [])
    const blocked = x.events().filter(e => e.reason === 'intraday_nav_marks_missing')
    assert.equal(blocked.length, 1, JSON.stringify(x.events().map(e => [e.event_type, e.status, e.reason])))
    assert.equal(blocked[0].event_type, 'paper_order')
    assert.equal(blocked[0].status, 'blocked')
    assert.equal(blocked[0].source, 'intraday_nav_valuation')
    assert.deepEqual(JSON.parse(blocked[0].detail_json), { missing_symbols: ['3374'], fallback_price_date: x.S })
    // The entry never reached the allocator: no budget was sized against an unknown NAV.
    assert.ok(!x.events().some(e => e.status === 'allocator_buy'))
    assert.equal(x.f.sqls.paper.prepare("SELECT shares FROM paper_positions WHERE symbol='3374'").get()?.shares, 1000)
    // The pending buy stays active for the next check; the active-state snapshot carries the valuation stage.
    const kept = (await withPaperExecutionScope(x.f.ports, () => loadPendingBuySnapshot(x.f.env, x.T, { allowFallbackRecent: false }))).result
    assert.deepEqual(kept.pendingBuys.map(p => p.symbol), ['2330'])
    const meta = JSON.parse(x.f.kvs.get(`paper:pending_buys_meta:${x.T}`)!)
    assert.equal(meta.stage, 'intraday_nav_valuation')
    assert.equal(meta.reason, 'intraday_nav_marks_missing')
    assert.deepEqual(JSON.parse(meta.detail).missing_symbols, ['3374'])
  } finally { x.f.close() }
})

test('intraday_nav_marks_missing counter: the previous-session close marks the holding and the buy proceeds', { skip }, async () => {
  const x = await nativeEntry({ held: { symbol: '3374', shares: 1000, previousClose: 10 } })
  try {
    x.at('09:25:00')
    await x.run()
    assert.ok(!x.events('2330').some(e => e.reason === 'intraday_nav_marks_missing'))
    assert.ok(x.events().some(e => e.status === 'allocator_buy'), JSON.stringify(x.events().map(e => [e.status, e.reason])))
    assert.equal(x.buys().length, 1)
  } finally { x.f.close() }
})

// R14 runs on a second-breakout trade date. The first ATR signal completes on the 09:20 bar, so it
// triggers at 09:25 and its original recovery deadline is 09:55.
const R14 = { signalDate: '2026-10-16', tradeDate: '2026-10-19' }
async function latchedWithoutAuthorization(x: Awaited<ReturnType<typeof nativeEntry>>) {
  x.at('09:25:00')
  const assess = createSwingEntryAssessor(x.f.env, x.T, x.f.cfg.position.strongBreakoutMaxEntryChasePct)
  await withPaperExecutionScope(x.f.ports, () => assess(x.pending, 20))
  // A passed signal latched without its authorization (e.g. by the pre-R14 code), identical otherwise.
  x.f.sqls.paper.prepare("UPDATE paper_second_breakout_state_v2 SET evidence_json=json_remove(evidence_json,'$.authorization') WHERE symbol='2330'").run()
  const saved = await readSecondBreakout(x.f.env.PAPER_DB, 1, x.T, '2330')
  assert.equal(saved?.policy, SECOND_BREAKOUT_POLICY)
  assert.equal(saved?.status, 'passed')
  assert.equal(saved?.triggerMs, Date.parse(`${x.T}T09:25:00+08:00`))
  assert.equal(saved?.authorization, undefined)
}

test('R14 late: a passed signal latched without authorization is authorized off the bar minute, before its deadline, and buys', { skip }, async () => {
  const x = await nativeEntry(R14)
  try {
    await latchedWithoutAuthorization(x)
    x.at('09:27:00')
    await x.run()
    const saved = await readSecondBreakout(x.f.env.PAPER_DB, 1, x.T, '2330')
    assert.equal(saved?.authorization?.submitUntilMs, Date.parse(`${x.T}T09:55:00+08:00`))
    assert.equal(saved?.authorization?.signalMs, Date.parse(`${x.T}T09:25:00+08:00`))
    const decision = x.events().filter(e => e.event_type === 'intraday_technical_decision' && e.source === SWING_POLICY_VERSION).at(-1)
    assert.equal(decision?.status, 'pass', JSON.stringify(x.events().map(e => [e.status, e.reason])))
    assert.notEqual(JSON.parse(decision!.detail_json).bar_source, 'saved_signal')
    const [buy, ...rest] = x.buys()
    assert.ok(buy, JSON.stringify(x.events().map(e => [e.status, e.reason])))
    assert.equal(rest.length, 0)
    assert.equal(JSON.parse(buy.note).order_intent.executionConstraints.swingAuthorization.signalKey, `${x.T}:${saved!.triggerMs}`)
  } finally { x.f.close() }
})

test('R14 late counter: at the original deadline the unauthorized signal stays unauthorized and nothing is bought', { skip }, async () => {
  const x = await nativeEntry(R14)
  try {
    await latchedWithoutAuthorization(x)
    x.at('09:55:00')
    await x.run()
    assert.equal((await readSecondBreakout(x.f.env.PAPER_DB, 1, x.T, '2330'))?.authorization, undefined)
    const decision = x.events().filter(e => e.event_type === 'intraday_technical_decision' && e.source === SWING_POLICY_VERSION).at(-1)
    assert.equal(decision?.status, 'defer')
    assert.equal(decision?.reason, 'swing_recovery_not_observed_live')
    assert.equal(JSON.parse(decision!.detail_json).bar_source, 'saved_signal')
    assert.deepEqual(x.buys(), [])
  } finally { x.f.close() }
})
