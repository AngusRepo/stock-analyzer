import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { buildChampionTradingConfig } from './tradingConfig'
export function l4NativeFixture() {
  let clockPorts:{nowMs:number}={nowMs:Date.parse('2026-09-14T00:00:00Z')}
  const frozenSql=(query:string)=>{const time=new Date(clockPorts.nowMs).toISOString();return query
    .replace(/\bCURRENT_TIMESTAMP\b/gi,`datetime('${time}')`)
    .replace(/(['"])now\1/gi,`'${time}'`)}
  const domains=['core','market','paper','learning','execution','ops']
  const sqls:Record<string,DatabaseSync>={},dbs:Record<string,any>={}
  for(const domain of domains) {
    const sql=sqls[domain]=new DatabaseSync(':memory:')
    const dir=new URL(`../../domain-migrations/${domain}/`,import.meta.url)
    for(const file of fs.readdirSync(dir).filter(f=>f.startsWith('0001_') || f==='0002_runtime_owned_tables.sql' || domain==='ops' && f==='0005_ops_artifact_compute_cost_runtime.sql' || domain==='market' && f==='0004_legacy_schema_alignment.sql' || domain==='paper' && ['0004_corporate_action_accounting.sql','0005_l4_distribution.sql','0006_p5_rearm.sql'].includes(f)).sort()) sql.exec(fs.readFileSync(new URL(file,dir),'utf8'))
    const statement=(query:string,args:any[]=[]):any=>({bind:(...values:any[])=>statement(query,values),
      first:async()=>sql.prepare(frozenSql(query)).get(...args) ?? null,all:async()=>({success:true,results:sql.prepare(frozenSql(query)).all(...args)}),
      run:async()=>{const result=sql.prepare(frozenSql(query)).run(...args);return {success:true,meta:{changes:Number(result.changes)}}}})
    dbs[domain]={prepare:statement,batch:async(statements:any[])=>{sql.exec('SAVEPOINT fixture_batch');try {const rows=[];for(const s of statements)rows.push(await s.run());sql.exec('RELEASE fixture_batch');return rows} catch(error) {sql.exec('ROLLBACK TO fixture_batch; RELEASE fixture_batch');throw error}}}
  }
  const cfg=buildChampionTradingConfig(null)
  const kvs=new Map([['trading:config',JSON.stringify(cfg)]])
  const kv:any={get:async(k:string,type?:string)=>{const v=kvs.get(k) ?? null;return type==='json' && v!==null?JSON.parse(v):v},put:async(k:string,v:string)=>{kvs.set(k,v)},delete:async(k:string)=>{kvs.delete(k)}}
  const env:any={DB:dbs.core,KV:kv,MULTI_D1_ACTIVE_DOMAINS:domains.join(','),MULTI_D1_STRICT:'true'}
  const artifacts=new Map<string,string>()
  env.ARTIFACTS={put:async(key:string,body:string)=>{artifacts.set(key,body)},get:async(key:string)=>artifacts.has(key)?{text:async()=>artifacts.get(key)}:null}
  for(const domain of domains)env[domain.toUpperCase()+'_DB']=dbs[domain]
  sqls.paper.exec("INSERT INTO paper_accounts(id,cash,initial_cash) VALUES(1,1000000,1000000)")
  const ports:any={environment:env,accountId:1,nowMs:Date.parse('2026-09-14T00:00:00Z'),databases:dbs,
    fetchFrozen:async()=>{throw new Error('unexpected_network_in_account_capture')},transaction:async(fn:()=>Promise<any>)=>fn()}
  clockPorts=ports
  return {sqls,env,ports,cfg,kvs,artifacts,close:()=>Object.values(sqls).forEach(s=>s.close())}
}
