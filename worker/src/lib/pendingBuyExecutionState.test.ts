import {
  applyPendingBuyExecutionEvents,
  type PendingBuyExecutionEvent,
} from './pendingBuyExecutionState'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function assertDeepEqual(actual: unknown, expected: unknown, message: string): void {
  const actualJson = JSON.stringify(actual)
  const expectedJson = JSON.stringify(expected)
  if (actualJson !== expectedJson) {
    throw new Error(`${message}: expected ${expectedJson}, got ${actualJson}`)
  }
}

function item(symbol: string) {
  return {
    symbol,
    name: symbol,
    signal: 'BUY',
    confidence: 0.8,
    ml_entry_price: 100,
    ml_stop_loss: 92,
    ml_target1: 110,
    ml_target2: 120,
    reason: '',
    watch_points: [],
    debate_verdict: 'APPROVE',
    debate_status: 'completed' as const,
    execution_status: 'pending' as const,
    risk_pct: 0.01,
    kelly_pct: null,
    chip_score: null,
    tech_score: null,
    ml_score: null,
    score: null,
  }
}

const events: PendingBuyExecutionEvent[] = [
  { symbol: '2330', status: 'filled', reason: 'paper_order_created' },
  { symbol: '2454', status: 'skipped', reason: 'pre_trade_skip' },
]

const result = applyPendingBuyExecutionEvents([item('2330'), item('2454'), item('2317')], events)

assertDeepEqual(result.activeItems.map((entry) => entry.symbol), ['2317'], 'terminal items should be removed from active list')
assert(result.allItems.find((entry) => entry.symbol === '2330')?.execution_status === 'filled', 'filled item should be terminal')
assert(result.allItems.find((entry) => entry.symbol === '2454')?.execution_status === 'skipped', 'skipped item should be terminal')
assert(result.allItems.find((entry) => entry.symbol === '2317')?.execution_status === 'pending', 'untouched item should stay pending')
assertDeepEqual(result.summary, {
  filled: 1,
  skipped: 1,
  cancelled: 0,
  expired: 0,
}, 'summary should count terminal outcomes')

const cancelled = applyPendingBuyExecutionEvents([item('3008')], [
  { symbol: '3008', status: 'cancelled', reason: 'rod_cancelled' },
])
assert(cancelled.activeItems.length === 0, 'cancelled item should not remain active')
assert(cancelled.allItems[0].execution_status === 'cancelled', 'cancelled item should be marked')
