import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { l4NativeFixture } from './l4NativeFixture.testSupport'
import { computeNavCashFlowResidual, NAV_RECONCILIATION_TOLERANCE_NTD, reconcilePaperNavCashFlow } from './paperSnapshotAudit'
import { runDailySnapshot } from './paperWorkerTasks'
import { withPaperExecutionScope } from './paperExecutionScope'
import { sessionMarkDateIssues } from './paperValuationDate'

const point = (date: string, cash: number, positions: Record<string, number>, marks: Record<string, number>) => ({
  date, cash, positions, marks,
  nav: cash + Object.entries(positions).reduce((sum, [symbol, shares]) => sum + shares * (marks[symbol] ?? 0), 0),
})
const none = { tradeCash: 0, corporateCash: 0, tradeShares: {}, corporateShares: {} }

test('NAV reconciliation explains overnight holds, same-day buys/sells, odd lots and corporate flows', () => {
  // Overnight hold: only the mark moves.
  assert.equal(computeNavCashFlowResidual(point('d0', 5e5, { A: 1000 }, { A: 100 }), point('d1', 5e5, { A: 1000 }, { A: 90 }), none).residual, 0)
  // Same-day board-lot buy (fee included in the settlement amount) and odd-lot sell.
  const prev = point('d0', 5e5, { A: 1000, B: 300 }, { A: 100, B: 50 })
  const cur = point('d1', 5e5 - 20_028 + 14_920, { A: 1000, B: 0, C: 1000 }, { A: 101, C: 20.5 })
  const flows = { tradeCash: -20_028 + 14_920, corporateCash: 0, tradeShares: { C: 1000, B: -300 }, corporateShares: {} }
  const result = computeNavCashFlowResidual(prev, cur, flows)
  assert.equal(result.residual, 0)
  assert.equal(result.within_tolerance, true)
  // Paid cash dividend and delivered stock dividend.
  assert.equal(computeNavCashFlowResidual(point('d0', 1e5, { A: 1000 }, { A: 50 }), point('d1', 1e5 + 2500, { A: 1100 }, { A: 45 }),
    { tradeCash: 0, corporateCash: 2500, tradeShares: {}, corporateShares: { A: 100 } }).residual, 0)
})

test('NAV reconciliation flags unexplained cash and share changes beyond the 1 NTD tolerance', () => {
  assert.equal(NAV_RECONCILIATION_TOLERANCE_NTD, 1)
  const prev = point('d0', 1e5, { A: 1000 }, { A: 50 })
  assert.equal(computeNavCashFlowResidual(prev, point('d1', 1e5 + 1, { A: 1000 }, { A: 50 }), none).within_tolerance, true)
  const cash = computeNavCashFlowResidual(prev, point('d1', 1e5 + 1.5, { A: 1000 }, { A: 50 }), none)
  assert.equal(cash.within_tolerance, false)
  assert.equal(cash.cash_residual, 1.5)
  const shares = computeNavCashFlowResidual(prev, point('d1', 1e5, { A: 1500 }, { A: 50 }), none)
  assert.deepEqual(shares.share_residuals, { A: 500 })
  assert.equal(shares.residual, 25_000)
  // An unexplained new symbol without any mark is never valued as zero.
  const unmarked = computeNavCashFlowResidual(prev, { ...point('d1', 1e5, { A: 1000 }, { A: 50 }), positions: { A: 1000, Z: 10 } }, none)
  assert.equal(unmarked.within_tolerance, false)
})

function fixture() {
  const f = l4NativeFixture()
  f.sqls.paper.exec(readFileSync(new URL('../../domain-migrations/paper/0007_daily_plan_reviews.sql', import.meta.url), 'utf8'))
  f.kvs.set('trading:config', JSON.stringify({ l4Distribution: {} }))
  // No post-close quote source: marks come only from the exact session close.
  f.ports.fetchFrozen = async () => new Response('', { status: 503 })
  f.sqls.core.exec("INSERT INTO stocks(id,symbol,name,market) VALUES(1,'2330','fixture','TWSE'),(2,'0050','etf','TWSE')")
  const price = (date: string, id: number, value: number) => f.sqls.market.prepare(
    'INSERT INTO stock_prices(stock_id,date,open,high,low,close,avg_price,volume) VALUES(?,?,?,?,?,?,?,1000)').run(id, date, value, value, value, value, value)
  const snapshot = (date: string) => {
    f.ports.nowMs = Date.parse(`${date}T14:20:00+08:00`)
    return withPaperExecutionScope(f.ports, () => runDailySnapshot(f.env, { date }))
  }
  const events = (reason: string) => f.sqls.paper.prepare(
    "SELECT trade_date, status, detail_json FROM paper_execution_events WHERE event_type='snapshot_audit' AND reason=? ORDER BY id").all(reason) as any[]
  return { ...f, price, snapshot, events }
}

