import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runR2RetentionSweep, retainArtifactHardReference, writeEvidenceArtifact } from './artifactLifecycle'

const NOW='2036-09-27T00:00:00.000Z', LATER='2036-09-27T00:03:00.000Z'
const migration=readFileSync('domain-migrations/ops/0020_artifact_deletion_claims.sql','utf8')
function fixture() {
  const sql=new DatabaseSync(':memory:');sql.exec('PRAGMA foreign_keys=ON')
  const schema=readFileSync('domain-schemas/ops.sql','utf8')
  for(const table of ['run_artifacts','artifact_hard_references'])
    sql.exec(schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS '+table+' (')).split(';')[0])
  sql.exec(migration)
  const objects=new Map<string,string>(), deleted:string[]=[], puts:string[]=[]
  let mutateAfterSelection:(()=>Promise<void>)|undefined, onDelete:((key:string)=>Promise<void>)|undefined
  let loseCommit=false,failCommit=false,loseClaim=false,clock=0
  function prepare(query:string) {
    let params:any[]=[]
    return {query,get params(){return params},bind(...v:any[]){params=v;return this},
      async first(){return sql.prepare(query).get(...params)??null},
      async all(){const results=sql.prepare(query).all(...params)
        if(query.includes('a.retain_until scheduled_at')&&mutateAfterSelection){const run=mutateAfterSelection;mutateAfterSelection=undefined;await run()}
        return {results}},
      async run(){const r=sql.prepare(query).run(...params)
        if(loseClaim && query.startsWith('INSERT INTO artifact_deletion_claims_v1')){loseClaim=false;throw new Error('claim response lost')}
        return {meta:{changes:Number(r.changes)},success:true}}}
  }
  const db={prepare,async batch(statements:any[]) {
    sql.exec('BEGIN')
    try {
      const results=statements.map((s,i)=>{if(failCommit&&i===1&&s.query.includes("status='done'"))throw new Error('finish write failed')
        const q=sql.prepare(s.query);return {success:true,results:q.columns().length?q.all(...s.params):(q.run(...s.params),[])}})
      sql.exec('COMMIT');if(loseCommit){loseCommit=false;throw new Error('commit response lost')}return results
    }catch(e){if(sql.isTransaction)sql.exec('ROLLBACK');throw e}
  }} as unknown as D1Database
  const r2={async get(key:string){const value=objects.get(key);return value==null?null:{text:async()=>value}},
    async put(key:string,value:string){puts.push(key);objects.set(key,value)},
    async delete(key:string){deleted.push(key);objects.delete(key);if(onDelete)await onDelete(key)}}
  const env={DB:db,ARTIFACTS:r2 as any}
  function artifact(id:string,patch:Record<string,any>={}) {
    const row={artifact_id:id,retention_class:'request_debug',status:'ready',domain:'test',business_date:'2026-09-26',producer_run_id:'fixture',
      r2_key:'evidence/'+id,checksum:'sha256:'+id,schema_version:'fixture-v1',created_at:'2026-09-26T00:00:00Z',
      retain_until:'2026-10-26T00:00:00Z',checksum_verified_at:'2026-09-26T00:00:00Z',...patch}
    sql.prepare(`INSERT INTO run_artifacts(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`)
      .run(...Object.values(row));objects.set(row.r2_key,'{}')
  }
  return {sql,db,env,objects,deleted,puts,artifact,clock:()=>clock,setClock(value:number){clock=value},
    afterSelect(run:()=>Promise<void>){mutateAfterSelection=run},duringDelete(run:((key:string)=>Promise<void>)|undefined){onDelete=run},
    loseCommit(){loseCommit=true},failCommit(value:boolean){failCommit=value},loseClaim(){loseClaim=true}}
}

test('expiry preserves pin/hold/live edges/verification requirements and leaves immutable metadata tombstones',async()=>{
  const f=fixture()
  try {
    f.artifact('expired');f.artifact('pin',{pinned:1});f.artifact('hold',{legal_hold:1})
    f.artifact('future',{retain_until:'2040-01-01T00:00:00Z'});f.artifact('forever',{retain_until:null})
    f.artifact('unverified',{checksum_verified_at:null});f.artifact('cached_ref',{hard_ref_count:1});f.artifact('edge')
    f.sql.exec("INSERT INTO artifact_hard_references(reference_id,artifact_id,owner_type,owner_id) VALUES('r','edge','test','owner')")
    const result=await runR2RetentionSweep(f.env,{now:NOW})
    assert.equal(result.deleted,1);assert.equal(result.failed,0);assert.equal(result.has_more,false)
    assert.deepEqual(f.deleted,['evidence/expired'])
    const record=f.sql.prepare("SELECT * FROM run_artifacts WHERE artifact_id='expired'").get()!
    assert.equal(record.status,'payload_deleted');assert.ok(record.payload_deleted_at);assert.equal(record.checksum,'sha256:expired')
    assert.equal(f.sql.prepare("SELECT status FROM artifact_deletion_claims_v1 WHERE artifact_id='expired'").get()?.status,'done')
    assert.throws(()=>f.sql.exec('DELETE FROM artifact_deletion_claims_v1'),/immutable/)
    assert.equal((await runR2RetentionSweep(f.env,{now:LATER})).deleted,0)
  }finally{f.sql.close()}
})

test('reference or hold attached after candidate selection wins before the atomic claim',async()=>{
  for(const race of ['reference','hold']) {
    const f=fixture()
    try {
      f.artifact('expired')
      f.afterSelect(async()=>{if(race==='reference')await retainArtifactHardReference(f.db,{artifactId:'expired',ownerType:'reader',ownerId:'late'})
        else f.sql.exec("UPDATE run_artifacts SET legal_hold=1 WHERE artifact_id='expired'")})
      const result=await runR2RetentionSweep(f.env,{now:NOW})
      assert.equal(result.skipped,1);assert.equal(result.deleted,0);assert.deepEqual(f.deleted,[])
      assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM artifact_deletion_claims_v1').get()?.n,0)
    }finally{f.sql.close()}
  }
})

test('after claim, new/reactivated references, holds, pins and manifest resurrection are rejected',async()=>{
  const f=fixture()
  try {
    f.artifact('expired')
    f.sql.exec("INSERT INTO artifact_hard_references(reference_id,artifact_id,owner_type,owner_id,active) VALUES('old','expired','reader','old',0)")
    f.duringDelete(async()=>{
      await assert.rejects(retainArtifactHardReference(f.db,{artifactId:'expired',ownerType:'reader',ownerId:'new'}),/delete_in_progress/)
      assert.throws(()=>f.sql.exec("UPDATE artifact_hard_references SET active=1 WHERE reference_id='old'"),/delete_in_progress/)
      for(const column of ['pinned','legal_hold'])assert.throws(()=>f.sql.exec(`UPDATE run_artifacts SET ${column}=1 WHERE artifact_id='expired'`),/delete_in_progress/)
      assert.throws(()=>f.sql.exec("INSERT OR REPLACE INTO run_artifacts SELECT * FROM run_artifacts WHERE artifact_id='expired'"),/delete_in_progress/)
    })
    assert.equal((await runR2RetentionSweep(f.env,{now:NOW})).deleted,1)
    assert.throws(()=>f.sql.exec("UPDATE run_artifacts SET status='ready',payload_deleted_at=NULL WHERE artifact_id='expired'"),/delete_in_progress/)
  }finally{f.sql.close()}
})

test('lost R2 acknowledgement backs off then retries idempotently without reopening reference admission',async()=>{
  const f=fixture()
  try {
    f.artifact('expired');f.duringDelete(async()=>{throw new Error('R2 reply lost')})
    assert.equal((await runR2RetentionSweep(f.env,{now:NOW})).failed,1)
    assert.equal(f.objects.size,0);assert.equal(f.sql.prepare('SELECT status FROM artifact_deletion_claims_v1').get()?.status,'pending')
    const waiting=await runR2RetentionSweep(f.env,{now:NOW})
    assert.equal(waiting.candidates,0,'do not hot-loop a failed delete')
    assert.equal(waiting.has_more,true,'backoff must remain visible as backlog')
    f.duringDelete(undefined)
    assert.equal((await runR2RetentionSweep(f.env,{now:LATER})).deleted,1)
    assert.equal(f.deleted.length,2)
  }finally{f.sql.close()}
})

test('metadata completion rollback and lost claim/commit responses remain recoverable',async()=>{
  for(const failure of ['finish','claim_ack','commit_ack']) {
    const f=fixture()
    try {
      f.artifact('expired');if(failure==='finish')f.failCommit(true)
      if(failure==='claim_ack')f.loseClaim();if(failure==='commit_ack')f.loseCommit()
      const first=await runR2RetentionSweep(f.env,{now:NOW})
      if(failure==='commit_ack') {assert.equal(first.deleted,1);assert.equal(first.failed,0)}
      else {
        assert.equal(first.failed,1);assert.equal(f.sql.prepare('SELECT status FROM run_artifacts').get()?.status,'ready')
        assert.equal(f.sql.prepare('SELECT status FROM artifact_deletion_claims_v1').get()?.status,'pending')
        f.failCommit(false);assert.equal((await runR2RetentionSweep(f.env,{now:LATER})).deleted,1)
      }
      assert.equal(f.sql.prepare('SELECT status FROM artifact_deletion_claims_v1').get()?.status,'done')
    }finally{f.sql.close()}
  }
})

test('a second sweeper cannot take an unexpired deletion lease',async()=>{
  const f=fixture()
  try {
    f.artifact('expired');let signal!:()=>void,finish!:()=>void
    const started=new Promise<void>(r=>{signal=r}),blocked=new Promise<void>(r=>{finish=r})
    f.duringDelete(async()=>{signal();await blocked})
    const first=runR2RetentionSweep(f.env,{now:NOW});await started
    const waiting=await runR2RetentionSweep(f.env,{now:NOW})
    assert.equal(waiting.claimed,0);assert.equal(waiting.has_more,true)
    finish();assert.equal((await first).deleted,1);assert.equal(f.deleted.length,1)
  }finally{f.sql.close()}
})

test('bounded admission leaves remaining objects discoverable and a failed oldest object does not block new work',async()=>{
  const f=fixture()
  try {
    for(const id of ['a','b','c'])f.artifact(id)
    f.duringDelete(async()=>{f.setClock(50)})
    const first=await runR2RetentionSweep(f.env,{now:NOW,budgetMs:20,clock:f.clock})
    assert.equal(first.deleted,1);assert.equal(first.budget_exhausted,true);assert.equal(first.has_more,true)
    f.duringDelete(async key=>{if(key==='evidence/b')throw new Error('bad object')})
    const next=await runR2RetentionSweep(f.env,{now:LATER,limit:1})
    assert.equal(next.failed,1)
    assert.equal((await runR2RetentionSweep(f.env,{now:LATER,limit:1})).deleted,1)
    assert.deepEqual(f.deleted,['evidence/a','evidence/b','evidence/c'])
  }finally{f.sql.close()}
})

test('legacy payload tombstones are backfilled idempotently and writer rejects reuse before R2 work',async()=>{
  const f=fixture()
  try {
    const input={domain:'test',businessDate:'2026-09-26',producerRunId:'writer',retentionClass:'request_debug' as const,
      schemaVersion:'v1',payload:{rows:[1]},rowCount:1,createdAt:'2026-09-26T00:00:00Z'}
    const written=await writeEvidenceArtifact(f.env,input)
    f.sql.prepare("UPDATE run_artifacts SET status='payload_deleted',payload_deleted_at=? WHERE artifact_id=?").run(NOW,written.artifact_id)
    f.sql.exec(migration);f.sql.exec(migration)
    const puts=f.puts.length
    await assert.rejects(writeEvidenceArtifact(f.env,input),/delete_in_progress/)
    assert.equal(f.puts.length,puts)
    assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM artifact_deletion_claims_v1').get()?.n,1)
    assert.ok(readFileSync('domain-schemas/ops.sql','utf8').includes(migration.trim()))
  }finally{f.sql.close()}
})


test('a large fresh backlog and due retries both make progress within the object cap',async()=>{
  const f=fixture()
  try {
    f.artifact('retry');f.duringDelete(async()=>{throw new Error('temporary')})
    assert.equal((await runR2RetentionSweep(f.env,{now:NOW,limit:1})).failed,1)
    for(const id of ['a','b','c'])f.artifact(id)
    f.duringDelete(undefined)
    const result=await runR2RetentionSweep(f.env,{now:LATER,limit:2})
    assert.equal(result.deleted,2);assert.equal(result.has_more,true)
    assert.deepEqual(f.deleted,['evidence/retry','evidence/retry','evidence/a'])
  }finally{f.sql.close()}
})
