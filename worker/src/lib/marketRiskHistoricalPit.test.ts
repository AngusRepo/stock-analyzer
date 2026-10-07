import assert from 'node:assert/strict'
import { calcMarketRisk } from './marketRisk'
const target='2026-08-20',cutoff=Date.parse(target+'T00:00:00Z')/1000
const days=Array.from({length:25},(_,i)=>new Date(Date.parse(target+'T00:00:00Z')-(24-i)*86400000).toISOString().slice(0,10))
const calls:{sql:string;params:unknown[]}[]=[];const fetched:string[]=[]
const realFetch=globalThis.fetch
globalThis.fetch=(async(input:unknown)=>{
 const url=String(input);fetched.push(url)
 if(url.includes('%5EVIX'))return Response.json({chart:{result:[{timestamp:[cutoff-86400,cutoff+86400],indicators:{quote:[{close:[17,90]}]}}]}})
 assert(url.includes('/twse/margin-summary?run_date='+target))
 return Response.json({date:'2026-10-06',source:'twse.mi_margn.all.listed',balance:10,limit:100,coverage:2000})
}) as typeof fetch
const db={prepare(sql:string){return{params:[] as unknown[],bind(...params:unknown[]){this.params=params;return this},async all(){
 calls.push({sql,params:this.params})
 if(sql.includes('canonical_market_index_daily'))return {results:days.map((date,i)=>({date,close:40000+i,source:'finlab.taiex_total_index'}))}
 if(sql.includes('LIMIT 21'))return {results:days.slice(-21).reverse().map(session_date=>({session_date}))}
 if(sql.includes('canonical_institutional_amount_daily'))return {results:days.slice(-5).map(date=>({date,daily_net:1}))}
 if(sql.includes('market_breadth'))return {results:days.slice(-5).reverse().map(date=>({date,advance_count:1000,decline_count:500}))}
 if(sql.includes('canonical_market_daily'))return {results:[{bull_count:1200,eligible:2000,universe:2200}]}
 throw new Error(sql)
}}}} as unknown as D1Database
async function main(){try{
 const risk=await calcMarketRisk(db,'https://dated.invalid',undefined,target)
 assert.equal(risk.vix,17,'future VIX excluded for all runs')
 assert.equal(risk.marginRatio,null,'different-day margin rejected')
 assert.equal(risk.quality.status,'bounded');assert.deepEqual(risk.quality.missing,['margin_ratio'])
 assert.equal(risk.quality.upper_score,risk.quality.known_score+10)
 assert.equal(risk.bullAlignmentPct,60);assert.equal(fetched.length,2)
 for(const call of calls){assert(call.params.includes(target));assert(!call.sql.includes("date('now'"))}
 assert(calls.some(c=>c.sql.includes("'-120 days'")&&c.sql.includes('ROW_NUMBER')))
 console.log('Historical risk: dated inputs, future VIX rejection, stale margin bounds, server MA60 aggregation PASS')
}finally{globalThis.fetch=realFetch}}
main().catch(e=>{console.error(e);process.exitCode=1})