test('daily snapshot records reconciliation, pending valuation for missing held marks, and exact benchmarks', async () => {
  const f = fixture()
  try {
    f.sqls.core.exec("INSERT INTO market_risk(date,twii_close,risk_score,risk_level) VALUES('2026-09-14',30000,10,'green')")
    f.price('2026-09-14', 2, 150)
    let run = await f.snapshot('2026-09-14')
    assert.equal(run.result.valuation.nav, 1e6)
    assert.equal(f.events('nav_reconciliation_unavailable').length, 1)
    assert.equal(f.events('benchmark_mark_missing').length, 0)
    assert.equal(f.sqls.paper.prepare("SELECT benchmark_value FROM paper_daily_snapshots WHERE date='2026-09-14'").get()?.benchmark_value, 150)

    // A same-day buy settles through the ledger: residual 0. 0050/TWII have no 09-15 close: null + warn, never 09-14's.
    f.sqls.paper.exec(`INSERT INTO paper_orders(id,account_id,symbol,side,shares,price,commission,total_cost,created_at)
      VALUES(10,1,'2330','buy',1000,20,28,20028,'2026-09-15 02:00:00')`)
    f.sqls.paper.exec("INSERT INTO paper_settlements(account_id,order_id,symbol,side,amount,trade_date,settlement_date) VALUES(1,10,'2330','buy',20028,'2026-09-15','2026-09-17')")
    f.sqls.paper.exec("INSERT INTO paper_positions(account_id,symbol,name,shares,avg_cost,entry_price,entry_date) VALUES(1,'2330','fixture',1000,20.028,20,'2026-09-15')")
    f.price('2026-09-15', 1, 21)
    run = await f.snapshot('2026-09-15')
    const ok = f.events('nav_cash_flow_residual')
    assert.equal(ok.length, 1)
    assert.equal(ok[0].status, 'verified')
    assert.equal(JSON.parse(ok[0].detail_json).residual, 0)
    const snap = f.sqls.paper.prepare("SELECT benchmark_value, twii_value FROM paper_daily_snapshots WHERE date='2026-09-15'").get() as any
    assert.equal(snap.benchmark_value, null)
    assert.equal(snap.twii_value, null)
    assert.equal(f.events('benchmark_mark_missing').length, 1)

    // Unexplained cash: warned and notified once on the first write of the session.
    f.sqls.paper.exec('UPDATE paper_accounts SET cash=cash+500 WHERE id=1')
    f.price('2026-09-16', 1, 21); f.price('2026-09-16', 2, 151)
    f.sqls.core.exec("INSERT INTO market_risk(date,twii_close,risk_score,risk_level) VALUES('2026-09-16',30100,10,'green')")
    run = await f.snapshot('2026-09-16')
    const warn = f.events('nav_cash_flow_residual').at(-1)
    assert.equal(warn.status, 'warn')
    assert.equal(JSON.parse(warn.detail_json).cash_residual, 500)
    assert.equal(run.notifications.filter((n: any) => /NAV 對帳差額/.test(n.message)).length, 1)
    run = await f.snapshot('2026-09-16') // rerun of the same session re-records but does not notify again
    assert.equal(run.notifications.filter((n: any) => /NAV 對帳差額/.test(n.message)).length, 0)

    // A held symbol without the session's exact close: pending valuation recorded, then the snapshot fails.
    await assert.rejects(f.snapshot('2026-09-17'), /paper_snapshot_held_marks_missing:2330/)
    const pending = f.events('paper_snapshot_held_marks_missing')
    assert.equal(pending.length, 1)
    assert.equal(pending[0].status, 'pending_valuation')
    // Pending valuation is execution-critical: the full detail lives in the evidence artifact.
    const pointer = JSON.parse(pending[0].detail_json).evidence_pointer
    assert.ok(pointer?.r2_key)
    assert.match(f.artifacts.get(pointer.r2_key) ?? '', /"missing_symbols":\["2330"\]/)
    assert.equal(f.sqls.paper.prepare("SELECT COUNT(*) AS n FROM paper_daily_snapshots WHERE date='2026-09-17'").get()?.n, 0)
  } finally { f.close() }
})

