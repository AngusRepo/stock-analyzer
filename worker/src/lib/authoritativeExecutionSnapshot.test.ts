import { resolveAuthoritativeBuyExecutionSnapshot } from './authoritativeExecutionSnapshot'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const impossible4541 = resolveAuthoritativeBuyExecutionSnapshot({
  limitPrice: 63.4,
  lotType: 'board_lot',
  nowMs: Date.parse('2026-07-13T01:04:20.000Z'),
  maxAgeMs: 1500,
  observations: [
    { source: 'shioaji_hub', lotType: 'board_lot', bid: 63.2, ask: 63.4, ageMs: 9698 },
    { source: 'finlab_l5', lotType: 'board_lot', bid: 63.4, ask: 63.5, ageMs: 200 },
  ],
})
assert(impossible4541.status === 'blocked', 'fresh best ask above limit must not fill')
assert(impossible4541.reason.startsWith('authoritative_ask_above_limit'), 'fresh selected ask must be authoritative')

const disagreement = resolveAuthoritativeBuyExecutionSnapshot({
  limitPrice: 63.4,
  lotType: 'board_lot',
  maxAgeMs: 1500,
  observations: [
    { source: 'shioaji_hub', lotType: 'board_lot', bid: 63.2, ask: 63.4, ageMs: 300 },
    { source: 'finlab_l5', lotType: 'board_lot', bid: 63.4, ask: 63.5, ageMs: 200 },
  ],
})
assert(disagreement.status === 'blocked', 'conflicting marketability must fail closed')
assert(disagreement.reason === 'buy_fill_below_fresh_best_ask', 'impossible-fill mismatch must be explicit')
assert(disagreement.hardMismatch, 'conflicting fresh sources must set hard mismatch')

const ready = resolveAuthoritativeBuyExecutionSnapshot({
  limitPrice: 63.5,
  lotType: 'board_lot',
  observations: [
    { source: 'shioaji_hub', lotType: 'board_lot', bid: 63.4, ask: 63.5, ageMs: 300 },
    { source: 'finlab_l5', lotType: 'board_lot', bid: 63.4, ask: 63.5, ageMs: 200 },
  ],
})
assert(ready.status === 'ready' && ready.ask === 63.5, 'agreeing fresh books should be executable')

const wrongLot = resolveAuthoritativeBuyExecutionSnapshot({
  limitPrice: 143,
  lotType: 'odd_lot',
  observations: [
    { source: 'shioaji_hub', lotType: 'board_lot', bid: 142.5, ask: 143, ageMs: 200 },
  ],
})
assert(wrongLot.status === 'blocked' && wrongLot.reason === 'execution_book_unavailable', 'board-lot book must not authorize odd-lot fills')

console.log('authoritativeExecutionSnapshot tests passed')
