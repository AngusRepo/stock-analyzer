import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { test } from 'node:test'
import { repairHistoricalStrategyDecisionGrid } from './strategyLearning'

function fixture() {
 const db=new DatabaseSync(':memory:')
 const schema=readFileSync('domain-schemas/learning.sql','utf8')
 for(const table of ['strategy_decision_log','strategy_label_matrix_runs_v4','strategy_label_matrix_v4','selection_reference_snapshots_v1']) {
  const ddl=schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`))
  assert.ok(ddl);db.exec(ddl[0])
 }
 db.exec(`INSERT INTO strategy_label_matrix_runs_v4(producer_run_id,signal_date,status,reference_candidate_count,strategy_count,expected_cell_count,persisted_cell_count,strategy_registry_checksum,labeler_version,reference_contract_version)
 VALUES('run1','2026-01-01','ready',2,1,2,2,'registry','labels','reference')`)
 for(const symbol of ['2330','2317']) {
  db.prepare(`INSERT INTO selection_reference_snapshots_v1(signal_date,symbol,producer_run_id,name,hard_gate_passed,hard_gate_reason,feature_available,strategy_labeled,strategy_selected,selection_stage,strategy_registry_checksum,feature_contract_version)
  VALUES('2026-01-01',?,'run1',NULL,1,'ok',1,1,1,'L3','registry','features')`).run(symbol)
  db.prepare(`INSERT INTO strategy_label_matrix_v4(signal_date,symbol,producer_run_id,strategy_id,strategy_version,strategy_status,alpha_bucket,family_id,production_owner,strategy_hit,evaluable,evaluability_status,weak_label,affinity,match_strength,position_weight,overlap,labeler_version,strategy_registry_checksum,reference_contract_version)
  VALUES('2026-01-01',?,'run1','s1','v1','active','trend','trend',1,1,1,'EVALUABLE',1,0.5,0.3,0.1,0,'labels','registry','reference')`).run(symbol)
 }
 const adapter={prepare(sql: string){let args: SQLInputValue[]=[];const s={bind(...values:SQLInputValue[]){args=values;return s},
  async first(){return db.prepare(sql).get(...args)??null},async run(){return {meta:{changes:Number(db.prepare(sql).run(...args).changes)}}}};return s}}
 const repair=(producer='run1')=>repairHistoricalStrategyDecisionGrid(adapter as unknown as D1Database,{date:'2026-01-01',canonicalProducerRunId:producer})
 return {db,repair}
}

test('identical projection retries write zero rows and retain the original creation time',async()=>{
 const {db,repair}=fixture()
 try {
  assert.equal((await repair()).persistedRows,2)
  db.exec("UPDATE strategy_decision_log SET created_at='2020-01-01 00:00:00'")
  const before=db.prepare('SELECT * FROM strategy_decision_log ORDER BY symbol').all()
  const retry=await repair()
  assert.equal(retry.persistedRows,0);assert.equal(retry.decisionRowsAfter,2)
  assert.deepEqual(db.prepare('SELECT * FROM strategy_decision_log ORDER BY symbol').all(),before)
  db.exec("UPDATE strategy_label_matrix_v4 SET match_strength=0.8 WHERE symbol='2330'")
  assert.equal((await repair()).persistedRows,1)
  assert.equal(db.prepare("SELECT match_score FROM strategy_decision_log WHERE symbol='2330'").get()?.match_score,0.8)
  assert.equal((await repair()).persistedRows,0)
 } finally {db.close()}
})

test('name, nullability, missing rows, evidence and producer lineage still repair exactly',async()=>{
 const {db,repair}=fixture()
 try {
  await repair()
  for(const change of [
   "UPDATE selection_reference_snapshots_v1 SET name='corrected' WHERE symbol='2330'",
   "UPDATE selection_reference_snapshots_v1 SET name=NULL WHERE symbol='2330'",
   "UPDATE strategy_label_matrix_v4 SET labeler_version='labels-v2' WHERE symbol='2330'",
   "UPDATE strategy_label_matrix_v4 SET evaluable=0,evaluability_status='MISSING_SOURCE',unavailable_reason='broker' WHERE symbol='2330'",
   "UPDATE strategy_label_matrix_v4 SET evaluable=1,evaluability_status='EVALUABLE',unavailable_reason=NULL WHERE symbol='2330'",
   "UPDATE strategy_decision_log SET evidence_json='{}',context_id='stale',evidence_artifact_id='stale' WHERE symbol='2330'",
   "DELETE FROM strategy_decision_log WHERE symbol='2330'",
  ]) {
   db.exec(change);assert.equal((await repair()).persistedRows,1,change)
   assert.equal((await repair()).persistedRows,0,change)
  }
  db.exec("UPDATE strategy_label_matrix_runs_v4 SET producer_run_id='run2'; UPDATE strategy_label_matrix_v4 SET producer_run_id='run2'; UPDATE selection_reference_snapshots_v1 SET producer_run_id='run2'")
  assert.equal((await repair('run2')).persistedRows,2)
  assert.equal((await repair('run2')).persistedRows,0)
  assert.ok(db.prepare('SELECT decision_id FROM strategy_decision_log').all().every(r=>String(r.decision_id).startsWith('historical-matrix-projection:run2:')))
 } finally {db.close()}
})

test('incomplete canonical source still fails rather than accepting an incomplete projection',async()=>{
 const {db,repair}=fixture()
 try {
  db.exec("DELETE FROM strategy_label_matrix_v4 WHERE symbol='2330'")
  await assert.rejects(repair(),/historical_strategy_decision_grid_incomplete/)
 } finally {db.close()}
})
