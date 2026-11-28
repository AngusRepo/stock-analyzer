import test from 'node:test'
import assert from 'node:assert/strict'
import {
  axisPosition, buildCompletedRow, buildSimRow, CONDITION_KEYS, countByStatus, defaultView, formatQuoteAge, isClosedDay, marketTrend,
  postOutcome, selectSimQuote, sessionPhase, sortRows, staleQuoteLabel, twClock,
} from './simroomModel'
import fs from 'node:fs'
import { formatS12IntradayStructureState } from './pendingBuyExecutionUi'

const NOW = Date.parse('2026-11-26T02:00:00Z') // Thu 10:00 Taipei

function item(over: Record<string, any> = {}, or15: Record<string, any> = {}) {
  return {
    symbol: '2330', name: '台積電', execution_status: 'pending', ml_entry_price: 1000,
    planned_allocation: { target_weight: 0.1, locked: false, finalized_at: '2026-11-26T00:40:00Z' },
    execution_preview: {
      or15: {
        checked_at: '2026-11-26T01:59:00Z', or_high: 1010, or_low: 990, max_buy_price: 1020, limit_up: 1100,
        previous_close: 1000, vwap: 1002, conditions: { plan: true, ma60: false, opening_limit: true, atr_once: true, bars: true, or_touch: false },
        ...or15,
      },
    },
    ...over,
  }
}

test('session phase, default view and axis follow Taipei time', () => {
  assert.equal(sessionPhase(0), 'premarket')
  assert.equal(sessionPhase(8 * 60 + 59), 'premarket')
  assert.equal(sessionPhase(9 * 60), 'intraday')
  assert.equal(sessionPhase(13 * 60 + 29), 'intraday')
  assert.equal(sessionPhase(13 * 60 + 30), 'postmarket')
  assert.equal(sessionPhase(23 * 60 + 59), 'postmarket')
  assert.equal(defaultView('premarket'), 'premarket')
  assert.equal(defaultView('postmarket'), 'postmarket')
  assert.equal(axisPosition(0), 0)
  assert.ok(axisPosition(9 * 60) > axisPosition(8 * 60))
  const clock = twClock(NOW)
  assert.deepEqual(clock, { minutes: 600, weekday: 4, date: '2026-11-26' })
})

test('closed day uses the weekend or the Worker holiday-backed outside_session status, intraday only', () => {
  assert.equal(isClosedDay({ minutes: 600, weekday: 6, date: '' }), true)
  assert.equal(isClosedDay({ minutes: 600, weekday: 3, date: '' }, 'outside_session'), true)
  assert.equal(isClosedDay({ minutes: 600, weekday: 3, date: '' }, 'ok'), false)
  // Before 09:00 outside_session is normal, so it must not mark the day closed.
  assert.equal(isClosedDay({ minutes: 500, weekday: 3, date: '' }, 'outside_session'), false)
})

test('row status, first blocker and MA60 record-only tone', () => {
  const quote = { price: 1005, as_of: new Date(NOW - 10_000).toISOString(), reference_price: 1000 }
  const row = buildSimRow(item(), quote, NOW)
  assert.equal(row.conditions.length, 16)
  assert.deepEqual(row.conditions.map((c) => c.key), CONDITION_KEYS)
  const ma60 = row.conditions.find((c) => c.key === 'ma60')!
  assert.equal(ma60.tone, 'rec', 'MA60 is record-only and never blocks')
  assert.equal(row.conditions[row.firstBlocker].key, 'or_touch', 'first non-passing gate after the record-only MA60')
  assert.equal(row.conditions[row.firstBlocker].tone, 'warn', 'a not-yet-touched ORH is waiting, not terminal')
  assert.equal(row.status, 'near', '1005 is within 1% under ORH 1010')
  assert.ok(Math.abs(row.distancePct! - (1005 / 1010 - 1) * 100) < 1e-9)
  assert.equal(row.chase, 1020)
  assert.equal(row.changePct, 0.5)
})

