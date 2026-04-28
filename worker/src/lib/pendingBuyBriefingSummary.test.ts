import { formatPendingBuyBriefing } from './pendingBuyBriefingSummary'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

{
  const text = formatPendingBuyBriefing([], {
    state: 'closed',
    label: '已收斂',
    active_count: 0,
    total_count: 3,
    execution_counts: { pending: 0, filled: 1, skipped: 1, cancelled: 0, expired: 1 },
    debate_counts: { pending: 0, completed: 3, failed: 0, skipped: 0 },
  })

  assert(text.includes('**已收斂**'), 'closed briefing should explain the state')
  assert(text.includes('filled 1'), 'closed briefing should include filled count')
  assert(text.includes('skipped 1'), 'closed briefing should include skipped count')
  assert(text.includes('expired 1'), 'closed briefing should include expired count')
}

{
  const text = formatPendingBuyBriefing([
    {
      symbol: '2330',
      name: '台積電',
      ml_entry_price: 100,
      ml_stop_loss: 92,
      debate_verdict: 'DOWNGRADE',
      debate_status: 'completed',
      execution_status: 'pending',
      watch_points: ['price above VWAP', 'execution:skipped:limit_up_chase'],
    },
  ], {
    state: 'ready_to_execute',
    label: '待執行',
    active_count: 1,
    total_count: 1,
    execution_counts: { pending: 1, filled: 0, skipped: 0, cancelled: 0, expired: 0 },
    debate_counts: { pending: 0, completed: 1, failed: 0, skipped: 0 },
  })

  assert(text.includes('2330 台積電'), 'active briefing should include symbol and name')
  assert(text.includes('DOWNGRADE'), 'active briefing should include debate verdict')
  assert(text.includes('entry 100'), 'active briefing should include entry')
  assert(text.includes('watch: price above VWAP'), 'active briefing should include first watch point')
}
