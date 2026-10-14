import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { loadObservations, backfillMissingStrategyEvidenceMetricSnapshots, strategyMetricPublicationScope } from './strategyEvidenceMetrics'
import { loadDateReturns } from './strategyEvidenceOwnerCalibration'

async function main() {
const db = new DatabaseSync(':memory:')
db.exec(`CREATE TABLE strategy_evidence_observations_v1 (
 matrix_row_id INTEGER,signal_date TEXT,symbol TEXT,producer_run_id TEXT,strategy_id TEXT,strategy_version TEXT,
 strategy_status TEXT,alpha_bucket TEXT,legacy_binary_affinity REAL,legacy_affinity_version TEXT,
 affinity_evidence_count INTEGER,evidence_affinity REAL,evidence_affinity_version TEXT,position_weight REAL,
 overlap REAL,horizon_days INTEGER,outcome_known_date TEXT,entry_date TEXT,exit_date TEXT,
 absolute_return_net REAL,benchmark_return_net REAL,residual_return_net REAL,cross_section_rank REAL,alpha_context TEXT);
 CREATE TABLE selection_reference_snapshots_v1(signal_date TEXT,symbol TEXT,producer_run_id TEXT,
 strategy_matrix_status TEXT,feature_contract_version TEXT,strategy_labeler_version TEXT,strategy_registry_checksum TEXT);
 CREATE TABLE strategy_label_matrix_runs_v4(producer_run_id TEXT,status TEXT,expected_cell_count INTEGER,
 persisted_cell_count INTEGER,labeler_version TEXT,strategy_registry_checksum TEXT,reference_contract_version TEXT);`)
const v3 = 'selection-reference-snapshot-v3', v4 = 'selection-reference-snapshot-v4-regime-veto-evidence'
const legacy = 'strategy-labeler-v2-revenue-pit-fuse-v1', current = 'strategy-labeler-v3-regime-veto-counterfactual-v1'
const canonical: Record<string,string> = {}
for (const [i, contract, labeler] of [[1,v3,legacy],[2,v4,current],[3,v3,current],[4,v4,legacy],[5,'unknown',current]] as const) {
  const day = `2026-09-0${i}`, run = `run${i}`; canonical[day] = run
  db.prepare(`INSERT INTO strategy_evidence_observations_v1 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(i,day,'2330',run,'s','v1','active','trend_following',1,'legacy',1,1,'v1',1,0,5,'2026-09-10',day,'2026-09-10',0.02,0.01,0.01,0.9,'{}')
  db.prepare('INSERT INTO selection_reference_snapshots_v1 VALUES(?,?,?,?,?,?,?)').run(day,'2330',run,'ready',contract,labeler,'registry')
  db.prepare('INSERT INTO strategy_label_matrix_runs_v4 VALUES(?,?,?,?,?,?,?)').run(run,'ready',1,1,labeler,'registry',contract)
}
const adapter = {prepare(sql:string) {return {bind(...args:any[]) {return {async all() {return {results: db.prepare(sql).all(...args)}}}}}}} as any
const profiles = [{strategy_id:'s',strategy_version:'v1',strategy_status:'active',primary_horizon_days:5,required_metrics:['rank_ic']}]
const read = async () => {
  const observations = await loadObservations(adapter,'2026-09-11',canonical)
  const returns = await loadDateReturns(adapter,profiles,'2026-09-11',canonical)
  return [observations.map(r=>r.signal_date),returns.map(r=>r.signal_date)]
}
assert.deepEqual(await read(), [['2026-09-01','2026-09-02'],['2026-09-01','2026-09-02']])
// Incomplete matrices, changed registry, noncanonical producer and future
// outcomes must still be rejected by both actual SQL readers.
for (const sql of [
 "UPDATE strategy_label_matrix_runs_v4 SET persisted_cell_count=0 WHERE producer_run_id='run2'",
 "UPDATE strategy_label_matrix_runs_v4 SET strategy_registry_checksum='other' WHERE producer_run_id='run2'",
 "UPDATE strategy_evidence_observations_v1 SET outcome_known_date='2026-09-12' WHERE producer_run_id='run2'",
]) {
  db.exec('SAVEPOINT fixture'); db.exec(sql)
  assert.deepEqual(await read(), [['2026-09-01'],['2026-09-01']]); db.exec('ROLLBACK TO fixture; RELEASE fixture')
}
canonical['2026-09-02']='other'
assert.deepEqual(await read(), [['2026-09-01'],['2026-09-01']])
// Exercise the real backfill selection SQL, stopping before materialization.
db.exec(`CREATE TABLE strategy_evidence_metric_snapshot_runs_v2 (
 outcome_as_of_date TEXT, definition_version TEXT, source_mode TEXT, status TEXT, publication_scope TEXT);
 INSERT INTO strategy_evidence_metric_snapshot_runs_v2 VALUES
 ('2026-09-10','strategy-evidence-metrics-v4','authority_bridge','ready','daily:2026-09-10');`)
let selected: any[] = []
const selectionOnly = {prepare(sql:string) {return {bind(...args:any[]) {return {async all() {
  selected = db.prepare(sql).all(...args); return {results:[]}
}}}}}} as any
const selectMissing = () => backfillMissingStrategyEvidenceMetricSnapshots({DB:selectionOnly} as any,
  {knowledgeCutoffDate:'2026-09-11'})
await selectMissing()
assert.deepEqual(selected.map(row=>row.outcome_known_date), ['2026-09-10'])
db.prepare('UPDATE strategy_evidence_metric_snapshot_runs_v2 SET publication_scope=?')
 .run(strategyMetricPublicationScope('daily:2026-09-10'))
await selectMissing(); assert.equal(selected.length,0)
db.exec("UPDATE strategy_evidence_metric_snapshot_runs_v2 SET status='pending'")
await selectMissing(); assert.equal(selected.length,1)
assert.throws(()=>strategyMetricPublicationScope(' '.repeat(2)),/invalid_strategy_metric_publication_scope/)
assert.throws(()=>strategyMetricPublicationScope('x'.repeat(500)),/invalid_strategy_metric_publication_scope/)
db.close()
console.log('strategy evidence readers v3/v4 and provenance checks passed')

}
main().catch(error => {console.error(error); process.exitCode=1})