test('corporate receivable marks use only today or the previous trading session exact close (holiday aware)', async () => {
  const { corporateAccountRiskBounds } = await import('./paperCorporateActions')
  const f = fixture()
  try {
    f.sqls.paper.exec(`INSERT INTO paper_corporate_entitlements_v1(account_id,action_id,symbol,kind,ex_date,eligible_shares,shares_due,whole_shares_due,terms_json,source_checksum,recognized_at)
      VALUES(1,'stk-1','2330','stock','2026-09-10',1000,100,100,'{}','x','2026-09-10T00:00:00Z')`)
    f.kvs.set('holiday:2026-09-11', 'fixture holiday')
    const bounds = () => withPaperExecutionScope(f.ports, () => corporateAccountRiskBounds(f.env, 1))
    f.ports.nowMs = Date.parse('2026-09-14T10:00:00+08:00')
    f.price('2026-09-09', 1, 30) // older than the previous session (09-10, since 09-11 is a holiday)
    await assert.rejects(bounds(), /paper_corporate_receivable_mark_missing:2330/)
    f.price('2026-09-10', 1, 31)
    assert.equal((await bounds()).result.lower, 3100)
    f.price('2026-09-14', 1, 32) // today's exact close, once published, wins
    assert.equal((await bounds()).result.lower, 3200)
  } finally { f.close() }
})

test('O04 ledger flows: sells, buys, odd lots, settled dividends and exchange conversions reconcile across a holiday gap', async () => {
  const f = fixture()
  try {
    f.kvs.set('holiday:2026-09-11', 'fixture holiday')
    const valuation = (cash: number, positions: Record<string, number>, marks: Record<string, number>) => ({
      cash, positions, marks, valuation_complete: true,
      nav: cash + Object.entries(positions).reduce((sum, [symbol, shares]) => sum + shares * marks[symbol], 0),
    })
    // Previous complete session (09-10); 09-11 is a holiday, so the window is (09-10, 09-14].
    f.sqls.paper.prepare(`INSERT INTO paper_execution_events(account_id,trade_date,event_type,status,reason,detail_json,source,created_at)
      VALUES(1,'2026-09-10','snapshot_audit','verified','dated_marks_complete',?,'daily_snapshot','2026-09-10T06:20:00Z')`)
      .run(JSON.stringify(valuation(100_000, { A: 1000, B: 300, C: 100 }, { A: 50, B: 20, C: 100 })))
    // Odd-lot sell of B and a board-lot buy of D, both settling T+2 after the window closes.
    f.sqls.paper.exec(`INSERT INTO paper_orders(id,account_id,symbol,side,shares,price,commission,total_cost,created_at) VALUES
      (21,1,'B','sell',300,20,20,5940,'2026-09-14 02:00:00'),(22,1,'D','buy',1000,10,14,10014,'2026-09-14 02:05:00')`)
    f.sqls.paper.exec(`INSERT INTO paper_settlements(account_id,order_id,symbol,side,amount,trade_date,settlement_date) VALUES
      (1,21,'B','sell',5940,'2026-09-14','2026-09-16'),(1,22,'D','buy',10014,'2026-09-14','2026-09-16')`)
    // Settled cash and stock dividends on A.
    f.sqls.paper.exec(`INSERT INTO paper_corporate_entitlements_v1(account_id,action_id,symbol,kind,ex_date,eligible_shares,cash_due,shares_due,whole_shares_due,terms_json,source_checksum,recognized_at,settled,settled_at) VALUES
      (1,'cash-a','A','cash','2026-09-08',1000,2000,0,0,'{}','x','2026-09-08T00:00:00Z',1,'2026-09-14T00:30:00Z'),
      (1,'stock-a','A','stock','2026-09-08',1000,0,100,100,'{}','x','2026-09-08T00:00:00Z',1,'2026-09-14T00:30:00Z')`)
    // Exchange C 100 -> 75 recorded by the corporate opening.
    const conversion = () => f.sqls.paper.prepare(`INSERT INTO paper_execution_events(account_id,trade_date,symbol,event_type,status,reason,detail_json,source,created_at)
      VALUES(1,'2026-09-14','C','corporate_share_conversion','recorded','exchange',?,'paper_corporate_actions_v1','2026-09-14T00:30:00Z')`)
      .run(JSON.stringify({ action_id: 'exchange-c', shares_before: 100, shares_after: 75 }))
    const current = valuation(100_000 + 5940 - 10014 + 2000, { A: 1100, C: 75, D: 1000 }, { A: 48, C: 130, D: 10 })
    const run = () => withPaperExecutionScope(f.ports, () => reconcilePaperNavCashFlow(f.env, { date: '2026-09-14', valuation: current, notify: false }))
    f.ports.nowMs = Date.parse('2026-09-14T14:20:00+08:00')
    // Without the conversion record the exchange is an unexplained share change.
    let result = (await run()).result!
    assert.deepEqual(result.share_residuals, { C: -25 })
    assert.equal(result.within_tolerance, false)
    conversion()
    result = (await run()).result!
    assert.equal(result.residual, 0)
    assert.equal(result.cash_residual, 0)
    assert.deepEqual(result.share_residuals, {})
    assert.equal(result.within_tolerance, true)
    assert.equal(result.previous_date, '2026-09-10')
  } finally { f.close() }
})

