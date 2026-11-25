import assert from 'node:assert/strict'
import test from 'node:test'
import { buildPendingBuyDateSanityCheck, loadPendingBuyStats } from './dataQualityMonitor'
import { l4NativeFixture } from './l4NativeFixture.testSupport'

const date = '2026-09-14'
async function dateCheck(f: ReturnType<typeof l4NativeFixture>) {
  const stats = await loadPendingBuyStats(f.env.CORE_DB, f.env.PAPER_DB, date)
  return buildPendingBuyDateSanityCheck({
    targetDate: date,
    runTradeDate: stats.run_trade_date,
    sourceRecoDate: stats.source_reco_date,
    candidateCount: Number(stats.candidate_count ?? 0),
    activeCount: Number(stats.active_count ?? 0),
    runStatus: stats.run_status ?? null,
    errorMessage: stats.run_error_message ?? null,
  })
}

test('the latest non-superseded error run fails the pending-buy date check with its cause', async () => {
  const f = l4NativeFixture()
  try {
    const insert = f.sqls.paper.prepare('INSERT INTO pending_buy_runs(trade_date,source_reco_date,status,debate_status,candidate_count,error_message) VALUES(?,?,?,?,?,?)')
    insert.run(date, '2026-09-11', 'superseded', 'pending', 2, null)
    insert.run(date, null, 'error', 'skipped', 0, 'premarket_no_decision:allocate:Error: Controller /pipeline/v2/premarket-resume HTTP 500: Internal Server Error')
    const check = await dateCheck(f)
    assert.equal(check.status, 'fail')
    assert.match(check.summary, /status=error: premarket_no_decision:allocate:/)
  } finally { f.close() }
})

test('a later ready run (same-day recovery) restores the existing date logic', async () => {
  const f = l4NativeFixture()
  try {
    const insert = f.sqls.paper.prepare('INSERT INTO pending_buy_runs(trade_date,source_reco_date,status,debate_status,candidate_count,error_message) VALUES(?,?,?,?,?,?)')
    insert.run(date, null, 'superseded', 'skipped', 0, 'premarket_no_decision:not_started')
    insert.run(date, '2026-09-11', 'ready', 'pending', 0, null)
    assert.equal((await dateCheck(f)).status, 'ok')
  } finally { f.close() }
})
