import assert from 'node:assert/strict'
import fs from 'node:fs'
import { l4NativeFixture } from './l4NativeFixture.testSupport'
import { recomputeDailyMarketRisk } from './marketRiskMaterialization'
import { buildMarketRegimeFactorPacket, excludeSourceAfterDate } from './marketRegimeFactorPacket'

// PIT (Wei 10/29): after the next session opens, a past date keeps its original market_risk,
// quality receipt and factor packet; recomputations are appended to the revisions tables.
const frozen=JSON.parse(fs.readFileSync(new URL('../../test-fixtures/daily-market-risk/readonly-sources.json', import.meta.url),'utf8'))
const f=l4NativeFixture(),nativeMarket=f.env.MARKET_DB
const realFetch=globalThis.fetch,realNow=Date.now
let vix=frozen.vix,cnyesCalls=0,cnyesPublishAt=0
globalThis.fetch=(async(input:unknown)=>{
 const url=String(input)
 if(url.includes('%5EVIX'))return Response.json(vix)
 if(url.includes('/twse/margin-summary?run_date='+frozen.date))return Response.json(frozen.margin)
 if(url.includes('news.cnyes.com')){cnyesCalls++;return Response.json({items:{data:[{title:'later headline',newsId:1,publishAt:cnyesPublishAt}]}})}
 throw new Error('unfrozen_request:'+url)
}) as typeof fetch
f.env.ML_CONTROLLER_URL='https://frozen-controller.invalid'
f.env.MARKET_DB={...nativeMarket,prepare(sql:string){let args:unknown[]=[]
 const base=()=>nativeMarket.prepare(sql).bind(...args)
 return {bind(...values:unknown[]){args=values;return this},first:async()=>base().first(),run:async()=>base().run(),all:async()=>{
   if(sql.includes('canonical_market_index_daily'))return {results:frozen.index}
   if(sql.includes('canonical_institutional_amount_daily')&&sql.includes('daily_net'))return {results:frozen.foreign.slice(-5)}
   if(sql.includes('market_breadth')&&sql.includes('LIMIT 5'))return {results:frozen.adl.slice(0,5)}
   if(sql.includes('canonical_market_daily')&&sql.includes('ROW_NUMBER'))return {results:frozen.alignment}
   if(sql.includes('market_trading_sessions')&&sql.includes('LIMIT 21'))return {results:frozen.sessions}
   if(sql.includes('market_trading_sessions')&&sql.includes('session_date<?'))return {results:[{session_date:frozen.previous_session}]}
   return base().all()
 }}
}}
const at=(iso:string)=>{Date.now=()=>Date.parse(iso)}
const core=(sql:string)=>f.sqls.core.prepare(sql).all(frozen.date) as any[]
const market=(sql:string)=>f.sqls.market.prepare(sql).all(frozen.date) as any[]
async function main(){try{
 assert.equal(frozen.date,'2026-10-06')
 f.sqls.market.prepare("INSERT INTO canonical_market_daily(stock_id,date,source,lineage_json,as_of_date,close) VALUES('0050','2026-10-07','finlab.price','{}','2026-10-07',100)").run()
 f.sqls.market.prepare('INSERT INTO market_breadth(date,advance_count,decline_count,advance_ratio,sample_size) VALUES(?,1000,700,.419,1952)').run(frozen.date)

 // Same evening: the canonical rows are written.
 at('2026-10-06T12:00:00Z')
 const first=await recomputeDailyMarketRisk(f.env,frozen.date)
 assert.equal(first.canonical_mode,'replace')
 const risk0=core('SELECT * FROM market_risk WHERE date=?'),quality0=core('SELECT * FROM market_risk_quality_v1 WHERE date=?')
 const packet0=market('SELECT * FROM market_regime_factor_packets WHERE date=?')
 assert.equal(risk0.length,1);assert.equal(packet0.length,1)
 assert.equal(core('SELECT * FROM market_risk_revisions_v1 WHERE date=?').length,1)

 // After the next session opened: a recomputation with new inputs keeps every original row.
 vix=JSON.parse(JSON.stringify(frozen.vix))
 const quote=vix.chart.result[0].indicators.quote[0];quote.close=quote.close.map((v:any)=>typeof v==='number'?v*2:v)
 f.sqls.market.prepare('UPDATE market_breadth SET bull_alignment_pct=12.5 WHERE date=?').run(frozen.date)
 at('2026-10-07T02:00:00Z')
 const later=await recomputeDailyMarketRisk(f.env,frozen.date)
 assert.equal(later.canonical_mode,'keep_original')
 assert.deepEqual(core('SELECT * FROM market_risk WHERE date=?'),risk0)
 assert.deepEqual(core('SELECT * FROM market_risk_quality_v1 WHERE date=?'),quality0)
 assert.deepEqual(market('SELECT * FROM market_regime_factor_packets WHERE date=?'),packet0)
 assert.equal(market('SELECT bull_alignment_pct FROM market_breadth WHERE date=?')[0].bull_alignment_pct,12.5)
 const packetRevisions=market('SELECT canonical_mode FROM market_regime_factor_packet_revisions_v1 WHERE date=? ORDER BY recorded_at')
 assert.deepEqual(packetRevisions.map(r=>r.canonical_mode),['replace','keep_original'])
 const riskRevisions=core('SELECT canonical_mode,risk_json FROM market_risk_revisions_v1 WHERE date=? ORDER BY recorded_at')
 assert.deepEqual(riskRevisions.map(r=>r.canonical_mode),['replace','keep_original'])
 assert.notEqual(JSON.parse(riskRevisions[1].risk_json).vix,risk0[0].vix,'the revision holds the recomputed value')

 // A first observation that never existed is still filled after the open.
 f.sqls.core.prepare('DELETE FROM market_risk WHERE date=?').run(frozen.date)
 f.sqls.core.prepare('DELETE FROM market_risk_quality_v1 WHERE date=?').run(frozen.date)
 f.sqls.market.prepare('DELETE FROM market_regime_factor_packets WHERE date=?').run(frozen.date)
 const filled=await recomputeDailyMarketRisk(f.env,frozen.date)
 assert.equal(filled.canonical_mode,'keep_original')
 assert.equal(core('SELECT * FROM market_risk WHERE date=?').length,1)
 assert.equal(market('SELECT * FROM market_regime_factor_packets WHERE date=?').length,1)

 // An original whose quality receipt is unusable is kept, and the caller is told so.
 f.sqls.core.prepare('UPDATE market_risk_quality_v1 SET checksum=? WHERE date=?').run('0'.repeat(64),frozen.date)
 const kept=core('SELECT * FROM market_risk_quality_v1 WHERE date=?')
 await assert.rejects(()=>recomputeDailyMarketRisk(f.env,frozen.date),/market_risk_original_kept_unqualified:2026-10-06/)
 assert.deepEqual(core('SELECT * FROM market_risk_quality_v1 WHERE date=?'),kept)

 // A receipt without its risk row is not completed from a post-open recompute (the pair never splits).
 f.sqls.core.prepare('DELETE FROM market_risk WHERE date=?').run(frozen.date)
 await assert.rejects(()=>recomputeDailyMarketRisk(f.env,frozen.date),/market_risk_original_kept_unqualified/)
 assert.equal(core('SELECT * FROM market_risk WHERE date=?').length,0)
 assert.deepEqual(core('SELECT * FROM market_risk_quality_v1 WHERE date=?'),kept)

 // Before the next open the past date may still be replaced.
 at('2026-10-07T00:30:00Z')
 const repaired=await recomputeDailyMarketRisk(f.env,frozen.date)
 assert.equal(repaired.canonical_mode,'replace')
 assert.notDeepEqual(core('SELECT * FROM market_risk_quality_v1 WHERE date=?'),kept)

 // Factor packets never cite a source dated after the packet date.
 at('2026-10-07T02:00:00Z')
 const regimeLater={run_date:'2026-10-07',regime_evidence:{evidence:{}},monitors:{lppls_weekly_bubble:{score:.9}}}
 cnyesCalls=0
 const past=await buildMarketRegimeFactorPacket(f.env.MARKET_DB,{date:frozen.date},regimeLater)
 assert.equal(cnyesCalls,0,'a past packet does not read the live headline feed')
 for(const id of ['macro','global','event_monitors']){
   const tile=past.factors.find(t=>t.id===id)!
   assert.equal(tile.missing_reason,'source_after_packet_date',id);assert.equal(tile.score,45);assert.equal(tile.source_date,null)
 }
 // A headline published 10/07 01:00 Taipei (10/06 17:00Z) is not a 10/06 source.
 at('2026-10-06T17:30:00Z');cnyesPublishAt=Date.parse('2026-10-06T17:00:00Z')/1000
 const sameDay=await buildMarketRegimeFactorPacket(f.env.MARKET_DB,{date:'2026-10-07'},{run_date:'2026-10-07'})
 assert.equal(cnyesCalls,1);assert.equal(sameDay.factors.find(t=>t.id==='event_monitors')!.source_date,'2026-10-07')
 const tile={id:'x',label:'x',value:'v',raw_value:1,score:80,weight:.1,contribution:8,status:'warn' as const,source:'s',source_date:'2026-10-07',detail:'d'}
 assert.equal(excludeSourceAfterDate(tile,'2026-10-06').contribution,4.5)
 assert.equal(excludeSourceAfterDate(tile,'2026-10-07'),tile)
 // The new tables ship with their schema files and the deploy schema check.
 const read=(path:string)=>fs.readFileSync(new URL(path,import.meta.url),'utf8')
 assert.match(read('../../domain-schemas/core.sql'),/CREATE TABLE IF NOT EXISTS market_risk_revisions_v1/)
 assert.match(read('../../domain-schemas/market.sql'),/CREATE TABLE IF NOT EXISTS market_regime_factor_packet_revisions_v1/)
 assert.match(read('../../domain-schemas/market.sql'),/screener_momentum_snapshots[\s\S]*pool_definition\s+TEXT/)
 const deploy=read('../../../tools/deploy_worker_with_provenance.mjs')
 for(const table of ['market_risk_revisions_v1','market_regime_factor_packet_revisions_v1'])assert.match(deploy,new RegExp(`FROM ${table} LIMIT 0`))
 assert.match(deploy,/SELECT pool_definition FROM screener_momentum_snapshots LIMIT 0/)
 console.log('market risk PIT: originals kept after the open, revisions appended, first observations filled, no later sources PASS')
}finally{globalThis.fetch=realFetch;Date.now=realNow;f.close()}}
main().catch(e=>{console.error(e);process.exitCode=1})
