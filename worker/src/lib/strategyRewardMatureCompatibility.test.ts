import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { listStrategyRewardSourceRows } from './strategyLearning'
import { STRATEGY_FORMAL_LABELER_VERSION as labeler } from './strategySpec'
import { SELECTION_REFERENCE_MATURE_COMPATIBLE_CONTRACT_VERSIONS as contracts } from './selectionReferenceEvidence'

async function main() {
  const sql=new DatabaseSync(':memory:')
  sql.exec(`CREATE TABLE strategy_label_matrix_v4(signal_date TEXT,symbol TEXT,producer_run_id TEXT,strategy_id TEXT,strategy_version TEXT,
    strategy_status TEXT,alpha_bucket TEXT,strategy_hit INTEGER,evaluable INTEGER,reference_contract_version TEXT,labeler_version TEXT);
    CREATE TABLE selection_reference_snapshots_v1(signal_date TEXT,symbol TEXT,producer_run_id TEXT,market_segment TEXT,strategy_labeler_version TEXT,feature_contract_version TEXT);
    CREATE TABLE strategy_label_matrix_runs_v4(producer_run_id TEXT,status TEXT,labeler_version TEXT);
    CREATE TABLE canonical_selection_labels_v4(signal_date TEXT,symbol TEXT,producer_run_id TEXT,label_schema_version TEXT,
      absolute_return_net REAL,residual_return_net REAL,cross_section_rank REAL,benchmark_scope TEXT);`)
  sql.prepare('INSERT INTO strategy_label_matrix_runs_v4 VALUES (?,?,?)').run('head','ready',labeler)
  for(const [symbol,contract] of [['A',contracts[0]],['B',contracts[1]],['C','invalid-future-contract']]) {
    sql.prepare('INSERT INTO strategy_label_matrix_v4 VALUES (?,?,?,?,?,?,?,1,1,?,?)')
      .run('2026-08-28',symbol,'head','s8','v1','active','test',contract,labeler)
    sql.prepare('INSERT INTO selection_reference_snapshots_v1 VALUES (?,?,?,?,?,?)')
      .run('2026-08-28',symbol,'head','listed',labeler,contract)
    sql.prepare('INSERT INTO canonical_selection_labels_v4 VALUES (?,?,?,?,?,?,?,?)')
      .run('2026-08-28',symbol,'head','canonical-strategy-selection-label-v4',.03,.01,.9,'market')
  }
  const db={prepare(query:string){return {bind(...args:any[]){return {async all(){return {results:sql.prepare(query).all(...args)}}}}}}} as unknown as D1Database
  const options={endDate:'2026-09-04',canonicalRunIds:{'2026-08-28':'head'},limit:1}
  assert.deepEqual((await listStrategyRewardSourceRows(db,options)).map(r=>r.symbol),['A','B'])
  sql.exec("UPDATE selection_reference_snapshots_v1 SET feature_contract_version='invalid-future-contract' WHERE symbol='B'")
  assert.deepEqual((await listStrategyRewardSourceRows(db,options)).map(r=>r.symbol),['A'])
  sql.close();console.log('strategyRewardMatureCompatibility: PASS')
}
main().catch(error=>{console.error(error);process.exitCode=1})
