import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { test } from 'node:test'
import { buildAuditJsonCandidateQuery, runAuditJsonArchiveRetention, type AuditJsonArchiveTargetId } from './auditJsonArchive'
import type { RetentionCursor } from './retentionRunLedger'

// Captured from unmodified production33b10256 before this candidate was edited.
const baseline=JSON.parse(readFileSync('src/lib/fixtures/auditJsonCandidateBaselineV1.json','utf8'))
const targets: AuditJsonArchiveTargetId[]=['strategy_decision_log','screener_funnel_items','canonical_screener_funnel_items','paper_execution_events']
function fixture(target:AuditJsonArchiveTargetId,count=260,uniform=false) {
 const db=new DatabaseSync(':memory:')
 for(const [domain,tables] of [['learning',['strategy_decision_log']],['ops',['screener_funnel_items','screener_funnel_runs','canonical_run_heads']],['paper',['paper_execution_events']]] as const) {
  const schema=readFileSync(`domain-schemas/${domain}.sql`,'utf8')
  for(const table of tables) {const ddl=schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`));assert.ok(ddl);db.exec(ddl[0])}
 }
 db.exec(`CREATE INDEX strategy_date ON strategy_decision_log(date DESC,strategy_id,matched);
 CREATE INDEX funnel_date ON screener_funnel_items(date,id);
 CREATE INDEX run_date ON screener_funnel_runs(date DESC,created_at DESC);
 CREATE INDEX event_date ON paper_execution_events(trade_date,id)`)
 for(const date of ['2026-01-01','2026-01-02','2026-01-03']) {
  for(const [run,status,time] of [['old','success','01'],['latest','success','02'],['failed','failed','03'],['frozen','success','00']]) db.prepare('INSERT INTO screener_funnel_runs(run_id,date,status,created_at) VALUES(?,?,?,?)').run(`${date}-${run}`,date,status,`${date}T${time}:00:00Z`)
  db.prepare('INSERT INTO canonical_run_heads(logical_run_key,run_id,promoted_at) VALUES(?,?,?)').run(date,`${date}-frozen`,date)
 }
 for(let i=1;i<=count;i++) {
  const date=uniform?'2026-01-01':i===count?'2026-01-03':i<130?'2026-01-01':'2026-01-02'
  let blob:string|null=JSON.stringify({text:'漢😀"\\x'.repeat(280+i%37),i})
  if(!uniform) {if(i%17===0)blob='{}';else if(i%19===0)blob=JSON.stringify({archived_to_r2:true,padding:'x'.repeat(1500)});else if(i%23===0)blob=null}
  if(target==='strategy_decision_log') db.prepare(`INSERT INTO strategy_decision_log(decision_id,date,symbol,name,strategy_id,strategy_version,strategy_status,alpha_bucket,matched,match_score,reason_code,context_json,evidence_json,context_id,evidence_artifact_id)
   VALUES(?,?,?,NULL,'s','v1','active','trend',?,?,'matched',?,?,?,?)`).run(`d${String(i).padStart(6,'0')}`,date,String(i),i%2,i%2?0.75:null,blob??'{}',blob??'{}',!uniform&&i%11===0?null:'ctx','artifact')
  else if(target==='paper_execution_events')db.prepare(`INSERT INTO paper_execution_events(id,trade_date,symbol,side,event_type,status,detail_json) VALUES(?,?,?,'buy','entry','completed',?)`).run(i,date,String(i),blob)
  else db.prepare(`INSERT INTO screener_funnel_items(id,run_id,date,symbol,stage,decision,reason_code,score_before,score_after,evidence) VALUES(?,?,?,?,'L3','pass','ok',NULL,0.5,?)`).run(i,`${date}-${['old','latest','failed','frozen'][i%4]}`,date,String(i),blob)
 }
 const adapter={prepare(sql:string){let args:SQLInputValue[]=[];return{bind(...values:SQLInputValue[]){args=values;return this},async all(){return{results:db.prepare(sql).all(...args)}},async first(){return db.prepare(sql).get(...args)??null}}}}
 return{db,adapter}
}
function cursorFor(id:AuditJsonArchiveTargetId):RetentionCursor{return{cursor_date:'2026-01-01',cursor_key:id==='strategy_decision_log'?'d000050':'50'} as RetentionCursor}
for(const target of targets)for(const mode of ['head','tail'] as const)test(`${target} ${mode}: rows equal frozen production SQL`,()=>{
 const{db}=fixture(target)
 try{for(const limit of [1,7,100,500]){
  const q=buildAuditJsonCandidateQuery(target,'2026-01-03',limit,1024,mode==='tail'?cursorFor(target):null)
  const expectedBinds=[...baseline.queries[target][mode].binds];expectedBinds[expectedBinds.length-1]=limit
  // Tail pages add one redundant `date >= cursor_date` bind ahead of the frozen keyset binds.
  const cursorBinds=mode==='tail'?[expectedBinds.at(-4),...expectedBinds.slice(-4,-1)]:[]
  assert.deepEqual(q.binds,mode==='tail'?[...expectedBinds.slice(0,-4),...cursorBinds,limit]:expectedBinds)
  const oldRows=db.prepare(baseline.queries[target][mode].sql).all(...expectedBinds)
  assert.deepEqual(db.prepare(q.sql).all(...q.binds as SQLInputValue[]),oldRows);assert.ok(oldRows.length>0)
 }}finally{db.close()}
})

test('tail page starts its index range at the cursor date instead of rescanning the compacted prefix',()=>{
 const{db}=fixture('strategy_decision_log',10,true)
 try{db.exec('DELETE FROM strategy_decision_log')
  const ins=db.prepare(`INSERT INTO strategy_decision_log(decision_id,date,symbol,strategy_id,strategy_version,strategy_status,alpha_bucket,matched,reason_code,context_json,evidence_json,context_id,evidence_artifact_id)
   VALUES(?,?,?,'s','v1','active','trend',0,'r',?,?,'ctx','artifact')`)
  const marked=JSON.stringify({schema_version:'strategy-decision-json-ref-v2'})
  for(let day=1;day<=20;day++)for(let i=0;i<50;i++){
   const date=`2026-01-${String(day).padStart(2,'0')}`
   ins.run(`d-${date}-${String(i).padStart(3,'0')}`,date,String(i),day<=15?marked:JSON.stringify({candidate:i}),day<=15?marked:'{}')
  }
  let calls=0;db.function('probe',x=>{calls++;return x})
  const cursor={cursor_date:'2026-01-16',cursor_key:'d-2026-01-16-010'} as RetentionCursor
  const q=buildAuditJsonCandidateQuery('strategy_decision_log_ref_v2','2026-01-21',20,1024,cursor)
  const probed=(sql:string)=>sql.replace("COALESCE(context_json, '') NOT LIKE","COALESCE(probe(context_json), '') NOT LIKE")
  const frozen=q.sql.replace(/AND date >= \? AND \(date > \?/,'AND (date > ?')
  assert.notEqual(frozen,q.sql)
  const oldBinds=[...q.binds.slice(0,1),...q.binds.slice(2)] as SQLInputValue[]
  calls=0;const oldRows=db.prepare(probed(frozen)).all(...oldBinds);const oldCalls=calls
  calls=0;const rows=db.prepare(probed(q.sql)).all(...q.binds as SQLInputValue[]);const newCalls=calls
  assert.deepEqual(rows,oldRows);assert.equal(rows.length,20);assert.equal(rows[0].decision_id,'d-2026-01-16-011')
  // The page stops after the cursor date group (50 rows + the next row); the frozen SQL examined every row up to the cutoff.
  assert.ok(newCalls<=51,`examined ${newCalls}`);assert.ok(oldCalls>=239,`old ${oldCalls} new ${newCalls}`)
 }finally{db.close()}
})

test('decision-log pages keep a bounded date seek without idx_strategy_decision_log_date',()=>{
 // D1-RR learning 0065 drops that index; another date-leading index must take the range.
 const schema=readFileSync('domain-schemas/learning.sql','utf8')
 const db=new DatabaseSync(':memory:')
 try{db.exec(schema.match(/CREATE TABLE IF NOT EXISTS strategy_decision_log \([\s\S]*?\n\);/)![0])
  for(const m of schema.matchAll(/CREATE INDEX IF NOT EXISTS (idx_strategy_decision_log_\w+)\s+ON strategy_decision_log\([^;]*\);/g))if(m[1]!=='idx_strategy_decision_log_date')db.exec(m[0])
  for(const target of ['strategy_decision_log','strategy_decision_log_ref_v2'] as const)for(const cursor of [null,{cursor_date:'2026-01-16',cursor_key:'d'} as RetentionCursor]){
   const q=buildAuditJsonCandidateQuery(target,'2026-01-21',20,1024,cursor)
   const plan=db.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).all(...q.binds as SQLInputValue[]).map(r=>String(r.detail))
   const range=cursor?/\(date>\? AND date<\?\)/:/\(date<\?\)/
   assert.ok(plan.some(d=>/^SEARCH strategy_decision_log USING (COVERING )?INDEX idx_strategy_decision_log_\w+ /.test(d)&&range.test(d)),`${target} ${cursor?'tail':'head'}: ${plan.join(' | ')}`)
   assert.ok(!plan.some(d=>/^SCAN strategy_decision_log\b/.test(d)),`${target}: ${plan.join(' | ')}`)
  }
 }finally{db.close()}
})

test('JSON quoting is bounded by page size when sorting visits the entire date',()=>{
 const{db}=fixture('strategy_decision_log',3001,true)
 try{let calls=0;db.function('probe',x=>{calls++;return x})
  const q=buildAuditJsonCandidateQuery('strategy_decision_log','2026-01-03',100,1024,null)
  const run=(sql:string)=>{calls=0;const rows=db.prepare(sql.replace(/json_quote\(([\w.]+)\)/g,'json_quote(probe($1))')).all(...q.binds as SQLInputValue[]);return{rows,calls}}
  const old=run(baseline.queries.strategy_decision_log.head.sql);const current=run(q.sql)
  assert.deepEqual(current.rows,old.rows);assert.equal(current.calls,14*100);assert.equal(old.calls,14*3001)
 }finally{db.close()}
})

test('oversized first row still fails closed instead of skipping to smaller rows',async()=>{
 const{db,adapter}=fixture('paper_execution_events',10,true)
 try{db.prepare('UPDATE paper_execution_events SET detail_json=? WHERE id=1').run('漢'.repeat(400000))
  await assert.rejects(runAuditJsonArchiveRetention({DB:adapter,ARTIFACTS:null} as any,{businessDate:'2026-04-03',retentionDays:90,targets:['paper_execution_events'],dryRun:true}),/audit_json_row_requires_large_object_path:paper_execution_events/)
 }finally{db.close()}
})

test('byte-limited page retains hasMore and empty source returns an empty dry run',async()=>{
 const{db,adapter}=fixture('paper_execution_events',100,true)
 try{db.prepare('UPDATE paper_execution_events SET detail_json=?').run('漢'.repeat(20000))
  const options={businessDate:'2026-04-03',retentionDays:90,targets:['paper_execution_events'],dryRun:true}
  const result=await runAuditJsonArchiveRetention({DB:adapter,ARTIFACTS:null} as any,options)
  assert.ok(result.tables[0].candidate_rows>0&&result.tables[0].candidate_rows<100);assert.equal(result.tables[0].backlog_remaining,true)
  db.exec("UPDATE paper_execution_events SET detail_json='{}'")
  const empty=await runAuditJsonArchiveRetention({DB:adapter,ARTIFACTS:null} as any,options)
  assert.equal(empty.tables[0].candidate_rows,0);assert.equal(empty.tables[0].backlog_remaining,false)
 }finally{db.close()}
})
