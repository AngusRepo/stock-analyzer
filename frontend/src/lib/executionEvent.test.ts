import { explainExecutionEvent } from './executionEvent'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const stale = explainExecutionEvent('execution:stale_quote:stale_quote-59467ms')

assert(stale?.includes('報價過期'), 'stale quote should be shown as a human-readable execution gate')
assert(stale?.includes('59 秒'), 'stale quote should convert raw milliseconds into seconds')
assert(!stale?.includes('59467ms'), 'stale quote should not expose raw millisecond noise in the UI')

const rangeLow = explainExecutionEvent('execution:pending:range_position_low:range_position=0.20;min=0.30')

assert(rangeLow?.includes('range_position_low'), 'range position gate should keep the raw key for traceability')
assert(rangeLow?.includes('盤中區間位置過低'), 'range position gate should include zh-TW meaning')
assert(rangeLow?.includes('20%'), 'range position gate should show the observed value')
assert(rangeLow?.includes('30%'), 'range position gate should show the configured threshold')

const legacyRangeLow = explainExecutionEvent('execution:pending:range_position_low-12%')

assert(legacyRangeLow?.includes('range_position_low'), 'legacy range-position watch points should be translated')
assert(legacyRangeLow?.includes('12%'), 'legacy range-position watch points should preserve the embedded value')

const priceAbove = explainExecutionEvent('execution:pending:price_above_entry:current=65.9;entry=65.4;bestAsk=65.9;premium=0.0076;max=0.006')

assert(priceAbove?.includes('price_above_entry'), 'price-above-entry gate should keep the raw key for traceability')
assert(priceAbove?.includes('0.76%'), 'price-above-entry gate should show the current premium')
assert(priceAbove?.includes('0.60%'), 'price-above-entry gate should show the chase limit')

const waitingConfirmation = explainExecutionEvent('execution:pending:waiting_for_ohlcv_confirmation:current=99.2;confirmation=100')

assert(waitingConfirmation?.includes('waiting_for_ohlcv_confirmation'), 'OHLCV confirmation gate should keep the raw key')
assert(waitingConfirmation?.includes('轉強確認 100'), 'OHLCV confirmation gate should show the backend trigger')

const aboveOptimistic = explainExecutionEvent('execution:pending:price_above_ohlcv_optimistic_range:current=104.2;optimistic_high=103')

assert(aboveOptimistic?.includes('price_above_ohlcv_optimistic_range'), 'OHLCV optimistic range gate should keep the raw key')
assert(aboveOptimistic?.includes('區間上緣 103'), 'OHLCV optimistic range gate should show the backend ceiling')
