import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { buildRetentionArchiveOnlyQuery,retentionR2PolicyConfig,runRetentionArchiveOnly } from './retentionArchiveOnly'

test('indexed prediction pages preserve old rows, ties, nulls and strict cutoff',()=>{
 const db=new DatabaseSync(':memory:')
 try {
  db.exec('CREATE TABLE predictions(id INTEGER PRIMARY KEY, prediction_date TEXT, stock_id INTEGER, model_name TEXT); CREATE INDEX idx_date ON predictions(prediction_date,stock_id,model_name)')
  const ins=db.prepare('INSERT INTO predictions VALUES(?,?,?,?)')
  for(let i=1;i<=2000;i++)ins.run(i,i%11===0?null:`2026-01-${String(1+i%28).padStart(2,'0')}`,i%20,'A')
  const source=retentionR2PolicyConfig('learning_lineage_v1')!.sources.find(s=>s.datasetId==='predictions')!
  const cutoff='2026-01-21',expected=db.prepare("SELECT id FROM predictions WHERE substr(prediction_date,1,10) < ? ORDER BY substr(prediction_date,1,10),rowid").all(cutoff).map(r=>r.id)
  const actual:unknown[]=[];let cursor:any=null
  while(true){
   const query=buildRetentionArchiveOnlyQuery(source,cursor)
   const args=cursor?[cutoff,cursor.cursor_date,cursor.cursor_key,37]:[cutoff,37]
   const rows=db.prepare(query).all(...args)
   if(!rows.length)break
   actual.push(...rows.map(r=>r.id));const last=rows.at(-1)!
   cursor={cursor_date:last.__archive_date,cursor_key:String(last.__cursor_key)}
  }
  assert.deepEqual(actual,expected)
  const details=db.prepare('EXPLAIN QUERY PLAN '+buildRetentionArchiveOnlyQuery(source,{cursor_date:'2026-01-10',cursor_key:'100'})).all(cutoff,'2026-01-10','100',37).map(r=>r.detail).join(' ')
  assert.match(details,/SEARCH predictions USING.*idx_date/)
  assert.doesNotMatch(details,/SCAN predictions/)
 }finally{db.close()}
})

test('archive read failure retains last acknowledged cursor instead of scanning from the beginning',async()=>{
 const writes:any[]=[]
 const ops={prepare(sql:string){let args:any[]=[];const statement={sql,get args(){return args},bind(...a:any[]){args=a;return statement},
  async first(){
   if(sql.includes('FROM data_retention_policies'))return {policy_id:'learning_lineage_v1',hot_retention_days:120,cold_retention_days:3650,archive_store:'r2',hard_reference_protected:1,status:'active'}
   if(sql.includes('FROM data_retention_cursors')&&args[1]==='predictions')return {policy_id:args[0],dataset_id:args[1],status:'running',cursor_date:'2026-01-20',cursor_key:'19876',cycle:0,backlog_remaining:1}
   return null
  },async run(){return {success:true}}};return statement},async batch(statements:any[]){writes.push(...statements.map(s=>({sql:s.sql,args:s.args})));return []}}
 const learning={prepare(sql:string){const st={bind(){return st},async all(){if(sql.includes('FROM predictions'))throw new Error('fixture read failure');return {results:[]}}};return st}}
 const result=await runRetentionArchiveOnly({DB:learning,LEARNING_DB:learning,OPS_DB:ops,MULTI_D1_ACTIVE_DOMAINS:'learning,ops',ARTIFACTS:{}} as any,{businessDate:'2026-09-23',policyIds:['learning_lineage_v1']})
 assert.equal(result.status,'error')
 const failure=writes.find(w=>w.sql.includes('INSERT INTO data_retention_run_items')&&w.args[1]==='predictions')
 assert.equal(failure.args[2],'error')
 assert.equal(failure.args[8],'2026-01-20');assert.equal(failure.args[9],'19876')
 assert.equal(failure.args[6],0)
})
