import assert from 'node:assert/strict'
import { test } from 'node:test'
import { learningRetentionBlockers } from './learningTenYearRetentionReadiness'
import { retentionR2PolicyConfig } from './retentionArchiveOnly'
const base={policyReady:true,navReady:true,asOfDate:'2026-09-22',datasets:[{dataset_id:'predictions',candidate_rows:0}],receipts:[{dataset_id:'hot-drain:predictions',status:'cycle_complete',backlog_remaining:0,updated_at:'2026-09-22 02:30:00'}]}
test('configured 120/3650 policy and NAV recovery alone cannot declare Learning complete',()=>{
 assert.deepEqual(learningRetentionBlockers({...base,receipts:[]}),['retention_executor_not_current:predictions'])
})
test('only completed current receipts with zero actual backlog satisfy retention check',()=>{
 assert.deepEqual(learningRetentionBlockers(base),[])
 for(const patch of [{status:'error'},{backlog_remaining:1},{updated_at:'2026-09-01'},{updated_at:'2026-09-23'}])
  assert(learningRetentionBlockers({...base,receipts:[{...base.receipts[0],...patch}]}).length)
 assert.deepEqual(learningRetentionBlockers({...base,datasets:[{dataset_id:'predictions',candidate_rows:1}]}),['retention_backlog:predictions'])
 assert(learningRetentionBlockers({...base,navReady:false}).includes('nav_cold_storage_not_closed'))
})

test('unverified Learning cold readers cannot delete strategy reward sources or declare closure',()=>{
 const sources=retentionR2PolicyConfig('learning_lineage_v1')?.sources ?? []
 const pending=sources.filter(source=>!source.deleteTable).map(source=>source.datasetId)
 for(const table of ['strategy_label_matrix_v4','selection_reference_snapshots_v1','canonical_selection_labels_v4']) {
  assert(pending.includes(table))
  assert(learningRetentionBlockers({...base,readerBlockedDatasets:pending}).includes(`cold_reader_not_verified:${table}`))
 }
 assert.deepEqual(sources.filter(source=>source.deleteTable).map(source=>source.datasetId),['predictions'])
})

test('reader-blocked backlog remains visible without claiming an enabled delete executor',()=>{
 const result=learningRetentionBlockers({...base,datasets:[...base.datasets,{dataset_id:'strategy_decision_log',candidate_rows:421}],readerBlockedDatasets:['strategy_decision_log']})
 assert.deepEqual(result,['cold_reader_not_verified:strategy_decision_log','retention_backlog:strategy_decision_log'])
})

test('readiness counts backlog against the same cutoff the drain deletes to', async () => {
 const { inspectLearningTenYearRetentionReadiness } = await import('./learningTenYearRetentionReadiness')
 const { retentionHotDrainCutoff } = await import('./retentionHotWindowDrain')
 const cutoffs = new Map<string, string>()
 const db = { prepare(sql: string) { const st = { args: [] as unknown[], bind(...a: unknown[]) { st.args = a; return st },
   async first() { const table = /FROM (\w+)\s+WHERE/.exec(sql)?.[1]; if (table && /candidate_rows/.test(sql)) cutoffs.set(table, String(st.args[0])); return null },
   async all() { return { results: [] } } }; return st } } as unknown as D1Database
 const asOf = '2026-12-02'
 const report = await inspectLearningTenYearRetentionReadiness(db, db, asOf)
 assert.equal(cutoffs.get('predictions'), retentionHotDrainCutoff(asOf, 120, 'predictions'))
 assert.equal(report.datasets.find((d: any) => d.dataset_id === 'predictions')?.cutoff_date, cutoffs.get('predictions'))
 assert.equal(cutoffs.get('strategy_decision_log'), retentionHotDrainCutoff(asOf, 120, 'strategy_decision_log'))
})