test('O04 mark-date check: a held mark must be dated the valuation session, never an older price', () => {
  const session = '2026-09-17'
  const close = { price: 21, price_date: session, source: 'stock_prices.exact_session_close', quote_time: null }
  const quote = { price: 22, price_date: session, source: 'post_close_shioaji', quote_time: '2026-09-17 13:30:00' }
  assert.deepEqual(sessionMarkDateIssues(['A', 'B'], { A: close, B: quote }, session), [])
  // Injected stale prices: a close dated another session, and a quote whose own time is the previous day.
  assert.deepEqual(sessionMarkDateIssues(['A', 'B'], { A: { ...close, price_date: '2026-09-16' }, B: { ...quote, quote_time: '2026-09-16T05:30:00Z' } }, session), [
    { symbol: 'A', issue: 'stale', price_date: '2026-09-16', source: 'stock_prices.exact_session_close' },
    { symbol: 'B', issue: 'stale', price_date: '2026-09-16', source: 'post_close_shioaji' },
  ])
  // A time-only quote cannot prove its date; no price at all is missing.
  assert.deepEqual(sessionMarkDateIssues(['B', 'C'], { B: { ...quote, quote_time: '13:30:00' } }, session), [
    { symbol: 'B', issue: 'undated', price_date: null, source: 'post_close_shioaji' },
    { symbol: 'C', issue: 'missing', price_date: null, source: null },
  ])
  // Zoned times are converted to the Taiwan day; a close row without its own date cannot prove one.
  assert.deepEqual(sessionMarkDateIssues(['B'], { B: { ...quote, quote_time: '2026-09-17T05:30:00Z' } }, session), [])
  assert.deepEqual(sessionMarkDateIssues(['B'], { B: { ...quote, quote_time: '2026-09-16T17:00:00+00:00' } }, session), [])
  assert.deepEqual(sessionMarkDateIssues(['B'], { B: { ...quote, quote_time: '2026-09-16T15:59:00Z' } }, session), [
    { symbol: 'B', issue: 'stale', price_date: '2026-09-16', source: 'post_close_shioaji' },
  ])
  assert.deepEqual(sessionMarkDateIssues(['A'], { A: { ...close, price_date: null } }, session), [
    { symbol: 'A', issue: 'undated', price_date: null, source: 'stock_prices.exact_session_close' },
  ])
  // A price the source returned but refused for its date is reported as stale, not silently missing.
  assert.deepEqual(sessionMarkDateIssues(['C'], {}, session, new Map([['C', { quote_time: '2026-09-16 13:30:00', source: 'shioaji' }]])), [
    { symbol: 'C', issue: 'stale', price_date: '2026-09-16', source: 'shioaji' },
  ])
})

