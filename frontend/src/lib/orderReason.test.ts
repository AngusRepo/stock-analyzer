import assert from 'node:assert/strict'
import test from 'node:test'
import { humanEntryReason, humanExitReason, humanOrderReason } from './orderReason'

// Real sell-note shapes written by worker/src/lib/paperExitTasks.ts (buildSellOrderNote / decision.reason).
const sell = (note: unknown) => humanOrderReason({ side: 'sell', note: typeof note === 'string' ? note : JSON.stringify(note) })

test('sell notes never put the raw Worker string on screen; the raw string stays in title', () => {
  const cases: Array<[unknown, string]> = [
    [{ reason: '[intraday] [L4Target] plan=l4p_20261125_abc;target=0.05 (mkt=123.5, -1 tick fill)', exit_category: 'model_exit' }, 'L4 目標權重調整'],
    [{ reason: '[PortfolioRisk] red current=80.0% target=40.0% owner=canonical_market_risk_runtime_v1' }, '組合風控減碼（市場風險紅燈）'],
    [{ reason: '[intraday] s12_tp1 (mkt=100, -1 tick fill)' }, '停利出場'],
    [{ reason: '[13:24 daytrade force close] atr_trail_stop' }, '移動停損出場'],
    [{ reason: '[intraday] Hard stop -8.1% (mkt=95, -1 tick fill)' }, '停損出場'],
    [{ reason: '[intraday] swing_daily_orl', exit_category: 'structural_stop' }, '結構停損出場'],
    [{ reason: 'whatever', exit_category: 'take_profit' }, '停利出場'],
    [{ reason: '[intraday] something_new_from_worker (mkt=1)' }, '依出場規則賣出'],
    ['[Intraday] full sell 2330 1000 @ 1000 (mkt 1001) Time stop 20d +3.0%', '依出場規則賣出'],
  ]
  for (const [note, text] of cases) {
    const view = sell(note)
    assert.equal(view.text, text, JSON.stringify(note))
    assert.ok(!/\[|mkt=|plan=|owner=|_v1/.test(view.text), `raw code leaked: ${view.text}`)
    assert.ok(view.raw.length > 0, 'raw note is kept for the title')
  }
})

test('target in an entry/gate code is not take-profit; entry and exit use separate tables', () => {
  assert.equal(humanEntryReason('l4_target_locked', '其他原因'), 'L4 目標鎖定，不再加碼')
  assert.equal(humanEntryReason('l4_target_met_or_cash_reserved', '其他原因'), '已達 L4 目標或保留現金')
  assert.equal(humanEntryReason('l4_target_reconciliation', '其他原因'), 'L4 目標與持倉對帳中')
  assert.equal(humanEntryReason('regime_gate_closed', '其他原因'), '盤勢閘門關閉，不進場')
  assert.equal(humanEntryReason('swing_atr_day_veto', '其他原因'), '首次原進場訊號動能未通過；今日不再買入')
  assert.equal(humanEntryReason('l4_hard_risk_veto_new', '其他原因'), '其他原因', 'unknown codes fall back, never echo')
  // The exit table never reads an entry gate code as a take-profit.
  assert.equal(humanExitReason('l4_target_locked', '依出場規則賣出'), '依出場規則賣出')
  assert.equal(humanExitReason('swing_stop_recovery_target', '依出場規則賣出'), '依出場規則賣出')
})

test('buy notes keep the plan summary', () => {
  const view = humanOrderReason({ side: 'buy', note: JSON.stringify({ ml_entry: 2100, ml_stop: 1995, ml_t1: 2300 }) })
  assert.equal(view.text, '計畫進場 $2100 · 停損 $1995 · 目標 $2300')
})

test('R2-4: gate reasons the Worker writes most often have Chinese labels; unknown codes stay 其他原因', () => {
  const cases: Record<string, string> = {
    l4_hard_risk_veto: 'S12 否決或五檔品質未通過，L4 不進場',
    position_sector_cap: '同產業持股已達上限',
    position_correlation_cap: '與現有持股相關性過高',
    paper_order_risk_blocked: '下單風控驗證未通過',
    quote_unavailable: '報價暫不可用',
    stale_quote: '報價過期，等待新報價',
    'stale_quote:95s': '報價過期，等待新報價',
    'broker_quote_required:finlab': '需要券商即時報價',
    restricted_execution_gate: '官方交易限制（處置、下市等），不進場',
    s12_unified_no_buy: 'S12 空方防守成立，今日不買',
  }
  for (const [code, label] of Object.entries(cases)) assert.equal(humanEntryReason(code, '其他原因'), label, code)
  assert.equal(humanEntryReason('totally_new_gate', '其他原因'), '其他原因')
})

test('R3-2: portfolio-level gates and L5 quality reasons have Chinese labels', () => {
  const cases: Record<string, string> = {
    portfolio_risk_halt: '組合熔斷，暫停新倉',
    p8_daily_loss: '當日虧損達上限，暫停新倉',
    p8_fail_closed: '前一日淨值基準缺失，暫停新倉',
    p9_intraday_drawdown_halt: '盤中回撤達上限，暫停新倉',
    p9_state_unavailable: '盤中回撤無法評估，暫停新倉',
    intraday_nav_marks_missing: '持股缺報價、淨值無法估算，暫停新倉',
    l5_depth_incomplete: '五檔深度不足',
    auto_swap_replacement_not_executable: '換股標的目前無法成交',
  }
  for (const [code, label] of Object.entries(cases)) assert.equal(humanEntryReason(code, '其他原因'), label, code)
})
