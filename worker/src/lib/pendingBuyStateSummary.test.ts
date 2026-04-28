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
    execution_counts: { filled: 1, skipped: 2 },
    debate_counts: { completed: 3 },
  })

  assert(summary.state === 'closed', 'terminal-only run should be closed')
  assert(summary.active_count === 0, 'closed run should have no active items')
  assert(summary.total_count === 3, 'total count should include terminal items')
  assertDeepEqual(summary.execution_counts, {
    pending: 0,
    filled: 1,
    skipped: 2,
    cancelled: 0,
    expired: 0,
  }, 'execution counts should be normalized')
}

{
  const summary = buildPendingBuyStateSummary([
    { symbol: '2330', debate_status: 'pending', execution_status: 'pending' },
  ], { status: 'ready', debate_status: 'pending', candidate_count: 1 })

  assert(summary.state === 'debate_pending', 'pending debate should be explicit')
  assert(summary.label === '等待辯論', 'pending debate should have zh-TW label')
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
  assert(summary.label === '異常', 'error should have zh-TW label')
}
