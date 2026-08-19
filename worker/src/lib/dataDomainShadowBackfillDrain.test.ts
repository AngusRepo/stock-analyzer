import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  dataDomainShadowBackfillPauseKey,
  dataDomainShadowBackfillQueueBatchLimit,
  LEARNING_CRITICAL_EVIDENCE_BACKFILL_TABLES,
  resolveDataDomainShadowBackfillContinuation,
  shouldYieldToLearningCriticalEvidence,
  shouldRefreshStrategyEvidenceMetricsAfterBackfill,
  resolveLatestEveningChainClosure,
  shouldContinueDataDomainGlobalSweep,
} from './dataDomainShadowBackfillDrain'

const drain = fs.readFileSync('src/lib/dataDomainShadowBackfillDrain.ts', 'utf8')
const orchestrator = fs.readFileSync('src/lib/updateOrchestrator.ts', 'utf8')
const admin = fs.readFileSync('src/lib/adminTriggerWorkerDomainTasks.ts', 'utf8')
const types = fs.readFileSync('src/types.ts', 'utf8')
const heavyMaintenanceSet = admin.slice(
  admin.indexOf('const D1_HEAVY_MAINTENANCE_TASKS'), admin.indexOf('])', admin.indexOf('const D1_HEAVY_MAINTENANCE_TASKS')) + 2,
)
const nextDomainSelector = drain.slice(
  drain.indexOf('export async function nextDataDomainBackfillDomain'),
  drain.indexOf('export async function enqueueNextDataDomainShadowBackfill'),
)
const httpStepSelector = drain.slice(
  drain.indexOf('export async function runDataDomainShadowBackfillHttpStep'),
  drain.indexOf('export async function runQueuedDataDomainShadowBackfill'),
)

