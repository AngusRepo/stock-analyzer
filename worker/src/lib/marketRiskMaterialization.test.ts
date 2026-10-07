import assert from 'node:assert/strict'
import fs from 'node:fs'
import { l4NativeFixture } from './l4NativeFixture.testSupport'
import { recomputeDailyMarketRisk } from './marketRiskMaterialization'
import { adminConfigCoreRoutes } from '../routes/adminConfigCoreRoutes'
const root='C:/Users/Wei/Desktop/CloudCode/stockvision-cloudflare-v12/audits/hmm-risk-repair-20261007'
const frozen=JSON.parse(fs.readFileSync(root+'/readonly-sources.json','utf8'))
const f=l4NativeFixture(),nativeMarket=f.env.MARKET_DB,nativeCore=f.env.CORE_DB
const realFetch=globalThis.fetch;let fault=false
globalThis.fetch=(async(input:unknown)=>{
 const url=String(input)
 if(url.includes('%5EVIX'))return Response.json(frozen.vix)
 if(url.includes('/twse/margin-summary?run_date='+frozen.date))return Response.json(frozen.margin)
 throw new Error('unfrozen_request:'+url)
}) as typeof fetch
f.env.ML_CONTROLLER_URL='https://frozen-controller.invalid';f.env.STOCKVISION_AUTH_TOKEN='fixture-token'
f.env.CORE_DB={...nativeCore,batch:async(statements:any[])=>nativeCore.batch(fault?[statements[0],{run:async()=>{throw new Error('injected_quality_error')}}]:statements)}
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
async function main(){try{
 f.sqls.market.prepare('INSERT INTO market_breadth(date,advance_count,decline_count,advance_ratio,sample_size) VALUES(?,1000,700,.419,1952)').run(frozen.date)
 const noAuth=await adminConfigCoreRoutes.request('http://test/api/admin/risk/recompute',{method:'POST'},f.env)
 assert.equal(noAuth.status,401)
 const result=await recomputeDailyMarketRisk(f.env,frozen.date)
 assert.equal(result.quality_status,'bounded');assert.equal(result.known_score,21);assert.equal(result.upper_score,21)
 assert.equal(result.model_training,false);assert.equal(result.prediction_pipeline_started,false)
 const row:any=f.sqls.core.prepare('SELECT * FROM market_risk WHERE date=?').get(frozen.date)
 assert.equal(row.bull_alignment_pct,33.53);assert.equal(row.adl_trend,'down');assert.equal(row.margin_ratio,null)
 assert.equal((f.sqls.market.prepare('SELECT bull_alignment_pct FROM market_breadth WHERE date=?').get(frozen.date) as any).bull_alignment_pct,33.53)
 f.sqls.core.prepare('UPDATE market_risk SET risk_score=90 WHERE date=?').run(frozen.date)
 const before=f.sqls.core.prepare('SELECT * FROM market_risk WHERE date=?').get(frozen.date)
 fault=true
 await assert.rejects(()=>recomputeDailyMarketRisk(f.env,frozen.date),/injected_quality_error/)
 assert.deepEqual(f.sqls.core.prepare('SELECT * FROM market_risk WHERE date=?').get(frozen.date),before,'Core risk and quality writes rollback together')
 await assert.rejects(()=>recomputeDailyMarketRisk(f.env,'2026-02-30'),/date_invalid/)
 console.log('Risk materialization: protected endpoint, actual SQLite raw fields/quality readback, no ML dispatch, atomic failure rollback PASS')
}finally{globalThis.fetch=realFetch;f.close()}}
main().catch(e=>{console.error(e);process.exitCode=1})
