import assert from 'node:assert/strict'
import { loadCandidateStockIds, loadCandidateSignalDates } from './priceHorizonProjection'

async function main(){
  const calls:{sql:string;params:unknown[]}[]=[]
  const db={prepare(sql:string){return{params:[] as unknown[],bind(...params:unknown[]){this.params=params;return this},async first(){return{reference_rows:0,identified_reference_rows:0}},async all(){
    calls.push({sql,params:this.params})
    if(sql.includes('FROM price_horizon_labels_v2'))return{results:[{stock_id:981},{stock_id:1500}]}
    if(sql.includes('FROM price_horizon_labels_v1'))return{results:[{stock_id:7}]}
    return{results:[{stock_id:7},{stock_id:981}]}
  }}}} as unknown as D1Database
  const ten=await loadCandidateStockIds(db,'2026-08-07',10)
  assert.deepEqual(ten.stockIds,[7,981,1500])
  assert(calls.some(c=>c.sql.includes('horizon_days=?')&&c.params[1]===10))
  calls.length=0
  const five=await loadCandidateStockIds(db,'2026-08-07')
  assert.deepEqual(five.stockIds,[7,981])
  assert(!calls.some(c=>c.sql.includes('FROM price_horizon_labels_v2')),'canonical five-day must not invent identities from other horizons')
  const dateDb={prepare(sql:string){return{bind(...params:unknown[]){
    assert.equal((sql.match(/\?/g)??[]).length,params.length)
    assert((sql.match(/\bUNION\b/g)??[]).length<5,'production D1 compound SELECT limit')
    return{async all(){return{results:sql.includes('price_horizon_labels_v1')
      ?[{signal_date:'2026-08-07'},{signal_date:'2026-08-12'}]
      :[{signal_date:'2026-08-12'}]}}}
  }}}} as unknown as D1Database
  assert.deepEqual([...await loadCandidateSignalDates(dateDb,'2026-08-07','2026-08-12')].sort(),
    ['2026-08-07','2026-08-12'])
  console.log('priceHorizonRetainedIdentity: PASS')
}
main().catch(error=>{console.error(error);process.exitCode=1})
