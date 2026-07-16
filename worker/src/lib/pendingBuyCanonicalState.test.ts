import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { pendingBuyStateFingerprint } from './pendingBuyStore'

const source = readFileSync('src/lib/pendingBuyStore.ts', 'utf8')
const migration = readFileSync('migrations/0060_pending_buy_canonical_state.sql', 'utf8')

assert.match(source, /WHERE canonical_key = \?/)
assert.match(source, /ON CONFLICT\(run_id, symbol\) DO UPDATE SET/)
assert.match(source, /state_revision = state_revision \+ 1/)
assert.doesNotMatch(source, /SET status='superseded'/)
assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_buy_runs_canonical_key/)
assert.match(migration, /WHERE active_rn > 1/)

async function main(): Promise<void> {
const first = await pendingBuyStateFingerprint({
  tradeDate: '2026-07-15',
  status: 'ready',
  debateStatus: 'completed',
  pendingBuys: [
    { symbol: '2330', name: 'TSMC', signal: 'BUY', confidence: 80, ml_entry_price: 100, ml_stop_loss: 95, ml_target1: 110, ml_target2: 120, reason: 'a', watch_points: [], debate_verdict: 'BUY', risk_pct: 5, kelly_pct: null },
    { symbol: '2317', name: 'Hon Hai', signal: 'BUY', confidence: 70, ml_entry_price: 90, ml_stop_loss: 85, ml_target1: 100, ml_target2: 110, reason: 'b', watch_points: [], debate_verdict: 'BUY', risk_pct: 5, kelly_pct: null },
  ],
})
const reordered = await pendingBuyStateFingerprint({
  tradeDate: '2026-07-15',
  status: 'ready',
  debateStatus: 'completed',
  pendingBuys: [
    { symbol: '2317', name: 'Hon Hai', signal: 'BUY', confidence: 70, ml_entry_price: 90, ml_stop_loss: 85, ml_target1: 100, ml_target2: 110, reason: 'b', watch_points: [], debate_verdict: 'BUY', risk_pct: 5, kelly_pct: null },
    { symbol: '2330', name: 'TSMC', signal: 'BUY', confidence: 80, ml_entry_price: 100, ml_stop_loss: 95, ml_target1: 110, ml_target2: 120, reason: 'a', watch_points: [], debate_verdict: 'BUY', risk_pct: 5, kelly_pct: null },
  ],
})
assert.equal(first, reordered, 'input ordering must not create a new pending state revision')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