test('terminal conditions stop the row; fills win', () => {
  const quote = { price: 1005, as_of: new Date(NOW).toISOString() }
  const locked = buildSimRow(item({}, { conditions: { plan: true, opening_limit: false } }), quote, NOW)
  assert.equal(locked.status, 'stop')
  assert.equal(locked.lock, true)
  assert.equal(locked.conditions.find((c) => c.key === 'opening_limit')!.tone, 'fail')
  const veto = buildSimRow(item({}, { reason: 'swing_atr_day_veto' }), quote, NOW)
  assert.equal(veto.status, 'stop')
  const filled = buildSimRow(item({ today_fills: { shares: 1000, average_price: 1006 } }), quote, NOW)
  assert.equal(filled.status, 'filled')
  // A fill makes 未持有 false by construction; that is the result of entering, not a blocker.
  assert.equal(filled.conditions.find((c) => c.key === 'position')!.tone, 'ok')
  assert.equal(filled.firstBlocker, -1, 'a filled row has no blocking gate to outline')
  const unplanned = buildSimRow(item({ planned_allocation: { target_weight: 0, locked: false } }), quote, NOW)
  assert.equal(unplanned.status, 'stop')
})

test('stale quotes and reference gaps fail closed', () => {
  const stale = buildSimRow(item(), { price: 1009, as_of: new Date(NOW - 120_000).toISOString() }, NOW)
  assert.equal(stale.stale, true)
  assert.equal(stale.distancePct, null, 'a stale quote never drives the near/trigger distance')
  assert.equal(stale.status, 'wait')
  const gap = buildSimRow(item({ ml_entry_price: 700 }), { price: 1000, as_of: new Date(NOW).toISOString() }, NOW)
  assert.equal(gap.refFlag, true)
  assert.equal(gap.estimatedShares, null, 'no auto share count when the reference price is >20% off')
})

test('sort order, counts and market trend', () => {
  const quote = { price: 1005, as_of: new Date(NOW).toISOString() }
  const rows = [
    buildSimRow(item({ symbol: 'A' }, { conditions: { plan: true, opening_limit: false } }), quote, NOW),
    buildSimRow(item({ symbol: 'B', today_fills: { shares: 1000 } }), quote, NOW),
    buildSimRow(item({ symbol: 'C' }), quote, NOW),
  ]
  assert.deepEqual(sortRows(rows).map((r) => r.symbol), ['B', 'C', 'A'])
  assert.deepEqual(countByStatus(rows), { filled: 1, trig: 0, near: 1, wait: 0, stop: 1 })
  const trend = marketTrend([{ execution_preview: { daily_assessment: { benchmark_previous_close: 200, ma60: 190 } } }])
  assert.ok(trend && Math.abs(trend.ratioPct - (200 / 190 - 1) * 100) < 1e-9)
  assert.equal(marketTrend([{}]), null)
})

// ── verify-batch3 findings: each test fails on the code it reviewed ───────────────────────────────

test('F1: a window that closed without a trigger is untriggered, not blocked; rule vetoes stay blocked', () => {
  const quote = { price: 1000, as_of: new Date(NOW).toISOString() }
  // Worker or15VwapEntry.ts returns wait('or15_entry_window_closed') for rows that never triggered after 13:30.
  for (const reason of ['or15_entry_window_closed', 'swing_entry_window_closed', 'swing_recovery_expired', 'swing_next_bar_submission_missed']) {
    const row = buildSimRow(item({}, { action: 'wait', reason }), quote, NOW)
    assert.equal(row.status, 'stop', reason)
    assert.equal(postOutcome(row), 'untriggered', reason)
  }
  for (const reason of ['swing_atr_day_veto', 'swing_chase_limit', 'swing_buy_at_limit']) {
    assert.equal(postOutcome(buildSimRow(item({}, { reason }), quote, NOW)), 'blocked', reason)
  }
  assert.equal(postOutcome(buildCompletedRow({ symbol: 'X', execution_status: 'expired' })), 'untriggered')
  assert.equal(postOutcome(buildCompletedRow({ symbol: 'X', execution_status: 'skipped' })), 'blocked')
})

