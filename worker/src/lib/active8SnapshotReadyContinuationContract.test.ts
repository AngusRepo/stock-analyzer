import assert from 'node:assert/strict'
import fs from 'node:fs'
import { parseBacktestSnapshotId } from './active8SnapshotReadyContinuation'

const callback = fs.readFileSync('src/routes/adminControlRoutes.ts', 'utf8')
const continuation = fs.readFileSync('src/lib/active8SnapshotReadyContinuation.ts', 'utf8')
const orchestrator = fs.readFileSync('src/lib/updateOrchestrator.ts', 'utf8')
const types = fs.readFileSync('src/types.ts', 'utf8')

assert.equal(
  parseBacktestSnapshotId('run_id=x backtest=backtest_dataset:2026-08-28:x rows=2545370 price=p rows=1'),
  'backtest_dataset:2026-08-28:x',
)
assert.equal(parseBacktestSnapshotId('backtest=None rows=0'), null)
assert.match(callback, /body\.task === 'dataset-snapshot-export' && body\.status === 'success'/)
assert.match(callback, /enqueueActive8AfterDatasetSnapshot/)
assert.match(callback, /active8_snapshot_continuation_ticket_settlement_failed/)
assert.match(continuation, /kind='backtest_dataset' AND access_tier='compute' AND status='ready'/)
assert.match(continuation, /schedulerJobId: 'evening-chain'/)
assert.match(continuation, /childKey: `dataset-snapshot-ready:active8-oof-daily:/)
assert.match(continuation, /childKey: `dataset-snapshot-export:/)
assert.match(continuation, /claimSchedulerExecutionTicket/)
assert.match(continuation, /runActive8OofLifecycle\(env, businessDate, 'daily'\)/)
assert.match(continuation, /settleActive8SnapshotContinuationTicket/)
assert.match(continuation, /active8_callback_run_id/)
assert.match(orchestrator, /msg\.type === 'active8_oof_after_snapshot'/)
assert.match(types, /'active8_oof_after_snapshot'/)
assert.match(types, /active8SnapshotId\?: string/)

console.log('active8 snapshot-ready durable continuation contract passed')
