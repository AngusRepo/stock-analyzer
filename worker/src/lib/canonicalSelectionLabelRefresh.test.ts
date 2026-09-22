import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { listCanonicalReferences, CANONICAL_SELECTION_ADJUSTMENT_SOURCE } from './canonicalSelectionLabels'
import { deleteRejectedMultiHorizonLabels, deleteResolvedMultiHorizonRejections } from './priceHorizonProjection'
import { SELECTION_REFERENCE_MATURE_COMPATIBLE_CONTRACT_VERSIONS } from './selectionReferenceEvidence'

async function main() {
  const sql = new DatabaseSync(':memory:')
  let batchCalls = 0
  let statementCount = 0
  let maxBindings = 0
  const db = {
    prepare(query: string) {
      const statement = sql.prepare(query)
      return { bind(...params: any[]) { maxBindings = Math.max(maxBindings,params.length); return {
        async all() { return { results: statement.all(...params) } },
        async run() { return statement.run(...params) },
      } } }
    },
    async batch(statements: any[]) { batchCalls++; statementCount += statements.length; return Promise.all(statements.map(s => s.run())) },
  } as unknown as D1Database
  sql.exec(`
    CREATE TABLE selection_reference_snapshots_v1(signal_date TEXT,symbol TEXT,producer_run_id TEXT,
      stock_id INTEGER,market_segment TEXT,sector TEXT,feature_contract_version TEXT);
    CREATE TABLE canonical_selection_labels_v4(signal_date TEXT,symbol TEXT,producer_run_id TEXT,
      label_schema_version TEXT,adjustment_source TEXT,reference_contract_version TEXT,
      transaction_cost_bps REAL,entry_date TEXT,exit_date TEXT,outcome_known_date TEXT,
      entry_raw_open REAL,exit_raw_close REAL,entry_adjustment_factor REAL,exit_adjustment_factor REAL);
    CREATE TABLE price_horizon_labels_v1(stock_id INTEGER,price_date TEXT,entry_date TEXT,exit_date TEXT,
      outcome_known_date TEXT,entry_raw_open REAL,exit_raw_close REAL,entry_adjustment_factor REAL,exit_adjustment_factor REAL);
    CREATE TABLE price_horizon_labels_v2(stock_id INTEGER,price_date TEXT,horizon_days INTEGER);
  `)
  const contract = SELECTION_REFERENCE_MATURE_COMPATIBLE_CONTRACT_VERSIONS[0]
  for (const [id, date, symbol] of [[1,'2026-08-13','A'],[2,'2026-08-13','B'],[3,'2026-08-12','C']] as const) {
    sql.prepare('INSERT INTO selection_reference_snapshots_v1 VALUES (?,?,?,?,?,?,?)')
      .run(date,symbol,'run-'+date,id,'listed','sector',contract)
    sql.prepare('INSERT INTO canonical_selection_labels_v4 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(date,symbol,'run-'+date,'canonical-strategy-selection-label-v4',CANONICAL_SELECTION_ADJUSTMENT_SOURCE,
        contract,18,'2026-08-14','2026-08-20','2026-08-20',10,11,1,1)
    sql.prepare('INSERT INTO price_horizon_labels_v1 VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id,date,'2026-08-14','2026-08-20','2026-08-20',10,id===1?12:11,1,1)
  }
  const heads={'2026-08-13':'run-2026-08-13','2026-08-12':'run-2026-08-12'}
  const rows=await listCanonicalReferences(db,'2026-09-04',undefined,undefined,heads)
  assert.deepEqual(rows.map(r=>r.symbol),['A','B'],'source correction must include the unchanged peer for full-cohort neutralization')
  sql.exec("UPDATE canonical_selection_labels_v4 SET exit_raw_close=12 WHERE symbol='A'")
  assert.deepEqual(await listCanonicalReferences(db,'2026-09-04',undefined,undefined,heads),[],
    'matching upstream values are truly idempotent')
  sql.exec("DELETE FROM canonical_selection_labels_v4 WHERE symbol='B'")
  assert.deepEqual((await listCanonicalReferences(db,'2026-09-04',undefined,undefined,heads)).map(r=>r.symbol),['A','B'],
    'late peer must refresh the full date, not a singleton benchmark')
  sql.exec("INSERT INTO price_horizon_labels_v2 VALUES (981,'2026-08-07',5),(981,'2026-08-07',10),(1,'2026-08-07',10)")
  await deleteRejectedMultiHorizonLabels(db,10,[{stockId:981,priceDate:'2026-08-07',entryDate:'2026-08-10',
    exitDate:'2026-08-21',reason:'exit_price_row_missing'}])
  assert.deepEqual(sql.prepare('SELECT stock_id,horizon_days FROM price_horizon_labels_v2 ORDER BY stock_id').all()
    .map(r=>[r.stock_id,r.horizon_days]),[[1,10],[981,5]],'retire only the rejected exact horizon identity')
  sql.exec('CREATE TABLE price_horizon_label_rejections_v2(stock_id INTEGER,price_date TEXT,horizon_days INTEGER)')
  const insert=sql.prepare('INSERT INTO price_horizon_label_rejections_v2 VALUES (?,?,?)')
  for(let id=1;id<=811;id++) for(const day of ['2026-09-08','2026-09-09']) for(const horizon of [3,5,10])
    insert.run(id,day,horizon)
  const resolved=Array.from({length:809},(_,i)=>i+1)
  batchCalls=0; statementCount=0; maxBindings=0
  await deleteResolvedMultiHorizonRejections(db,5,'2026-09-08',resolved)
  assert.equal(batchCalls,1,'800-stock cleanup needs one D1 batch, not 41')
  assert.equal(statementCount,9)
  assert.ok(maxBindings<=100)
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM price_horizon_label_rejections_v2 WHERE price_date='2026-09-08' AND horizon_days=5").get()!.n,2)
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM price_horizon_label_rejections_v2').get()!.n,811*6-809,
    'retain other dates, horizons, and unresolved symbols')
  await deleteResolvedMultiHorizonRejections(db,5,'2026-09-08',[])
  assert.equal(batchCalls,1,'empty cleanup does not issue SQL')
  sql.close()
  console.log('canonicalSelectionLabelRefresh: PASS')
}
main().catch(error=>{console.error(error);process.exitCode=1})