test('F2: a quote older than 90 s stays on screen as stale through the real display-price path', () => {
  const daily = item().execution_preview.or15
  const old = { price: 1009, as_of: new Date(NOW - 100_000).toISOString() }
  const quote = selectSimQuote(old, null, NOW, daily)
  assert.ok(quote, 'the stale quote is kept, not dropped like currentDisplayPrice does')
  const row = buildSimRow(item(), quote, NOW)
  assert.equal(row.stale, true)
  assert.equal(row.price, 1009)
  assert.ok(Math.abs(row.quoteAgeSec! - 100) < 1e-9)
  assert.equal(row.distancePct, null, 'stale prices never drive distance or 接近')
  assert.equal(row.status, 'wait')
  const fresh = buildSimRow(item(), selectSimQuote({ price: 1009, as_of: new Date(NOW - 5_000).toISOString() }, old, NOW, daily), NOW)
  assert.equal(fresh.stale, false)
  assert.equal(fresh.status, 'near')
  assert.equal(formatQuoteAge(100), '1 分')
  assert.equal(formatQuoteAge(42), '42s')
  assert.equal(selectSimQuote(null, null, NOW), null)
})

test('F7: partial fills keep running checks; s12 owner has no ORH ladder; risk-skip and debate labels survive', () => {
  const quote = { price: 1005, as_of: new Date(NOW).toISOString() }
  const partial = buildSimRow(item({ execution_status: 'partially_filled', today_fills: { shares: 500, average_price: 1004 } }), quote, NOW)
  assert.notEqual(partial.status, 'filled', 'the remainder is still live')
  assert.equal(partial.partial, true)
  assert.equal(partial.conditions.find((c) => c.key === 'position')!.tone, 'ok')
  assert.ok(partial.firstBlocker >= 0, 'the remaining shares still show their first blocking gate')
  assert.equal(postOutcome(partial), 'filled')

  const s12 = buildSimRow(item({ execution_preview: { entry_owner: 's12', or15: null, s12: { state: 'waiting', reason: 's12_structure_primary_waiting', ready: false, entry_price: null, chase_ceiling: null, checked_at: '2026-11-26T01:59:00Z' } } }), quote, NOW)
  assert.equal(s12.owner, 's12')
  assert.equal(s12.trigger, null)
  assert.ok(s12.s12Text && s12.s12Text.length > 0)
  const s12Ready = buildSimRow(item({ execution_preview: { entry_owner: 's12', or15: null, s12: { state: 'ready', reason: 'ready', ready: true, entry_price: 1010, chase_ceiling: 1020, checked_at: '2026-11-26T01:59:00Z' } } }), quote, NOW)
  assert.equal(s12Ready.trigger, 1010)
  assert.equal(s12Ready.chase, 1020)

  const flagged = buildSimRow(item({ watch_points: ['alpha_risk_overlay:skip=true;reason=x'], debate_status: 'completed', debate_verdict: 'DOWNGRADE' }), quote, NOW)
  assert.equal(flagged.riskSkip, true)
  assert.equal(flagged.debateLabel, '辯論觀察：保守')
})

test('N2: reference gap is measured from the reference price and the 20% limit is symmetric', () => {
  const at = (price: number) => buildSimRow(item({ ml_entry_price: 100 }), { price, as_of: new Date(NOW).toISOString() }, NOW)
  assert.ok(Math.abs(at(80).refGapPct! - -20) < 1e-9, 'price 80 vs reference 100 is -20%, not -25%')
  assert.equal(at(119).refFlag, false)
  assert.equal(at(121).refFlag, true, 'a price 21% above the reference is flagged too')
  assert.equal(at(82).refFlag, true, '100/82 − 1 > 20%')
})

test('trading_day from pending-buys decides closed days before the open and after the close', () => {
  const clock = { minutes: 500, weekday: 3, date: '2026-11-26' }
  assert.equal(isClosedDay(clock, null, { session_date: '2026-11-26', trading_day: false }), true)
  assert.equal(isClosedDay({ ...clock, weekday: 6 }, null, { session_date: '2026-11-26', trading_day: true }), false, 'a make-up trading Saturday')
  assert.equal(isClosedDay(clock, null, { session_date: '2026-11-26', trading_day: null }), false, 'null stays undecided')
  assert.equal(isClosedDay(clock, null, { session_date: '2026-11-25', trading_day: false }), false, 'another day\'s flag is ignored')
})

// D1 created_at 形狀（UTC、空白分隔、無時區），與 Worker pendingBuyExecutionPreview 的 checked_at 相同。
const D1 = (iso: string) => iso.replace('T', ' ').replace(/\.\d+Z$|Z$/, '')

