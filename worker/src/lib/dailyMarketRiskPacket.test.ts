import { fixtureQuality, fixtureProvenance } from './riskProtocol.testSupport'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { withPaperExecutionScope } from './paperExecutionScope'
import { buildDailyMarketRiskPacket, riskPacketChecksum } from './dailyMarketRiskPacket'
import { adminConfigCoreRoutes } from '../routes/adminConfigCoreRoutes'
const root='C:/Users/Wei/Desktop/CloudCode/stockvision-cloudflare-v12/audits/dynamic-risk-p9-20261007'
const raw=JSON.parse(fs.readFileSync(root+'/../revenue-and-picks-20261007/risk-canonical-inputs.json','utf8'))
const policy=JSON.parse(fs.readFileSync(root+'/policy-source-readback.json','utf8'))
raw.breadth[0].bull_alignment_pct=60
raw.breadth[0].advance_ratio=.6
const patchedState=JSON.parse(raw.hmm[0].state_json)
patchedState.regime_evidence.hmm_provenance=fixtureProvenance('2026-10-06',fixtureQuality('2026-10-06',raw.market_risk[0].risk_score,raw.market_risk[0].twii_close,raw.market_risk[1].twii_close,raw.market_risk[1].date).checksum,patchedState.computed_at)
const state=JSON.stringify(patchedState)
const history={run_date:'2026-10-06',state_json:state,state_checksum:createHash('sha256').update(state).digest('hex')}
const db=(domain:string)=>({prepare(sql:string){return {bind(){return this},async first(){
 if(sql.includes('market_risk_quality_v1'))return fixtureQuality('2026-10-06',raw.market_risk[0].risk_score,raw.market_risk[0].twii_close,raw.market_risk[1].twii_close,raw.market_risk[1].date)
 if(sql.includes('market_regime_state_history'))return history
 if(sql.includes('market_regime_factor_packets'))return raw.factors[0]
 if(sql.includes('market_breadth'))return raw.breadth[0]
 throw new Error('unexpected_sql:'+sql)
 },async all(){assert.equal(domain,'core');assert(sql.includes('market_risk'));return {results:raw.market_risk}}}}})
const core=db('core'),market=db('market')
const kv:any={get:async(k:string,mode?:string)=>{let value:any=k==='trading:config' ? policy['trading:config'] : k==='trading:risk_config' ? policy['trading:risk_config'] : null;return mode==='json' ? value : value===null ? null : JSON.stringify(value)}}
const env:any={DB:core,CORE_DB:core,MARKET_DB:market,KV:kv,MULTI_D1_ACTIVE_DOMAINS:'core,market',MULTI_D1_STRICT:'true',
 STOCKVISION_AUTH_TOKEN:'local-test-token',CF_VERSION_METADATA:{tag:'0'.repeat(40)}}
const scoped=(execute:()=>Promise<any>)=>withPaperExecutionScope({environment:env,accountId:1,nowMs:Date.parse('2026-10-07T08:00:00+08:00'),
 databases:{core:core as any,market:market as any},fetchFrozen:async()=>{throw new Error('no_network')}},execute)
async function main(){
 const {result:packet}=await scoped(()=>buildDailyMarketRiskPacket(env,'2026-10-07'))
 assert.equal(packet.content.market.status,'ready');assert.equal(packet.content.market.level,'yellow')
 assert.equal(packet.content.constraints.exposure_cap,.68);assert.equal(packet.content.constraints.name_cap,.25)
 assert.equal(packet.content.constraints.max_positions,5)
 assert.equal(packet.checksum,await riskPacketChecksum(packet.content))
 assert.deepEqual(JSON.parse(packet.canonical_json),packet.content)
 fs.writeFileSync(root+'/../hmm-risk-repair-20261007/worker-daily-packet-golden.json',JSON.stringify(packet,null,2))
 const noAuth=await adminConfigCoreRoutes.request('http://test/api/admin/risk/daily-packet?trade_date=2026-10-07',{},env)
 assert.equal(noAuth.status,401)
 const {result:response}=await scoped(async()=>await adminConfigCoreRoutes.request('http://test/api/admin/risk/daily-packet?trade_date=2026-10-07',{headers:{Authorization:'Bearer local-test-token'}},env))
 assert.equal(response.status,200)
 assert.equal((await response.json() as any).checksum,packet.checksum)
 const alignment=raw.breadth[0].bull_alignment_pct
 raw.breadth[0].bull_alignment_pct=10
 const {result:weakAlignment}=await scoped(()=>buildDailyMarketRiskPacket(env,'2026-10-07'))
 assert.equal(weakAlignment.content.constraints.name_cap,.125,'formal P4 also constrains common packet')
 raw.breadth[0].bull_alignment_pct=alignment
 await assert.rejects(()=>scoped(()=>buildDailyMarketRiskPacket(env,'2026-10-06')),/current_decision/)
 console.log('Daily packet: exact Worker owner, live configuration inheritance, checksum, predecision clock, date scope and service auth passed')
}
main().catch(e=>{console.error(e);process.exit(1)})
