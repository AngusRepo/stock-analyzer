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

const pendingExitBadge = formatS12HoldingDefenseBadge({
  active: true,
  action: 'full_exit',
  reason: 's12_position_structural_stop_full_exit',
  detail: {
    detail: 'state=waiting_15m_completed_bars;bars15m=0;bars1h=0;bars4h=0',
    holding_defense: {
      action: 'full_exit',
      decision_reason: 's12_position_structural_stop_full_exit',
    },
  },
  execution: {
    status: 'pending',
    reason: 'authoritative_snapshot_not_ready:execution_book_stale_or_incomplete',
    attempt_count: 3,
  },
})

assert(pendingExitBadge?.label === 'S12 出場已觸發，等待成交', 'triggered exit must expose execution state instead of assessment maturity')
assert(pendingExitBadge?.description.includes('等待新鮮五檔'), 'pending exit must explain authoritative quote retry')
assert(pendingExitBadge?.description.includes('第 3 次'), 'pending exit must expose retry count')
assert(!pendingExitBadge?.description.includes('等待 15M'), 'completed-bar readiness must not look like an exit prerequisite')

console.log('S12 odd-lot holding-defense UI tests passed')
