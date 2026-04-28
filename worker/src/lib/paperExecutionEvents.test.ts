import { normalizePaperExecutionEvent } from './paperExecutionEvents'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const event = normalizePaperExecutionEvent({
  tradeDate: '2026-04-28',
  symbol: '2330',
  side: 'buy',
  eventType: 'paper_order',
  status: 'filled',
  reason: 'paper_order_created',
  orderId: 99,
})

assert(event.accountId === 1, 'default account id should be 1')
assert(event.tradeDate === '2026-04-28', 'explicit trade date should be preserved')
assert(event.symbol === '2330', 'symbol should be preserved')
assert(event.side === 'buy', 'side should be preserved')
assert(event.eventType === 'paper_order', 'event type should be preserved')
assert(event.status === 'filled', 'status should be preserved')
assert(event.orderId === 99, 'order id should be preserved')

const fallback = normalizePaperExecutionEvent({ eventType: 'pending_buy', status: '' })
assert(fallback.status === 'unknown', 'blank status should be normalized')
assert(fallback.symbol == null, 'missing symbol should normalize to null')
