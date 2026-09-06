import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { materializeStrategyMultiHorizonOutcomes, listReferences } from './strategyMultiHorizonOutcomes'
import { STRATEGY_MULTI_HORIZON_PROJECTION_VERSION as version } from './priceHorizonProjection'
import { SELECTION_REFERENCE_MATURE_COMPATIBLE_CONTRACT_VERSIONS as contracts } from './selectionReferenceEvidence'

async function main() {
  const sql = new DatabaseSync(':memory:')
  const db = { prepare(query: string) { return { bind(...params: any[]) { return {
    async all() { return { results: sql.prepare(query).all(...params) } },
    async run() { return { meta: { changes: Number(sql.prepare(query).run(...params).changes) } } },
  } } } }, async batch(statements: any[]) { return Promise.all(statements.map(s => s.run())) } } as unknown as D1Database
  sql.exec(`CREATE TABLE canonical_run_heads(logical_run_key TEXT,run_id TEXT);
    CREATE TABLE selection_reference_snapshots_v1(signal_date TEXT,symbol TEXT,producer_run_id TEXT,stock_id INTEGER,
      market_segment TEXT,sector TEXT,feature_contract_version TEXT,hard_gate_passed INTEGER);
    CREATE TABLE price_horizon_labels_v2(stock_id INTEGER,price_date TEXT,horizon_days INTEGER,entry_date TEXT,
      entry_raw_open REAL,entry_adjustment_factor REAL,exit_date TEXT,exit_raw_close REAL,exit_adjustment_factor REAL,
      outcome_known_date TEXT,projection_version TEXT);
    CREATE TABLE price_horizon_label_rejections_v2(stock_id INTEGER,price_date TEXT,horizon_days INTEGER,exit_date TEXT,projection_version TEXT);
    CREATE TABLE canonical_selection_outcomes_v1(signal_date TEXT,symbol TEXT,producer_run_id TEXT,horizon_days INTEGER,
      label_schema_version TEXT,market_segment TEXT,sector TEXT,entry_date TEXT,exit_date TEXT,outcome_known_date TEXT,
      gross_return REAL,transaction_cost_bps REAL,absolute_return_net REAL,benchmark_return_net REAL,benchmark_scope TEXT,
      residual_return_net REAL,cross_section_rank REAL,adjustment_source TEXT,reference_contract_version TEXT,created_at TEXT,
      PRIMARY KEY(signal_date,symbol,producer_run_id,horizon_days,label_schema_version));
    INSERT INTO canonical_run_heads VALUES ('screener:2026-08-13:TW:production:market_screener','head');`)
  for (const id of [1,2,3,4]) {
    sql.prepare('INSERT INTO selection_reference_snapshots_v1 VALUES (?,?,?,?,?,?,?,1)')
      .run('2026-08-13',String(id),'head',id,'listed','sector',id===2?contracts[0]:contracts[1])
    for (const horizon of [3,5,10]) sql.prepare('INSERT INTO price_horizon_labels_v2 VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(id,'2026-08-13',horizon,'2026-08-14',10,1,'2026-08-27',10+id,1,'2026-08-27',version)
  }
  const env={DB:db} as any
  const options={asOfDate:'2026-09-06',startDate:'2026-08-13',endDate:'2026-08-13'}
  assert.equal((await materializeStrategyMultiHorizonOutcomes(env,options)).referenceRows,4)
  assert.equal(sql.prepare("SELECT reference_contract_version v FROM canonical_selection_outcomes_v1 WHERE symbol='1' LIMIT 1").get()!.v,contracts[1])
  sql.exec("UPDATE price_horizon_labels_v2 SET exit_raw_close=15 WHERE stock_id=1; DELETE FROM price_horizon_labels_v2 WHERE stock_id IN (3,4)")
  sql.prepare('INSERT INTO price_horizon_label_rejections_v2 VALUES (?,?,?,?,?)').run(3,'2026-08-13',5,'2026-08-27',version)
  sql.prepare('INSERT INTO price_horizon_label_rejections_v2 VALUES (?,?,?,?,?)').run(4,'2026-08-13',5,'2026-09-07',version)
  const result=await materializeStrategyMultiHorizonOutcomes(env,options)
  assert.equal(result.horizons.find(h=>h.horizonDays===5)!.retiredRows,1)
  const updated=sql.prepare("SELECT * FROM canonical_selection_outcomes_v1 WHERE symbol='1' AND horizon_days=5").get()!
  assert.ok(Math.abs(Number(updated.absolute_return_net)-0.4982)<1e-10)
  assert.ok(Math.abs(Number(updated.benchmark_return_net)-0.3482)<1e-10,'refresh the full available cohort, including unchanged peer')
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM canonical_selection_outcomes_v1 WHERE symbol='3' AND horizon_days=5").get()!.n,0)
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM canonical_selection_outcomes_v1 WHERE symbol='4' AND horizon_days=5").get()!.n,1,'pending/future rejection cannot erase history')
  // Page boundary must not skip the canonical producer when two runs share a symbol.
  sql.exec('DELETE FROM selection_reference_snapshots_v1')
  for(let i=0;i<499;i++) sql.prepare('INSERT INTO selection_reference_snapshots_v1 VALUES (?,?,?,?,?,?,?,1)')
    .run('2026-08-13',String(i).padStart(4,'0'),'head',i+1,'listed','sector',contracts[1])
  for(const producer of ['a-replay','head']) sql.prepare('INSERT INTO selection_reference_snapshots_v1 VALUES (?,?,?,?,?,?,?,1)')
    .run('2026-08-13','9999',producer,1000,'listed','sector',contracts[1])
  assert.equal((await listReferences(db,new Set(['head']),'2026-08-13','2026-08-13')).length,500)
  sql.close()
  console.log('strategyMultiHorizonRefresh: PASS')
}
main().catch(error=>{console.error(error);process.exitCode=1})