test('R2-1: a blocker written after the OR15 pass wins — not 已觸發, and blocked after the close with a Chinese reason', () => {
  const quote = { price: 1012, as_of: new Date(NOW - 5_000).toISOString() }
  const pass = { action: 'pass', reason: 'or15_vwap_breakout', checked_at: D1('2026-11-26T01:58:00Z') }
  const blocked = buildSimRow(item({ execution_preview: { ...item().execution_preview, or15: { ...item().execution_preview.or15, ...pass },
    last_blocker: { reason: 'position_sector_cap', detail: 'sector=半導體;holdings=2;cap=2', checked_at: D1('2026-11-26T01:58:30Z') } } }), quote, NOW)
  assert.notEqual(blocked.status, 'trig')
  assert.equal(blocked.blockedAfterSignal, true)
  assert.equal(blocked.reasonCode, 'position_sector_cap')
  assert.equal(blocked.blockerText, '同產業持股已達上限')
  assert.equal(postOutcome(blocked), 'blocked')

  const veto = buildSimRow(item({ execution_preview: { ...item().execution_preview, or15: { ...item().execution_preview.or15, ...pass },
    last_blocker: { reason: 'l4_hard_risk_veto', detail: null, checked_at: D1('2026-11-26T01:59:10Z') } } }), quote, NOW)
  assert.equal(postOutcome(veto), 'blocked')
  assert.equal(veto.blockerText, 'S12 否決或五檔品質未通過，L4 不進場')

  // An older blocker (before the pass) does not override the newer signal.
  const older = buildSimRow(item({ execution_preview: { ...item().execution_preview, or15: { ...item().execution_preview.or15, ...pass },
    last_blocker: { reason: 'position_sector_cap', detail: null, checked_at: D1('2026-11-26T01:50:00Z') } } }), quote, NOW)
  assert.equal(older.status, 'trig')
  assert.equal(postOutcome(older), 'trig')
})

test('R2-2: a fallback quote stamped in the future (slow device clock) is not fresh', () => {
  const future = { price: 1009, as_of: new Date(NOW + 120_000).toISOString() }
  const quote = selectSimQuote(future, null, NOW, item().execution_preview.or15)
  assert.ok(quote, 'kept on screen through the fallback path')
  const row = buildSimRow(item(), quote, NOW)
  assert.equal(row.stale, true)
  assert.equal(row.quoteAgeSec, null)
  assert.equal(row.distancePct, null, 'the 90 s fail-closed rule still holds')
  assert.equal(row.status, 'wait')
  assert.equal(staleQuoteLabel(row), '報價時間不明')
})

test('R2-3: a stale quote from a previous trading day shows no change', () => {
  const yesterday = { price: 1100, as_of: '2026-11-25T05:29:00Z', reference_price: 1000 }
  const row = buildSimRow(item(), selectSimQuote(yesterday, null, NOW, item().execution_preview.or15), NOW)
  assert.equal(row.stale, true)
  assert.equal(row.change, null)
  assert.equal(row.changePct, null)
  // A same-day stale quote keeps its change (it is still today's move).
  const sameDay = buildSimRow(item(), selectSimQuote({ price: 1010, as_of: new Date(NOW - 300_000).toISOString(), reference_price: 1000 }, null, NOW), NOW)
  assert.equal(sameDay.stale, true)
  assert.equal(sameDay.change, 10)
})

test('R2-5: every S12 state the Worker can write has a Chinese label; unknown states never show English', () => {
  const worker = fs.readFileSync(new URL('../../../worker/src/lib/s12IntradayStructure.ts', import.meta.url), 'utf8')
  const union = worker.match(/export type S12IntradayState =([\s\S]*?)\n\n/)
  assert.ok(union, 'Worker S12IntradayState union found')
  const states = [...union![1].matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1])
  assert.ok(states.length >= 18)
  for (const state of states) {
    const text = formatS12IntradayStructureState(state, `s12_${state}`)
    assert.ok(!/[a-z]{3,}/.test(text.replace(/CHoCH|BOS|OB|FVG/g, '')), `${state} → ${text}`)
  }
  // Worker writes status='error' without a state when S12 market data is missing.
  assert.equal(formatS12IntradayStructureState('error', 's12_market_data_unavailable'), '盤中行情暫不可用')
  assert.equal(formatS12IntradayStructureState('brand_new_state', 's12_brand_new_reason'), 'S12 結構狀態更新中')
  const row = buildSimRow(item({ execution_preview: { entry_owner: 's12', or15: null,
    s12: { state: 'waiting_session_60m_bearish_risk', reason: 's12_waiting_session_60m_bearish_risk', ready: false, entry_price: null, chase_ceiling: null, checked_at: D1('2026-11-26T01:59:00Z') } } }),
  { price: 1005, as_of: new Date(NOW).toISOString() }, NOW)
  assert.equal(row.s12Text, '盤中 60M 偏空，等待風險解除')
})

