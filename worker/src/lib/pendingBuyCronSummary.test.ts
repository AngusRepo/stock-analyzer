import { formatPendingBuyCronSummary } from './pendingBuyCronSummary'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

{
  const summary = formatPendingBuyCronSummary('morning setup done', {
    state: 'debate_pending',
    label: '等待辯論',
    active_count: 3,
    total_count: 3,
    execution_counts: { pending: 3, filled: 0, skipped: 0, cancelled: 0, expired: 0, rejected: 0 },
    debate_counts: { pending: 3, completed: 0, failed: 0, skipped: 0 },
  })

  assert(summary === 'morning setup done; state=debate_pending(等待辯論); active=3/3; debate_pending=3; exec[pending=3 filled=0 skipped=0 cancelled=0 expired=0 rejected=0]', 'morning summary should include canonical pending-buy state')
}

{
  const summary = formatPendingBuyCronSummary('intraday heartbeat ok', {
    state: 'closed',
    label: '已收斂',
    active_count: 0,
    total_count: 4,
    execution_counts: { pending: 0, filled: 2, skipped: 1, cancelled: 1, expired: 0, rejected: 0 },
    debate_counts: { pending: 0, completed: 4, failed: 0, skipped: 0 },
  }, { buys: 2 })

  assert(summary.includes('state=closed(已收斂)'), 'closed summary should include state')
  assert(summary.includes('active=0/4'), 'closed summary should include active and total')
  assert(summary.includes('exec[pending=0 filled=2 skipped=1 cancelled=1 expired=0 rejected=0]'), 'closed summary should include execution counts')
  assert(summary.endsWith('; buys=2'), 'summary should append extra metrics')
}
