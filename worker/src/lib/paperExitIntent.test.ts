import assert from 'node:assert/strict'
import { applyLatchedPaperExitIntent, normalizePaperStopBreach } from './paperExitIntent'

const breach = normalizePaperStopBreach({
  schema_version: 'paper-stop-breach-v1',
  intent_key: '1:4541:2026-07-13:2000:72.8000:full_sell',
  account_id: 1,
  symbol: '4541',
  entry_date: '2026-07-13',
  requested_shares: 2000,
  stop_price: 72.8,
  stop_version: '72.8000',
  trigger_price: 72.7,
  trigger_time: '2026-07-16T09:00:02+08:00',
  received_at: '2026-07-16T09:00:02.050+08:00',
  session_epoch: 7,
  source: 'shioaji_tick_callback',
})

assert.ok(breach)
assert.equal(breach.trigger_price, 72.7)
assert.equal(breach.trigger_time, '2026-07-16T09:00:02+08:00')
assert.equal(breach.session_epoch, 7)

const reboundedDecision = applyLatchedPaperExitIntent(
  { action: 'hold', reason: 'price_rebounded_to_73.2', exitIntentKind: 'none' },
  { trigger_source: 'shioaji_tick_callback', stop_price: 72.8 },
)
assert.equal(reboundedDecision.action, 'full_sell')
assert.equal(reboundedDecision.exitIntentKind, 'risk_stop')
assert.match(reboundedDecision.reason, /^latched_stop_breach:/)

assert.equal(normalizePaperStopBreach({
  intent_key: '',
  symbol: '4541',
  requested_shares: 2000,
  stop_price: 72.8,
  trigger_price: 72.7,
  received_at: '2026-07-16T09:00:02+08:00',
}), null)

console.log('paperExitIntent tests passed')
