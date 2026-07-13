import { formatS12HoldingDefenseBadge } from './pendingBuyExecutionUi'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const badge = formatS12HoldingDefenseBadge({
  active: true,
  action: 'quote_unavailable',
  reason: 's12_position_structural_stop_quote_unavailable',
  detail: {
    holding_defense: {
      action: 'quote_unavailable',
      required_lot_types: ['odd_lot'],
      odd_lot_book_available: false,
      decision_reason: 's12_position_structural_stop_quote_unavailable',
    },
  },
})

assert(badge?.label === 'S12 停損已觸發，等待零股報價', 'odd-lot exit wait must not look like a generic S12 quote error')
assert(badge?.description.includes('盤中零股 BidAsk'), 'badge must explain the missing execution contract')

console.log('S12 odd-lot holding-defense UI tests passed')
