import {
  arrayFromPayload,
  paperOrdersFromPayload,
  paperPendingBuysFromPayload,
  paperPnlSnapshotsFromPayload,
  paperPositionsFromPayload,
} from './paperPayload.ts'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

{
  const payload = { status: 'success', orders: [{ id: 1 }, { id: 2 }] }
  const orders = paperOrdersFromPayload(payload)
  assert(orders.length === 2, 'orders should unwrap the Worker { orders } payload')
}

{
  const payload = { status: 'success', orders: { id: 1 } }
  const orders = paperOrdersFromPayload(payload)
  assert(Array.isArray(orders) && orders.length === 0, 'orders should reject non-array nested payloads')
}

{
  const positions = paperPositionsFromPayload({ positions: [{ symbol: '2330' }] })
  assert(positions[0]?.symbol === '2330', 'positions should unwrap { positions } payloads')
}

{
  const pending = paperPendingBuysFromPayload({ pendingBuys: [{ symbol: '2317' }] })
  assert(pending[0]?.symbol === '2317', 'pending buys should unwrap { pendingBuys } payloads')
}

{
  const snapshots = paperPnlSnapshotsFromPayload({ status: 'success', snapshots: [{ date: '2026-05-15' }] })
  assert(snapshots[0]?.date === '2026-05-15', 'PnL snapshots should unwrap { snapshots } payloads')
}

{
  const fallbackDaily = paperPnlSnapshotsFromPayload({ snapshots: [], daily: [{ date: '2026-05-14' }] })
  assert(fallbackDaily[0]?.date === '2026-05-14', 'PnL snapshots should fall back to daily rows')
}

{
  assert(arrayFromPayload({ orders: [] }).length === 0, 'generic array normalizer should reject objects')
}
