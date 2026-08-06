import assert from 'node:assert/strict'
import fs from 'node:fs'
import { resolveLatestEveningChainClosure } from './dataDomainShadowBackfillDrain'

const drain = fs.readFileSync('src/lib/dataDomainShadowBackfillDrain.ts', 'utf8')
const orchestrator = fs.readFileSync('src/lib/updateOrchestrator.ts', 'utf8')
const admin = fs.readFileSync('src/lib/adminTriggerWorkerDomainTasks.ts', 'utf8')
const types = fs.readFileSync('src/types.ts', 'utf8')

assert(drain.includes("leaseGroup: 'd1_heavy_maintenance'"))
assert(drain.includes('tablesForDataDomainShadowBackfill'))
assert(drain.includes('requestedTable && backfillTables.includes(requestedTable)'))
assert(drain.includes('nextIncompleteTable'))
assert(drain.includes("status: result.domain_shadow_ready ? 'success' : 'error'"))
assert(drain.includes("status: checksumReady ? 'success' : 'error'"))
assert(drain.includes('checksum_ready='))
assert(orchestrator.includes("msg.type === 'data_domain_shadow_backfill'"))
assert(admin.includes("c.req.query('durable') === '1'"))
assert(admin.includes('enqueueDataDomainShadowBackfill'))
assert(types.includes("| 'data_domain_shadow_backfill'"))
assert(types.includes('dataDomainTable?: string'))

assert(drain.includes('inspectLatestEveningChainClosure'))
assert(drain.includes('enqueueNextDataDomainShadowBackfill'))
const latestRunning = resolveLatestEveningChainClosure([
  {
    task: 'evening-chain', status: 'success', summary: 'closed', duration_ms: 1,
    timestamp: '2026-08-05T16:00:00Z', run_date: '2026-08-05', run_scope: 'live_canonical',
  },
  {
    task: 'evening-chain', status: 'running', summary: 'active', duration_ms: 1,
    timestamp: '2026-08-06T14:00:00Z', run_date: '2026-08-06', run_scope: 'live_canonical',
  },
])
assert.equal(latestRunning.runDate, '2026-08-06')
assert.equal(latestRunning.terminalSuccess, false)
assert.equal(resolveLatestEveningChainClosure([{
  task: 'evening-chain', status: 'success', summary: 'closed', duration_ms: 1,
  timestamp: '2026-08-06T16:00:00Z', run_date: '2026-08-06', run_scope: 'live_canonical',
}]).terminalSuccess, true)
assert.equal(resolveLatestEveningChainClosure([{
  task: 'evening-chain', status: 'success', summary: 'replay', duration_ms: 1,
  timestamp: '2026-08-06T16:00:00Z', run_date: '2026-08-06', run_scope: 'historical_replay',
}]).terminalSuccess, false)
assert.equal(resolveLatestEveningChainClosure([]).reason, 'latest_evening_chain_missing')

console.log('data domain shadow backfill drain contract tests passed')