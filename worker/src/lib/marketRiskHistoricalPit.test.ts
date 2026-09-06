import assert from 'node:assert/strict'
import { calcMarketRisk } from './marketRisk'

const target='2026-08-20'
const calls: {sql:string;params:unknown[]}[]=[]
const fetched:string[]=[]
const realFetch=globalThis.fetch
globalThis.fetch=(async(input:unknown)=>{
  const url=String(input); fetched.push(url)
  assert(url.includes('%5EVIX'),`unexpected external request: ${url}`)
  assert(url.includes('period1=')&&url.includes('period2='))
  const cutoff=Date.parse(target+'T00:00:00Z')/1000
  return new Response(JSON.stringify({chart:{result:[{timestamp:[cutoff-86400,cutoff+86400],indicators:{quote:[{close:[17,90]}]}}]}}))
}) as typeof fetch
const db={prepare(sql:string){return{params:[] as unknown[],bind(...params:unknown[]){this.params=params;return this},async all(){
  calls.push({sql,params:this.params})
  if(sql.includes('canonical_market_index_daily'))return{results:Array.from({length:25},(_,i)=>({date:`2026-07-${String(i+1).padStart(2,'0')}`,close:40000+i,source:'finlab.taiex_total_index'}))}
  if(sql.includes('canonical_institutional_amount_daily'))return{results:[{date:target,daily_net:1}]}
  if(sql.includes('market_breadth'))return{results:[]}
  if(sql.includes('stock_prices'))return{results:[]}
  throw new Error(sql)
}}}} as unknown as D1Database
async function main(){try{
  const risk=await calcMarketRisk(db,undefined,'https://latest-only.invalid',undefined,undefined,target)
  assert.equal(risk.date,target)
  assert.equal(risk.vix,17,'future VIX must be excluded even if upstream returns it')
  assert.equal(risk.marginRatio,null,'latest-only margin ratio must not enter historical backfill')
  assert.equal(fetched.length,1)
  for(const {sql,params} of calls){
    assert(params.includes(target),`missing PIT bind: ${sql}`)
    assert(!sql.includes("date('now'"),'historical DB reads cannot be relative to runtime now')
  }
  assert(calls.some(c=>c.sql.includes("'-120 days'")&&c.params.length===2),'MA60 needs more than 70 calendar days')
  console.log('marketRiskHistoricalPit: PASS')
}finally{globalThis.fetch=realFetch}}
main().catch(error=>{console.error(error);process.exitCode=1})
