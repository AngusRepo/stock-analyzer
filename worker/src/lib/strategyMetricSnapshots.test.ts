import assert from 'node:assert/strict'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { publishMetricSnapshot,readMetricSnapshot,METRIC_ROWS_BEFORE_CUTOFF_SQL } from './strategyMetricSnapshots'
async function main() {
 const sql=new DatabaseSync(':memory:')
 sql.exec(`CREATE TABLE strategy_evidence_metrics_v1(strategy_id TEXT,strategy_version TEXT,strategy_status TEXT,alpha_bucket TEXT,
 primary_horizon_days INTEGER,metric_name TEXT,metric_value REAL,metric_status TEXT,sample_count INTEGER,mature_dates INTEGER,
 date_start TEXT,date_end TEXT,outcome_as_of_date TEXT,definition_version TEXT,evidence_json TEXT);
 CREATE TABLE strategy_evidence_metric_snapshot_runs_v1(snapshot_run_id TEXT,outcome_as_of_date TEXT,definition_version TEXT,source_mode TEXT,status TEXT,created_at TEXT);`)
 sql.exec(fs.readFileSync('domain-migrations/learning/0042_strategy_metric_run_snapshots.sql','utf8'))
 const db={prepare(query:string){return {bind(...values:any[]){return {
   async first(){return sql.prepare(query).get(...values)??null},
   async all(){return {results:sql.prepare(query).all(...values)}},
   run(){return sql.prepare(query).run(...values)},
 }}}},async batch(stmts:any[]){sql.exec('BEGIN');try{const r=stmts.map(s=>s.run());sql.exec('COMMIT');return r}catch(e){sql.exec('ROLLBACK');throw e}}} as any
 const row={strategy_id:'s',strategy_version:'v1',strategy_status:'active',alpha_bucket:'test',primary_horizon_days:5,
 metric_name:'rank_ic',metric_value:0.2,metric_status:'ready',sample_count:50,mature_dates:10,date_start:'2026-08-19',
 date_end:'2026-09-01',outcome_as_of_date:'2026-09-09',definition_version:'v4',evidence_json:'{}'} as any
 const input={date:'2026-09-09',definition:'v4',mode:'authority_bridge',scope:'late-prior-run',source:'test',profiles:1,observations:50,readyRows:1,rows:[row]}
 const first=await publishMetricSnapshot(db,input)
 const second=await publishMetricSnapshot(db,{...input,scope:'actual-evening-run',rows:[{...row,metric_value:.4}]})
 assert.notEqual(first.snapshot_run_id,second.snapshot_run_id)
 assert.deepEqual(await readMetricSnapshot(db,input.date,'v4',input.mode,input.scope),first)
 await assert.rejects(publishMetricSnapshot(db,{...input,rows:[{...row,metric_value:-.8}]}),/receipt_conflict/)
 assert.equal(sql.prepare('SELECT COUNT(*) n FROM strategy_evidence_metric_snapshot_rows_v2').get()!.n,2)
 assert.equal(sql.prepare('SELECT COUNT(*) n FROM strategy_evidence_metrics_v1').get()!.n,0)
 sql.prepare('UPDATE strategy_evidence_metric_snapshot_runs_v2 SET created_at=? WHERE snapshot_run_id=?').run('2026-09-08 16:09:34',first.snapshot_run_id)
 sql.prepare('UPDATE strategy_evidence_metric_snapshot_runs_v2 SET created_at=? WHERE snapshot_run_id=?').run('2026-09-09 15:00:00',second.snapshot_run_id)
 const get=(day:string)=>sql.prepare(METRIC_ROWS_BEFORE_CUTOFF_SQL+' SELECT metric_value FROM metric_revisions WHERE snapshot_rank=1').all(day,day)
 assert.equal(get('2026-09-09').length,0)
 assert.equal(get('2026-09-10')[0].metric_value,.4)
 // A backfill published after the decision must not replace what was known then.
 sql.prepare('UPDATE strategy_evidence_metric_snapshot_runs_v2 SET created_at=? WHERE snapshot_run_id=?').run('2026-09-10 16:00:00',second.snapshot_run_id)
 assert.equal(get('2026-09-10')[0].metric_value,.2)
 sql.prepare('UPDATE strategy_evidence_metric_snapshot_rows_v2 SET row_json=? WHERE snapshot_run_id=?').run(JSON.stringify({...row,metric_value:99}),first.snapshot_run_id)
 await assert.rejects(readMetricSnapshot(db,input.date,'v4',input.mode,input.scope),/integrity_failure/)
 console.log('run-scoped immutable snapshots and Taipei publication cutoff: PASS')
}
main().catch(e=>{console.error(e);process.exitCode=1})