test('R2-7: S12 READY (reaction_ready／limited_takeover_ready) is 已觸發 before submission; bearish defense is not', () => {
  const quote = { price: 1012, as_of: new Date(NOW - 5_000).toISOString() }
  const s12 = (state: string, ready: boolean, last_blocker?: any) => buildSimRow(item({ execution_preview: { entry_owner: 's12', or15: null, last_blocker,
    s12: { state, reason: `s12_${state}`, ready, entry_price: ready ? 1010 : null, chase_ceiling: ready ? 1020 : null, checked_at: D1('2026-11-26T01:59:00Z') } } }), quote, NOW)
  const ready = s12('reaction_ready', true)
  assert.equal(ready.status, 'trig')
  assert.equal(ready.blockerText, '多方反應結構成立')
  assert.equal(s12('limited_takeover_ready', true).status, 'trig')
  assert.notEqual(s12('bearish_defense_ready', true).status, 'trig')
  const blocked = s12('reaction_ready', true, { reason: 'paper_order_risk_blocked', detail: null, checked_at: D1('2026-11-26T01:59:20Z') })
  assert.notEqual(blocked.status, 'trig')
  assert.equal(postOutcome(blocked), 'blocked')
  assert.equal(blocked.blockerText, '下單風控驗證未通過')
})

test('R3-1: a portfolio gate written in the same second as the signal counts as blocked (D1 has second precision)', () => {
  const quote = { price: 1012, as_of: new Date(NOW - 5_000).toISOString() }
  for (const reason of ['portfolio_risk_halt', 'holding_risk_evidence_unavailable']) {
    const row = buildSimRow(item({ execution_preview: { ...item().execution_preview,
      or15: { ...item().execution_preview.or15, action: 'pass', reason: 'or15_vwap_breakout', checked_at: '2026-11-26 01:30:05' },
      last_blocker: { reason, detail: null, checked_at: '2026-11-26 01:30:05' } } }), quote, NOW)
    assert.equal(row.blockedAfterSignal, true, reason)
    assert.notEqual(row.status, 'trig', reason)
    assert.equal(postOutcome(row), 'blocked', reason)
  }
  const halted = buildSimRow(item({ execution_preview: { ...item().execution_preview,
    or15: { ...item().execution_preview.or15, action: 'pass', checked_at: '2026-11-26 01:30:05' },
    last_blocker: { reason: 'portfolio_risk_halt', detail: null, checked_at: '2026-11-26 01:30:05' } } }), quote, NOW)
  assert.equal(halted.blockerText, '組合熔斷，暫停新倉')
})

test('R3-3: a partial fill stopped by a later terminal blocker reads as partial, not a plain 今日不進場', () => {
  const quote = { price: 1012, as_of: new Date(NOW - 5_000).toISOString() }
  const row = buildSimRow(item({
    execution_status: 'partially_filled',
    today_fills: { shares: 500, average_price: 1010 },
    watch_points: ['execution:partially_filled:paper_order_partial_fill:requested=1000;filled=500;remaining=500'],
    execution_preview: { ...item().execution_preview,
      or15: { ...item().execution_preview.or15, action: 'pass', checked_at: '2026-11-26 01:30:05' },
      last_blocker: { reason: 'swing_existing_position_or_daily_fill', detail: null, checked_at: '2026-11-26 01:31:00' } },
  }), quote, NOW)
  assert.equal(row.status, 'stop')
  assert.equal(row.statusText, '部分成交・不再加碼')
  assert.ok(row.blockerText!.startsWith('已部分成交 500 股・今日不再加碼'))
  assert.equal(row.partialRemaining, '部分成交：已成交 500 / 委託 1000，剩餘 500 股')
  assert.equal(postOutcome(row), 'filled', 'the after-close classification is unchanged')
  // A partial fill still waiting keeps the normal status text.
  const waiting = buildSimRow(item({ execution_status: 'partially_filled', today_fills: { shares: 500, average_price: 1010 } }), quote, NOW)
  assert.equal(waiting.statusText, null)
})

