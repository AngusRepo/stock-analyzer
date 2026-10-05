import assert from 'node:assert/strict'
import test from 'node:test'
import { l4NativeFixture } from './l4NativeFixture.testSupport'
import { recordAdvisoryDebateResults } from './pendingBuyOrchestrator'

test('REJECT and DOWNGRADE remain observations on the same pending run', async () => {
  const f = l4NativeFixture()
  const date = '2026-09-14'
  try {
    f.sqls.paper.prepare("INSERT INTO pending_buy_runs(trade_date,status,debate_status,candidate_count) VALUES(?,'ready','pending',2)").run(date)
    const runId = Number((f.sqls.paper.prepare('SELECT id FROM pending_buy_runs').get() as { id: number }).id)
    const insert = f.sqls.paper.prepare("INSERT INTO pending_buy_items(run_id,symbol,risk_pct,execution_status) VALUES(?,?,?,'checked_waiting')")
    insert.run(runId, '1101', 0.02)
    insert.run(runId, '2330', 0.015)

    const recorded = await recordAdvisoryDebateResults(f.env.PAPER_DB, date, runId, [
      { symbol: '1101', verdict: 'REJECT', agentTurns: [{ agent: 'judge', summary: 'risk' }] },
      { symbol: '2330', verdict: 'DOWNGRADE' },
    ])

    assert.equal(recorded, 2)
    assert.deepEqual(f.sqls.paper.prepare('SELECT symbol,debate_verdict,debate_status,risk_pct,execution_status FROM pending_buy_items ORDER BY symbol').all().map(row => ({ ...row })), [
      { symbol: '1101', debate_verdict: 'REJECT', debate_status: 'completed', risk_pct: 0.02, execution_status: 'checked_waiting' },
      { symbol: '2330', debate_verdict: 'DOWNGRADE', debate_status: 'completed', risk_pct: 0.015, execution_status: 'checked_waiting' },
    ])
    assert.equal((f.sqls.paper.prepare('SELECT debate_status FROM pending_buy_runs WHERE id=?').get(runId) as any).debate_status, 'completed')
    assert.equal((f.sqls.paper.prepare('SELECT COUNT(*) AS n FROM l4_replan_outbox_v1').get() as any).n, 0)
    assert.equal(await recordAdvisoryDebateResults(f.env.PAPER_DB, date, runId, [{ symbol: '1101', verdict: 'APPROVE' }]), 0)
  } finally { f.close() }
})
