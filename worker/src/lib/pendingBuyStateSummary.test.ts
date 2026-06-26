import { buildPendingBuyStateSummary } from './pendingBuyStateSummary'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function assertDeepEqual(actual: unknown, expected: unknown, message: string): void {
  const actualJson = JSON.stringify(actual)
  const expectedJson = JSON.stringify(expected)
  if (actualJson !== expectedJson) {
    throw new Error(`${message}: expected ${expectedJson}, got ${actualJson}`)
  }
}

{
  const summary = buildPendingBuyStateSummary([], {
    status: 'ready',
    debate_status: 'completed',
    candidate_count: 3,
    execution_counts: { skipped: 2, cancelled: 1 },
    debate_counts: { completed: 3 },
  })

  assert(summary.state === 'skipped', 'skipped-only run should be explicit')
  assert(summary.active_count === 0, 'terminal run should have no active items')
  assert(summary.total_count === 3, 'total count should include terminal items')
  assertDeepEqual(summary.execution_counts, {
    pending: 0,
    checked_waiting: 0,
    submitted: 0,
    requoted: 0,
    partially_filled: 0,
    stale_quote: 0,
    quote_unavailable: 0,
    filled: 0,
    skipped: 2,
    cancelled: 1,
    expired: 0,
    rejected: 0,
  }, 'execution counts should be normalized')
}

{
  const summary = buildPendingBuyStateSummary([], {
    status: 'ready',
    debate_status: 'completed',
    candidate_count: 1,
    execution_counts: { rejected: 1 },
    debate_counts: { completed: 1 },
  })

  assert(summary.state === 'skipped', 'rejected-only run should be shown as a skipped/rejected terminal outcome')
  assert(summary.execution_counts.rejected === 1, 'execution counts should preserve rejected terminal outcomes')
}

{
  const summary = buildPendingBuyStateSummary([
    { symbol: '2330', debate_status: 'pending', execution_status: 'pending' },
  ], { status: 'ready', debate_status: 'pending', candidate_count: 1 })

  assert(summary.state === 'debate_pending', 'pending debate should be explicit')
  assert(summary.label === 'Base ready / 辯論中', 'pending debate should have zh-TW label')
}

{
  const summary = buildPendingBuyStateSummary([
    { symbol: '2330', debate_status: 'completed', execution_status: 'pending' },
    { symbol: '2454', debate_status: 'completed', execution_status: 'pending' },
  ], { status: 'ready', debate_status: 'completed', candidate_count: 2 })

  assert(summary.state === 'ready_to_execute', 'completed debates with active pending should be executable')
  assert(summary.active_count === 2, 'active count should count executable items')
}

{
  const summary = buildPendingBuyStateSummary([], { status: 'error', error_message: 'pipeline failed' })
  assert(summary.state === 'error', 'error run should stay error')
  assert(summary.label === '流程失敗', 'error should have zh-TW label')
}

{
  const summary = buildPendingBuyStateSummary([], {
    status: 'ready',
    debate_status: 'completed',
    candidate_count: 1,
    execution_counts: { expired: 1 },
    debate_counts: { completed: 1 },
  })

  assert(summary.state === 'expired', 'expired-only run should be explicit')
  assert(summary.label === '已過期', 'expired should have zh-TW label')
}

{
  const summary = buildPendingBuyStateSummary([
    { symbol: '2330', debate_status: 'completed', execution_status: 'checked_waiting' },
  ], { status: 'ready', debate_status: 'completed', candidate_count: 1 })

  assert(summary.state === 'ready_to_execute', 'checked-waiting items should remain active')
  assert(summary.execution_counts.checked_waiting === 1, 'summary should expose checked waiting execution count')
  assert(summary.execution_counts.pending === 0, 'checked waiting should not be counted as never-checked pending')
}

{
  const summary = buildPendingBuyStateSummary([], {
    status: 'ready',
    debate_status: 'completed',
    candidate_count: 0,
    empty_reason: 'empty_after_soft_risk',
    filter_audit: {
      version: 'pending_buy_filter_audit_v1',
      initial_buy_signals: 5,
      final_candidates: 0,
      rrg_lagging_soft_downgrade: 5,
    },
  })

  assert(summary.state === 'empty_after_soft_risk', 'soft-risk empty runs should be explicit')
  assert(summary.total_count === 5, 'total count should include initial L4 buy signals from filter audit')
  assert(summary.label === '軟性風險後無候選', 'soft-risk empty runs should have zh-TW label')
}
