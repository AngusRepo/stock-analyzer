import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { readStrategyNavEvidence } from './strategyNavEvidence'

for (const mode of ['current','prior','missing-proof','future','mismatched-request'] as const) {
  test('strategy NAV display cutoff: '+mode, async(t)=>{
    const db=new DatabaseSync(':memory:')
    db.exec(`CREATE TABLE strategy_replacement_authority_v1(singleton_id INTEGER,owner TEXT);
      INSERT INTO strategy_replacement_authority_v1 VALUES(1,'original_paired_daily_nav');
      CREATE TABLE strategy_atomic_nav_adoptions_v1(artifact_checksum TEXT);`)
    const adapter={prepare(sql:string){return {async first(){return db.prepare(sql).get()??null}}}}
    const old=globalThis.fetch;t.after(()=>{globalThis.fetch=old;db.close()})
    const input={strategy_id:'s8',strategy_version:'v1',business_date:'2026-09-29'}
    const response:any={schema_version:'strategy-nav-evidence-v1',strategy_id:'s8',strategy_version:'v1',
      as_of_date:mode==='current'?'2026-09-29':mode==='future'?'2026-09-30':'2026-09-28',
      observed_at:'2026-09-28T14:00:00Z',read_only:true,promotion_allowed:false,
      source:'original_frozen_policy_and_verified_nav',status:'not_registered',entries:[],entry_count:0,
      read_model:{schema_version:'strategy-nav-read-model-v1',requested_as_of_date:mode==='mismatched-request'?'2026-09-27':'2026-09-29',is_prior_business_date:mode!=='current'}}
    if(mode==='missing-proof')delete response.read_model
    globalThis.fetch=async(url,init)=>{
      assert.equal(String(url),'https://controller.invalid/nav/strategy-evidence')
      assert.deepEqual(JSON.parse(String(init?.body)),input)
      return Response.json(response)
    }
    const read=()=>readStrategyNavEvidence({DB:adapter,ML_CONTROLLER_URL:'https://controller.invalid',ML_CONTROLLER_SECRET:'fixture'} as any,input)
    if(mode==='current'||mode==='prior'){
      const result=await read();assert.equal(result.as_of_date,response.as_of_date)
      assert.equal(result.current_replacement_owner,'original_paired_daily_nav')
      assert.equal(result.promotion_allowed,false)
    }else await assert.rejects(read(),/strategy_nav_original_evidence_invalid/)
  })
}
