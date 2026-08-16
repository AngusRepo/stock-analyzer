import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  resolveDataDomainShadowBackfillContinuation,
  resolveLatestEveningChainClosure,
  shouldContinueDataDomainGlobalSweep,
} from './dataDomainShadowBackfillDrain'

const drain = fs.readFileSync('src/lib/dataDomainShadowBackfillDrain.ts', 'utf8')
const orchestrator = fs.readFileSync('src/lib/updateOrchestrator.ts', 'utf8')
const admin = fs.readFileSync('src/lib/adminTriggerWorkerDomainTasks.ts', 'utf8')
const types = fs.readFileSync('src/types.ts', 'utf8')

assert(drain.includes("leaseGroup: 'd1_heavy_maintenance'"))
assert(drain.includes('SHADOW_BACKFILL_QUEUE_BATCH_LIMIT = 50'))
assert(drain.includes('limit: SHADOW_BACKFILL_QUEUE_BATCH_LIMIT'))
assert(drain.includes('tablesForDataDomainShadowBackfill'))
assert(drain.includes('msg.dataDomainRequestedTable'))
assert(drain.includes('data_domain_shadow_backfill_scope_mismatch'))
assert(drain.includes('dataDomainRequestedTable: input.requestedTable'))
assert(drain.includes('requestedTable: input.table'))
assert((drain.match(/\n\s+requestedTable,/g) ?? []).length >= 3)
assert(drain.includes('nextIncompleteTable'))
assert(drain.includes('nextDataDomainReceiptRefreshTable'))
assert(
  drain.indexOf('await nextDataDomainReceiptRefreshTable(env, input.domain')
  < drain.indexOf('await nextIncompleteTable(env, input.domain)'),
)
assert(drain.includes('nextDataDomainIncrementalCatchupTableStep'))
assert(drain.includes("phase: 'incremental_scan'"))
assert(drain.includes('scanned_tables: scan.scannedTables'))
assert(drain.includes("status: result.domain_shadow_ready ? 'success' : 'error'"))
assert(drain.includes("status: aggregateShadowReady ? 'success' : 'error'"))
assert(drain.includes('aggregateShadowReady = checksumReady'))
assert((drain.match(/await refreshDataDomainAggregateCutover\(env,/g) ?? []).length >= 2)
assert(drain.includes('domainShadowReady: aggregateShadowReady'))
assert(drain.includes('checksum_ready='))
assert(drain.includes('aggregate_shadow_ready='))
assert(orchestrator.includes("msg.type === 'data_domain_shadow_backfill'"))
assert(drain.includes('dataDomainErrorAttempt'))
assert(drain.includes("status='error', last_batch_rows=0, error_code=excluded.error_code"))
assert(drain.includes('consecutive_errors='))
assert(types.includes('dataDomainErrorAttempt?: number'))
assert(admin.includes("c.req.query('durable') === '1'"))
assert(admin.includes("c.req.query('direct_step') === '1'"))
assert(admin.includes('runDataDomainShadowBackfillHttpStep'))
assert(admin.includes('enqueueDataDomainShadowBackfill'))
assert(types.includes("| 'data_domain_shadow_backfill'"))
assert(types.includes('dataDomainTable?: string'))
assert(types.includes('dataDomainRequestedTable?: string'))
assert(types.includes('dataDomainGlobalSweep?: boolean'))
assert(drain.includes('dataDomainGlobalSweep: input.globalSweep'))
assert(drain.includes('globalSweep: true'))
assert((drain.match(/\n\s+globalSweep,/g) ?? []).length >= 3)
assert(drain.indexOf("continuation === 'requested_table_complete'") < drain.indexOf('attempt + 1 >= maxAttempts'))
assert.equal(resolveDataDomainShadowBackfillContinuation(
  'model_artifact_registry',
  'shadow_table_complete',
), 'requested_table_complete')
assert.equal(resolveDataDomainShadowBackfillContinuation(
  undefined,
  'shadow_table_complete',
), 'next_domain_table')
assert.equal(resolveDataDomainShadowBackfillContinuation(
  'model_artifact_registry',
  'shadow_progress',
), 'same_table')
assert.equal(resolveDataDomainShadowBackfillContinuation(
  undefined,
  'shadow_delete_reconciliation_deferred',
), 'next_domain_table')
assert.equal(resolveDataDomainShadowBackfillContinuation(
  'expected_return_artifact_payloads',
  'shadow_delete_reconciliation_deferred',
), 'requested_table_dependency_blocked')
assert.equal(resolveDataDomainShadowBackfillContinuation(
  'expected_return_artifact_payloads',
  'shadow_table_complete',
), 'requested_table_dependency_blocked')
assert.equal(shouldContinueDataDomainGlobalSweep({
  globalSweep: true,
  domainShadowReady: true,
}), true)
assert.equal(shouldContinueDataDomainGlobalSweep({
  globalSweep: false,
  domainShadowReady: true,
}), false)
assert.equal(shouldContinueDataDomainGlobalSweep({
  globalSweep: true,
  requestedTable: 'model_artifact_registry',
  domainShadowReady: true,
}), false)
assert.equal(shouldContinueDataDomainGlobalSweep({
  globalSweep: true,
  domainShadowReady: false,
}), false)

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