test('O04 acceptance: a stale broker quote injected into the daily snapshot is refused and the snapshot fails closed', async () => {
  const f = fixture()
  try {
    f.sqls.paper.exec("INSERT INTO paper_positions(account_id,symbol,name,shares,avg_cost,entry_price,entry_date) VALUES(1,'2330','fixture',1000,20,20,'2026-09-15')")
    f.price('2026-09-16', 1, 21) // older close only; no 09-17 close
    f.price('2026-09-17', 2, 150)
    f.sqls.core.exec("INSERT INTO market_risk(date,twii_close,risk_score,risk_level) VALUES('2026-09-17',30000,10,'green')")
    ;(f.env as any).SHIOAJI_PROXY_URL = 'https://proxy.invalid'
    let quoteTime = '2026-09-16 13:30:00'
    f.ports.fetchFrozen = async (input: any) => String(input).endsWith('/snapshots')
      ? Response.json({ data: { '2330': { close: 23, ts: quoteTime } } })
      : new Response('', { status: 503 })
    await assert.rejects(f.snapshot('2026-09-17'), /^Error: paper_snapshot_mark_date_mismatch:2026-09-17:2330@2026-09-16$/)
    const pending = f.events('paper_snapshot_mark_date_mismatch')
    assert.equal(pending.length, 1)
    assert.equal(pending[0].status, 'pending_valuation')
    const detail = JSON.parse(f.artifacts.get(JSON.parse(pending[0].detail_json).evidence_pointer.r2_key) ?? '{}').payload.detail
    assert.deepEqual(detail.mark_issues, [{ symbol: '2330', issue: 'stale', price_date: '2026-09-16', source: 'shioaji' }])
    assert.deepEqual(detail.marks, {})
    assert.equal(detail.rejected_quotes['2330'].price, 23)
    assert.equal(f.sqls.paper.prepare("SELECT COUNT(*) AS n FROM paper_daily_snapshots WHERE date='2026-09-17'").get()?.n, 0)
    // The same quote dated the session is a valid mark.
    quoteTime = '2026-09-17 13:30:00'
    const run = await f.snapshot('2026-09-17')
    assert.equal(run.result.valuation.marks['2330'], 23)
    assert.equal(run.result.valuation.mark_evidence['2330'].price_date, '2026-09-17')
  } finally { f.close() }
})

test('O04 acceptance: an older close that reaches the mark evidence is stopped by the mark-date check alone', async () => {
  const f = fixture()
  try {
    f.sqls.paper.exec("INSERT INTO paper_positions(account_id,symbol,name,shares,avg_cost,entry_price,entry_date) VALUES(1,'2330','fixture',1000,20,20,'2026-09-15')")
    f.price('2026-09-16', 1, 21) // older close only; no 09-17 close
    f.price('2026-09-17', 2, 150)
    f.sqls.core.exec("INSERT INTO market_risk(date,twii_close,risk_score,risk_level) VALUES('2026-09-17',30000,10,'green')")
    // Simulate a loader regression to "latest close on or before the session": the 09-16 row and its own
    // date now reach finalPriceMap and the evidence. The exact-date SQL filter is no longer the guard.
    const market = (f.env as any).MARKET_DB
    const prepare = market.prepare.bind(market)
    market.prepare = (sql: string) => prepare(sql.includes('close AS price, date FROM stock_prices')
      ? sql.replace('AND date=? AND close>0', 'AND date<=? AND close>0') : sql)
    await assert.rejects(f.snapshot('2026-09-17'), /^Error: paper_snapshot_mark_date_mismatch:2026-09-17:2330@2026-09-16$/)
    const pending = f.events('paper_snapshot_mark_date_mismatch')
    const detail = JSON.parse(f.artifacts.get(JSON.parse(pending[0].detail_json).evidence_pointer.r2_key) ?? '{}').payload.detail
    // The stale price did enter the marks; only the date check refused it.
    assert.equal(detail.marks['2330'], 21)
    assert.equal(detail.mark_evidence['2330'].price_date, '2026-09-16')
    assert.deepEqual(detail.mark_issues, [{ symbol: '2330', issue: 'stale', price_date: '2026-09-16', source: 'stock_prices.exact_session_close' }])
    assert.equal(f.sqls.paper.prepare("SELECT COUNT(*) AS n FROM paper_daily_snapshots WHERE date='2026-09-17'").get()?.n, 0)
  } finally { f.close() }
})