test('item-aware execution badge comes from the item, not the derived row status', () => {
  const quote = { price: 1005, as_of: new Date(NOW).toISOString() }
  assert.notEqual(buildSimRow(item({ execution_status: 'stale_quote' }), quote, NOW).executionBadge.label,
    buildSimRow(item({ execution_status: 'pending' }), quote, NOW).executionBadge.label)
  for (const status of ['submitted', 'requoted', 'quote_unavailable', 'rejected']) {
    const label = buildSimRow(item({ execution_status: status }), quote, NOW).executionBadge.label
    assert.ok(label && !/[a-z]_[a-z]/.test(label), `${status} → ${label}`)
  }
})

test('R4-2/R4-3: the 五檔 cell is Chinese with the raw code in title; the allocator conclusion is shown', () => {
  const quote = { price: 1005, as_of: new Date(NOW).toISOString() }
  const withAllocator = (allocator: Record<string, any>) => buildSimRow(item({ execution_preview: { ...item().execution_preview,
    allocator: { action: 'buy', reason: '', budget_cap: 120000, target_value: null, available_cash: null, l5_status: 'pass', l5_reasons: [], s12_hard_veto: false, checked_at: '2026-11-26 01:59:00', ...allocator } } }), quote, NOW)
  const cell = (row: ReturnType<typeof buildSimRow>, key: string) => row.conditions.find((c) => c.key === key)!
  for (const [status, label] of [['pass', 'L5 報價通過'], ['blocked', 'L5 報價未通過'], ['degraded', 'L5 報價品質不足（未通過）'], [null, '缺五檔']] as const) {
    const l5 = cell(withAllocator({ l5_status: status }), 'l5')
    assert.ok(l5.value.includes(label), `${status} → ${l5.value}`)
    assert.ok(!/\b(pass|blocked|degraded|missing)\b/.test(l5.value), 'raw code never on screen')
    assert.equal(l5.raw, status ?? undefined)
  }
  assert.ok(cell(withAllocator({ action: 'buy' }), 'allocation').value.includes('L4 配置可買'))
  assert.ok(cell(withAllocator({ action: 'add' }), 'allocation').value.includes('L4 配置可加碼'))
  assert.ok(!cell(withAllocator({ action: 'skip' }), 'allocation').value.includes('可買'))
  // With no blocker reason, the row says the allocator is ready to buy instead of nothing.
  const ready = withAllocator({ action: 'buy' })
  const noReason = buildSimRow({ ...item(), execution_preview: { entry_owner: 's12', or15: null, s12: null,
    allocator: { action: 'buy', reason: '', budget_cap: 1, target_value: null, available_cash: null, l5_status: 'pass', l5_reasons: [], s12_hard_veto: false, checked_at: '2026-11-26 01:59:00' } } }, quote, NOW)
  assert.ok(ready.blockerText)
  assert.equal(noReason.blockerText, 'L4 配置可買，等待進場條件')
})

test('R4-4: when the S12 preview has aged out, the last structure state in watch_points is shown', () => {
  const quote = { price: 1005, as_of: new Date(NOW).toISOString() }
  const row = buildSimRow(item({ watch_points: ['execution:checked_waiting:s12_waiting_bos:'],
    execution_preview: { entry_owner: 's12', or15: null, s12: null } }), quote, NOW)
  assert.equal(row.s12Text, 'S12 等待 BOS 確認')
  const none = buildSimRow(item({ watch_points: [], execution_preview: { entry_owner: 's12', or15: null, s12: null } }), quote, NOW)
  assert.equal(none.s12Text, '等待近期盤中結構資料')
  // An unregistered S12 reason would render as an English phrase; it falls back to the generic copy instead.
  const unknown = buildSimRow(item({ watch_points: ['execution:checked_waiting:s12_brand_new_code:'],
    execution_preview: { entry_owner: 's12', or15: null, s12: null } }), quote, NOW)
  assert.equal(unknown.s12Text, '等待近期盤中結構資料')
})
