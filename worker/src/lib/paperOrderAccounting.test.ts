import {
  buildSellOrderNote,
  calcRealizedPnlSnapshot,
  estimateSellOrderRealizedPnl,
  summarizeSellOrderLosses,
} from './paperOrderAccounting'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const snapshot = calcRealizedPnlSnapshot({
  entryPrice: 100,
  exitPrice: 110,
  shares: 1000,
  commission: 20,
  tax: 330,
})

assert(snapshot.gross_pnl === 10000, 'gross pnl should use price spread times shares')
assert(snapshot.realized_pnl === 9650, 'realized pnl should subtract commission and tax')
assert(snapshot.realized_pnl_pct === 9.65, 'realized pnl pct should use entry cost basis')

const note = buildSellOrderNote(
  { reason: 'stop-loss', entry_date: '2026-04-27' },
  { entryPrice: 50, exitPrice: 47, shares: 1000, commission: 20, tax: 141 },
)
assert(estimateSellOrderRealizedPnl({ price: 47, shares: 1000, commission: 20, tax: 141, note }) === -3161, 'estimated pnl should prefer note metadata')

const summary = summarizeSellOrderLosses([
  { price: 47, shares: 1000, commission: 20, tax: 141, note },
  { price: 110, shares: 1000, commission: 20, tax: 330, note: JSON.stringify({ entry_price: 100 }) },
  { price: 10, shares: 1000, note: 'legacy text without entry price' },
])
assert(summary.losses === 1, 'loss summary should count negative realized pnl')
assert(summary.total === 2, 'loss summary should ignore rows without recoverable entry price')