assert(drain.includes("leaseGroup: 'd1_heavy_maintenance'"))
assert.equal(dataDomainShadowBackfillQueueBatchLimit('predictions'), 200)
assert.equal(dataDomainShadowBackfillQueueBatchLimit('s12_structure_snapshots'), 100)
assert.equal(dataDomainShadowBackfillQueueBatchLimit('expected_return_artifact_payloads'), 50)
assert.equal(dataDomainShadowBackfillQueueBatchLimit('strategy_label_matrix_v4'), 1000)
assert.equal(dataDomainShadowBackfillQueueBatchLimit('stock_prices'), 500)
assert.equal(dataDomainShadowBackfillQueueBatchLimit('price_horizon_labels_v1'), 500)
assert.equal(dataDomainShadowBackfillQueueBatchLimit('s12_replay_trade_outcomes'), 500)
assert.equal(dataDomainShadowBackfillQueueBatchLimit('strategy_decision_log'), 500)
assert(drain.includes('limit: dataDomainShadowBackfillQueueBatchLimit(table)'))
assert.deepEqual(LEARNING_CRITICAL_EVIDENCE_BACKFILL_TABLES, [
  'strategy_spec_registry',
  'strategy_label_matrix_runs_v4',
  'strategy_label_matrix_v4',
])
assert.equal(shouldYieldToLearningCriticalEvidence({
  domain: 'learning', currentTable: 'predictions', criticalTable: 'strategy_spec_registry',
}), true)
assert.equal(shouldYieldToLearningCriticalEvidence({
  domain: 'learning', currentTable: 'predictions', requestedTable: 'predictions', criticalTable: 'strategy_spec_registry',
}), false)
assert.equal(shouldYieldToLearningCriticalEvidence({
  domain: 'paper', currentTable: 'paper_orders', criticalTable: 'strategy_spec_registry',
}), false)
assert(drain.includes('nextLearningCriticalEvidenceTable(env)'))
assert.equal(dataDomainShadowBackfillPauseKey('learning'), 'data-domain-shadow-backfill:learning:paused')
assert.equal(shouldRefreshStrategyEvidenceMetricsAfterBackfill({
  domain: 'learning', table: 'strategy_label_matrix_v4', status: 'shadow_table_complete',
}), true)
assert.equal(shouldRefreshStrategyEvidenceMetricsAfterBackfill({
  domain: 'learning', table: 'strategy_label_matrix_v4', status: 'shadow_progress', bridgeReady: true,
}), false)
assert.equal(shouldRefreshStrategyEvidenceMetricsAfterBackfill({
  domain: 'learning', table: 'strategy_label_matrix_v4', status: 'shadow_progress', bridgeReady: false,
}), true)
assert.equal(shouldRefreshStrategyEvidenceMetricsAfterBackfill({
  domain: 'learning', table: 'predictions', status: 'shadow_table_complete',
}), false)
assert.equal(shouldRefreshStrategyEvidenceMetricsAfterBackfill({
  domain: 'paper', table: 'strategy_label_matrix_v4', status: 'shadow_table_complete',
}), false)
assert(drain.includes('strategy_metric_refresh: strategyMetricRefresh'))
assert(drain.includes("sourceMode: result.status === 'shadow_table_complete' ? 'learning_target' : 'authority_bridge'"))
assert(drain.includes('backfill_paused=true durable_cursor_preserved=true'))
assert(drain.includes('tablesForDataDomainShadowBackfill'))
assert(drain.includes('msg.dataDomainRequestedTable'))
assert(drain.includes('data_domain_shadow_backfill_scope_mismatch'))
assert(drain.includes('dataDomainRequestedTable: input.requestedTable'))
assert(drain.includes('requestedTable: input.table'))
assert((drain.match(/\n\s+requestedTable,/g) ?? []).length >= 3)
assert(drain.includes('nextIncompleteTable'))
assert(drain.includes('nextDataDomainReceiptRefreshTable'))
assert(
  httpStepSelector.indexOf('await nextIncompleteTable(env, input.domain)')
  < httpStepSelector.indexOf('await nextDataDomainReceiptRefreshTable(env, input.domain'),
)
assert(drain.includes('nextDataDomainIncrementalCatchupTableStep'))
assert((drain.match(/nextDataDomainIncrementalCatchupTableStep\(env, domain, parityNotBefore\)/g) ?? []).length >= 2)
assert(drain.includes('enqueueDataDomainIncrementalScanContinuation'))
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
assert(admin.includes("parseBoundedPositiveInt(c.req.query('limit'), 50, 1000)"))
assert(drain.includes('const iterations = !activeDataDomains(env).has(input.domain)'))
assert(drain.includes('data_domain_shadow_http_batch_result_missing'))
assert(admin.includes('enqueueDataDomainShadowBackfill'))
assert(drain.includes('input.parityNotBefore ?? active?.started_at ?? dataDomainParitySessionWatermark()'))
assert(drain.includes('const httpAggregateShadowReady = Boolean(result.domain_shadow_ready)'))
assert(drain.includes('caughtUp: httpAggregateShadowReady'))
assert((admin.match(/parityNotBefore: closure.timestamp/g) ?? []).length >= 3)
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
assert(!nextDomainSelector.includes('data_domain_shadow_requires_strict_disabled'))
const mutationAuthority = drain.slice(
  drain.indexOf('async function assertDataDomainShadowMutationAuthority'),
  drain.indexOf('export function dataDomainParitySessionWatermark'),
)
assert(!mutationAuthority.includes('data_domain_shadow_requires_strict_disabled'))
assert(mutationAuthority.includes('data_domain_shadow_requires_inactive_target'))
assert((nextDomainSelector.match(/for \(const domain of DOMAIN_BACKFILL_ORDER\)/g) ?? []).length === 2)
assert(nextDomainSelector.indexOf('const incomplete = await nextIncompleteTable')
  < nextDomainSelector.indexOf('const receiptRefresh = await nextDataDomainReceiptRefreshTable'))
assert(drain.includes("if (domain === 'ops')"))
assert(drain.includes('run: () => runDataDomainShadowBackfillHttpStep(env'))
assert(drain.includes('queued: false, runId: step.runId'))
assert(drain.includes("taskName: 'data-domain-shadow-backfill:ops-coordinator'"))
assert(drain.includes("leaseGroup: 'd1_heavy_maintenance'"))
assert(!heavyMaintenanceSet.includes("'data-domain-shadow-backfill-next'"))
assert(drain.indexOf("if (domain === 'ops')") < drain.indexOf('const queued = await enqueueDataDomainShadowBackfill(env'))
assert(drain.includes('input.parityNotBefore || dataDomainParitySessionWatermark()'))
assert(admin.includes('parityNotBefore: closure.timestamp'))
assert(!admin.includes('parityNotBefore: dataDomainParitySessionWatermark()'))
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
assert(drain.includes("closure.runScope !== 'historical_replay'"))
assert(drain.includes('FROM market_trading_sessions'))
assert(drain.includes("stage='post_verify_chain'"))
assert(drain.includes('FROM strategy_learning_runs'))
assert(drain.includes('latest_evening_chain_latest_completed_session_recovery_success'))

console.log('data domain shadow backfill drain contract tests passed')
